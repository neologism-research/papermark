import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { DocumentStorageType } from "@prisma/client";

import { getS3Client } from "./aws-client";

export type DeleteFileOptions = {
  type: DocumentStorageType;
  data: string; // url for vercel, folderpath for s3
};

export const deleteFileServer = async ({ type, data }: DeleteFileOptions) => {
  // Always use S3 deletion regardless of the storage type
  return deleteFileFromS3({ data });
};

const deleteFileFromS3 = async ({ data }: { data: string }) => {
  if (!data) return false;

  try {
    const prefix = data; // The prefix for the S3 keys to delete (typically a folder path)
    const s3Client = getS3Client();

    // List all objects with the given prefix
    const listCommand = new ListObjectsV2Command({
      Bucket: process.env.NEXT_PRIVATE_UPLOAD_BUCKET,
      Prefix: prefix,
    });

    const listedObjects = await s3Client.send(listCommand);

    if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
      return false;
    }

    // Prepare objects to delete
    const deleteParams = {
      Bucket: process.env.NEXT_PRIVATE_UPLOAD_BUCKET,
      Delete: {
        Objects: listedObjects.Contents.map(({ Key }) => ({ Key })),
        Quiet: false,
      },
    };

    // Delete the objects
    await s3Client.send(new DeleteObjectsCommand(deleteParams));

    return true;
  } catch (error) {
    console.error("Error deleting file from S3:", error);
    return false;
  }
};
