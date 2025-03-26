import fetch from "node-fetch";

import { getFile } from "@/lib/files/get-file";
import { putFileServer } from "@/lib/files/put-file-server";
import { convertPdfToImage } from "@/lib/local-processing/pdf-to-image";
import prisma from "@/lib/prisma";

type ConvertOfficeToPdfPayload = {
  documentId: string;
  documentVersionId: string;
  teamId: string;
};

/**
 * Converts Office documents (docs, slides) to PDF format
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

    // Prepare form data
    const formData = new FormData();
    formData.append(
      "downloadFrom",
      JSON.stringify([
        {
          url: fileUrl,
        },
      ]),
    );
    formData.append("quality", "75");

    updateProgress(20, "Converting document...");

    // Make the conversion request with retry logic
    let conversionResponse;
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      try {
        conversionResponse = await fetch(
          `${process.env.NEXT_PRIVATE_CONVERSION_BASE_URL}/forms/libreoffice/convert`,
          {
            method: "POST",
            body: formData,
            headers: {
              Authorization: `Basic ${process.env.NEXT_PRIVATE_INTERNAL_AUTH_TOKEN}`,
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

    const conversionBuffer = Buffer.from(
      await conversionResponse.arrayBuffer(),
    );

    console.log("Conversion successful, buffer size:", conversionBuffer.length);

    // get docId from url with starts with "doc_" with regex
    const match = document.versions[0].originalFile.match(/(doc_[^\/]+)\//);
    const docId = match ? match[1] : undefined;

    updateProgress(30, "Saving converted file...");

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

    updateProgress(40, "Generating page previews...");

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
      message: "Successfully converted Office document to PDF",
    };
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
