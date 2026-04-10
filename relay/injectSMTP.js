const nodemailer = require('nodemailer');

const items = $input.all();
const returnData = [];
const transporter = nodemailer.createTransport({
  host: "SMTP_HOST",
  port: 25,
  secure: false,
  auth: {
    user: "SMTP_USER",
    pass: "SMTP_PASSWORD",
  },
  tls: { rejectUnauthorized: false }
});

for (let i = 0; i < items.length; i++) {
  const item = items[i].json;
  // PATH SELECTION
  // We look for 'item.data' (if nested by verification) or 'item' (if top-level)
  const payload = item.data || item;

  const from = payload.envelope?.from;
  const to = payload.envelope?.to;
  const rawMimeString = payload.raw;

  if (!from || !to || !rawMimeString) {
    throw new Error(`Missing JSON fields. From: ${!!from}, To: ${!!to}, Raw: ${!!rawMimeString}`);
  }

  try {
    const info = await transporter.sendMail({
      envelope: { from, to },
      raw: rawMimeString,
    });

    returnData.push({ 
      json: { 
        success: true, 
        messageId: info.messageId, 
        recipient: to,
        recipientDomain: payload.routing?.recipientDomain || (to.split('@')[1] || '').toLowerCase(),
        workerEventId: payload.eventId || null,
      } 
    });
  } catch (error) {
    const debug = {
      recipient: to,
      recipient_domain:
        payload.routing?.recipientDomain ||
        ((to || "").split('@')[1] || "").toLowerCase(),
      worker_event_id: payload.eventId || null,
      mime_start: (rawMimeString || "").substring(0, 20),
    };

    throw new Error(`SMTP injection failed: ${error.message} | ${JSON.stringify(debug)}`);
  }
}

return returnData;
