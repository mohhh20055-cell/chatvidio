const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');
const { getOne, update } = require('./helpers');

let dataDir = path.join(__dirname, '..', 'data');
let storePath = path.join(dataDir, 'views_store.json');

// حاول استخدام مجلد data أو الانتقال إلى os.tmpdir() في بيئات الاستضافة ذات النظام غير القابل للكتابة (Read-Only)
try {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
} catch (e) {
    dataDir = os.tmpdir();
    storePath = path.join(dataDir, 'views_store.json');
}

// تحميل المشاهدات المخزنة محلياً
const viewsCounts = new Map();
const uniqueViewsMap = new Map();

function loadStore() {
    try {
        if (fs.existsSync(storePath)) {
            const raw = fs.readFileSync(storePath, 'utf8');
            const data = JSON.parse(raw);
            if (data && typeof data === 'object') {
                for (const [k, v] of Object.entries(data)) {
                    if (typeof v === 'number') {
                        viewsCounts.set(k, v);
                    }
                }
            }
        }
    } catch (e) {
        // التجاهل عند عدم إمكانية القراءة
    }
}

let saveTimer = null;
function persistStore() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            const obj = {};
            for (const [k, v] of viewsCounts.entries()) {
                obj[k] = v;
            }
            fs.writeFileSync(storePath, JSON.stringify(obj, null, 2), 'utf8');
        } catch (e) {
            if (e.code === 'EROFS' || e.message?.includes('read-only')) {
                try {
                    storePath = path.join(os.tmpdir(), 'views_store.json');
                    const obj = {};
                    for (const [k, v] of viewsCounts.entries()) {
                        obj[k] = v;
                    }
                    fs.writeFileSync(storePath, JSON.stringify(obj, null, 2), 'utf8');
                } catch (tmpErr) {
                    // التجاهل الصامت في حالة بيئات العرض المؤقت القابلة للقراءة فقط
                }
            }
        }
    }, 1000);
}

// تحميل المشاهدات عند بدء التشغيل
loadStore();

// تنظيف ذاكرة المشاهدات الفريدة كل ساعة (أقدم من 24 ساعة)
setInterval(() => {
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    for (const [key, timestamp] of uniqueViewsMap.entries()) {
        if (now - timestamp > TWENTY_FOUR_HOURS) {
            uniqueViewsMap.delete(key);
        }
    }
}, 3600000);

function getViewCount(type, id, dbViews) {
    const key = `${type}_${id}`;
    const stored = viewsCounts.get(key) || 0;
    const db = parseInt(dbViews, 10) || 0;
    const maxVal = Math.max(stored, db);
    if (maxVal > stored) {
        viewsCounts.set(key, maxVal);
        persistStore();
    }
    return maxVal;
}

function syncItemViews(type, item) {
    if (!item) return item;
    if (Array.isArray(item)) {
        return item.map(i => syncItemViews(type, i));
    }
    const count = getViewCount(type, item.id, item.views_count || item.views);
    item.views_count = count;
    item.views = count;
    return item;
}

async function recordUniqueView(table, idField, id, req, type) {
    if (!id) return null;
    const numericId = parseInt(id, 10);
    if (isNaN(numericId)) return null;

    const item = await getOne(table, idField, numericId);
    if (!item) return null;

    let userRole = req?.user?.role || null;
    let userId = req?.user?.userId || req?.user?.id || null;
    const authHeader = req?.headers ? req.headers['authorization'] : null;
    
    if (!userId && authHeader) {
        try {
            const token = authHeader.split(' ')[1];
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'zoomdz_secret_key_2026');
            userRole = decoded.role;
            userId = decoded.userId || decoded.id;
        } catch (e) {}
    }

    const currentViews = getViewCount(type, numericId, item.views_count || item.views);

    // استثناء صاحب المحتوى (الأستاذ) من احتساب مشاهدات محتواه الخاص
    if (userRole === 'teacher' && userId && parseInt(item.teacher_id, 10) === parseInt(userId, 10)) {
        return { counted: false, views: currentViews };
    }

    const clientIp = req?.headers?.['x-forwarded-for']?.split(',')[0].trim() || req?.ip || req?.socket?.remoteAddress || '127.0.0.1';
    const identifier = (userRole && userId) ? `user_${userId}` : `ip_${clientIp}`;
    const dedupeKey = `${type}_${numericId}_${identifier}`;
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const lastView = uniqueViewsMap.get(dedupeKey);

    if (lastView && (now - lastView < TWENTY_FOUR_HOURS)) {
        return { counted: false, views: currentViews };
    }

    uniqueViewsMap.set(dedupeKey, now);
    const newViews = currentViews + 1;
    viewsCounts.set(`${type}_${numericId}`, newViews);
    persistStore();

    try {
        const updateData = {};
        if (item.views_count !== undefined) {
            updateData.views_count = newViews;
        } else if (item.views !== undefined) {
            updateData.views = newViews;
        } else {
            updateData.views_count = newViews;
        }
        await update(table, numericId, updateData);
    } catch (err) {
        logger.warn(`⚠️ تعذر تحديث عدد المشاهدات لـ ${type} ${numericId} في قاعدة البيانات:`, err.message);
    }

    return { counted: true, views: newViews };
}

module.exports = {
    recordUniqueView,
    getViewCount,
    syncItemViews
};
