// ============================================================
// دوال مساعدة عامة
// ============================================================

const { supabase } = require('../config/database');
const crypto = require('crypto');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');

const teacherFollowersFilePath = path.join(__dirname, '../data/teacher_followers.json');

async function loadLocalTeacherFollowers() {
    try {
        if (fs.existsSync(teacherFollowersFilePath)) {
            const content = await fs.promises.readFile(teacherFollowersFilePath, 'utf8');
            return JSON.parse(content) || [];
        }
    } catch (e) {
        logger.error('Error loading local teacher followers:', e.message);
    }
    return [];
}

async function saveLocalTeacherFollowers(list) {
    try {
        const dir = path.dirname(teacherFollowersFilePath);
        if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(teacherFollowersFilePath, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {
        logger.error('Error saving local teacher followers:', e.message);
    }
}

function sanitizeInput(input) {
    if (typeof input === 'string') {
        return input.trim();
    }
    return input;
}

function sanitizeObject(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
            sanitized[key] = sanitizeInput(value);
        } else if (Array.isArray(value)) {
            sanitized[key] = value.map(v => typeof v === 'string' ? sanitizeInput(v) : v);
        } else if (value && typeof value === 'object') {
            sanitized[key] = sanitizeObject(value);
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

function generateVerificationToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateReferralCode(name, id) {
    const numericId = typeof id === 'string' ? parseInt(id, 10) : id;
    const base = numericId || 1000;
    const suffix = (base + 5371).toString().slice(-6);
    return suffix;
}

async function getOne(table, column, value) {
    try {
        const { data, error } = await supabase
            .from(table)
            .select('*')
            .eq(column, value)
            .single();
        if (error && error.code !== 'PGRST116') {
            logger.error(`خطأ في getOne من جدول ${table}`, { 
                table, 
                column, 
                value,
                error: error.message 
            });
            return null;
        }
        return data;
    } catch (error) {
        logger.error(`استثناء في getOne من جدول ${table}`, { 
            table, 
            column, 
            error: error.message,
            stack: error.stack 
        });
        return null;
    }
}

function extractMissingColumn(msg) {
    if (!msg || typeof msg !== 'string') return null;
    let match = msg.match(/Could not find the '([^']+)' column/i);
    if (match && match[1]) return match[1];
    match = msg.match(/column "([^"]+)"/i);
    if (match && match[1]) return match[1];
    match = msg.match(/column '([^']+)'/i);
    if (match && match[1]) return match[1];
    match = msg.match(/find column '([^']+)'/i);
    if (match && match[1]) return match[1];
    return null;
}

async function insert(table, data) {
    let sanitizedData = sanitizeObject(data);
    let attempts = 0;
    while (attempts < 10) {
        try {
            const { data: result, error } = await supabase.from(table).insert(sanitizedData).select();
            if (error) {
                const missingCol = extractMissingColumn(error.message);
                if (missingCol) {
                    logger.warn(`⚠️ العمود [${missingCol}] غير موجود في الجدول [${table}]، سيتم حذفه وإعادة المحاولة.`, { table });
                    delete sanitizedData[missingCol];
                    attempts++;
                    continue;
                }
                logger.error(`خطأ في insert إلى جدول ${table}`, { 
                    table, 
                    data: sanitizedData,
                    error: error.message 
                });
                throw error;
            }
            
            if (!result || result.length === 0) {
                logger.error(`فشل إدخال البيانات في جدول ${table} - لا توجد نتائج`, { table, data: sanitizedData });
                return null;
            }

            logger.debug(`تم إدخال بيانات في جدول ${table}`, { table, insertedId: result[0].id });
            return result[0];
        } catch (error) {
            const missingCol = extractMissingColumn(error.message);
            if (missingCol) {
                logger.warn(`⚠️ استثناء: العمود [${missingCol}] غير موجود في الجدول [${table}]، سيتم حذفه وإعادة المحاولة.`, { table });
                delete sanitizedData[missingCol];
                attempts++;
                continue;
            }
            logger.error(`استثناء في insert إلى جدول ${table}`, { 
                table, 
                error: error.message,
                stack: error.stack 
            });
            throw error;
        }
    }
}

async function update(table, id, data) {
    let sanitizedData = sanitizeObject(data);
    let attempts = 0;
    while (attempts < 10) {
        try {
            const { data: result, error } = await supabase.from(table).update(sanitizedData).eq('id', id).select();
            if (error) {
                const missingCol = extractMissingColumn(error.message);
                if (missingCol) {
                    logger.warn(`⚠️ العمود [${missingCol}] غير موجود في الجدول [${table}]، سيتم حذفه وإعادة المحاولة لتحديث السجل.`, { table, id });
                    delete sanitizedData[missingCol];
                    attempts++;
                    continue;
                }
                logger.error(`خطأ في update لجدول ${table}`, { 
                    table, 
                    id, 
                    data: sanitizedData,
                    error: error.message 
                });
                throw error;
            }

            if (!result || result.length === 0) {
                logger.warn(`لم يتم العثور على سجل لتحديثه في جدول ${table}`, { id });
                return null;
            }

            logger.debug(`تم تحديث بيانات في جدول ${table}`, { table, id });
            return result[0];
        } catch (error) {
            const missingCol = extractMissingColumn(error.message);
            if (missingCol) {
                logger.warn(`⚠️ استثناء: العمود [${missingCol}] غير موجود في الجدول [${table}]، سيتم حذفه وإعادة المحاولة لتحديث السجل.`, { table, id });
                delete sanitizedData[missingCol];
                attempts++;
                continue;
            }
            logger.error(`استثناء في update لجدول ${table}`, { 
                table, 
                id, 
                error: error.message,
                stack: error.stack 
            });
            throw error;
        }
    }
}

async function updateWithCondition(table, id, expectedBalanceField, expectedBalanceValue, data) {
    try {
        const sanitizedData = sanitizeObject(data);
        const { data: result, error } = await supabase.from(table).update(sanitizedData).eq('id', id).eq(expectedBalanceField, expectedBalanceValue).select();

        if (error) {
            logger.error(`خطأ في updateWithCondition لجدول ${table}`, { 
                table, id, data: sanitizedData, error: error.message 
            });
            throw error;
        }

        if (!result || result.length === 0) {
            return null; // Condition not met or record not found
        }

        return result[0];
    } catch (error) {
        throw error;
    }
}

async function remove(table, column, value) {
    try {
        const { error } = await supabase.from(table).delete().eq(column, value);
        if (error) {
            logger.error(`خطأ في remove من جدول ${table}`, { 
                table, 
                column, 
                value,
                error: error.message 
            });
            throw error;
        }
        return true;
    } catch (error) {
        logger.error(`استثناء في remove من جدول ${table}`, { 
            table, 
            column, 
            value,
            error: error.message,
            stack: error.stack 
        });
        throw error;
    }
}

async function isNameTaken(name, excludeUserId = null, excludeRole = null) {
    if (!name || typeof name !== 'string') return { taken: false };
    const cleanName = name.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!cleanName) return { taken: false };

    try {
        // 1. فحص جدول الأساتذة
        try {
            const { data: teachers, error: tErr } = await supabase
                .from('teachers')
                .select('id, full_name, name')
                .limit(500);

            if (!tErr && teachers && teachers.length > 0) {
                const match = teachers.find(t => {
                    if (excludeRole === 'teacher' && excludeUserId && String(t.id) === String(excludeUserId)) {
                        return false;
                    }
                    const tFullName = (t.full_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
                    const tName = (t.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
                    return (tFullName && tFullName === cleanName) || (tName && tName === cleanName);
                });
                if (match) {
                    return { taken: true, role: 'teacher', user: match };
                }
            }
        } catch (te) {
            logger.warn('خطأ في فحص اسم الأستاذ:', te.message);
        }

        // 2. فحص جدول الطلاب
        try {
            const { data: students, error: sErr } = await supabase
                .from('students')
                .select('id, full_name, name')
                .limit(500);

            if (!sErr && students && students.length > 0) {
                const match = students.find(s => {
                    if (excludeRole === 'student' && excludeUserId && String(s.id) === String(excludeUserId)) {
                        return false;
                    }
                    const sFullName = (s.full_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
                    const sName = (s.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
                    return (sFullName && sFullName === cleanName) || (sName && sName === cleanName);
                });
                if (match) {
                    return { taken: true, role: 'student', user: match };
                }
            }
        } catch (se) {
            logger.warn('خطأ في فحص اسم الطالب:', se.message);
        }

        return { taken: false };
    } catch (err) {
        logger.error('استثناء في التحقق من فرادة الاسم:', err.message);
        return { taken: false };
    }
}

// ============================================================
// ✅ إتمام الحجز تلقائياً للحصص المجانية بمجرد دخول الطالب البث
// ============================================================
async function autoBookFreeSession(offerOrOfferId, studentId) {
    if (!offerOrOfferId || !studentId) return null;
    try {
        const parsedStudentId = parseInt(studentId, 10);
        if (isNaN(parsedStudentId)) return null;

        let offer = offerOrOfferId;
        if (typeof offerOrOfferId === 'number' || typeof offerOrOfferId === 'string' || !offerOrOfferId.id) {
            offer = await getOne('offers', 'id', parseInt(offerOrOfferId, 10));
        }
        if (!offer) return null;

        const isFree = (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1 || offer.is_free === '1') || parseFloat(offer.price || 0) === 0;
        if (!isFree) return null;

        // 1. فحص وجود حجز سابق للطالب
        const { data: existing } = await supabase
            .from('sessions')
            .select('*')
            .eq('offer_id', offer.id)
            .eq('student_id', parsedStudentId)
            .maybeSingle();

        let session = existing;

        if (session && session.payment_status === 'cancelled') {
            await supabase.from('sessions').delete().eq('id', session.id);
            session = null;
        }

        if (!session) {
            // إنشاء حجز مجاني فعال فوراً
            const newSessionData = {
                student_id: parsedStudentId,
                offer_id: offer.id,
                teacher_id: offer.teacher_id,
                amount_paid: 0,
                payment_amount: 0,
                pending_balance: 0,
                platform_fee: 0,
                teacher_earnings: 0,
                teacher_earned: 0,
                payment_status: 'paid',
                status: 'active',
                created_at: new Date().toISOString()
            };

            session = await insert('sessions', newSessionData);

            if (session) {
                // تحديث عدد المحجوزات للحصة
                try {
                    const { count: bookedCount } = await supabase
                        .from('sessions')
                        .select('*', { count: 'exact', head: true })
                        .eq('offer_id', offer.id);
                    if (bookedCount) {
                        await update('offers', offer.id, { booked_count: bookedCount });
                    }
                } catch (bErr) {}

                // إضافة الطالب لغرفة الانتظار
                try {
                    await insert('waiting_room', {
                        offer_id: offer.id,
                        student_id: parsedStudentId,
                        added_at: new Date().toISOString()
                    });
                } catch (wErr) {}
            }
        }

        // 2. إذا كان البث جارياً، إضافة الطالب للبث النشط تلقائياً
        if (session && ['live', 'teacher_ready', 'paused'].includes(offer.status)) {
            try {
                const { data: active } = await supabase
                    .from('active_stream')
                    .select('id')
                    .eq('offer_id', offer.id)
                    .eq('student_id', parsedStudentId)
                    .maybeSingle();

                if (!active) {
                    await insert('active_stream', {
                        offer_id: offer.id,
                        student_id: parsedStudentId,
                        joined_at: new Date().toISOString(),
                        added_at: new Date().toISOString()
                    });
                }
            } catch (aErr) {}
        }

        return session;
    } catch (err) {
        if (typeof logger !== 'undefined' && logger.error) {
            logger.error('خطأ في autoBookFreeSession:', err.message);
        } else {
            console.error('خطأ في autoBookFreeSession:', err.message);
        }
        return null;
    }
}

module.exports = {
    sanitizeInput,
    sanitizeObject,
    generateVerificationToken,
    generateReferralCode,
    isNameTaken,
    getOne,
    insert,
    update,
    updateWithCondition,
    remove,
    loadLocalTeacherFollowers,
    saveLocalTeacherFollowers,
    autoBookFreeSession
};
