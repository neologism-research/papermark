import ffmpeg from "fluent-ffmpeg";
import { createReadStream, createWriteStream } from "fs";
import fs from "fs/promises";
import fetch from "node-fetch";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";

import { getFile } from "@/lib/files/get-file";
import { streamFileServer } from "@/lib/files/stream-file-server";
import prisma from "@/lib/prisma";

type ProcessVideoPayload = {
  videoUrl: string;
  teamId: string;
  docId: string;
  documentVersionId: string;
  fileSize: number;
};

/**
 * Optimizes video files for better streaming and viewing
 * Local replacement for the Trigger.dev task
 */
export async function optimizeVideo(payload: ProcessVideoPayload) {
  const { videoUrl, teamId, docId, documentVersionId, fileSize } = payload;
  let progressCallback:
    | ((progress: number, message: string) => void)
    | undefined;

  try {
    // Optional progress tracking function
    const updateProgress = (progress: number, text: string) => {
      console.log(`Video Optimization Progress (${progress}%): ${text}`);
      if (progressCallback) {
        progressCallback(progress, text);
      }
    };

    updateProgress(0, "Initializing...");

    const fileUrl = await getFile({
      data: videoUrl,
      type: "S3_PATH",
    });

    console.log("Starting video optimization", { fileUrl });
    updateProgress(10, "Fetching video file...");

    // Create temp directory for input and output
    const tempDirectory = path.join(os.tmpdir(), `video_${Date.now()}`);
    await fs.mkdir(tempDirectory, { recursive: true });
    const inputPath = path.join(tempDirectory, "input.mp4");
    const outputPath = path.join(tempDirectory, "output.mp4");

    // Stream video to temporary file
    const response = await fetch(fileUrl);
    if (!response.body) {
      throw new Error("Failed to fetch video stream");
    }

    console.log("Streaming video to temporary file");
    updateProgress(20, "Downloading video...");
    await pipeline(response.body, createWriteStream(inputPath));

    // Get input metadata first
    updateProgress(30, "Analyzing video...");
    const metadata = await new Promise<{
      width: number;
      height: number;
      fps: number;
      duration: number;
    }>((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
          console.error("Probe error:", { error: err.message });
          reject(err);
          return;
        }
        const videoStream = metadata.streams.find(
          (s) => s.codec_type === "video",
        );
        if (!videoStream) {
          reject(new Error("No video stream found"));
          return;
        }

        const fps = (() => {
          const fpsStr = videoStream.r_frame_rate || videoStream.avg_frame_rate;
          const [num, den] = fpsStr?.split("/").map(Number) || [0, 1];
          return num / (den || 1);
        })();

        resolve({
          width: videoStream.width || 1920,
          height: videoStream.height || 1080,
          fps,
          duration: Math.round(metadata.format.duration || 0),
        });
      });
    });

    // Update document version with metadata
    await prisma.documentVersion.update({
      where: { id: documentVersionId },
      data: {
        length: metadata.duration,
      },
    });

    if (fileSize > 500 * 1024 * 1024) {
      // if file size is greater than 500MB, skip optimization
      console.log(
        `File size is ${fileSize / 1024 / 1024} MB, skipping optimization`,
      );

      // Clean up temporary directory
      await fs.rm(tempDirectory, { recursive: true });
      console.log("Temporary directory cleaned up", { tempDirectory });
      updateProgress(100, "Completed (skipped large file)");
      return {
        success: true,
        message: "File size is too large, skipping optimization",
      };
    }

    // Calculate encoding parameters
    const keyframeInterval = Math.round(metadata.fps * 2);
    const bitrate = "6000k";
    const maxBitrate = parseInt(bitrate.replace("k", "")) * 2;

    // Only scale if the video is larger than 1080p
    const scaleFilter = metadata.width > 1920 ? "-vf scale=1920:-2" : null;

    console.log("Video metadata:", {
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      fps: metadata.fps,
      duration: metadata.duration,
      willScale: !!scaleFilter,
    });

    updateProgress(40, "Processing video...");

    // Process video to temporary file first
    await new Promise<void>((resolve, reject) => {
      const ffmpegCommand = ffmpeg(inputPath)
        .inputOptions(["-y"])
        .outputOptions([
          ...(scaleFilter ? [scaleFilter] : []), // Only include scale if needed
          "-c:v libx264",
          "-profile:v high",
          "-level:v 4.1",
          "-c:a aac",
          "-ar 48000",
          "-b:a 128k",
          `-b:v ${bitrate}`,
          `-maxrate ${maxBitrate}k`,
          `-bufsize ${maxBitrate}k`,
          "-preset medium",
          `-g ${keyframeInterval}`,
          `-keyint_min ${keyframeInterval}`,
          "-sc_threshold 0",
          "-movflags +faststart",
        ])
        .output(outputPath)
        .on("progress", (progress) => {
          if (progress.percent) {
            // Convert ffmpeg progress (0-100) to our 40-80% range
            const scaledProgress = 40 + progress.percent * 0.4;
            updateProgress(
              Math.round(scaledProgress),
              `Processing: ${Math.round(progress.percent)}%`,
            );
          }
        })
        .on("start", (cmd) => {
          console.log("FFmpeg started:", {
            cmd,
            originalSize: `${metadata.width}x${metadata.height}`,
            scaling: !!scaleFilter,
            fps: metadata.fps,
            keyframeInterval,
          });
        })
        .on("error", (err, stdout, stderr) => {
          console.error("FFmpeg error:", {
            error: err.message,
            stdout,
            stderr,
          });
          reject(err);
        })
        .on("end", () => {
          console.log("FFmpeg completed");
          resolve();
        });

      ffmpegCommand.run();
    });

    updateProgress(80, "Uploading optimized video...");

    // Create read stream from output file
    const fileStream = createReadStream(outputPath);

    // Add error handling for the file stream
    fileStream.on("error", (err) => {
      console.error("Stream error:", {
        error: err.message,
        stack: err.stack,
      });
    });

    // Start the upload process using streamFileServer
    const uploadPromise = streamFileServer({
      file: {
        name: "optimized.mp4",
        type: "video/mp4",
        stream: fileStream,
      },
      teamId,
      docId,
    });

    // Wait for the upload to complete
    const { type, data } = await uploadPromise;
    console.log("Upload completed", { type, data });

    if (!data) {
      throw new Error("Upload failed: No file path returned");
    }

    updateProgress(90, "Finalizing...");

    // Update the document version with the new file and length
    await prisma.documentVersion.update({
      where: {
        id: documentVersionId,
      },
      data: {
        file: data,
      },
    });

    // Clean up temporary directory
    await fs.rm(tempDirectory, { recursive: true });
    console.log("Temporary directory cleaned up", { tempDirectory });

    updateProgress(100, "Optimization complete");

    return {
      success: true,
      message: "Successfully optimized video",
    };
  } catch (error) {
    console.error("Failed to optimize video:", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

// Register a progress callback if needed
export function setProgressCallback(
  callback: (progress: number, message: string) => void,
) {
  (optimizeVideo as any).progressCallback = callback;
}
