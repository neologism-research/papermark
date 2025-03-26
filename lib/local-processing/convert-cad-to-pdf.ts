import fetch from "node-fetch";

import { getFile } from "@/lib/files/get-file";
import { putFileServer } from "@/lib/files/put-file-server";
import { convertPdfToImage } from "@/lib/local-processing/pdf-to-image";
import prisma from "@/lib/prisma";
import { getExtensionFromContentType } from "@/lib/utils/get-content-type";

type ConvertCadToPdfPayload = {
  documentId: string;
  documentVersionId: string;
  teamId: string;
};

/**
 * Converts CAD files to PDF format
 * Local replacement for the Trigger.dev task
 */
export async function convertCadToPdf(payload: ConvertCadToPdfPayload) {
  const { documentId, documentVersionId, teamId } = payload;
  let progressCallback:
    | ((progress: number, message: string) => void)
    | undefined;

  try {
    // Optional progress tracking function
    const updateProgress = (progress: number, text: string) => {
      console.log(`CAD to PDF Progress (${progress}%): ${text}`);
      if (progressCallback) {
        progressCallback(progress, text);
      }
    };

    updateProgress(0, "Initializing...");

    const team = await prisma.team.findUnique({
      where: {
        id: teamId,
      },
    });

    if (!team) {
      console.error("Team not found", { teamId });
      updateProgress(0, "Team not found");
      return;
    }

    const document = await prisma.document.findUnique({
      where: {
        id: documentId,
      },
      select: {
        name: true,
        versions: {
          where: {
            id: documentVersionId,
          },
          select: {
            file: true,
            originalFile: true,
            contentType: true,
            storageType: true,
          },
        },
      },
    });

    if (
      !document ||
      !document.versions[0] ||
      !document.versions[0].originalFile ||
      !document.versions[0].contentType
    ) {
      console.error("Document not found", {
        documentId,
        documentVersionId,
        teamId,
      });
      updateProgress(0, "Document not found");
      return;
    }

    updateProgress(10, "Retrieving file...");

    const fileUrl = await getFile({
      data: document.versions[0].originalFile,
      type: document.versions[0].storageType,
    });

    // create payload for cad to pdf conversion
    const tasksPayload = {
      tasks: {
        "import-file-v1": {
          operation: "import/url",
          url: fileUrl,
          filename: document.name,
        },
        "convert-file-v1": {
          operation: "convert",
          input: ["import-file-v1"],
          input_format: getExtensionFromContentType(
            document.versions[0].contentType,
          ),
          output_format: "pdf",
          engine: "cadconverter",
          all_layouts: true,
          auto_zoom: false,
        },
        "export-file-v1": {
          operation: "export/url",
          input: ["convert-file-v1"],
          inline: false,
          archive_multiple_files: false,
        },
      },
      redirect: true,
    };

    updateProgress(20, "Converting document...");

    // Make the conversion request with retry logic
    let conversionResponse;
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      try {
        conversionResponse = await fetch(
          `${process.env.NEXT_PRIVATE_CONVERT_API_URL}`,
          {
            method: "POST",
            body: JSON.stringify(tasksPayload),
            headers: {
              Authorization: `Bearer ${process.env.NEXT_PRIVATE_CONVERT_API_KEY}`,
              "Content-Type": "application/json",
            },
          },
        );

        if (conversionResponse.ok) {
          break;
        }

        // If status is 5xx, retry
        if (
          conversionResponse.status >= 500 &&
          conversionResponse.status < 600
        ) {
          retryCount++;
          const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
          console.log(
            `Retrying conversion after ${delay}ms (attempt ${retryCount}/${maxRetries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          // For non-5xx errors, don't retry
          break;
        }
      } catch (error) {
        retryCount++;
        if (retryCount >= maxRetries) {
          throw error;
        }
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
        console.log(
          `Network error, retrying after ${delay}ms (attempt ${retryCount}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (!conversionResponse || !conversionResponse.ok) {
      const body = conversionResponse
        ? ((await conversionResponse.json()) as { message?: string })
        : { message: "Network error" };
      const message = `Conversion failed: ${body.message || "Unknown error"} ${conversionResponse?.status || "unknown status"}`;
      console.error(message);
      updateProgress(0, "Conversion failed");
      throw new Error(message);
    }

    updateProgress(40, "Processing converted document...");

    const conversionBuffer = Buffer.from(
      await conversionResponse.arrayBuffer(),
    );

    // get docId from url with starts with "doc_" with regex
    const match = document.versions[0].originalFile.match(/(doc_[^\/]+)\//);
    const docId = match ? match[1] : undefined;

    updateProgress(60, "Saving document...");

    // Save the converted file to the database
    const { type: storageType, data } = await putFileServer({
      file: {
        name: `${document.name}.pdf`,
        type: "application/pdf",
        buffer: conversionBuffer,
      },
      teamId: teamId,
      docId: docId,
    });

    if (!data || !storageType) {
      console.error("Failed to save converted file to database", {
        documentId,
        documentVersionId,
        teamId,
        docId,
      });
      updateProgress(0, "Failed to save converted file");
      return;
    }

    console.log("data from conversion", data);
    console.log("storageType from conversion", storageType);

    await prisma.documentVersion.update({
      where: { id: documentVersionId },
      data: {
        file: data,
        type: "pdf",
        storageType: storageType,
      },
    });

    updateProgress(80, "Generating page previews...");

    // Process the PDF to generate page previews
    try {
      await convertPdfToImage({
        documentId: documentId,
        documentVersionId: documentVersionId,
        teamId: teamId,
      });
      console.log("PDF to image conversion completed successfully");
    } catch (error) {
      console.error("Error converting PDF to images:", error);
      // Continue despite error in PDF to image conversion
    }

    updateProgress(100, "Conversion complete");

    console.log("Document converted", {
      documentId,
      documentVersionId,
      teamId,
      docId,
    });

    return {
      success: true,
      message: "Successfully converted CAD file to PDF",
    };
  } catch (error) {
    console.error("Failed to convert CAD file:", {
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
  (convertCadToPdf as any).progressCallback = callback;
}
