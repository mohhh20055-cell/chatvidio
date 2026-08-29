// ============================================================
// حماية ضد ثغرة النقر المتكرر (Anti-Rapid-Click / Double Submit Protection)
// ============================================================

const recentRequests = new Map();

// تنظيف الطلبات القديمة دورياً كل دقيقة
setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of recentRequests.entries()) {
        if (now - timestamp > 5000) {
            recentRequests.delete(key);
        }
    }
}, 60 * 1000);

/**
 * Middleware لمنع النقر المتكرر وإرسال طلبات متطابقة في أقل من ثانية
 */
const antiRapidClickLimiter = (req, res, next) => {
    // نطبق الحماية فقط على طلبات التعديل والإرسال
    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
        return next();
    }

    // استثناء بعض المسارات الحساسة للوقت مثل ping أو webhooks
    if (req.path.includes('/sofizpay-callback') || req.path.includes('/ping') || req.path.includes('/stream-status')) {
        return next();
    }

    try {
        const userIdentifier = req.user?.userId || req.headers.authorization || req.ip || 'anonymous';
        const bodySignature = req.body ? JSON.stringify(req.body).slice(0, 200) : '';
        const requestKey = `${userIdentifier}:${req.method}:${req.path}:${bodySignature}`;

        const now = Date.now();
        const lastRequestTime = recentRequests.get(requestKey);

        // إذا تم إرسال نفس الطلب في أقل من 1000ms (ثانية واحدة)
        if (lastRequestTime && (now - lastRequestTime < 1000)) {
            return res.status(429).json({
                success: false,
                error: '⚠️ تم استلام طلبك بالفعل، يرجى الانتظار ثانية وعدم النقر المتكرر على الزر.'
            });
        }

        recentRequests.set(requestKey, now);
        next();
    } catch (err) {
        next();
    }
};

const authLimiter = (req, res, next) => next();
const generalLimiter = (req, res, next) => next();

module.exports = {
    antiRapidClickLimiter,
    authLimiter,
    generalLimiter
};
