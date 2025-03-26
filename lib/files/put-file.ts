import { DocumentStorageType } from "@prisma/client";

import { newId } from "@/lib/id-helper";
import { getPagesCount } from "@/lib/utils/get-page-number-count";

import { SUPPORTED_DOCUMENT_MIME_TYPES } from "../constants";

export const putFile = async ({
  file,
  teamId,
  docId,
}: {
  file: File;
  teamId: string;
  docId?: string;
}): Promise<{
  type: DocumentStorageType | null;
  data: string | null;
  numPages: number | undefined;
  fileSize: number | undefined;
}> => {
  // Always use S3 regardless of environment setting
  return putFileInS3({ file, teamId, docId });
};

const putFileInS3 = async ({
  file,
  teamId,
  docId,
}: {
  file: File;
  teamId: string;
  docId?: string;
}) => {
  if (!docId) {
    docId = newId("doc");
  }

  if (
    !SUPPORTED_DOCUMENT_MIME_TYPES.includes(file.type) &&
    !file.name.endsWith(".dwg") &&
    !file.name.endsWith(".dxf") &&
    !file.name.endsWith(".xlsm")
  ) {
    throw new Error(
      "Only PDF, Powerpoint, Word, and Excel, ZIP files are supported",
    );
  }

  const presignedResponse = await fetch(
    `${process.env.NEXT_PUBLIC_BASE_URL}/api/file/s3/get-presigned-post-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileName: file.name,
        contentType: file.type,
        teamId: teamId,
        docId: docId,
      }),
    },
  );

  if (!presignedResponse.ok) {
    throw new Error(
      `Failed to get presigned post url, failed with status code ${presignedResponse.status}`,
    );
  }

  const { url, key, fileName } = (await presignedResponse.json()) as {
    url: string;
    key: string;
    fileName: string;
  };

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": file.type,
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
    body: file,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to upload file "${file.name}", failed with status code ${response.status}`,
    );
  }

  let numPages: number = 1;
  // get page count for pdf files
  if (file.type === "application/pdf") {
    const body = await file.arrayBuffer();
    numPages = await getPagesCount(body);
  }
  // get sheet count for excel files
  // else if (
  //   SUPPORTED_DOCUMENT_MIME_TYPES.includes(file.type) &&
  //   file.type !== "application/pdf"
  // ) {
  //   const body = await file.arrayBuffer();
  //   numPages = getSheetsCount(body);
  // }

  return {
    type: DocumentStorageType.S3_PATH,
    data: key,
    numPages: numPages,
    fileSize: file.size,
  };
};
