# CloudflareMail2Webhook
Script for Cloudflare worker to process and send email to external webhook url

# Notes
- Files under `relay/` are intended to be pasted into n8n Code nodes, not run as standalone Node.js scripts.
- The current flow is synchronous: Cloudflare Email Worker -> webhook -> n8n -> SMTP injection.
- The worker now posts the raw MIME message as `message/rfc822` and sends routing/auth metadata in HTTP headers.
- In n8n, enable `Raw Body` on the Webhook node and set the binary property name to `data` if you want to use the sample Code nodes unchanged.
- This means mail acceptance is coupled to webhook availability unless you add a durable queue/storage layer.
- Cloudflare documents `message.setReject()` as a permanent SMTP reject, so do not use it for "retry later" behavior.
- In n8n, the SMTP Code node must throw on failure. Returning `{ success: false }` and then replying `200` will silently lose mail.
- The worker treats `3xx` responses as failures so Cloudflare Access redirects cannot be mistaken for successful webhook delivery.

# TODO
- Test offline and error handling
- Add email encryption option
