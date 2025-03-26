import { NextApiRequest, NextApiResponse } from "next";

import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { DocumentStorageType } from "@prisma/client";
import { getServerSession } from "next-auth/next";

import { copyFileToBucketServer } from "@/lib/files/copy-file-to-bucket-server";
import { convertOfficeToPdf } from "@/lib/local-processing/convert-office-to-pdf";
import { optimizeVideo } from "@/lib/local-processing/optimize-video";
import { convertPdfToImage } from "@/lib/local-processing/pdf-to-image";
import prisma from "@/lib/prisma";
import { getTeamWithUsersAndDocument } from "@/lib/team/helper";
import { CustomUser } from "@/lib/types";
import { log } from "@/lib/utils";

export default async function handle(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method === "POST") {
    // POST /api/teams/:teamId/documents/:id/versions
    const session = await getServerSession(req, res, authOptions);
    if (!session) {
      return res.status(401).end("Unauthorized");
    }

    // get document id from query params
    const { teamId, id: documentId } = req.query as {
      teamId: string;
      id: string;
    };
    const { url, type, numPages, storageType, contentType, fileSize } =
      req.body as {
        url: string;
        type: string;
        numPages: number;
        storageType: DocumentStorageType;
        contentType: string;
        fileSize: number | undefined;
      };

    const userId = (session.user as CustomUser).id;

    try {
      const { team, document } = await getTeamWithUsersAndDocument({
        teamId,
        userId,
        docId: documentId,
        checkOwner: true,
        options: {
          select: {
            id: true,
            advancedExcelEnabled: true,
            versions: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { versionNumber: true },
            },
          },
        },
      });

      // create a new document version
      const currentVersionNumber = document?.versions
        ? document.versions[0].versionNumber
        : 1;
      const version = await prisma.documentVersion.create({
        data: {
          documentId: documentId,
          file: url,
          originalFile: url,
          type: type,
          storageType,
          numPages: document?.advancedExcelEnabled ? 1 : numPages,
          isPrimary: true,
          versionNumber: currentVersionNumber + 1,
          contentType,
          fileSize,
        },
      });

      // turn off isPrimary flag for all other versions
      await prisma.documentVersion.updateMany({
        where: {
          documentId: documentId,
          id: { not: version.id },
        },
        data: {
          isPrimary: false,
        },
      });

      // turn off isPrimary flag for all other versions
      await prisma.documentVersion.updateMany({
        where: {
          documentId: documentId,
          id: { not: version.id },
        },
        data: {
          isPrimary: false,
        },
      });

      if (type === "docs" || type === "slides") {
        // Use our local implementation instead of Trigger.dev
        convertOfficeToPdf({
          documentId: documentId,
          documentVersionId: version.id,
          teamId,
        }).catch((error) => {
          console.error("Error in Office to PDF conversion:", error);
        });
      }

      if (type === "video") {
        // Use our local implementation instead of Trigger.dev
        optimizeVideo({
          videoUrl: url,
          teamId,
          docId: url.split("/")[1], // Extract doc_xxxx from teamId/doc_xxxx/filename
          documentVersionId: version.id,
          fileSize: fileSize || 0,
        }).catch((error) => {
          console.error("Error in video optimization:", error);
        });
      }

      // skip triggering convert-pdf-to-image job for "notion" / "excel" documents
      if (type === "pdf") {
        // Use our local implementation instead of Trigger.dev
        convertPdfToImage({
          documentId: documentId,
          documentVersionId: version.id,
          teamId,
          versionNumber: version.versionNumber,
        }).catch((error) => {
          console.error("Error in PDF to image conversion:", error);
        });
      }

      if (type === "sheet" && document?.advancedExcelEnabled) {
        console.log("copying file to bucket server");
        await copyFileToBucketServer({
          filePath: version.file,
          storageType: version.storageType,
        });
      }

      res.status(200).json({ id: documentId });
    } catch (error) {
      log({
        message: `Failed to create new version for document: _${documentId}_. \n\n ${error} \n\n*Metadata*: \`{teamId: ${teamId}, userId: ${userId}}\``,
        type: "error",
      });
      return res.status(500).json({
        message: "Internal Server Error",
        error: (error as Error).message,
      });
    }
  } else {
    // We only allow GET requests
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
