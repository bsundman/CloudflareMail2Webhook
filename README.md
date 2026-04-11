# CloudflareMail2Webhook

Cloudflare email ingress pipeline for this flow:

`Cloudflare Email Routing -> Email Worker -> R2 spool -> direct webhook attempt -> Queue retry consumer -> n8n -> SMTP injection`

The current design is store-first and encrypted:

- The Worker receives raw inbound email from Cloudflare Email Routing.
- The Worker encrypts the full raw MIME plus the delivery metadata into one opaque blob.
- The encrypted blob is stored in R2.
- The Worker immediately tries to POST that encrypted blob to n8n.
- If n8n is unavailable, the Worker enqueues only the opaque R2 storage key for retry.
- The queue consumer retries delivery on a fixed schedule.
- n8n verifies the shared secret, decrypts the blob, and injects the original MIME through SMTP.

This README is intended to be enough for a new human operator or an AI agent to understand, deploy, maintain, and troubleshoot the project.

## What This Project Solves

This project exists to solve two problems that a simple direct webhook relay does not solve well:

1. `n8n` or the internal SMTP path can be temporarily unavailable.
2. Sensitive message content should not be stored or shared in plaintext inside Cloudflare.

The current implementation addresses those by:

- storing the message durably before acknowledging success internally
- retrying from Cloudflare-owned storage instead of relying only on sender SMTP retry behavior
- encrypting the message and its routing metadata before R2 storage and before webhook delivery
- minimizing plaintext metadata in Cloudflare logs, queue payloads, and webhook headers

## Current Architecture

### Direct Path

1. Cloudflare Email Routing invokes the Worker `email()` handler.
2. The Worker reads the full raw MIME body.
3. The Worker builds minimal delivery metadata:
   - event ID
   - timestamp
   - SMTP envelope
   - recipient domain/local part
   - original `Message-ID`
   - raw size
4. The Worker encrypts the metadata and MIME together into one opaque binary blob.
5. The Worker writes that blob to R2.
6. The Worker POSTs the same encrypted blob to the n8n webhook as `application/octet-stream`.
7. If n8n returns `2xx`, the Worker schedules the R2 object for deletion.

### Retry Path

1. If direct webhook delivery fails, the Worker enqueues only `{ storageKey }` to the retry queue.
2. The queue consumer reads the encrypted blob back from R2.
3. The queue consumer POSTs the encrypted blob to n8n.
4. On success, the queue consumer deletes the R2 object.
5. On failure, the queue consumer retries with the configured delay.
6. After retry exhaustion, the queue message goes to the DLQ and the encrypted R2 object remains until manually handled.

## Security Model

### Encrypted

- Full raw MIME message body
- Attachments
- SMTP envelope metadata
- Recipient routing metadata
- Original message ID
- Any delivery metadata embedded inside the encrypted payload
- R2 stored object body
- Webhook request body to n8n

### Plaintext Inside Cloudflare

- R2 object key, which is opaque and fingerprint-based
- Queue message body, which contains only the opaque `storageKey`
- Minimal Worker logs if observability is enabled
- Shared webhook secret header value during transit to n8n
- Optional Cloudflare Access service-token headers if you use Access in front of the webhook

### Not Logged By Default

Observability is currently disabled in [wrangler.toml](/Users/brian/code/CloudflareMail2Webhook/wrangler.toml). The Worker still contains `console.*` calls, but Workers Logs/Observability ingestion is turned off in the deployed config.

### Encryption Format

The current format is a self-describing encrypted blob:

- magic header: `CFEM`
- blob version
- key ID length
- IV length
- key ID bytes
- IV bytes
- AES-GCM ciphertext plus authentication tag

The decrypted plaintext format is:

- 4-byte metadata length
- JSON metadata
- raw RFC822/MIME bytes

The decrypt node also supports the previous legacy encrypted format during migration.

## Repository Layout

- [worker.js](/Users/brian/code/CloudflareMail2Webhook/worker.js)
  Cloudflare Email Worker and Queue consumer. This is the main runtime.

- [wrangler.toml](/Users/brian/code/CloudflareMail2Webhook/wrangler.toml)
  Worker config, bindings, queue consumer settings, observability settings, required secrets, and `keep_vars = true`.

- [relay/verifyWebhookSecret.js](/Users/brian/code/CloudflareMail2Webhook/relay/verifyWebhookSecret.js)
  n8n Code node snippet for webhook shared-secret validation.

- [relay/decryptMime.js](/Users/brian/code/CloudflareMail2Webhook/relay/decryptMime.js)
  n8n Code node snippet for decrypting the Worker payload into raw MIME.

- [relay/injectSMTP.js](/Users/brian/code/CloudflareMail2Webhook/relay/injectSMTP.js)
  n8n Code node snippet for SMTP injection using Nodemailer and the decrypted raw MIME.

## Cloudflare Resources

The repo currently expects these resource names:

- R2 bucket: `email`
- retry queue: `email`
- dead-letter queue: `dlq`

Those are defined in [wrangler.toml](/Users/brian/code/CloudflareMail2Webhook/wrangler.toml). If you want different resource names, change the bindings there before deploy.

## Runtime Configuration Model

Runtime config is dashboard-managed. The repo is intentionally not the source of truth for runtime values.

[wrangler.toml](/Users/brian/code/CloudflareMail2Webhook/wrangler.toml) includes:

- `keep_vars = true`
- required secrets validation
- no runtime `[vars]`

That means:

- existing dashboard vars/secrets are preserved on deploy
- missing dashboard vars/secrets are not auto-created by the repo
- required secrets are validated during deploy

## Required Dashboard Configuration

Create these once in the Cloudflare Worker dashboard.

### Required Variables

- `WEBHOOK_URL`
  The production n8n webhook URL the Worker POSTs to.

### Optional Variables

- `WEBHOOK_TIMEOUT_MS`
  Direct/queue webhook timeout in milliseconds. Default in code: `10000`.

- `WEBHOOK_RETRY_DELAY_SECONDS`
  Retry delay in seconds. Default in code: `840`.

- `EMAIL_ENCRYPTION_KEY_ID`
  Non-secret key label used for key rotation. Default in code: `v1`.

- `CF_ACCESS_CLIENT_ID`
  Only needed if the webhook is behind Cloudflare Access and you are using service auth.

### Required Secrets

- `WEBHOOK_SECRET`
  Shared secret the Worker sends to n8n in `X-Webhook-Secret`.

- `EMAIL_ENCRYPTION_KEY`
  Base64-encoded 32-byte encryption key used by the Worker.

### Optional Secrets

- `CF_ACCESS_CLIENT_SECRET`
  Only needed if the webhook is behind Cloudflare Access and you are using service auth.

## Generating The Encryption Key

Generate a new base64 32-byte key:

```bash
openssl rand -base64 32
```

Use that same value in two places:

1. Cloudflare Worker secret `EMAIL_ENCRYPTION_KEY`
2. `ENCRYPTION_KEYS` map inside [decryptMime.js](/Users/brian/code/CloudflareMail2Webhook/relay/decryptMime.js)

Example:

```js
const ENCRYPTION_KEYS = {
  v1: 'PASTE_THE_SAME_BASE64_32_BYTE_KEY_HERE',
};
```

The matching key label is `EMAIL_ENCRYPTION_KEY_ID`. If you keep the default:

- `EMAIL_ENCRYPTION_KEY_ID = v1`
- `ENCRYPTION_KEYS.v1 = <same key>`

## Cloudflare Deployment Steps

1. Create the R2 bucket `email`.
2. Create the retry queue `email`.
3. Create the dead-letter queue `dlq`.
4. Confirm [wrangler.toml](/Users/brian/code/CloudflareMail2Webhook/wrangler.toml) matches those resource names.
5. In the Worker dashboard, create the required runtime variable and secrets listed above.
6. If you use Cloudflare Access in front of the webhook:
   - either bypass the webhook path
   - or add `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
7. Deploy with Wrangler or Workers Builds.
8. In every Cloudflare Email Routing zone, bind the inbound route to this Worker.

## n8n Workflow

### Required Node Order

Use this exact shape:

`Webhook -> JS: Verify Signature -> If(authenticated) -> JS: Decrypt MIME -> JS: Inject SMTP -> Respond to Webhook`

Unauthorized branch:

`If(false) -> Respond to Webhook (403)`

### Webhook Node

Set:

- method: `POST`
- respond mode: `Using "Respond to Webhook" Node`
- `Raw Body`: enabled

Important:

- the Worker sends the request body as `application/octet-stream`
- the Webhook node must preserve that as binary input
- the sample relay code expects the binary property to be `data`, but it can also fall back to the first binary property found

### JS: Verify Signature

Paste in [verifyWebhookSecret.js](/Users/brian/code/CloudflareMail2Webhook/relay/verifyWebhookSecret.js).

Edit:

- replace `SECRET_FROM_CLOUDFLARE_ENV_VARIABLES` with the same value used in Worker secret `WEBHOOK_SECRET`

What it does:

- validates `X-Webhook-Secret`
- passes through the binary payload unchanged
- supports both:
  - the current opaque encrypted payload format
  - the older legacy header-assisted encrypted format

### If Node

Condition:

`{{$json.authenticated}} is equal to true`

True branch:

- go to `JS: Decrypt MIME`

False branch:

- go to `Respond to Webhook` with HTTP `403`

### JS: Decrypt MIME

Paste in [decryptMime.js](/Users/brian/code/CloudflareMail2Webhook/relay/decryptMime.js).

Edit:

- replace the `ENCRYPTION_KEYS` map with your real keys

Requirements:

- n8n must allow the built-in `crypto` module
- for self-hosted n8n, that usually means setting:

```bash
NODE_FUNCTION_ALLOW_BUILTIN=crypto
```

What it does:

- reads the encrypted blob from the Webhook binary input
- detects the current `CFEM` format
- decrypts with AES-256-GCM
- extracts delivery metadata and raw MIME
- outputs binary property `mime`
- preserves support for the previous legacy encrypted format during migration

### JS: Inject SMTP

Paste in [injectSMTP.js](/Users/brian/code/CloudflareMail2Webhook/relay/injectSMTP.js).

Edit:

- `SMTP_HOST`
- `SMTP_USER`
- `SMTP_PASSWORD`
- port/security/TLS settings as needed for your environment

What it does:

- reads the decrypted binary MIME
- sends the original raw MIME through Nodemailer with the correct envelope
- throws on failure so n8n returns non-`2xx`

This node must throw on SMTP failure. Do not change it to “soft-fail” and still return `200`.

### Respond to Webhook

Success branch:

- return `200`

Unauthorized branch:

- return `403`

Do not return `200` unless the SMTP injection node has succeeded.

## Worker Behavior

### Direct Delivery Success

Expected sequence:

1. message arrives
2. Worker encrypts and stores blob in R2
3. Worker POSTs to n8n
4. n8n verifies, decrypts, SMTP injects, returns `200`
5. Worker schedules R2 deletion

### Direct Delivery Failure

Expected sequence:

1. message arrives
2. Worker encrypts and stores blob in R2
3. direct webhook delivery fails
4. Worker enqueues `{ storageKey }`
5. message stays encrypted in R2
6. queue consumer retries later

### Queue Delivery Success

Expected sequence:

1. queue consumer reads encrypted blob from R2
2. queue consumer POSTs blob to n8n
3. n8n verifies, decrypts, SMTP injects, returns `200`
4. queue consumer deletes the R2 object
5. queue message is acknowledged

## Retry Policy

Current queue consumer config in [wrangler.toml](/Users/brian/code/CloudflareMail2Webhook/wrangler.toml):

- batch size: `1`
- max batch timeout: `1`
- retry delay: `840` seconds
- max retries: `100`
- DLQ: `dlq`

This is intended to spread retries over roughly one day on Cloudflare Free.

Notes:

- the initial direct attempt happens immediately
- queue retries use the configured delay
- the queue stores only the opaque storage key, not the message body
- after retry exhaustion, the queue message goes to the DLQ and the encrypted R2 object remains

## Data Lifecycle

- On direct success, the encrypted R2 object is scheduled for deletion.
- On queue success, the encrypted R2 object is scheduled for deletion.
- On repeated failure, the encrypted R2 object remains in R2.
- If deletion fails after a successful delivery, the message is already delivered and only the encrypted spool copy remains.

## Current Logging Behavior

With observability disabled:

- Worker logs should not be ingested into Cloudflare Workers Logs
- the code still contains `console.*` calls for future troubleshooting

If you need troubleshooting later:

1. temporarily re-enable observability in [wrangler.toml](/Users/brian/code/CloudflareMail2Webhook/wrangler.toml)
2. redeploy
3. reproduce the issue
4. turn observability off again when finished

## Cloudflare Access

If the webhook is not behind Cloudflare Access:

- leave `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` unset

If the webhook is behind Cloudflare Access:

- either bypass the webhook path
- or configure a service token and set:
  - `CF_ACCESS_CLIENT_ID`
  - `CF_ACCESS_CLIENT_SECRET`

The Worker will add those headers only if they exist.

## Migration Notes

The project currently supports two encrypted formats in n8n:

1. current format: self-describing `CFEM` blob with metadata inside ciphertext
2. legacy format: encrypted MIME with routing/encryption metadata in headers

Why this matters:

- newly delivered messages use the current format
- old queued messages created before the format change may still arrive in the legacy format

After the queue is fully drained and no old encrypted messages remain:

- you can remove the legacy decryption branch from [decryptMime.js](/Users/brian/code/CloudflareMail2Webhook/relay/decryptMime.js)

## Troubleshooting

### The webhook receives plaintext MIME instead of ciphertext

Expected:

- Webhook binary MIME type should be `application/octet-stream`

If not:

- the deployed Worker is not the current encrypted version

### The decrypt node fails

Check:

- `WEBHOOK_SECRET` in Worker matches `MY_SECRET` in [verifyWebhookSecret.js](/Users/brian/code/CloudflareMail2Webhook/relay/verifyWebhookSecret.js)
- `EMAIL_ENCRYPTION_KEY` in Cloudflare matches the key in `ENCRYPTION_KEYS` inside [decryptMime.js](/Users/brian/code/CloudflareMail2Webhook/relay/decryptMime.js)
- `EMAIL_ENCRYPTION_KEY_ID` matches a key entry in `ENCRYPTION_KEYS`
- `NODE_FUNCTION_ALLOW_BUILTIN=crypto` is enabled in n8n

### SMTP injection fails

Check:

- SMTP host/user/password in [injectSMTP.js](/Users/brian/code/CloudflareMail2Webhook/relay/injectSMTP.js)
- network reachability from n8n to the SMTP host
- whether the SMTP server expects different TLS settings or authentication

### Queue retries do not happen

Check:

- queue producer binding `MAIL_RETRY_QUEUE`
- queue consumer attached to queue `email`
- DLQ `dlq`
- Worker deploy includes the current [wrangler.toml](/Users/brian/code/CloudflareMail2Webhook/wrangler.toml)

### Cloudflare deploy overwrites dashboard values

Expected current behavior:

- it should not, because:
  - `keep_vars = true`
  - runtime `[vars]` are not defined in the repo

If it still appears to:

- confirm the dashboard values exist in the Worker runtime config
- confirm you are deploying the current commit
- confirm you are not setting competing build-time variables in Workers Builds

## Operational Checklist

Before first production use:

- create R2/Queue/DLQ resources
- set Worker dashboard variable `WEBHOOK_URL`
- set Worker dashboard secrets `WEBHOOK_SECRET` and `EMAIL_ENCRYPTION_KEY`
- optionally set retry/timeout/key-ID vars
- deploy Worker
- wire Email Routing to the Worker
- update n8n nodes from `relay/`
- set the same encryption key in [decryptMime.js](/Users/brian/code/CloudflareMail2Webhook/relay/decryptMime.js)
- test one message end-to-end
- test one forced failure and confirm queue retry behavior

After any crypto change:

- verify new mail decrypts successfully
- keep old keys in `ENCRYPTION_KEYS` until old queue contents are drained
- only then remove obsolete keys

## AI Operator Notes

If an AI agent is maintaining this project, these assumptions matter:

- files under `relay/` are n8n Code node snippets, not standalone Node programs
- runtime values are dashboard-managed, not repo-managed
- changing the encryption format requires synchronized updates to:
  - [worker.js](/Users/brian/code/CloudflareMail2Webhook/worker.js)
  - [relay/decryptMime.js](/Users/brian/code/CloudflareMail2Webhook/relay/decryptMime.js)
- SMTP injection must remain fail-hard
- direct webhook success must remain `2xx`-only
- retry queue payloads should stay minimal and should not regain plaintext metadata
- if observability is re-enabled, review whether any logged fields expose more metadata than intended

## Current Status

At the time of this README version:

- runtime vars are dashboard-managed
- `keep_vars = true` is enabled
- observability is disabled
- R2 stores encrypted blobs
- queue messages store only opaque storage keys
- n8n decrypts before SMTP injection
- legacy encrypted payloads are still supported during migration
