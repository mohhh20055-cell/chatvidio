// ============================================================
// Middleware المصادقة والتفويض (معدل بالكامل مع دعم نظام البث)
// ============================================================

const { verifyToken } = require('../utils/jwt');
const { encrypt } = require('../utils/encryption');
const { supabase } = require('../config/database');

// ============================================================
// ✅ المصادقة - التحقق من التوكن
// ============================================================
async function authenticate(req, res, next) {
    let token = req.headers.authorization?.substring(7);
    if (!token && req.query.token) {
        token = req.query.token;
    }
    
    if (!token) {
        return res.status(401).json({ 
            success: false, 
            error: '❌ غير مصرح به، يرجى تسجيل الدخول' 
        });
    }

    const decoded = verifyToken(token);
    
    if (!decoded) {
        return res.status(401).json({ 
            success: false, 
            error: '❌ انتهت صلاحية الجلسة، يرجى تسجيل الدخول مرة أخرى' 
        });
    }

    // ✅ التحقق من أن المستخدم لا يزال موجوداً في قاعدة البيانات
    const tableName = decoded.role === 'student' ? 'students' : 'teachers';
    const { data: user, error } = await supabase
        .from(tableName)
        .select('id, is_banned, status')
        .eq('id', decoded.userId)
        .single();

    if (error || !user) {
        return res.status(401).json({ 
            success: false, 
            error: '❌ المستخدم غير موجود، يرجى تسجيل الدخول مرة أخرى' 
        });
    }

    // ✅ التحقق من الحظر
    if (user.is_banned) {
        return res.status(403).json({
            success: false,
            error: '⛔ تم حظر حسابك من المنصة',
            banned: true
        });
    }

    // ✅ التحقق من حالة الأستاذ
    if (decoded.role === 'teacher' && user.status !== 'approved') {
        return res.status(403).json({
            success: false,
            error: `⏳ حسابك غير مفعل. الحالة: ${user.status === 'pending' ? 'قيد المراجعة' : 'غير معتمد'}`,
            status: user.status
        });
    }

    req.user = decoded;
    req.token = token;
    next();
}

// ============================================================
// ✅ التفويض - التحقق من الصلاحيات
// ============================================================
function authorize(roles = []) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ 
                success: false, 
                error: '❌ غير مصرح به، يرجى تسجيل الدخول' 
            });
        }
        if (roles.length > 0 && !roles.includes(req.user.role)) {
            return res.status(403).json({ 
                success: false, 
                error: `❌ صلاحيات غير كافية. الدور المطلوب: ${roles.join(' أو ')}` 
            });
        }
        next();
    };
}

// ============================================================
// ✅ التحقق من الحظر (IP)
// ============================================================
async function checkBanned(req, res, next) {
    let ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];
    
    if (ip && typeof ip === 'string' && ip.includes(',')) {
        ip = ip.split(',')[0].trim();
    }
    
    if (ip && typeof ip === 'string') {
        ip = ip.replace(/:\d+[^:]*$/, '');
    }
    
    if (!ip) {
        return next();
    }
    
    try {
        const encryptedIP = encrypt(ip);
        
        const { data } = await supabase
            .from('banned_users')
            .select('*')
            .eq('ip_address_encrypted', encryptedIP)
            .single();
        
        if (data) {
            return res.status(403).json({
                success: false,
                error: '⛔ تم حظر عنوان IP الخاص بك من المنصة',
                banned: true,
                reason: data.ban_reason || 'انتهاك شروط الاستخدام'
            });
        }
        next();
    } catch (error) {
        next();
    }
}

// ============================================================
// ✅ التحقق من وجود بث نشط (للأستاذ)
// ============================================================
async function checkActiveStream(req, res, next) {
    if (!req.user || req.user.role !== 'teacher') {
        return next();
    }

    try {
        const { data: activeOffer, error } = await supabase
            .from('offers')
            .select('id, status, subject_name, stream_url, room_password, remaining_seconds, total_seconds, is_paused, booked_count, stream_started_at, duration')
            .eq('teacher_id', req.user.userId)
            .in('status', ['live', 'teacher_ready', 'paused'])
            .single();

        if (error && error.code !== 'PGRST116') {
            console.error('❌ خطأ في التحقق من البث النشط:', error.message);
        }

        if (activeOffer) {
            // حساب الوقت المتبقي
            let remainingSeconds = activeOffer.remaining_seconds || 0;
            if (activeOffer.status === 'live' && !activeOffer.is_paused && activeOffer.stream_started_at) {
                const startedAt = new Date(activeOffer.stream_started_at);
                const now = new Date();
                const elapsed = Math.floor((now - startedAt) / 1000);
                const total = activeOffer.total_seconds || (activeOffer.duration * 60);
                remainingSeconds = Math.max(0, total - elapsed);
            }

            req.activeStream = {
                ...activeOffer,
                remaining_seconds: remainingSeconds
            };
        }

        next();
    } catch (error) {
        console.error('❌ خطأ في التحقق من البث النشط:', error.message);
        next();
    }
}

// ============================================================
// ✅ التحقق من أن المستخدم هو صاحب الحساب
// ============================================================
function isOwner(paramName = 'id') {
    return (req, res, next) => {
        const userId = parseInt(req.params[paramName]);
        if (req.user.userId !== userId && req.user.role !== 'admin') {
            return res.status(403).json({ 
                success: false, 
                error: '❌ غير مصرح لك بالوصول إلى هذا المورد' 
            });
        }
        next();
    };
}

// ============================================================
// ✅ التحقق من صحة معرف العرض (offer) وكونه مملوكاً للأستاذ
// ============================================================
async function validateOfferOwnership(req, res, next) {
    const offerId = parseInt(req.params.offerId || req.params.id || req.params.offer_id);
    const teacherId = req.user.userId;

    if (!offerId) {
        return res.status(400).json({ 
            success: false, 
            error: '❌ معرف العرض مطلوب' 
        });
    }

    try {
        const { data: offer, error } = await supabase
            .from('offers')
            .select('*')
            .eq('id', offerId)
            .single();

        if (error || !offer) {
            return res.status(404).json({ 
                success: false, 
                error: '❌ العرض غير موجود' 
            });
        }

        if (offer.teacher_id !== teacherId && req.user.role !== 'admin') {
            return res.status(403).json({ 
                success: false, 
                error: '❌ غير مصرح لك بالوصول إلى هذا العرض' 
            });
        }

        req.offer = offer;
        next();
    } catch (error) {
        console.error('❌ خطأ في التحقق من ملكية العرض:', error.message);
        return res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ في الخادم' 
        });
    }
}

// ============================================================
// ✅ التحقق من صلاحية الطالب (للوصول إلى البث)
// ============================================================
async function validateStudentAccess(req, res, next) {
    const studentId = req.user.userId;
    const offerId = parseInt(req.params.offerId || req.params.id || req.params.offer_id);

    if (!offerId) {
        return res.status(400).json({ 
            success: false, 
            error: '❌ معرف العرض مطلوب' 
        });
    }

    try {
        // ✅ التحقق من أن الطالب لديه حجز مدفوع أو معلق
        const { data: session, error } = await supabase
            .from('sessions')
            .select('id, payment_status, pending_balance')
            .eq('offer_id', offerId)
            .eq('student_id', studentId)
            .in('payment_status', ['paid', 'pending_stream'])
            .single();

        if (error || !session) {
            return res.status(403).json({ 
                success: false, 
                error: '❌ لم تقم بحجز هذه الحصة أو الدفع غير مكتمل' 
            });
        }

        req.session = session;
        next();
    } catch (error) {
        console.error('❌ خطأ في التحقق من صلاحية الطالب:', error.message);
        return res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ في الخادم' 
        });
    }
}

// ============================================================
// ✅ التحقق من أن البث نشط
// ============================================================
async function checkStreamActive(req, res, next) {
    const offerId = parseInt(req.params.offerId || req.params.id || req.params.offer_id);

    if (!offerId) {
        return res.status(400).json({ 
            success: false, 
            error: '❌ معرف العرض مطلوب' 
        });
    }

    try {
        const { data: offer, error } = await supabase
            .from('offers')
            .select('id, status, stream_url, room_password, subject_name, teacher_id')
            .eq('id', offerId)
            .in('status', ['live', 'teacher_ready'])
            .single();

        if (error || !offer) {
            return res.status(404).json({ 
                success: false, 
                error: '❌ البث غير موجود أو غير نشط' 
            });
        }

        req.stream = offer;
        next();
    } catch (error) {
        console.error('❌ خطأ في التحقق من البث النشط:', error.message);
        return res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ في الخادم' 
        });
    }
}

// ============================================================
// ✅ التحقق من عدم وجود بث نشط (لمنع البث المزدوج)
// ============================================================
async function checkNoActiveStream(req, res, next) {
    if (req.user.role !== 'teacher') {
        return next();
    }

    try {
        const { data: activeOffer, error } = await supabase
            .from('offers')
            .select('id, status')
            .eq('teacher_id', req.user.userId)
            .in('status', ['live', 'teacher_ready', 'paused'])
            .single();

        if (activeOffer) {
            return res.status(400).json({ 
                success: false, 
                error: `❌ لديك بث نشط بالفعل (${activeOffer.status === 'paused' ? 'متوقف مؤقتاً' : 'مباشر'}). لا يمكن بدء بث جديد.`,
                active_offer_id: activeOffer.id
            });
        }

        next();
    } catch (error) {
        if (error.code !== 'PGRST116') {
            console.error('❌ خطأ في التحقق من البث النشط:', error.message);
        }
        next();
    }
}

// ============================================================
// ✅ التحقق من أن الطالب في البث النشط
// ============================================================
async function checkStudentInStream(req, res, next) {
    const studentId = req.user.userId;
    const offerId = parseInt(req.params.offerId || req.params.id || req.params.offer_id);

    if (!offerId) {
        return res.status(400).json({ 
            success: false, 
            error: '❌ معرف العرض مطلوب' 
        });
    }

    try {
        const { data: active, error } = await supabase
            .from('active_stream')
            .select('*')
            .eq('offer_id', offerId)
            .eq('student_id', studentId)
            .single();

        if (error || !active) {
            return res.status(403).json({ 
                success: false, 
                error: '❌ لم تتم إضافتك إلى البث بعد' 
            });
        }

        req.activeStreamStudent = active;
        next();
    } catch (error) {
        console.error('❌ خطأ في التحقق من الطالب في البث:', error.message);
        return res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ في الخادم' 
        });
    }
}

// ============================================================
// ✅ تأكد من التصدير الصحيح
// ============================================================
module.exports = {
    authenticate,
    authorize,
    checkBanned,
    checkActiveStream,
    isOwner,
    validateOfferOwnership,
    validateStudentAccess,
    checkStreamActive,
    checkNoActiveStream,
    checkStudentInStream
};

// ✅ رسالة تأكيد التحميل
console.log('✅ middleware/auth.js تم تحميله بنجاح');
console.log('✅ authorize هي:', typeof authorize);
console.log('✅ authenticate هي:', typeof authenticate);
console.log('✅ checkActiveStream هي:', typeof checkActiveStream);
console.log('✅ checkNoActiveStream هي:', typeof checkNoActiveStream);
