// ============================================================
// Middleware المصادقة والتفويض (معدل بالكامل مع دعم نظام البث)
// ============================================================

const { verifyToken } = require('../utils/jwt');
const { encrypt } = require('../utils/encryption');
const { supabase } = require('../config/database');
const logger = require('../utils/logger');
const { autoBookFreeSession } = require('../utils/helpers');

// ============================================================
// ✅ المصادقة - التحقق من التوكن
// ============================================================
async function authenticate(req, res, next) {
    let authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    }
    
    if (!token && req.query.token) {
        token = req.query.token;
    }
    
    if (!token) {
        logger.warn('محاولة وصول بدون توكن', {
            ip: req.ip,
            url: req.originalUrl
        });
        return res.status(401).json({ 
            success: false, 
            error: '❌ غير مصرح به، يرجى تسجيل الدخول' 
        });
    }

    const decoded = verifyToken(token);
    
    if (!decoded) {
        logger.warn('توكن غير صالح أو منتهي الصلاحية', {
            ip: req.ip,
            url: req.originalUrl,
            userId: decoded?.userId
        });
        return res.status(401).json({ 
            success: false, 
            error: '❌ انتهت صلاحية الجلسة، يرجى تسجيل الدخول مرة أخرى' 
        });
    }

    // ✅ Admin لا يحتاج تحقق من قاعدة البيانات
    if (decoded.role === 'admin') {
        req.user = {
            userId: 0,
            role: 'admin',
            email: decoded.email
        };
        return next();
    }

    // ✅ Guest لا يحتاج تحقق من قاعدة البيانات
    if (decoded.userId === -1 || decoded.userId === '-1') {
        req.user = {
            userId: -1,
            role: decoded.role,
            email: decoded.email
        };
        return next();
    }

    // ✅ التحقق من أن المستخدم لا يزال موجوداً في قاعدة البيانات
    const tableName = decoded.role === 'student' ? 'students' : 'teachers';
    // students ليس لديه status، teachers لديه status
    const selectFields = decoded.role === 'student' ? 'id, is_banned' : 'id, is_banned, status';
    const { data: user, error } = await supabase
        .from(tableName)
        .select(selectFields)
        .eq('id', decoded.userId)
        .single();

    if (error || !user) {
        logger.error('المستخدم غير موجود في قاعدة البيانات', {
            userId: decoded.userId,
            role: decoded.role,
            error: error?.message
        });
        return res.status(401).json({ 
            success: false, 
            error: '❌ المستخدم غير موجود، يرجى تسجيل الدخول مرة أخرى' 
        });
    }

    // ✅ التحقق من الحظر
    if (user.is_banned) {
        logger.logSecurityEvent('محاولة وصول مستخدم محظور', {
            userId: decoded.userId,
            role: decoded.role,
            ip: req.ip
        });
        return res.status(403).json({
            success: false,
            error: '⛔ تم حظر حسابك من المنصة',
            banned: true
        });
    }

    // ✅ التحقق من حالة الأستاذ فقط (الطلاب ليس لديهم status)
    if (decoded.role === 'teacher' && user.status && user.status !== 'approved') {
        // السماح للمعلمين المعلقين أو غير المكتملين بالوصول للداشبورد وإكمال الملف
        // التقييد يتم في المسارات الحساسة فقط (مثل إنشاء الدروس)
    }

    req.user = decoded;
    req.token = token;
    
    logger.debug('تم المصادقة بنجاح', {
        userId: decoded.userId,
        role: decoded.role
    });
    
    next();
}

// ============================================================
// ✅ المصادقة الاختيارية - لا تفشل إذا لم يكن هناك توكن
// ============================================================
function optionalAuth(req, res, next) {
    let authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (req.query.token) {
        token = req.query.token;
    }
    if (token) {
        const decoded = verifyToken(token);
        if (decoded) {
            req.user = decoded;
            req.token = token;
        }
    }
    next();
}

// ============================================================
// ✅ التفويض - التحقق من الصلاحيات
// ============================================================
function authorize(roles = []) {
    return (req, res, next) => {
        if (!req.user) {
            logger.warn('محاولة وصول بدون مصادقة', {
                url: req.originalUrl,
                ip: req.ip
            });
            return res.status(401).json({ 
                success: false, 
                error: '❌ غير مصرح به، يرجى تسجيل الدخول' 
            });
        }
        if (req.user.role === 'admin' || (roles.length > 0 && roles.includes(req.user.role)) || roles.length === 0) {
            return next();
        }
        logger.warn('صلاحيات غير كافية', {
            userId: req.user.userId,
            userRole: req.user.role,
            requiredRoles: roles,
            url: req.originalUrl,
            ip: req.ip
        });
        return res.status(403).json({ 
            success: false, 
            error: `❌ صلاحيات غير كافية. الدور المطلوب: ${roles.join(' أو ')}` 
        });
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
        // التحقق من IP في جدول banned_users (يستخدم ip_address وليس ip_address_encrypted)
        const { data, error } = await supabase
            .from('banned_users')
            .select('*')
            .eq('ip_address', ip)
            .single();
        
        if (error && error.code !== 'PGRST116') {
            logger.error('خطأ في التحقق من الحظر', {
                ip: ip,
                error: error.message
            });
        }
        
        if (data) {
            logger.logSecurityEvent('محاولة وصول من IP محظور', {
                ip: ip,
                reason: data.ban_reason
            });
            return res.status(403).json({
                success: false,
                error: '⛔ تم حظر عنوان IP الخاص بك من المنصة',
                banned: true,
                reason: data.ban_reason || 'انتهاك شروط الاستخدام'
            });
        }
        next();
    } catch (error) {
        logger.error('استثناء في التحقق من الحظر', {
            ip: ip,
            error: error.message
        });
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
            logger.error('خطأ في التحقق من البث النشط', {
                userId: req.user.userId,
                error: error.message
            });
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
        logger.error('استثناء في التحقق من البث النشط', {
            userId: req.user.userId,
            error: error.message
        });
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
            logger.warn('محاولة وصول غير مصرح بها للمورد', {
                userId: req.user.userId,
                requestedUserId: userId,
                resource: req.originalUrl,
                ip: req.ip
            });
            return res.status(403).json({ 
                success: false, 
                error: '❌ غير مصرح لك بالوصول إلى هذا المورد' 
            });
        }
        next();
    };
}

// ============================================================
// ✅ التحقق من صحة معرف الدرس (offer) وكونه مملوكاً للأستاذ
// ============================================================
async function validateOfferOwnership(req, res, next) {
    const offerId = parseInt(req.params.offerId || req.params.id || req.params.offer_id);
    const teacherId = req.user.userId;

    if (teacherId === -1 || teacherId === '-1' || req.user.is_guest) {
        return res.status(403).json({ 
            success: false, 
            error: '❌ غير مصرح لك بالوصول إلى هذا الدرس (حساب زائر)' 
        });
    }

    if (!offerId) {
        return res.status(400).json({ 
            success: false, 
            error: '❌ معرف الدرس مطلوب' 
        });
    }

    try {
        const { data: offer, error } = await supabase
            .from('offers')
            .select('*')
            .eq('id', offerId)
            .single();

        if (error || !offer) {
            logger.warn('محاولة الوصول لدرس غير موجود', {
                offerId: offerId,
                userId: teacherId,
                error: error?.message
            });
            return res.status(404).json({ 
                success: false, 
                error: '❌ الدرس غير موجود' 
            });
        }

        if (offer.teacher_id !== teacherId && req.user.role !== 'admin') {
            logger.warn('محاولة الوصول لدرس غير مملوك', {
                offerId: offerId,
                userId: teacherId,
                ownerId: offer.teacher_id,
                ip: req.ip
            });
            return res.status(403).json({ 
                success: false, 
                error: '❌ غير مصرح لك بالوصول إلى هذا الدرس' 
            });
        }

        req.offer = offer;
        next();
    } catch (error) {
        logger.error('خطأ في التحقق من ملكية الدرس', {
            offerId: offerId,
            userId: teacherId,
            error: error.message
        });
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
            error: '❌ معرف الدرس مطلوب' 
        });
    }

    try {
        // ✅ التحقق من أن الطالب لديه حجز مدفوع أو معلق
        let { data: session, error } = await supabase
            .from('sessions')
            .select('*')
            .eq('offer_id', offerId)
            .eq('student_id', studentId)
            .in('payment_status', ['paid', 'pending_stream'])
            .maybeSingle();

        if (!session) {
            session = await autoBookFreeSession(offerId, studentId);
        }

        if (!session) {
            logger.warn('محاولة وصول طالب بدون حجز صحيح', {
                offerId: offerId,
                studentId: studentId,
                error: error?.message
            });
            return res.status(403).json({ 
                success: false, 
                error: '❌ لم تقم بحجز هذه الحصة أو الدفع غير مكتمل' 
            });
        }

        req.session = session;
        next();
    } catch (error) {
        logger.error('خطأ في التحقق من صلاحية الطالب', {
            offerId: offerId,
            studentId: studentId,
            error: error.message
        });
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
            error: '❌ معرف الدرس مطلوب' 
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
            logger.warn('محاولة الوصول لبث غير نشط', {
                offerId: offerId,
                error: error?.message
            });
            return res.status(404).json({ 
                success: false, 
                error: '❌ البث غير موجود أو غير نشط' 
            });
        }

        req.stream = offer;
        next();
    } catch (error) {
        logger.error('خطأ في التحقق من البث النشط', {
            offerId: offerId,
            error: error.message
        });
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
            logger.warn('محاولة بدء بث مع وجود بث نشط', {
                userId: req.user.userId,
                existingOfferId: activeOffer.id,
                existingStatus: activeOffer.status
            });
            return res.status(400).json({ 
                success: false, 
                error: `❌ لديك بث نشط بالفعل (${activeOffer.status === 'paused' ? 'متوقف مؤقتاً' : 'مباشر'}). لا يمكن بدء بث جديد.`,
                active_offer_id: activeOffer.id
            });
        }

        next();
    } catch (error) {
        if (error.code !== 'PGRST116') {
            logger.error('خطأ في التحقق من البث النشط', {
                userId: req.user.userId,
                error: error.message
            });
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
            error: '❌ معرف الدرس مطلوب' 
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
            logger.warn('محاولة دخول طالب غير مسجل في البث', {
                offerId: offerId,
                studentId: studentId,
                error: error?.message
            });
            return res.status(403).json({ 
                success: false, 
                error: '❌ لم تتم إضافتك إلى البث بعد' 
            });
        }

        req.activeStreamStudent = active;
        next();
    } catch (error) {
        logger.error('خطأ في التحقق من الطالب في البث', {
            offerId: offerId,
            studentId: studentId,
            error: error.message
        });
        return res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ في الخادم' 
        });
    }
}

// ============================================================
// ✅ منع الزوار غير المسجلين من استخدام الخدمات الحساسة كالذكاء الاصطناعي
// ============================================================
function requireRegisteredUser(req, res, next) {
    if (!req.user || req.user.role === 'guest' || req.user.userId === -1 || req.user.userId === '-1') {
        return res.status(403).json({
            success: false,
            error: '🔒 عذراً، يجب عليك إنشاء حساب جديد أو تسجيل الدخول لاستخدام الذكاء الاصطناعي.'
        });
    }
    next();
}

// ============================================================
// ✅ تأكد من التصدير الصحيح
// ============================================================
module.exports = {
    authenticate,
    requireRegisteredUser,
    optionalAuth,
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
