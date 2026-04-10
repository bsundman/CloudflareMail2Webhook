// YOUR CONFIGURATION
const MY_SECRET = 'SECRET_FROM_CLOUDFLARE_ENV_VARIABLES';

const item = $input.item;
const headers = item.json?.headers ?? {};
const binary = item.binary ?? {};
const binaryPropertyName = Object.keys(binary)[0] ?? null;

function getHeader(name) {
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

function getRequiredHeader(name) {
  const value = getHeader(name);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const receivedSecret = getRequiredHeader('x-webhook-secret');

const isValid = receivedSecret === MY_SECRET;

if (isValid) {
  const from = getRequiredHeader('x-envelope-from');
  const to = getRequiredHeader('x-envelope-to');

  return {
    json: {
      authenticated: true,
      details: 'Access Granted',
      source: getHeader('x-email-source') ?? 'cloudflare-worker',
      eventId: getHeader('x-email-event-id') ?? null,
      timestamp: getHeader('x-email-timestamp') ?? null,
      envelope: {
        from,
        to,
      },
      routing: {
        recipientDomain: getHeader('x-recipient-domain') ?? null,
        recipientLocalPart: getHeader('x-recipient-local-part') ?? null,
      },
      headers: {
        messageId: getHeader('x-email-message-id') ?? null,
      },
      rawSize: Number.parseInt(getHeader('x-email-raw-size') ?? '', 10) || null,
      binaryProperty: binaryPropertyName,
    },
    binary: item.binary,
  };
}

return {
  json: {
    authenticated: false,
    details: 'Access Denied',
    debug: {
      secret_present: !!receivedSecret,
      has_headers: Object.keys(headers).length > 0,
      has_binary: !!binaryPropertyName,
      binary_property: binaryPropertyName,
    },
  },
};
