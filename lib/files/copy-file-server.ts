import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { DocumentStorageType } from "@prisma/client";

import { newId } from "@/lib/id-helper";

import { getS3Client } from "./aws-client";

export const copyFileServer = async ({
  teamId,
  filePath,
  fileName,
  storageType,
}: {
  teamId: string;
  filePath: string;
  fileName: string;
  storageType: DocumentStorageType;
}) => {
  // Always use S3 copy regardless of storage type
  return copyFileInS3Server({ teamId, filePath });
};

const copyFileInS3Server = async ({
  teamId,
  filePath,
}: {
  teamId: string;
  filePath: string;
}) => {
  try {
    const s3Client = getS3Client();
    const documentId = newId("doc");
    const sourceKey = filePath;
    const destinationKey = `${teamId}/${documentId}/${sourceKey.split("/").pop()}`;

    // Copy the file
    await s3Client.send(
      new CopyObjectCommand({
        Bucket: process.env.NEXT_PRIVATE_UPLOAD_BUCKET,
        CopySource: `${process.env.NEXT_PRIVATE_UPLOAD_BUCKET}/${sourceKey}`,
        Key: destinationKey,
      }),
    );

    return {
      type: DocumentStorageType.S3_PATH,
      data: { fromLocation: sourceKey, toLocation: destinationKey },
    };
  } catch (error) {
    console.error("Error copying file in S3:", error);
    throw new Error("Failed to copy file in S3");
  }
};
