# CloudflareMail2Webhook
Script for Cloudflare worker to process and send email to external webhook url

# Notes
- Files under `relay/` are intended to be pasted into n8n Code nodes, not run as standalone Node.js scripts.
- The current flow is synchronous: Cloudflare Email Worker -> webhook -> n8n -> SMTP injection.
- This means mail acceptance is coupled to webhook availability unless you add a durable queue/storage layer.
- Cloudflare documents `message.setReject()` as a permanent SMTP reject, so do not use it for "retry later" behavior.
- In n8n, the SMTP Code node must throw on failure. Returning `{ success: false }` and then replying `200` will silently lose mail.

# TODO
- Test offline and error handling
- Add email encryption option
