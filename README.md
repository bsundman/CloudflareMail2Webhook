# CloudflareMail2Webhook
Script for Cloudflare worker to process and send email to external webhook url

# Notes
- Files under `relay/` are intended to be pasted into n8n Code nodes, not run as standalone Node.js scripts.
- The current flow is hybrid and store-first: Cloudflare Email Worker -> R2 spool -> direct webhook attempt -> Queue retry worker -> n8n -> SMTP injection.
- The worker now posts the raw MIME message as `message/rfc822` and sends routing/auth metadata in HTTP headers.
- In n8n, enable `Raw Body` on the Webhook node and set the binary property name to `data` if you want to use the sample Code nodes unchanged.
- The message is written to R2 before any direct delivery attempt, so the fast path does not sacrifice durability.
- Cloudflare documents `message.setReject()` as a permanent SMTP reject, so do not use it for "retry later" behavior.
- In n8n, the SMTP Code node must throw on failure. Returning `{ success: false }` and then replying `200` will silently lose mail.
- The worker treats `3xx` responses as failures so Cloudflare Access redirects cannot be mistaken for successful webhook delivery.
- When direct delivery fails, the worker enqueues a retry pointer and returns success because the message is already durably stored in R2.
- Queue retries use a fixed delay from `WEBHOOK_RETRY_DELAY_SECONDS` and the Wrangler consumer config currently sets `retry_delay = 840`.
- `840` seconds is 14 minutes, which is a safer default than 15 minutes if you want to stretch retries across Cloudflare Free's 24-hour queue retention window.
- If you keep the webhook behind Cloudflare Access, add `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` as Worker secrets.

# Deploy
- Create one R2 bucket for stored `.eml` payloads and bind it in the Cloudflare dashboard as `MAIL_R2`.
- Create one retry queue and one dead-letter queue, then attach the retry queue to the Worker in the Cloudflare dashboard as `MAIL_RETRY_QUEUE`.
- Keep `max_batch_size = 1` unless you want a failed delivery to retry a whole batch together.
- On Cloudflare Free, queue messages are limited to `128 KB`, which is why only the pointer/metadata is stored in the queue and the full email lives in R2.

# Cloudflare Setup
1. Create an R2 bucket dedicated to inbound email spool files.
2. Create a Queue for retry pointers and a second Queue for dead-letter messages.
3. In the Worker dashboard, add bindings:
   - R2 bucket binding named `MAIL_R2`
   - Queue producer binding named `MAIL_RETRY_QUEUE`
4. Configure the queue consumer attachment for this Worker:
   - attach this Worker as the consumer for your retry queue
   - set `max_batch_size = 1`
   - set `max_batch_timeout = 1`
   - set `max_retries = 100`
   - set `retry_delay = 840`
   - set the dead-letter queue to your retry DLQ
   - if you prefer config as code for the consumer, uncomment the template in `wrangler.toml` and set the real queue names there
5. Add Worker secrets/vars:
   - `WEBHOOK_URL`
   - `WEBHOOK_SECRET`
   - `WEBHOOK_TIMEOUT_MS`
   - `WEBHOOK_RETRY_DELAY_SECONDS`
   - optionally `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
6. Deploy the Worker with the R2 and Queue bindings present.
7. In each Cloudflare Email Routing zone, bind the inbound route to this Worker.
8. In n8n:
   - keep the Webhook node on `POST`
   - keep `Respond` set to `Using "Respond to Webhook" Node`
   - keep `Raw Body` enabled
   - update the Code nodes from `relay/verifyWebhookSecret.js` and `relay/injectSMTP.js`
9. If `relay.sundman.ca` or another webhook hostname is protected by Cloudflare Access, either:
   - add a bypass for the machine webhook path, or
   - configure Worker service-token secrets so the request is allowed through Access.

# Data Lifecycle
- On successful direct delivery, the Worker schedules the R2 object for deletion.
- On successful queue delivery, the queue consumer schedules the R2 object for deletion.
- If delivery keeps failing, the `.eml` file remains in R2 and the retry pointer remains in Queue until retries are exhausted or the message lands in the DLQ.
- If R2 deletion fails after a successful delivery, the mail is already delivered and only the stored spool copy remains; the Worker logs that cleanup failure.

# TODO
- Test offline and error handling
- Add email encryption option
