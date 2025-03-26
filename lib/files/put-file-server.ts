import { PutObjectCommand } from "@aws-sdk/client-s3";
import { DocumentStorageType } from "@prisma/client";
import slugify from "@sindresorhus/slugify";
import path from "node:path";

import { newId } from "@/lib/id-helper";

import { getS3Client } from "./aws-client";

// `File` is a web API type and not available server-side, so we need to define our own type
type File = {
  name: string;
  type: string;
  buffer: Buffer;
};

export const putFileServer = async ({
  file,
  teamId,
  docId,
  restricted = true,
}: {
  file: File;
  teamId: string;
  docId?: string;
  restricted?: boolean;
}) => {
  // Always use S3 regardless of environment setting
  return putFileInS3Server({ file, teamId, docId, restricted });
};

const putFileInS3Server = async ({
  file,
  teamId,
  docId,
  restricted = true,
}: {
  file: File;
  teamId: string;
  docId?: string;
  restricted?: boolean;
}) => {
  const s3Client = getS3Client();
  const documentId = docId ?? newId("doc");
  const { name, ext } = path.parse(file.name);

  const key = `${teamId}/${documentId}/${slugify(name)}${ext}`;
  const uploadParams = {
    Bucket: process.env.NEXT_PRIVATE_UPLOAD_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.type,
  };

  try {
    await s3Client.send(new PutObjectCommand(uploadParams));

    return {
      type: DocumentStorageType.S3_PATH,
      data: key,
    };
  } catch (err) {
    console.error("Error uploading file to S3:", err);
    throw err;
  }
};
