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

function setOptionalHeader(headers, name, value) {
  if (value !== null && value !== undefined && value !== "") {
    headers.set(name, value);
  }
}

/**
 * Main Email Worker Logic
 */
export default {
  async email(message, env, ctx) {
    const eventId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
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

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort("Webhook timeout"), getWebhookTimeoutMs(env));
      const requestHeaders = new Headers({
        "Content-Type": "message/rfc822",
        "User-Agent": "Cloudflare-Email-Relay",
        "X-Webhook-Secret": env.WEBHOOK_SECRET,
        "X-Email-Source": "cloudflare-worker",
        "X-Email-Event-Id": eventId,
        "X-Email-Timestamp": timestamp,
        "X-Envelope-From": message.from,
        "X-Envelope-To": message.to,
        "X-Recipient-Domain": recipientDomain,
        "X-Recipient-Local-Part": recipientLocalPart,
        "X-Email-Raw-Size": String(message.rawSize),
      });

      setOptionalHeader(requestHeaders, "X-Email-Message-Id", messageId);

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
          headers: requestHeaders,
          body: message.raw,
          signal: controller.signal,
          redirect: "manual",
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        throw new Error(`Upstream redirected with ${response.status}${location ? ` to ${location}` : ""}`);
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
          responseUrl: response.url,
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
