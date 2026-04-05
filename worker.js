/**
 * HMAC-SHA256 Signature Generator
 * * This helper function signs the JSON payload using a secret key.
 * It ensures the integrity of the data between Cloudflare and your webhook.
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
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * Main Email Worker Logic
 */
export default {
  async email(message, env, ctx) {
    // Extract the raw email stream
    const rawEmail = await new Response(message.raw).text();

    // Prepare the payload
    const payload = {
      source: "cloudflare-worker",
      timestamp: new Date().toISOString(),
      envelope: {
        from: message.from,
        to: message.to,
      },
      // This is the full, unparsed MIME string
      raw: rawEmail
    };

    const bodyString = JSON.stringify(payload);

    try {
      // Generate the signature using the Secret from your Dashboard
      // Ensure 'WEBHOOK_SECRET' is added as an Encrypted Secret in Cloudflare
      const signature = await generateSignature(bodyString, env.WEBHOOK_SECRET);

      // Send to your defined Webhook URL using the environment variable
      // Ensure 'webhookUrl' is defined in your Worker's Settings > Variables
      const response = await fetch(env.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "User-Agent": "Cloudflare-Email-Relay"
        },
        body: bodyString,
      });

      // Handle Offline/Error States
      if (!response.ok) {
        // Throwing an error triggers a temporary failure (4xx). 
        // The sender's server will keep the mail and retry later.
        throw new Error(`Upstream webhook error (${response.status})`);
      }

      console.log(`Relay successful for: ${message.from}`);

    } catch (error) {
      // Catch network timeouts, DNS failures, or missing Secrets
      // Re-throwing ensures the email stays in the sender's queue for a silent retry
      console.error("Worker fetch exception:", error.message);
      throw error;
    }
  },
};