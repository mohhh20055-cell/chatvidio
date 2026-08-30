const bcrypt = require('bcryptjs');

// ============================================================
// إعدادات وبيانات اعتماد لوحة التحكم (الآدمن)
// Admin Dashboard Credentials & Configuration
// ============================================================

// البريد الإلكتروني المعقد والآمن للآدمن (يمكن تغييره من متغيرات البيئة)
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin_secure_98327@platform-dz.com').trim().toLowerCase();

// كلمة المرور القوية والمعقدة للآدمن (يمكن تغييرها من متغيرات البيئة)
const DEFAULT_ADMIN_PASS = process.env.ADMIN_PASSWORD || 'A9$kL#2pQ!xM7@vR9#2026';

// تجزئة كلمة المرور (سواء كانت ممررة مباشرة كهاش أو مشتقة من كلمة المرور)
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync(DEFAULT_ADMIN_PASS, 12);

/**
 * التحقق من صحة بيانات دخول الآدمن
 * @param {string} email 
 * @param {string} password 
 * @returns {boolean}
 */
function verifyAdminCredentials(email, password) {
    if (!email || !password) return false;
    const cleanEmail = String(email).trim().toLowerCase();
    if (cleanEmail !== ADMIN_EMAIL) return false;
    return bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
}

module.exports = {
    ADMIN_EMAIL,
    ADMIN_PASSWORD_HASH,
    verifyAdminCredentials
};
