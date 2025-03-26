import { DocumentPage } from "@prisma/client";
import * as mupdf from "mupdf";

import { putFileServer } from "@/lib/files/put-file-server";
import prisma from "@/lib/prisma";
import { log } from "@/lib/utils";

/**
 * Get the number of pages in a PDF from a URL
 * @param url URL to the PDF file
 * @returns Number of pages
 */
export async function getPdfPageCount(url: string): Promise<number> {
  try {
    // Fetch the PDF data
    const response = await fetch(url);

    // Convert the response to an ArrayBuffer
    const pdfData = await response.arrayBuffer();

    // Create a MuPDF instance
    const doc = new mupdf.PDFDocument(pdfData);

    // Count pages
    const pageCount = doc.countPages();

    // Clean up
    doc.destroy();

    return pageCount;
  } catch (error) {
    console.error("Error getting PDF page count:", error);
    throw error;
  }
}

/**
 * Convert a specific PDF page to an image and save it
 * @param params Parameters for page conversion
 * @returns ID of the created document page
 */
export async function convertPdfPageToImage({
  documentVersionId,
  pageNumber,
  url,
  teamId,
}: {
  documentVersionId: string;
  pageNumber: number;
  url: string;
  teamId: string;
}): Promise<string> {
  try {
    // Fetch the PDF data
    const response = await fetch(url);

    // Convert the response to an ArrayBuffer
    const pdfData = await response.arrayBuffer();

    // Create a MuPDF instance
    const doc = new mupdf.PDFDocument(pdfData);
    console.log("Original document size:", pdfData.byteLength);

    const page = doc.loadPage(pageNumber - 1); // 0-based page index

    // Get the bounds of the page for orientation and scaling
    const bounds = page.getBounds();
    const [ulx, uly, lrx, lry] = bounds;
    const widthInPoints = Math.abs(lrx - ulx);
    const heightInPoints = Math.abs(lry - uly);

    if (pageNumber === 1) {
      // Get the orientation of the document and update document version
      const isVertical = heightInPoints > widthInPoints;

      await prisma.documentVersion.update({
        where: { id: documentVersionId },
        data: { isVertical },
      });
    }

    // Scale the document to 144 DPI
    const scaleFactor = widthInPoints >= 1600 ? 2 : 3; // 2x for width >= 1600, 3x for width < 1600
    const doc_to_screen = mupdf.Matrix.scale(scaleFactor, scaleFactor);

    console.log("Scale factor:", scaleFactor);

    // Get links
    const links = page.getLinks();
    const embeddedLinks = links.map((link) => {
      return { href: link.getURI(), coords: link.getBounds().join(",") };
    });

    const metadata = {
      originalWidth: widthInPoints,
      originalHeight: heightInPoints,
      width: widthInPoints * scaleFactor,
      height: heightInPoints * scaleFactor,
      scaleFactor: scaleFactor,
    };

    // Create pixmap
    let scaledPixmap = page.toPixmap(
      doc_to_screen,
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    );

    // Generate both PNG and JPEG and choose the smaller one
    const pngBuffer = scaledPixmap.asPNG();
    const jpegBuffer = scaledPixmap.asJPEG(80, false);

    const pngSize = pngBuffer.byteLength;
    const jpegSize = jpegBuffer.byteLength;

    let chosenBuffer;
    let chosenFormat;
    if (pngSize < jpegSize) {
      chosenBuffer = pngBuffer;
      chosenFormat = "png";
    } else {
      chosenBuffer = jpegBuffer;
      chosenFormat = "jpeg";
    }

    console.log("Chosen format:", chosenFormat);

    let buffer = Buffer.from(chosenBuffer);

    // Get docId from url with starts with "doc_" with regex
    const match = url.match(/(doc_[^\/]+)\//);
    const docId = match ? match[1] : undefined;

    // Save the image
    const { type, data } = await putFileServer({
      file: {
        name: `page-${pageNumber}.${chosenFormat}`,
        type: `image/${chosenFormat}`,
        buffer: buffer,
      },
      teamId: teamId,
      docId: docId,
    });

    // Free memory
    buffer = Buffer.alloc(0);
    chosenBuffer = Buffer.alloc(0);
    scaledPixmap.destroy();
    page.destroy();
    doc.destroy();

    if (!data || !type) {
      throw new Error(`Failed to upload document page ${pageNumber}`);
    }

    let documentPage: DocumentPage | null = null;

    // Check if a documentPage with the same pageNumber and versionId already exists
    const existingPage = await prisma.documentPage.findUnique({
      where: {
        pageNumber_versionId: {
          pageNumber: pageNumber,
          versionId: documentVersionId,
        },
      },
    });

    if (!existingPage) {
      // Only create a new documentPage if it doesn't already exist
      documentPage = await prisma.documentPage.create({
        data: {
          versionId: documentVersionId,
          pageNumber: pageNumber,
          file: data,
          storageType: type,
          pageLinks: embeddedLinks,
          metadata: metadata,
        },
      });
    } else {
      documentPage = existingPage;
    }

    return documentPage.id;
  } catch (error) {
    log({
      message: `Failed to convert page with error: \n\n Error: ${error} \n\n \`Metadata: {teamId: ${teamId}, documentVersionId: ${documentVersionId}, pageNumber: ${pageNumber}}\``,
      type: "error",
      mention: true,
    });
    throw error;
  }
}
