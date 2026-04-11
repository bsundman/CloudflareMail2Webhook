const crypto = require('crypto');

// Replace with one or more base64-encoded 32-byte keys. Keep old keys during rotation.
const ENCRYPTION_KEYS = {
  v1: 'BASE64_32_BYTE_ENCRYPTION_KEY',
};

const LEGACY_ENCRYPTION_ALGORITHM = 'AES-256-GCM';
const NODE_ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const AUTH_TAG_LENGTH_BYTES = 16;
const OUTPUT_BINARY_PROPERTY = 'mime';
const ENCRYPTED_BLOB_MAGIC = 'CFEM';
const ENCRYPTED_BLOB_VERSION = 1;
const ENCRYPTED_BLOB_HEADER_FIXED_LENGTH = 7;

function getEncryptionKey(keyId) {
  const resolvedKeyId = keyId || 'v1';
  const base64Key = ENCRYPTION_KEYS[resolvedKeyId];

  if (!base64Key) {
    throw new Error(`Missing encryption key for keyId "${resolvedKeyId}"`);
  }

  const key = Buffer.from(base64Key, 'base64');

  if (key.length !== 32) {
    throw new Error(`Encryption key "${resolvedKeyId}" must decode to 32 bytes`);
  }

  return key;
}

function buildLegacyEncryptionAAD(payload) {
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
      algorithm: payload.encryption?.algorithm ?? LEGACY_ENCRYPTION_ALGORITHM,
    }),
    'utf8'
  );
}

function decryptLegacyMimeBuffer(payload, encryptedBuffer) {
  if (payload.encryption?.algorithm !== LEGACY_ENCRYPTION_ALGORITHM) {
    throw new Error(`Unsupported legacy encryption algorithm: ${payload.encryption?.algorithm || 'unknown'}`);
  }

  if (!payload.encryption?.iv) {
    throw new Error('Missing legacy encryption IV');
  }

  if (encryptedBuffer.length <= AUTH_TAG_LENGTH_BYTES) {
    throw new Error('Legacy encrypted payload is too small to contain an auth tag');
  }

  const key = getEncryptionKey(payload.encryption?.keyId);
  const iv = Buffer.from(payload.encryption.iv, 'base64');
  const authTag = encryptedBuffer.subarray(encryptedBuffer.length - AUTH_TAG_LENGTH_BYTES);
  const ciphertext = encryptedBuffer.subarray(0, encryptedBuffer.length - AUTH_TAG_LENGTH_BYTES);
  const decipher = crypto.createDecipheriv(NODE_ENCRYPTION_ALGORITHM, key, iv);

  decipher.setAAD(buildLegacyEncryptionAAD(payload));
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function looksLikeCurrentEncryptedBlob(buffer) {
  return (
    buffer.length >= 4 &&
    buffer.subarray(0, 4).toString('ascii') === ENCRYPTED_BLOB_MAGIC
  );
}

function parseEncryptedBlob(buffer) {
  if (buffer.length <= ENCRYPTED_BLOB_HEADER_FIXED_LENGTH + AUTH_TAG_LENGTH_BYTES) {
    throw new Error('Encrypted payload is too small');
  }

  if (!looksLikeCurrentEncryptedBlob(buffer)) {
    throw new Error('Encrypted payload is missing the expected blob header');
  }

  const blobVersion = buffer[4];

  if (blobVersion !== ENCRYPTED_BLOB_VERSION) {
    throw new Error(`Unsupported encrypted blob version: ${blobVersion}`);
  }

  const keyIdLength = buffer[5];
  const ivLength = buffer[6];
  const headerLength = ENCRYPTED_BLOB_HEADER_FIXED_LENGTH + keyIdLength + ivLength;

  if (buffer.length <= headerLength + AUTH_TAG_LENGTH_BYTES) {
    throw new Error('Encrypted payload is truncated');
  }

  const keyIdStart = ENCRYPTED_BLOB_HEADER_FIXED_LENGTH;
  const keyIdEnd = keyIdStart + keyIdLength;
  const ivEnd = keyIdEnd + ivLength;

  return {
    blobVersion,
    keyId: buffer.subarray(keyIdStart, keyIdEnd).toString('utf8'),
    iv: buffer.subarray(keyIdEnd, ivEnd),
    authenticatedHeader: buffer.subarray(0, ivEnd),
    ciphertextWithTag: buffer.subarray(ivEnd),
  };
}

function decryptCurrentEncryptedBlob(buffer) {
  const parsed = parseEncryptedBlob(buffer);
  const key = getEncryptionKey(parsed.keyId);
  const authTag = parsed.ciphertextWithTag.subarray(
    parsed.ciphertextWithTag.length - AUTH_TAG_LENGTH_BYTES
  );
  const ciphertext = parsed.ciphertextWithTag.subarray(
    0,
    parsed.ciphertextWithTag.length - AUTH_TAG_LENGTH_BYTES
  );
  const decipher = crypto.createDecipheriv(NODE_ENCRYPTION_ALGORITHM, key, parsed.iv);

  decipher.setAAD(parsed.authenticatedHeader);
  decipher.setAuthTag(authTag);

  return {
    blobVersion: parsed.blobVersion,
    keyId: parsed.keyId,
    plaintext: Buffer.concat([decipher.update(ciphertext), decipher.final()]),
  };
}

function parseCurrentPlaintextPayload(plaintext) {
  if (plaintext.length < 5) {
    throw new Error('Decrypted payload is too small');
  }

  const metadataLength = plaintext.readUInt32BE(0);
  const metadataStart = 4;
  const metadataEnd = metadataStart + metadataLength;

  if (plaintext.length <= metadataEnd) {
    throw new Error('Decrypted payload is missing MIME data');
  }

  let metadata;

  try {
    metadata = JSON.parse(plaintext.subarray(metadataStart, metadataEnd).toString('utf8'));
  } catch (error) {
    throw new Error(`Decrypted metadata is not valid JSON: ${error.message}`);
  }

  return {
    metadata,
    rawMimeBuffer: plaintext.subarray(metadataEnd),
  };
}

function buildOutputBinary(rawMimeBuffer, eventId) {
  return {
    [OUTPUT_BINARY_PROPERTY]: {
      data: rawMimeBuffer.toString('base64'),
      mimeType: 'message/rfc822',
      fileName: `${eventId || 'message'}.eml`,
    },
  };
}

function buildLegacyOutputMetadata(payload, rawMimeBuffer) {
  return {
    source: payload.source ?? 'cloudflare-worker',
    eventId: payload.eventId ?? null,
    timestamp: payload.timestamp ?? null,
    envelope: payload.envelope ?? {
      from: null,
      to: null,
    },
    routing: payload.routing ?? {
      recipientDomain: null,
      recipientLocalPart: null,
    },
    headers: payload.headers ?? {
      messageId: null,
    },
    rawSize: payload.rawSize ?? rawMimeBuffer.length,
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

  const inputBuffer = await this.helpers.getBinaryDataBuffer(i, inputBinaryProperty);

  if (!inputBuffer?.length) {
    throw new Error(`Empty MIME payload in binary property "${inputBinaryProperty}"`);
  }

  let rawMimeBuffer;
  let decryptedMetadata;
  let decryptedFromMode = 'encrypted';

  if (looksLikeCurrentEncryptedBlob(inputBuffer)) {
    const decryptedBlob = decryptCurrentEncryptedBlob(inputBuffer);
    const parsedPayload = parseCurrentPlaintextPayload(decryptedBlob.plaintext);

    rawMimeBuffer = parsedPayload.rawMimeBuffer;
    decryptedMetadata = parsedPayload.metadata;
  } else if (payload.contentMode === 'encrypted' && payload.encryption?.iv) {
    rawMimeBuffer = decryptLegacyMimeBuffer(payload, inputBuffer);
    decryptedMetadata = buildLegacyOutputMetadata(payload, rawMimeBuffer);
    decryptedFromMode = 'encrypted-legacy';
  } else {
    rawMimeBuffer = inputBuffer;
    decryptedMetadata = buildLegacyOutputMetadata(payload, rawMimeBuffer);
    decryptedFromMode = payload.contentMode || 'plain';
  }

  if (!rawMimeBuffer?.length) {
    throw new Error('Decrypted MIME payload is empty');
  }

  returnData.push({
    json: {
      ...decryptedMetadata,
      contentMode: 'plain',
      decryptedFromMode,
      binaryProperty: OUTPUT_BINARY_PROPERTY,
    },
    binary: buildOutputBinary(rawMimeBuffer, decryptedMetadata.eventId),
  });
}

return returnData;
