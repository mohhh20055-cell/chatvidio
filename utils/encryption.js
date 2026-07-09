// utils/encryption.js
// ============================================================
// دوال التشفير وفك التشفير
// ============================================================

const crypto = require('crypto');

// ⚠️警告:生产环境必须设置这些环境变量
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ENCRYPTION_IV = process.env.ENCRYPTION_IV;

// 开发环境的默认密钥（仅用于本地开发）
const DEV_KEY = crypto.randomBytes(32).toString('hex');
const DEV_IV = crypto.randomBytes(16).toString('hex');

if (!ENCRYPTION_KEY || !ENCRYPTION_IV) {
    console.warn('⚠️ 警告: ENCRYPTION_KEY 或 ENCRYPTION_IV 未设置');
    console.warn('⚠️ 警告: 加密数据将在服务器重启后无法解密');
    console.warn('⚠️ 提示: 请在生产环境中设置这些环境变量');
}

const KEY = ENCRYPTION_KEY || DEV_KEY;
const IV = ENCRYPTION_IV || DEV_IV;

function encrypt(text) {
    if (!text) return null;
    try {
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(KEY, 'hex'), Buffer.from(IV, 'hex'));
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
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(KEY, 'hex'), Buffer.from(IV, 'hex'));
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
