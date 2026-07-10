// ============================================================
// معالج الأخطاء الشامل
// ============================================================

const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
    // تسجيل الخطأ في السجلات
    const errorInfo = {
        method: req.method,
        url: req.originalUrl || req.url,
        ip: req.ip || req.connection?.remoteAddress,
        userAgent: req.get('User-Agent'),
        userId: req.user?.userId,
        userRole: req.user?.role,
        statusCode: res.statusCode,
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
        timestamp: new Date().toISOString(),
        body: req.body ? Object.keys(req.body) : null,
        params: req.params ? Object.keys(req.params) : null
    };
    
    // تصنيف نوع الخطأ
    let errorType = 'UNKNOWN';
    let logLevel = 'error';
    
    if (err.message && err.message.includes('غير مسموح به من هذا المصدر')) {
        errorType = 'CORS_ERROR';
        logger.logSecurityEvent('محاولة وصول CORS محظورة', errorInfo);
        return res.status(403).json({
            success: false,
            error: 'غير مسموح به من هذا المصدر',
            origin: req.headers.origin || 'unknown',
            errorId: Date.now()
        });
    }
    
    if (err.name === 'ValidationError') {
        errorType = 'VALIDATION_ERROR';
        logger.warn('خطأ في التحقق من البيانات', errorInfo);
        return res.status(400).json({
            success: false,
            error: err.message,
            errorType: errorType,
            errorId: Date.now()
        });
    }
    
    if (err.name === 'MulterError') {
        errorType = 'UPLOAD_ERROR';
        logger.warn('خطأ في رفع الملف', errorInfo);
        return res.status(400).json({
            success: false,
            error: err.message,
            errorType: errorType,
            errorId: Date.now()
        });
    }
    
    if (err.name === 'JsonWebTokenError') {
        errorType = 'JWT_ERROR';
        logger.logSecurityEvent('خطأ في JWT', {
            ...errorInfo,
            errorCode: err.code
        });
        return res.status(401).json({
            success: false,
            error: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مرة أخرى',
            errorType: errorType,
            errorId: Date.now()
        });
    }
    
    if (err.code === '23505') {
        errorType = 'DUPLICATE_ENTRY';
        logger.warn('محاولة إدخال سجل مكرر', errorInfo);
        return res.status(409).json({
            success: false,
            error: 'هذا السجل موجود بالفعل',
            errorType: errorType,
            errorId: Date.now()
        });
    }
    
    if (err.code && err.code.startsWith('PGRST')) {
        errorType = 'DATABASE_ERROR';
        logger.error('خطأ في قاعدة البيانات', errorInfo);
        return res.status(500).json({
            success: false,
            error: 'حدث خطأ في قاعدة البيانات',
            errorType: errorType,
            errorId: Date.now()
        });
    }
    
    // خطأ عام
    logger.error('خطأ في الخادم', errorInfo);
    
    res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'production' 
            ? 'حدث خطأ داخلي في الخادم' 
            : err.message,
        errorType: errorType,
        errorId: Date.now()
    });
}

// ============================================================
// معالج 404
// ============================================================

function notFoundHandler(req, res, next) {
    logger.warn('مسار غير موجود', {
        method: req.method,
        url: req.originalUrl || req.url,
        ip: req.ip
    });
    
    res.status(404).json({
        success: false,
        error: 'المسار غير موجود',
        path: req.originalUrl || req.url,
        errorId: Date.now()
    });
}

module.exports = {
    errorHandler,
    notFoundHandler
};
