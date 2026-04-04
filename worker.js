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

    try {
      // Send to your defined Webhook URL using the environment variable
      // Ensure 'webhookUrl' is defined in your Worker's Settings > Variables
      const response = await fetch(env.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CF-Worker-Secret": "your-shared-secret-key" 
        },
        body: JSON.stringify(payload),
      });

      // Handle Offline/Error States
      if (!response.ok) {
        // This triggers a temporary failure (4xx). 
        // The sender's server will keep the mail in their queue and try again later.
        message.setReject(`Upstream webhook error (${response.status}). Retrying later.`);
        console.error(`Failed to post to webhook: ${response.statusText}`);
      }

    } catch (error) {
      // Catch network timeouts or DNS failures
      message.setReject("Connection to webhook failed. Retrying later.");
      console.error("Worker fetch exception:", error.message);
    }
  },
};