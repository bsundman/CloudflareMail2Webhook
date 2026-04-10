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
  const item = items[i];
  const payload = item.json?.data || item.json || {};
  const binaryPropertyName = payload.binaryProperty || Object.keys(item.binary ?? {})[0] || null;

  const from = payload.envelope?.from;
  const to = payload.envelope?.to;

  if (!from || !to || !binaryPropertyName) {
    throw new Error(
      `Missing input fields. From: ${!!from}, To: ${!!to}, Binary: ${!!binaryPropertyName}`
    );
  }

  const rawMimeBuffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);

  if (!rawMimeBuffer?.length) {
    throw new Error(`Empty MIME payload in binary property "${binaryPropertyName}"`);
  }

  try {
    const info = await transporter.sendMail({
      envelope: { from, to },
      raw: rawMimeBuffer,
    });

    returnData.push({
      json: {
        success: true,
        messageId: info.messageId,
        recipient: to,
        recipientDomain: payload.routing?.recipientDomain || (to.split('@')[1] || '').toLowerCase(),
        workerEventId: payload.eventId || null,
        rawSize: rawMimeBuffer.length,
      }
    });
  } catch (error) {
    const debug = {
      recipient: to,
      recipient_domain:
        payload.routing?.recipientDomain ||
        ((to || "").split('@')[1] || "").toLowerCase(),
      worker_event_id: payload.eventId || null,
      raw_size: rawMimeBuffer.length,
      binary_property: binaryPropertyName,
    };

    throw new Error(`SMTP injection failed: ${error.message} | ${JSON.stringify(debug)}`);
  }
}

return returnData;
