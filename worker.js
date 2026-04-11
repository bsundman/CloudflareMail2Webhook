const DEFAULT_WEBHOOK_TIMEOUT_MS = 10000;
const DEFAULT_RETRY_DELAY_SECONDS = 840;
const MAX_R2_METADATA_VALUE_LENGTH = 1024;

function getAddressDomain(address) {
  const atIndex = address.lastIndexOf("@");
  return atIndex === -1 ? "" : address.slice(atIndex + 1).toLowerCase();
}

function getAddressLocalPart(address) {
  const atIndex = address.lastIndexOf("@");
  return atIndex === -1 ? address : address.slice(0, atIndex);
}

function getWebhookTimeoutMs(env) {
  const parsed = Number.parseInt(env.WEBHOOK_TIMEOUT_MS ?? String(DEFAULT_WEBHOOK_TIMEOUT_MS), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEBHOOK_TIMEOUT_MS;
}

function getRetryDelaySeconds(env) {
  const parsed = Number.parseInt(env.WEBHOOK_RETRY_DELAY_SECONDS ?? String(DEFAULT_RETRY_DELAY_SECONDS), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETRY_DELAY_SECONDS;
}

function setOptionalHeader(headers, name, value) {
  if (value !== null && value !== undefined && value !== "") {
    headers.set(name, value);
  }
}

function setOptionalMetadata(metadata, name, value) {
  if (value !== null && value !== undefined && value !== "") {
    metadata[name] = String(value).slice(0, MAX_R2_METADATA_VALUE_LENGTH);
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildStorageKey(metadata) {
  const stableKeySource =
    metadata.messageId ?
      `${metadata.messageId}\n${metadata.from}\n${metadata.to}` :
      metadata.eventId;
  const fingerprint = await sha256Hex(stableKeySource);
  const datePath = metadata.timestamp.slice(0, 10).replace(/-/g, "/");
  const recipientDomain = metadata.recipientDomain || "unknown-domain";

  return `incoming/${datePath}/${recipientDomain}/${fingerprint}.eml`;
}

function ensureBindings(env) {
  if (!env.WEBHOOK_SECRET) {
    throw new Error("Missing WEBHOOK_SECRET in Cloudflare Variables");
  }
  if (!env.WEBHOOK_URL) {
    throw new Error("Missing WEBHOOK_URL in Cloudflare Variables");
  }
  if (!env.MAIL_R2 || typeof env.MAIL_R2.put !== "function") {
    throw new Error("Missing MAIL_R2 R2 binding");
  }
  if (!env.MAIL_RETRY_QUEUE || typeof env.MAIL_RETRY_QUEUE.send !== "function") {
    throw new Error("Missing MAIL_RETRY_QUEUE queue binding");
  }
}

function buildEnvelopeMetadata(message, eventId, timestamp) {
  const recipientDomain = getAddressDomain(message.to);
  const recipientLocalPart = getAddressLocalPart(message.to);

  return {
    source: "cloudflare-worker",
    eventId,
    timestamp,
    from: message.from,
    to: message.to,
    recipientDomain,
    recipientLocalPart,
    messageId: message.headers.get("message-id"),
    subject: message.headers.get("subject"),
    rawSize: message.rawSize,
  };
}

function buildR2CustomMetadata(metadata) {
  const customMetadata = {};

  setOptionalMetadata(customMetadata, "eventId", metadata.eventId);
  setOptionalMetadata(customMetadata, "source", metadata.source);
  setOptionalMetadata(customMetadata, "from", metadata.from);
  setOptionalMetadata(customMetadata, "to", metadata.to);
  setOptionalMetadata(customMetadata, "recipientDomain", metadata.recipientDomain);
  setOptionalMetadata(customMetadata, "recipientLocalPart", metadata.recipientLocalPart);
  setOptionalMetadata(customMetadata, "messageId", metadata.messageId);
  setOptionalMetadata(customMetadata, "timestamp", metadata.timestamp);

  return customMetadata;
}

function buildWebhookHeaders(env, metadata, deliveryMode, queueAttempt = null) {
  const headers = new Headers({
    "Content-Type": "message/rfc822",
    "User-Agent": "Cloudflare-Email-Relay",
    "X-Webhook-Secret": env.WEBHOOK_SECRET,
    "X-Email-Source": metadata.source,
    "X-Email-Event-Id": metadata.eventId,
    "X-Email-Timestamp": metadata.timestamp,
    "X-Envelope-From": metadata.from,
    "X-Envelope-To": metadata.to,
    "X-Recipient-Domain": metadata.recipientDomain,
    "X-Recipient-Local-Part": metadata.recipientLocalPart,
    "X-Email-Raw-Size": String(metadata.rawSize),
    "X-Delivery-Mode": deliveryMode,
  });

  setOptionalHeader(headers, "X-Email-Message-Id", metadata.messageId);
  setOptionalHeader(headers, "X-Email-Storage-Key", metadata.storageKey);
  setOptionalHeader(headers, "X-Queue-Attempt", queueAttempt);
  setOptionalHeader(headers, "CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
  setOptionalHeader(headers, "CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);

  return headers;
}

async function deliverToWebhook(env, metadata, body, deliveryMode, queueAttempt = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("Webhook timeout"), getWebhookTimeoutMs(env));

  try {
    const response = await fetch(env.WEBHOOK_URL, {
      method: "POST",
      headers: buildWebhookHeaders(env, metadata, deliveryMode, queueAttempt),
      body,
      signal: controller.signal,
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      throw new Error(`Upstream redirected with ${response.status}${location ? ` to ${location}` : ""}`);
    }

    if (!response.ok) {
      const upstreamBody = (await response.text()).slice(0, 500);
      throw new Error(`Upstream returned ${response.status}: ${upstreamBody}`);
    }

    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getStoredMessageBody(env, metadata) {
  const storedMessage = await env.MAIL_R2.get(metadata.storageKey);

  if (!storedMessage) {
    throw new Error(`Stored message not found for ${metadata.storageKey}`);
  }

  const body = await storedMessage.arrayBuffer();

  if (!body.byteLength) {
    throw new Error(`Stored message body is empty for ${metadata.storageKey}`);
  }

  return body;
}

async function enqueueRetry(env, metadata, delaySeconds) {
  await env.MAIL_RETRY_QUEUE.send(
    {
      version: 1,
      source: metadata.source,
      eventId: metadata.eventId,
      timestamp: metadata.timestamp,
      from: metadata.from,
      to: metadata.to,
      recipientDomain: metadata.recipientDomain,
      recipientLocalPart: metadata.recipientLocalPart,
      messageId: metadata.messageId,
      rawSize: metadata.rawSize,
      storageKey: metadata.storageKey,
    },
    {
      contentType: "json",
      delaySeconds,
    }
  );
}

function scheduleDelete(ctx, env, metadata, reason) {
  ctx.waitUntil(
    env.MAIL_R2.delete(metadata.storageKey).catch((error) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "mail_r2_delete_failed",
          reason,
          eventId: metadata.eventId,
          storageKey: metadata.storageKey,
          error: describeError(error),
        })
      );
    })
  );
}

function logInfo(event, fields) {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

function logWarn(event, fields) {
  console.warn(JSON.stringify({ level: "warn", event, ...fields }));
}

function logError(event, fields) {
  console.error(JSON.stringify({ level: "error", event, ...fields }));
}

export default {
  async email(message, env, ctx) {
    const eventId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const metadata = buildEnvelopeMetadata(message, eventId, timestamp);

    try {
      ensureBindings(env);

      metadata.storageKey = await buildStorageKey(metadata);

      logInfo("mail_received", {
        eventId,
        from: metadata.from,
        to: metadata.to,
        recipientDomain: metadata.recipientDomain,
        rawSize: metadata.rawSize,
        messageId: metadata.messageId,
        storageKey: metadata.storageKey,
      });

      await env.MAIL_R2.put(metadata.storageKey, message.raw, {
        httpMetadata: {
          contentType: "message/rfc822",
        },
        customMetadata: buildR2CustomMetadata(metadata),
      });

      logInfo("mail_stored", {
        eventId,
        storageKey: metadata.storageKey,
        recipientDomain: metadata.recipientDomain,
      });

      try {
        const directBody = await getStoredMessageBody(env, metadata);
        const response = await deliverToWebhook(env, metadata, directBody, "direct");

        scheduleDelete(ctx, env, metadata, "direct_delivery");

        logInfo("mail_relay_success", {
          deliveryMode: "direct",
          eventId,
          to: metadata.to,
          recipientDomain: metadata.recipientDomain,
          responseUrl: response.url,
          status: response.status,
        });

        return;
      } catch (directError) {
        const retryDelaySeconds = getRetryDelaySeconds(env);

        logWarn("mail_relay_deferred", {
          deliveryMode: "direct",
          eventId,
          to: metadata.to,
          recipientDomain: metadata.recipientDomain,
          retryDelaySeconds,
          error: describeError(directError),
        });

        try {
          await enqueueRetry(env, metadata, retryDelaySeconds);

          logInfo("mail_retry_enqueued", {
            eventId,
            storageKey: metadata.storageKey,
            recipientDomain: metadata.recipientDomain,
            retryDelaySeconds,
          });

          return;
        } catch (queueError) {
          throw new Error(
            `Direct delivery failed (${describeError(directError)}), and queue fallback failed (${describeError(queueError)})`
          );
        }
      }
    } catch (error) {
      logError("mail_relay_failure", {
        eventId,
        from: metadata.from,
        to: metadata.to,
        recipientDomain: metadata.recipientDomain,
        rawSize: metadata.rawSize,
        messageId: metadata.messageId,
        subject: metadata.subject,
        storageKey: metadata.storageKey || null,
        error: describeError(error),
      });

      throw error;
    }
  },

  async queue(batch, env, ctx) {
    ensureBindings(env);

    for (const message of batch.messages) {
      const metadata = message.body;

      try {
        const queuedBody = await getStoredMessageBody(env, metadata);
        const response = await deliverToWebhook(
          env,
          metadata,
          queuedBody,
          "queue",
          message.attempts
        );

        scheduleDelete(ctx, env, metadata, "queue_delivery");
        message.ack();

        logInfo("mail_relay_success", {
          deliveryMode: "queue",
          eventId: metadata.eventId || message.id,
          to: metadata.to,
          recipientDomain: metadata.recipientDomain,
          queueAttempt: message.attempts,
          responseUrl: response.url,
          status: response.status,
        });
      } catch (error) {
        logError("queue_delivery_failed", {
          eventId: metadata.eventId || message.id,
          to: metadata.to,
          recipientDomain: metadata.recipientDomain,
          storageKey: metadata.storageKey,
          queueAttempt: message.attempts,
          retryDelaySeconds: getRetryDelaySeconds(env),
          error: describeError(error),
        });

        message.retry({ delaySeconds: getRetryDelaySeconds(env) });
      }
    }
  },
};
