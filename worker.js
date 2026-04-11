const DEFAULT_WEBHOOK_TIMEOUT_MS = 10000;
const DEFAULT_RETRY_DELAY_SECONDS = 840;
const ENCRYPTION_ALGORITHM = "AES-GCM";
const ENCRYPTED_BLOB_MAGIC = new Uint8Array([67, 70, 69, 77]); // "CFEM"
const ENCRYPTED_BLOB_VERSION = 1;
const ENCRYPTED_PAYLOAD_VERSION = 1;
const GCM_IV_LENGTH = 12;
const ENCRYPTED_BLOB_HEADER_FIXED_LENGTH = 7;
const textEncoder = new TextEncoder();

let cachedEncryptionKeySecret = null;
let cachedEncryptionKeyPromise = null;

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
    headers.set(name, String(value));
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function base64ToBytes(base64) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function concatByteArrays(parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }

  return result;
}

async function sha256Hex(value) {
  const data = textEncoder.encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildStorageKey(metadata) {
  const stableKeySource =
    metadata.messageId ?
      `${metadata.messageId}\n${metadata.from}\n${metadata.to}` :
      metadata.eventId;
  const fingerprint = await sha256Hex(stableKeySource);

  return `incoming/${fingerprint}.cfem`;
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
  if (!env.EMAIL_ENCRYPTION_KEY) {
    throw new Error("Missing EMAIL_ENCRYPTION_KEY secret");
  }
}

function buildEnvelopeMetadata(message, eventId, timestamp) {
  return {
    source: "cloudflare-worker",
    eventId,
    timestamp,
    from: message.from,
    to: message.to,
    recipientDomain: getAddressDomain(message.to),
    recipientLocalPart: getAddressLocalPart(message.to),
    messageId: message.headers.get("message-id"),
    rawSize: message.rawSize,
  };
}

function getEncryptionKeyId(env) {
  return env.EMAIL_ENCRYPTION_KEY_ID || "v1";
}

function buildEncryptedPayloadMetadata(metadata) {
  return {
    version: ENCRYPTED_PAYLOAD_VERSION,
    source: metadata.source,
    eventId: metadata.eventId,
    timestamp: metadata.timestamp,
    envelope: {
      from: metadata.from,
      to: metadata.to,
    },
    routing: {
      recipientDomain: metadata.recipientDomain,
      recipientLocalPart: metadata.recipientLocalPart,
    },
    headers: {
      messageId: metadata.messageId || null,
    },
    rawSize: metadata.rawSize ?? null,
  };
}

function buildEncryptedBlobPrelude(keyId, iv) {
  const keyIdBytes = textEncoder.encode(keyId);

  if (keyIdBytes.byteLength > 255) {
    throw new Error("EMAIL_ENCRYPTION_KEY_ID must be 255 bytes or fewer");
  }

  if (iv.byteLength > 255) {
    throw new Error("Encryption IV must be 255 bytes or fewer");
  }

  const prelude = new Uint8Array(
    ENCRYPTED_BLOB_HEADER_FIXED_LENGTH + keyIdBytes.byteLength + iv.byteLength
  );

  prelude.set(ENCRYPTED_BLOB_MAGIC, 0);
  prelude[4] = ENCRYPTED_BLOB_VERSION;
  prelude[5] = keyIdBytes.byteLength;
  prelude[6] = iv.byteLength;
  prelude.set(keyIdBytes, ENCRYPTED_BLOB_HEADER_FIXED_LENGTH);
  prelude.set(iv, ENCRYPTED_BLOB_HEADER_FIXED_LENGTH + keyIdBytes.byteLength);

  return prelude;
}

function buildEncryptedPayloadPlaintext(metadata, mimeBuffer) {
  const metadataBytes = textEncoder.encode(JSON.stringify(buildEncryptedPayloadMetadata(metadata)));
  const mimeBytes = mimeBuffer instanceof Uint8Array ? mimeBuffer : new Uint8Array(mimeBuffer);
  const plaintext = new Uint8Array(4 + metadataBytes.byteLength + mimeBytes.byteLength);
  const view = new DataView(plaintext.buffer);

  view.setUint32(0, metadataBytes.byteLength);
  plaintext.set(metadataBytes, 4);
  plaintext.set(mimeBytes, 4 + metadataBytes.byteLength);

  return plaintext;
}

async function importEncryptionKey(env) {
  if (cachedEncryptionKeySecret !== env.EMAIL_ENCRYPTION_KEY || !cachedEncryptionKeyPromise) {
    cachedEncryptionKeySecret = env.EMAIL_ENCRYPTION_KEY;
    cachedEncryptionKeyPromise = (async () => {
      const keyBytes = base64ToBytes(env.EMAIL_ENCRYPTION_KEY);

      if (keyBytes.byteLength !== 32) {
        throw new Error("EMAIL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
      }

      return crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: ENCRYPTION_ALGORITHM },
        false,
        ["encrypt"]
      );
    })();
  }

  return cachedEncryptionKeyPromise;
}

async function encryptMessageBody(env, metadata, plaintextBuffer) {
  const keyId = getEncryptionKeyId(env);
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH));
  const prelude = buildEncryptedBlobPrelude(keyId, iv);
  const key = await importEncryptionKey(env);
  const payloadPlaintext = buildEncryptedPayloadPlaintext(metadata, plaintextBuffer);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: ENCRYPTION_ALGORITHM,
        iv,
        additionalData: prelude,
        tagLength: 128,
      },
      key,
      payloadPlaintext
    )
  );

  return concatByteArrays([prelude, ciphertext]);
}

function buildLegacyWebhookHeaders(headers, legacyMetadata) {
  setOptionalHeader(headers, "X-Email-Source", legacyMetadata.source);
  setOptionalHeader(headers, "X-Email-Event-Id", legacyMetadata.eventId);
  setOptionalHeader(headers, "X-Email-Timestamp", legacyMetadata.timestamp);
  setOptionalHeader(headers, "X-Envelope-From", legacyMetadata.from);
  setOptionalHeader(headers, "X-Envelope-To", legacyMetadata.to);
  setOptionalHeader(headers, "X-Recipient-Domain", legacyMetadata.recipientDomain);
  setOptionalHeader(headers, "X-Recipient-Local-Part", legacyMetadata.recipientLocalPart);
  setOptionalHeader(headers, "X-Email-Message-Id", legacyMetadata.messageId);
  setOptionalHeader(headers, "X-Email-Raw-Size", legacyMetadata.rawSize);
  setOptionalHeader(headers, "X-Email-Content-Mode", legacyMetadata.contentMode || "encrypted");
  setOptionalHeader(headers, "X-Email-Encryption-Version", legacyMetadata.encryption?.version);
  setOptionalHeader(headers, "X-Email-Encryption-Algorithm", legacyMetadata.encryption?.algorithm);
  setOptionalHeader(headers, "X-Email-Encryption-IV", legacyMetadata.encryption?.iv);
  setOptionalHeader(headers, "X-Email-Encryption-Key-Id", legacyMetadata.encryption?.keyId);
}

function buildWebhookHeaders(env, legacyMetadata = null) {
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "User-Agent": "Cloudflare-Email-Relay",
    "X-Webhook-Secret": env.WEBHOOK_SECRET,
  });

  if (legacyMetadata) {
    buildLegacyWebhookHeaders(headers, legacyMetadata);
  }

  setOptionalHeader(headers, "CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
  setOptionalHeader(headers, "CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);

  return headers;
}

async function deliverToWebhook(env, body, legacyMetadata = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("Webhook timeout"), getWebhookTimeoutMs(env));

  try {
    const response = await fetch(env.WEBHOOK_URL, {
      method: "POST",
      headers: buildWebhookHeaders(env, legacyMetadata),
      body,
      signal: controller.signal,
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      throw new Error(`Upstream redirected with ${response.status}${location ? ` to ${location}` : ""}`);
    }

    if (!response.ok) {
      throw new Error(`Upstream returned ${response.status}`);
    }

    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getStoredMessageBody(env, storageKey) {
  const storedMessage = await env.MAIL_R2.get(storageKey);

  if (!storedMessage) {
    throw new Error(`Stored message not found for ${storageKey}`);
  }

  const body = await storedMessage.arrayBuffer();

  if (!body.byteLength) {
    throw new Error(`Stored message body is empty for ${storageKey}`);
  }

  return body;
}

async function readIncomingMessageBody(message) {
  const body = await new Response(message.raw).arrayBuffer();

  if (!body.byteLength) {
    throw new Error("Incoming message body is empty");
  }

  return body;
}

async function enqueueRetry(env, storageKey, delaySeconds) {
  await env.MAIL_RETRY_QUEUE.send(
    { storageKey },
    {
      contentType: "json",
      delaySeconds,
    }
  );
}

function normalizeQueuePayload(body) {
  if (typeof body === "string" && body.length > 0) {
    return {
      storageKey: body,
      legacyMetadata: null,
    };
  }

  if (body && typeof body === "object" && typeof body.storageKey === "string" && body.storageKey.length > 0) {
    const hasLegacyMetadata =
      Object.prototype.hasOwnProperty.call(body, "encryption") ||
      Object.prototype.hasOwnProperty.call(body, "from") ||
      Object.prototype.hasOwnProperty.call(body, "to") ||
      Object.prototype.hasOwnProperty.call(body, "eventId");

    return {
      storageKey: body.storageKey,
      legacyMetadata: hasLegacyMetadata ? body : null,
    };
  }

  throw new Error("Invalid queue payload");
}

function scheduleDelete(ctx, env, storageKey, reason) {
  ctx.waitUntil(
    env.MAIL_R2.delete(storageKey).catch((error) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "mail_r2_delete_failed",
          reason,
          storageKey,
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
        storageKey: metadata.storageKey,
      });

      const incomingBody = await readIncomingMessageBody(message);
      const encryptedBody = await encryptMessageBody(env, metadata, incomingBody);

      await env.MAIL_R2.put(metadata.storageKey, encryptedBody, {
        httpMetadata: {
          contentType: "application/octet-stream",
        },
      });

      logInfo("mail_stored", {
        eventId,
        storageKey: metadata.storageKey,
      });

      try {
        const response = await deliverToWebhook(env, encryptedBody);

        scheduleDelete(ctx, env, metadata.storageKey, "direct_delivery");

        logInfo("mail_relay_success", {
          deliveryMode: "direct",
          eventId,
          storageKey: metadata.storageKey,
          status: response.status,
        });

        return;
      } catch (directError) {
        const retryDelaySeconds = getRetryDelaySeconds(env);

        logWarn("mail_relay_deferred", {
          deliveryMode: "direct",
          eventId,
          storageKey: metadata.storageKey,
          retryDelaySeconds,
          error: describeError(directError),
        });

        try {
          await enqueueRetry(env, metadata.storageKey, retryDelaySeconds);

          logInfo("mail_retry_enqueued", {
            eventId,
            storageKey: metadata.storageKey,
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
        storageKey: metadata.storageKey || null,
        error: describeError(error),
      });

      throw error;
    }
  },

  async queue(batch, env, ctx) {
    ensureBindings(env);

    for (const message of batch.messages) {
      let storageKey = null;

      try {
        const normalized = normalizeQueuePayload(message.body);

        storageKey = normalized.storageKey;

        const queuedBody = await getStoredMessageBody(env, storageKey);
        const response = await deliverToWebhook(env, queuedBody, normalized.legacyMetadata);

        scheduleDelete(ctx, env, storageKey, "queue_delivery");
        message.ack();

        logInfo("mail_relay_success", {
          deliveryMode: "queue",
          storageKey,
          queueAttempt: message.attempts,
          status: response.status,
        });
      } catch (error) {
        logError("queue_delivery_failed", {
          storageKey,
          queueAttempt: message.attempts,
          retryDelaySeconds: getRetryDelaySeconds(env),
          error: describeError(error),
        });

        message.retry({ delaySeconds: getRetryDelaySeconds(env) });
      }
    }
  },
};
