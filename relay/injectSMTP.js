const nodemailer = require('nodemailer');

const items = $input.all();
const returnData = [];

for (let i = 0; i < items.length; i++) {
  const item = items[i].json;

  try {
    // PATH SELECTION
    // We look for 'item.data' (if nested by verification) or 'item' (if top-level)
    const payload = item.data || item;
    
    const from = payload.envelope?.from; 
    const to = payload.envelope?.to;
    const rawMimeString = payload.raw;

    if (!from || !to || !rawMimeString) {
      throw new Error(`Missing JSON fields. From: ${!!from}, To: ${!!to}, Raw: ${!!rawMimeString}`);
    }

    // SMTP SETUP
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

    // INJECT THE STRING DIRECTLY
    // Nodemailer handles raw strings perfectly without needing Buffer.from()
    const info = await transporter.sendMail({
      envelope: { from, to },
      raw: rawMimeString,
    });

    returnData.push({ 
      json: { 
        success: true, 
        messageId: info.messageId, 
        recipient: to 
      } 
    });

  } catch (error) {
    returnData.push({ 
      json: { 
        success: false, 
        error: error.message,
        debug: {
          has_payload: !!(item.data || item),
          has_raw_field: !!(item.data?.raw || item.raw),
          // Check for unexpected whitespace/characters at the start of the MIME
          mime_start: (item.data?.raw || item.raw || "").substring(0, 20)
        }
      } 
    });
  }
}

return returnData;