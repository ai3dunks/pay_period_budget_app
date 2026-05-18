import crypto from 'crypto';

const PREFIX = 'enc:v1:';

function getSecretKey() {
  const secret = process.env.LOCAL_DATA_KEY || process.env.LOCAL_API_TOKEN;
  if (!secret) return null;
  return crypto.createHash('sha256').update(String(secret)).digest();
}

export function encryptSecret(value) {
  if (value === null || value === undefined || value === '') return value ?? null;
  const key = getSecretKey();
  if (!key) return String(value);

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(value) {
  if (!value || typeof value !== 'string') return value ?? null;
  if (!value.startsWith(PREFIX)) return value;

  const key = getSecretKey();
  if (!key) {
    throw new Error('LOCAL_DATA_KEY or LOCAL_API_TOKEN is required to decrypt stored secrets.');
  }

  const [ivText, tagText, ciphertextText] = value.slice(PREFIX.length).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function shouldStoreRawPlaidJson() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.STORE_RAW_PLAID_JSON || '').trim().toLowerCase());
}
