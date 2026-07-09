// ============================================================
// دوال JWT
// ============================================================

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'zoomdz_secret_key_2024_for_testing_only';
const JWT_EXPIRY = '24h';

function generateToken(userId, role, email) {
    return jwt.sign(
        { userId, role, email },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
    );
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return null;
    }
}

module.exports = {
    generateToken,
    verifyToken,
    JWT_SECRET,
    JWT_EXPIRY
};
