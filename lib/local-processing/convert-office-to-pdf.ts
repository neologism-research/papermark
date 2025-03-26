import fs from "fs/promises";
// Import libreoffice-convert
import libre from "libreoffice-convert";
import os from "os";
import path from "path";
import { promisify } from "util";

import { getFile } from "@/lib/files/get-file";
import { putFileServer } from "@/lib/files/put-file-server";
import { convertPdfToImage } from "@/lib/local-processing/pdf-to-image";
import prisma from "@/lib/prisma";

const libreConvertAsync = promisify(libre.convert);

type ConvertOfficeToPdfPayload = {
  documentId: string;
  documentVersionId: string;
  teamId: string;
};

/**
 * Converts Office documents (docs, slides) to PDF format using libreoffice-convert
 * Local replacement for the Trigger.dev task
 */
export async function convertOfficeToPdf(payload: ConvertOfficeToPdfPayload) {
  const { documentId, documentVersionId, teamId } = payload;
  let progressCallback:
    | ((progress: number, message: string) => void)
    | undefined;

  try {
    // Optional progress tracking function
    const updateProgress = (progress: number, text: string) => {
      console.log(`Office to PDF Progress (${progress}%): ${text}`);
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

    // Create temp directory for input file
    const tempDir = path.join(os.tmpdir(), `office_conversion_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Download the file
    updateProgress(20, "Downloading file...");
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }

    const fileBuffer = Buffer.from(await response.arrayBuffer());
    const inputPath = path.join(tempDir, path.basename(document.name));
    await fs.writeFile(inputPath, fileBuffer);

    updateProgress(30, "Converting document...");

    // Convert the document to PDF using libreoffice-convert
    try {
      // Setting PDF format as output
      const pdfBuffer = await libreConvertAsync(fileBuffer, ".pdf", undefined);

      console.log(`Conversion successful, buffer size: ${pdfBuffer.length}`);
      updateProgress(70, "Conversion complete, saving result...");

      // get docId from url with starts with "doc_" with regex
      const match = document.versions[0].originalFile.match(/(doc_[^\/]+)\//);
      const docId = match ? match[1] : undefined;

      // Save the converted file to the server
      const { type: storageType, data } = await putFileServer({
        file: {
          name: `${document.name.replace(/\.[^.]+$/, "")}.pdf`,
          type: "application/pdf",
          buffer: pdfBuffer,
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

      const { versionNumber } = await prisma.documentVersion.update({
        where: { id: documentVersionId },
        data: {
          file: data,
          type: "pdf",
          storageType: storageType,
        },
        select: {
          versionNumber: true,
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

      // Clean up temporary directory
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        console.error("Failed to clean up temporary directory:", error);
      }

      updateProgress(100, "Conversion complete");

      return {
        success: true,
        message: "Successfully converted Office document to PDF",
      };
    } catch (error) {
      console.error("Conversion error:", error);
      updateProgress(0, "Conversion failed");
      throw new Error(
        `Document conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } catch (error) {
    console.error("Failed to convert Office document:", {
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
  (convertOfficeToPdf as any).progressCallback = callback;
}
