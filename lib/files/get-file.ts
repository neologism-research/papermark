import { DocumentStorageType } from "@prisma/client";

export type GetFileOptions = {
  type: DocumentStorageType;
  data: string;
  isDownload?: boolean;
};

export const getFile = async ({
  type,
  data,
  isDownload = false,
}: GetFileOptions): Promise<string> => {
  // Always use S3 URL generation regardless of storage type
  return getFileFromS3(data);
};

// Function to generate a URL for an S3 object
async function getFileFromS3(key: string): Promise<string> {
  // Fallback to the original presigned URL implementation
  // which is more reliable than direct CloudFront URLs
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_BASE_URL}/api/file/s3/get-presigned-get-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key: key }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to get presigned get url, failed with status code ${response.status}`,
    );
  }

  const { url } = (await response.json()) as { url: string };

  return url;
}
