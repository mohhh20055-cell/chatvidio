// ============================================================
// نظام تسجيل الأخطاء والمراقبة المتكامل
// ============================================================

const fs = require('fs');
const path = require('path');

// ============================================================
// إعدادات السجل
// ============================================================

const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
};

const LOG_LEVEL = process.env.LOG_LEVEL 
    ? LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] || LOG_LEVELS.INFO 
    : LOG_LEVELS.INFO;

// مجلد السجلات
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
const ERROR_LOG_FILE = path.join(LOG_DIR, 'errors.log');
const ACCESS_LOG_FILE = path.join(LOG_DIR, 'access.log');
const AUDIT_LOG_FILE = path.join(LOG_DIR, 'audit.log');

// ============================================================
// إنشاء مجلد السجلات إذا لم يكن موجوداً
// ============================================================

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        try {
            fs.mkdirSync(LOG_DIR, { recursive: true });
            console.log('✅ تم إنشاء مجلد السجلات:', LOG_DIR);
        } catch (error) {
            console.error('❌ فشل في إنشاء مجلد السجلات:', error.message);
        }
    }
}

ensureLogDir();

// ============================================================
// دالة تنسيق التاريخ
// ============================================================

function formatDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

// ============================================================
// دالة تنسيق التفاصيل
// ============================================================

function formatLogEntry(level, message, details = {}) {
    const timestamp = formatDate();
    const detailsStr = Object.keys(details).length > 0 
        ? '\n  Details: ' + JSON.stringify(details, null, 2).replace(/\n/g, '\n    ')
        : '';
    
    return `[${timestamp}] [${level}] ${message}${detailsStr}`;
}

// ============================================================
// دالة كتابة السجل إلى ملف
// ============================================================

function writeToFile(filePath, content) {
    try {
        fs.appendFileSync(filePath, content + '\n');
    } catch (error) {
        console.error('❌ فشل في كتابة السجل:', error.message);
    }
}

// ============================================================
// نظام التخزين المؤقت للسجلات (للعرض على الواجهة)
// ============================================================

const MAX_LOGS_IN_MEMORY = 1000;
const logsInMemory = {
    errors: [],
    warnings: [],
    info: [],
    debug: []
};

// ============================================================
// إضافة سجل إلى الذاكرة المؤقتة
// ============================================================

function addToMemory(type, entry) {
    if (!logsInMemory[type]) {
        logsInMemory[type] = [];
    }
    
    logsInMemory[type].push(entry);
    
    // الحفاظ على الحد الأقصى
    if (logsInMemory[type].length > MAX_LOGS_IN_MEMORY) {
        logsInMemory[type].shift();
    }
}

// ============================================================
// دوال التسجيل
// ============================================================

/**
 * تسجيل خطأ
 */
function error(message, details = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        message: message,
        details: details,
        stack: details.stack || null
    };
    
    const formatted = formatLogEntry('ERROR', message, details);
    
    // طباعة في وحدة التحكم
    console.error('❌', formatted);
    
    // كتابة إلى ملف الأخطاء
    writeToFile(ERROR_LOG_FILE, formatted);
    
    // إضافة إلى الذاكرة المؤقتة
    addToMemory('errors', entry);
    
    return entry;
}

/**
 * تسجيل تحذير
 */
function warn(message, details = {}) {
    if (LOG_LEVEL < LOG_LEVELS.WARN) return;
    
    const entry = {
        timestamp: new Date().toISOString(),
        message: message,
        details: details
    };
    
    const formatted = formatLogEntry('WARN', message, details);
    
    // طباعة في وحدة التحكم
    console.warn('⚠️', formatted);
    
    // كتابة إلى ملف الأخطاء
    writeToFile(ERROR_LOG_FILE, formatted);
    
    // إضافة إلى الذاكرة المؤقتة
    addToMemory('warnings', entry);
    
    return entry;
}

/**
 * تسجيل معلومات
 */
function info(message, details = {}) {
    if (LOG_LEVEL < LOG_LEVELS.INFO) return;
    
    const entry = {
        timestamp: new Date().toISOString(),
        message: message,
        details: details
    };
    
    const formatted = formatLogEntry('INFO', message, details);
    
    // طباعة في وحدة التحكم
    console.log('ℹ️', formatted);
    
    // كتابة إلى ملف السجلات العام
    writeToFile(ACCESS_LOG_FILE, formatted);
    
    // إضافة إلى الذاكرة المؤقتة
    addToMemory('info', entry);
    
    return entry;
}

/**
 * تسجيل للتصحيح
 */
function debug(message, details = {}) {
    if (LOG_LEVEL < LOG_LEVELS.DEBUG) return;
    
    const entry = {
        timestamp: new Date().toISOString(),
        message: message,
        details: details
    };
    
    const formatted = formatLogEntry('DEBUG', message, details);
    
    // طباعة في وحدة التحكم
    console.log('🔍', formatted);
    
    // إضافة إلى الذاكرة المؤقتة
    addToMemory('debug', entry);
    
    return entry;
}

// ============================================================
// تسجيل أخطاء Express
// ============================================================

function logExpressError(error, req = {}, res = {}) {
    const errorInfo = {
        method: req.method,
        url: req.originalUrl || req.url,
        ip: req.ip || req.connection?.remoteAddress,
        userAgent: req.get('User-Agent'),
        userId: req.user?.userId,
        userRole: req.user?.role,
        statusCode: res.statusCode,
        errorName: error.name,
        errorMessage: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
    };
    
    return error(message, errorInfo);
}

// ============================================================
// تسجيل أحداث الأمان
// ============================================================

function logSecurityEvent(event, details = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        event: event,
        details: details
    };
    
    const formatted = `[${entry.timestamp}] [SECURITY] ${event}\n  Details: ${JSON.stringify(details, null, 2)}`;
    
    // طباعة
    console.warn('🔒 [SECURITY]', event, details);
    
    // كتابة إلى ملف التدقيق
    writeToFile(AUDIT_LOG_FILE, formatted);
    
    return entry;
}

// ============================================================
// الحصول على السجلات من الذاكرة
// ============================================================

function getLogs(type = 'all', limit = 100) {
    if (type === 'all') {
        return {
            errors: logsInMemory.errors.slice(-limit),
            warnings: logsInMemory.warnings.slice(-limit),
            info: logsInMemory.info.slice(-limit),
            debug: logsInMemory.debug.slice(-limit)
        };
    }
    
    return (logsInMemory[type] || []).slice(-limit);
}

// ============================================================
// الحصول على آخر الأخطاء
// ============================================================

function getRecentErrors(limit = 50) {
    return logsInMemory.errors.slice(-limit);
}

// ============================================================
// الحصول على إحصائيات السجلات
// ============================================================

function getLogStats() {
    return {
        totalErrors: logsInMemory.errors.length,
        totalWarnings: logsInMemory.warnings.length,
        totalInfo: logsInMemory.info.length,
        totalDebug: logsInMemory.debug.length,
        lastError: logsInMemory.errors.length > 0 
            ? logsInMemory.errors[logsInMemory.errors.length - 1] 
            : null,
        lastWarning: logsInMemory.warnings.length > 0 
            ? logsInMemory.warnings[logsInMemory.warnings.length - 1] 
            : null,
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime()
    };
}

// ============================================================
// مسح السجلات من الذاكرة
// ============================================================

function clearMemory() {
    logsInMemory.errors = [];
    logsInMemory.warnings = [];
    logsInMemory.info = [];
    logsInMemory.debug = [];
    
    info('تم مسح سجلات الذاكرة المؤقتة');
}

// ============================================================
// تصدير الوحدة
// ============================================================

module.exports = {
    error,
    warn,
    info,
    debug,
    logExpressError,
    logSecurityEvent,
    getLogs,
    getRecentErrors,
    getLogStats,
    clearMemory,
    LOG_LEVELS
};
