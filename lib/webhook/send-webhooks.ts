import { Webhook } from "@prisma/client";
import fetch from "node-fetch";
import { z } from "zod";

import { limiter } from "@/lib/cron";
import { webhookPayloadSchema } from "@/lib/zod/schemas/webhooks";

import { createWebhookSignature } from "./signature";
import { prepareWebhookPayload } from "./transform";
import { EventDataProps, WebhookTrigger } from "./types";

// Send webhooks to multiple webhooks
export const sendWebhooks = async ({
  webhooks,
  trigger,
  data,
}: {
  webhooks: Pick<Webhook, "pId" | "url" | "secret">[];
  trigger: WebhookTrigger;
  data: EventDataProps;
}) => {
  if (webhooks.length === 0) {
    return;
  }

  const payload = prepareWebhookPayload(trigger, data);

  return await Promise.all(
    webhooks.map((webhook) => sendWebhookDirectly({ webhook, payload })),
  );
};

// Send webhook event directly using fetch
const sendWebhookDirectly = async ({
  webhook,
  payload,
}: {
  webhook: Pick<Webhook, "pId" | "url" | "secret">;
  payload: z.infer<typeof webhookPayloadSchema>;
}) => {
  const signature = await createWebhookSignature(webhook.secret, payload);

  try {
    // Use the bottleneck limiter to avoid rate limiting
    const response = await limiter.schedule(() =>
      fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Papermark-Signature": signature,
        },
        body: JSON.stringify(payload),
      }),
    );

    return {
      success: response.ok,
      status: response.status,
      url: webhook.url,
    };
  } catch (error) {
    console.error(`Failed to send webhook to ${webhook.url}:`, error);
    return {
      success: false,
      error: (error as Error).message,
      url: webhook.url,
    };
  }
};
