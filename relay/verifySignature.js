// YOUR CONFIGURATION
const MY_SECRET = 'SECRET_FROM_CLOUDFLARE_ENV_VARIABLES'; // This should match the secret set in your Cloudflare Worker

const item = $input.item; // Get the full item (JSON + Binary)
const headers = item.json.headers;
const receivedSecret = headers['x-webhook-secret'];

// VERIFY THE SECRET
const isValid = (receivedSecret === MY_SECRET);

// RETURN RESULTS (Preserving Binary)
if (isValid) {
  return {
    json: {
      authenticated: true,
      details: "Access Granted",
      ...item.json.body // Spread the email fields (from, to, source) into the top level
    },
    binary: item.binary // This "passes the torch" for the raw email data
  };
} else {
  // If unauthorized, we return an error state (and no data/binary)
  return {
    json: {
      authenticated: false,
      details: "Access Denied: Secret Mismatch",
      debug: {
        received: receivedSecret,
        expected: MY_SECRET
      }
    }
  };
}