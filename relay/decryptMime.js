const crypto = require('crypto');

// Replace with one or more base64-encoded 32-byte keys. Keep old keys during rotation.
const ENCRYPTION_KEYS = {
  v1: 'BASE64_32_BYTE_ENCRYPTION_KEY',
};

const ENCRYPTION_ALGORITHM = 'AES-256-GCM';
const AUTH_TAG_LENGTH_BYTES = 16;
const OUTPUT_BINARY_PROPERTY = 'mime';

function buildEncryptionAAD(payload) {
  return Buffer.from(
    JSON.stringify({
      version: payload.encryption?.version ?? 1,
      source: payload.source ?? 'cloudflare-worker',
      eventId: payload.eventId ?? '',
      timestamp: payload.timestamp ?? '',
      from: payload.envelope?.from ?? '',
      to: payload.envelope?.to ?? '',
      recipientDomain: payload.routing?.recipientDomain ?? '',
      recipientLocalPart: payload.routing?.recipientLocalPart ?? '',
      messageId: payload.headers?.messageId ?? '',
      rawSize: payload.rawSize ?? 0,
      keyId: payload.encryption?.keyId ?? '',
      algorithm: payload.encryption?.algorithm ?? ENCRYPTION_ALGORITHM,
    }),
    'utf8'
  );
}

function getEncryptionKey(payload) {
  const keyId = payload.encryption?.keyId || 'v1';
  const base64Key = ENCRYPTION_KEYS[keyId];

  if (!base64Key) {
    throw new Error(`Missing encryption key for keyId "${keyId}"`);
  }

  const key = Buffer.from(base64Key, 'base64');

  if (key.length !== 32) {
    throw new Error(`Encryption key "${keyId}" must decode to 32 bytes`);
  }

  return key;
}

function decryptMimeBuffer(payload, encryptedBuffer) {
  if (payload.contentMode !== 'encrypted') {
    return encryptedBuffer;
  }

  if (payload.encryption?.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(`Unsupported encryption algorithm: ${payload.encryption?.algorithm || 'unknown'}`);
  }

  if (!payload.encryption?.iv) {
    throw new Error('Missing encryption IV');
  }

  if (encryptedBuffer.length <= AUTH_TAG_LENGTH_BYTES) {
    throw new Error('Encrypted payload is too small to contain an auth tag');
  }

  const key = getEncryptionKey(payload);
  const iv = Buffer.from(payload.encryption.iv, 'base64');
  const authTag = encryptedBuffer.subarray(encryptedBuffer.length - AUTH_TAG_LENGTH_BYTES);
  const ciphertext = encryptedBuffer.subarray(0, encryptedBuffer.length - AUTH_TAG_LENGTH_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

  decipher.setAAD(buildEncryptionAAD(payload));
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function buildOutputBinary(rawMimeBuffer, payload) {
  return {
    [OUTPUT_BINARY_PROPERTY]: {
      data: rawMimeBuffer.toString('base64'),
      mimeType: 'message/rfc822',
      fileName: `${payload.eventId || 'message'}.eml`,
    },
  };
}

const items = $input.all();
const returnData = [];

for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const payload = item.json?.data || item.json || {};
  const inputBinaryProperty = payload.binaryProperty || Object.keys(item.binary ?? {})[0] || null;

  if (!inputBinaryProperty) {
    throw new Error('Missing encrypted MIME binary input');
  }

  const encryptedMimeBuffer = await this.helpers.getBinaryDataBuffer(i, inputBinaryProperty);

  if (!encryptedMimeBuffer?.length) {
    throw new Error(`Empty MIME payload in binary property "${inputBinaryProperty}"`);
  }

  const rawMimeBuffer = decryptMimeBuffer(payload, encryptedMimeBuffer);

  if (!rawMimeBuffer?.length) {
    throw new Error('Decrypted MIME payload is empty');
  }

  returnData.push({
    json: {
      ...payload,
      contentMode: 'plain',
      decryptedFromMode: payload.contentMode || 'plain',
      binaryProperty: OUTPUT_BINARY_PROPERTY,
    },
    binary: buildOutputBinary(rawMimeBuffer, payload),
  });
}

return returnData;
