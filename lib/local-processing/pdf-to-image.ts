import { getFile } from "@/lib/files/get-file";
import { convertPdfPageToImage, getPdfPageCount } from "@/lib/mupdf/pdf-utils";
import prisma from "@/lib/prisma";

type ConvertPdfToImagePayload = {
  documentId: string;
  documentVersionId: string;
  teamId: string;
  versionNumber?: number;
};

/**
 * Convert PDF pages to images for document previews
 * Local replacement for the Trigger.dev task
 */
export async function convertPdfToImage(payload: ConvertPdfToImagePayload) {
  const { documentVersionId, teamId, documentId, versionNumber } = payload;
  let progressCallback:
    | ((progress: number, message: string) => void)
    | undefined;

  try {
    // Optional progress tracking function
    const updateProgress = (progress: number, text: string) => {
      console.log(`PDF to Image Progress (${progress}%): ${text}`);
      if (progressCallback) {
        progressCallback(progress, text);
      }
    };

    updateProgress(0, "Initializing...");

    // 1. get file url from document version
    const documentVersion = await prisma.documentVersion.findUnique({
      where: {
        id: documentVersionId,
      },
      select: {
        file: true,
        storageType: true,
        numPages: true,
      },
    });

    // if documentVersion is null, log error and return
    if (!documentVersion) {
      console.error("File not found", { payload });
      updateProgress(0, "Document not found");
      return;
    }

    console.log("Document version", { documentVersion });
    updateProgress(10, "Retrieving file...");

    // 2. get signed url from file
    const signedUrl = await getFile({
      type: documentVersion.storageType,
      data: documentVersion.file,
    });

    console.log("Retrieved signed url");

    if (!signedUrl) {
      console.error("Failed to get signed url", { payload });
      updateProgress(0, "Failed to retrieve document");
      return;
    }

    let numPages = documentVersion.numPages;

    // skip if the numPages are already defined
    if (!numPages || numPages === 1) {
      // 3. Call our utility function directly instead of using fetch
      console.log("Getting PDF page count");

      try {
        const numPagesResult = await getPdfPageCount(signedUrl);

        console.log("Received number of pages", { numPagesResult });

        if (numPagesResult < 1) {
          console.error("Failed to get number of pages", { payload });
          updateProgress(0, "Failed to get number of pages");
          return;
        }

        numPages = numPagesResult;
      } catch (error) {
        console.error("Error getting page count:", error);
        throw new Error("Failed to get number of pages");
      }
    }

    updateProgress(20, "Converting document...");

    // 4. Iterate through pages and process each one
    let currentPage = 0;
    let conversionWithoutError = true;
    for (var i = 0; i < numPages; ++i) {
      if (!conversionWithoutError) {
        break;
      }

      // increment currentPage
      currentPage = i + 1;
      console.log(`Converting page ${currentPage}`, {
        currentPage,
        numPages,
      });

      try {
        // Call our utility function directly instead of using fetch
        const documentPageId = await convertPdfPageToImage({
          documentVersionId,
          pageNumber: currentPage,
          url: signedUrl,
          teamId,
        });

        console.log(`Created document page for page ${currentPage}:`, {
          documentPageId,
        });
      } catch (error: unknown) {
        conversionWithoutError = false;
        if (error instanceof Error) {
          console.error("Failed to convert page", {
            error: error.message,
          });
        }
      }

      updateProgress(
        Math.round((currentPage / numPages) * 100),
        `${currentPage} / ${numPages} pages processed`,
      );
    }

    if (!conversionWithoutError) {
      console.error("Failed to process pages", { payload });
      updateProgress(
        Math.round((currentPage / numPages) * 100),
        `Error processing page ${currentPage} of ${numPages}`,
      );
      return;
    }

    // 5. after all pages are uploaded, update document version to hasPages = true
    await prisma.documentVersion.update({
      where: {
        id: documentVersionId,
      },
      data: {
        numPages: numPages,
        hasPages: true,
        isPrimary: true,
      },
    });

    console.log("Enabling pages");
    updateProgress(90, "Enabling pages...");

    if (versionNumber) {
      // after all pages are uploaded, update all other versions to be not primary
      await prisma.documentVersion.updateMany({
        where: {
          documentId: documentId,
          versionNumber: {
            not: versionNumber,
          },
        },
        data: {
          isPrimary: false,
        },
      });
    }

    console.log("Revalidating link");
    updateProgress(95, "Revalidating link...");

    // initialize link revalidation for all the document's links
    // We still need to use fetch for the revalidation endpoint
    await fetch(
      `${process.env.NEXTAUTH_URL}/api/revalidate?secret=${process.env.REVALIDATE_TOKEN}&documentId=${documentId}`,
    );

    updateProgress(100, "Processing complete");

    console.log("Processing complete");
    return {
      success: true,
      message: "Successfully converted PDF to images",
      totalPages: numPages,
    };
  } catch (error) {
    console.error("Error in PDF to image conversion:", error);
    throw error;
  }
}

// Register a progress callback if needed
export function setProgressCallback(
  callback: (progress: number, message: string) => void,
) {
  (convertPdfToImage as any).progressCallback = callback;
}
