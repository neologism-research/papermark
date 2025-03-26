import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

import { getS3Client } from "./aws-client";

export type DeleteFilesOptions = {
  teamId: string;
};

export const deleteTeamFilesServer = async ({ teamId }: DeleteFilesOptions) => {
  return deleteTeamFilesFromS3Server(teamId);
};

const deleteTeamFilesFromS3Server = async (teamId: string) => {
  try {
    const s3Client = getS3Client();

    // List all objects with the given team prefix
    const listCommand = new ListObjectsV2Command({
      Bucket: process.env.NEXT_PRIVATE_UPLOAD_BUCKET,
      Prefix: `${teamId}/`,
    });

    const listedObjects = await s3Client.send(listCommand);

    if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
      return true;
    }

    // Prepare objects to delete - We can only delete 1000 at a time
    const chunks = [];
    for (let i = 0; i < listedObjects.Contents.length; i += 1000) {
      chunks.push(listedObjects.Contents.slice(i, i + 1000));
    }

    // Delete all chunks
    for (const chunk of chunks) {
      const deleteParams = {
        Bucket: process.env.NEXT_PRIVATE_UPLOAD_BUCKET,
        Delete: {
          Objects: chunk.map(({ Key }) => ({ Key })),
          Quiet: false,
        },
      };

      await s3Client.send(new DeleteObjectsCommand(deleteParams));
    }

    // If there are more files (truncated), recursively call this function
    if (listedObjects.IsTruncated) {
      await deleteTeamFilesFromS3Server(teamId);
    }

    return true;
  } catch (error) {
    console.error("Error deleting team files from S3:", error);
    return false;
  }
};
