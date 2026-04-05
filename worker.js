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
    // 1. Extract raw email content
    const rawEmail = await new Response(message.raw).text();

    // 2. Prepare the JSON payload
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

    try {
      // 3. Verify the Secret exists in Environment Variables
      if (!env.WEBHOOK_SECRET) {
        throw new Error("Environment variable 'WEBHOOK_SECRET' is not defined.");
      }

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
        throw new Error(`Upstream webhook returned status: ${response.status}`);
      }

      console.log(`Successfully relayed email from: ${message.from}`);

    } catch (error) {
      // Log the error and throw to ensure the mail server retries later
      console.error("Relay Error:", error.message);
      throw error;
    }
  },
};