/**
 * Main Email Worker Logic
 */
export default {
  async email(message, env, ctx) {
    try {
      // Safety Check: Ensure required variables exist
      if (!env.WEBHOOK_SECRET) {
        throw new Error("Missing WEBHOOK_SECRET in Cloudflare Variables");
      }
      if (!env.WEBHOOK_URL) {
        throw new Error("Missing WEBHOOK_URL in Cloudflare Variables");
      }

      // Extract raw email content
      const rawEmail = await new Response(message.raw).text();

      // Prepare the JSON payload
      const payload = {
        source: "cloudflare-worker",
        timestamp: new Date().toISOString(),
        envelope: {
          from: message.from,
          to: message.to,
        },
        raw: rawEmail
      };

      const bodyString = JSON.stringify(payload);

      // POST to the Webhook
      const response = await fetch(env.WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Sending the unique secret directly as a static password
          "X-Webhook-Secret": env.WEBHOOK_SECRET,
          "User-Agent": "Cloudflare-Email-Relay"
        },
        body: bodyString,
      });

      // Handle failure (Triggering a 4xx/Soft-Fail for retries)
      if (!response.ok) {
        throw new Error(`Upstream returned ${response.status}`);
      }

      console.log(`Relay successful: ${message.from}`);

    } catch (error) {
      // Log the specific error to the Cloudflare dashboard
      console.error("Worker Error:", error.message);
      
      // Re-throw so the email stays in the sender's queue
      throw error;
    }
  },
};