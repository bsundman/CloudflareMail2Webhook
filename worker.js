function getAddressDomain(address) {
  const atIndex = address.lastIndexOf("@");
  return atIndex === -1 ? "" : address.slice(atIndex + 1).toLowerCase();
}

function getAddressLocalPart(address) {
  const atIndex = address.lastIndexOf("@");
  return atIndex === -1 ? address : address.slice(0, atIndex);
}

function getWebhookTimeoutMs(env) {
  const parsed = Number.parseInt(env.WEBHOOK_TIMEOUT_MS ?? "10000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10000;
}

/**
 * Main Email Worker Logic
 */
export default {
  async email(message, env, ctx) {
    const eventId = crypto.randomUUID();
    const recipientDomain = getAddressDomain(message.to);
    const recipientLocalPart = getAddressLocalPart(message.to);
    const messageId = message.headers.get("message-id");
    const subject = message.headers.get("subject");

    try {
      if (!env.WEBHOOK_SECRET) {
        throw new Error("Missing WEBHOOK_SECRET in Cloudflare Variables");
      }
      if (!env.WEBHOOK_URL) {
        throw new Error("Missing WEBHOOK_URL in Cloudflare Variables");
      }

      const rawEmail = await new Response(message.raw).text();

      const payload = {
        source: "cloudflare-worker",
        eventId,
        timestamp: new Date().toISOString(),
        envelope: {
          from: message.from,
          to: message.to,
        },
        routing: {
          recipientDomain,
          recipientLocalPart,
        },
        headers: {
          messageId,
          subject,
        },
        rawSize: message.rawSize,
        raw: rawEmail,
      };

      const bodyString = JSON.stringify(payload);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort("Webhook timeout"), getWebhookTimeoutMs(env));

      console.log(
        JSON.stringify({
          level: "info",
          event: "mail_received",
          eventId,
          from: message.from,
          to: message.to,
          recipientDomain,
          rawSize: message.rawSize,
          messageId,
        })
      );

      let response;

      try {
        response = await fetch(env.WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Secret": env.WEBHOOK_SECRET,
            "User-Agent": "Cloudflare-Email-Relay",
          },
          body: bodyString,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const upstreamBody = (await response.text()).slice(0, 500);
        throw new Error(`Upstream returned ${response.status}: ${upstreamBody}`);
      }

      console.log(
        JSON.stringify({
          level: "info",
          event: "mail_relay_success",
          eventId,
          to: message.to,
          recipientDomain,
          status: response.status,
        })
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "mail_relay_failure",
          eventId,
          from: message.from,
          to: message.to,
          recipientDomain,
          rawSize: message.rawSize,
          messageId,
          subject,
          error: error instanceof Error ? error.message : String(error),
        })
      );

      throw error;
    }
  },
};
