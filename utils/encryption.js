// utils/encryption.js
// ============================================================
// دوال التشفير وفك التشفير
// ============================================================

const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ENCRYPTION_IV = process.env.ENCRYPTION_IV || crypto.randomBytes(16).toString('hex');

function encrypt(text) {
    if (!text) return null;
    try {
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), Buffer.from(ENCRYPTION_IV, 'hex'));
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
    } catch (error) {
        console.error('خطأ في التشفير:', error.message);
        return null;
    }
}

function decrypt(encrypted) {
    if (!encrypted) return null;
    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), Buffer.from(ENCRYPTION_IV, 'hex'));
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        console.error('خطأ في فك التشفير:', error.message);
        return null;
    }
}

function maskIP(ip) {
    if (!ip) return null;
    const parts = ip.split('.');
    if (parts.length === 4) {
        parts[3] = 'xxx';
        return parts.join('.');
    }
    return ip;
}

module.exports = {
    encrypt,
    decrypt,
    maskIP
};
