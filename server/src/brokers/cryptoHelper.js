const crypto = require('crypto');

// Use env encryption key, fall back to a default 32-byte key for local development
const ENCRYPTION_KEY = process.env.BROKER_ENCRYPTION_KEY || 'd5a7f9b8c6e4d2a1b3c5e7f9a8b6c4d2'; // 32 bytes

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12); // 12 bytes for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'utf-8'), iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  return {
    encryptedText: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag
  };
}

function decrypt(encryptedText, ivHex, authTagHex) {
  if (!encryptedText || !ivHex || !authTagHex) return null;
  
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'utf-8'), iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

function encryptWithHeader(text) {
  if (!text) return null;
  const res = encrypt(text);
  return `${res.iv}:${res.authTag}:${res.encryptedText}`;
}

function decryptWithHeader(headerText) {
  if (!headerText) return null;
  const parts = headerText.split(':');
  if (parts.length !== 3) return null;
  const [ivHex, authTagHex, encryptedText] = parts;
  return decrypt(encryptedText, ivHex, authTagHex);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedValue) {
  if (!storedValue || !storedValue.includes(':')) return false;
  const [salt, originalHash] = storedValue.split(':');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === originalHash;
}

const JWT_SECRET = ENCRYPTION_KEY;

function generateToken(email) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 86400 * 7 })).toString('base64url'); // 7 days
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
    if (signature !== expectedSig) return null;
    const decodedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decodedPayload.exp && decodedPayload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return decodedPayload;
  } catch (e) {
    return null;
  }
}

module.exports = {
  encrypt,
  decrypt,
  encryptWithHeader,
  decryptWithHeader,
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken
};

