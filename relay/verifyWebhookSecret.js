// YOUR CONFIGURATION
const MY_SECRET = 'SECRET_FROM_CLOUDFLARE_ENV_VARIABLES';

const item = $input.item;
const headers = item.json?.headers ?? {};
const body = item.json?.body ?? {};
const receivedSecret =
  headers['x-webhook-secret'] ??
  headers['X-Webhook-Secret'];

const isValid = receivedSecret === MY_SECRET;

if (isValid) {
  return {
    json: {
      authenticated: true,
      details: 'Access Granted',
      ...body,
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
      has_body: Object.keys(body).length > 0,
    },
  },
};
