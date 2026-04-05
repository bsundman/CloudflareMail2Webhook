/**
 * HMAC-SHA256 Signature Generator
 * Signs the JSON payload using a secret key to ensure data integrity.
 */
async function generateSignature(payloadString, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const data = encoder.encode(payloadString);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, data);
  
  // Returns a Base64 encoded string
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export default {
  async email(message, env, ctx) {
    try {
      // 1. Safety Check: Ensure required variables exist
      if (!env.WEBHOOK_SECRET) {
        throw new Error("Missing WEBHOOK_SECRET in Cloudflare Variables");
      }
      if (!env.webhookUrl) {
        throw new Error("Missing webhookUrl in Cloudflare Variables");
      }

      // 2. Extract raw email content
      const rawEmail = await new Response(message.raw).text();

      // 3. Prepare the JSON payload
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

      // 4. Generate the HMAC signature
      const signature = await generateSignature(bodyString, env.WEBHOOK_SECRET);

      // 5. POST to the Webhook
      const response = await fetch(env.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "User-Agent": "Cloudflare-Email-Relay"
        },
        body: bodyString,
      });

      // 6. Handle failure (Triggering a 4xx/Soft-Fail for retries)
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