// ============================================================
// إعدادات تحديد معدل الطلبات
// ============================================================

const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { success: false, error: 'عدد محاولات تسجيل الدخول كبير جداً، حاول بعد ساعة' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.body && req.body.email) {
            return req.body.email;
        }
        return req.ip || req.connection?.remoteAddress || 'unknown';
    }
});

const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { success: false, error: 'عدد الطلبات كبير جداً، حاول بعد 15 دقيقة' },
    standardHeaders: true,
    legacyHeaders: false
});

module.exports = {
    authLimiter,
    generalLimiter
};
