const logger = require('../utils/logger');
const { getViewCount, syncItemViews } = require('../utils/viewsTracker');
// ============================================================
// مسارات الدروس - Offer Routes (معدل بالكامل مع دعم نظام البث والرصيد المعلق)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const crypto = require('crypto');

const { supabase } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { getOne, insert, update, loadLocalTeacherFollowers } = require('../utils/helpers');
const { getPublicImageUrl, uploadToSupabase } = require('../utils/upload');
const multer = require('multer');
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});
const { processStreamPayments, archiveStreamLog } = require('../utils/streamVerification');
const { sendPushNotification } = require('../utils/notification');

// ✅ دالة مساعدة لحساب واسترجاع الوقت المتبقي للبث
function calculateOfferRemainingSeconds(offer) {
    if (!offer) return 0;
    let sec = null;
    if (offer.remaining_seconds !== undefined && offer.remaining_seconds !== null && !isNaN(Number(offer.remaining_seconds))) {
        sec = Number(offer.remaining_seconds);
    } else if (offer.remaining_time !== undefined && offer.remaining_time !== null && !isNaN(Number(offer.remaining_time))) {
        sec = Number(offer.remaining_time);
    }

    if (sec !== null) {
        return Math.max(0, sec);
    }

    if (offer.status === 'live' && !offer.is_paused && offer.stream_started_at) {
        const startedAt = new Date(offer.stream_started_at).getTime();
        const nowTime = Date.now();
        const elapsed = Math.floor((nowTime - startedAt) / 1000);
        const total = offer.total_seconds || ((offer.duration || offer.duration_minutes || 60) * 60);
        return Math.max(0, total - elapsed);
    }

    return (offer.duration || offer.duration_minutes || 60) * 60;
}

// ============================================================
// ✅ إنشاء درس جديد (مع دعم نظام البث والرصيد المعلق)
// ============================================================
router.post('/offer/create', authenticate, authorize(['teacher']), upload.single('thumbnail'), [
    body('subject_name').notEmpty().withMessage('اسم المادة مطلوب').isLength({ max: 100 }),
    body('duration').isInt({ min: 1, max: 240 }).withMessage('المدة غير صالحة (1-240 دقيقة)'),
    body('offer_date').notEmpty().withMessage('تاريخ الدرس مطلوب').isISO8601().withMessage('تاريخ غير صالح'),
    body('price').isFloat({ min: 0, max: 1000000 }).withMessage('السعر غير صالح'),
    body('is_free').optional().isBoolean().withMessage('is_free يجب أن يكون true أو false'),
    body('education_level').optional().isString().withMessage('المستوى التعليمي يجب أن يكون نصاً')
], async (req, res) => {
    try {
        // ✅ التحقق من صحة المدخلات
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            console.log('❌ أخطاء في التحقق:', errors.array());
            return res.status(400).json({ 
                success: false, 
                error: errors.array()[0].msg,
                errors: errors.array() 
            });
        }

        const { 
            subject_name, 
            duration, 
            offer_date, 
            price, 
            is_free = false, 
            education_level = null,
            max_students = 20,
            plan_type = '1_day',
            total_sessions = 1,
            sessions_schedule = null
        } = req.body;

        const parsedPrice = parseFloat(price || 0);
        const isFreeOffer = (is_free === true || is_free === 'true' || is_free === 1 || is_free === '1' || req.body.type === 'free') && parsedPrice === 0;
        const parsedDuration = parseInt(duration);
        const parsedMaxStudents = parseInt(max_students || 20);
        const parsedTotalSessions = Math.max(1, parseInt(total_sessions || 1));
        const normalizedPlanType = ['1_day', '1_month', '3_months', '6_months', 'single'].includes(plan_type) ? plan_type : (parsedTotalSessions > 1 ? '1_month' : '1_day');

        // 🔥 مدة الدرس يجب أن تكون بين 60 دقيقة (ساعة واحدة) و 240 دقيقة (4 ساعات)
        if (isNaN(parsedDuration) || parsedDuration < 60) {
            return res.status(400).json({
                success: false,
                error: 'أقل مدة للدرس هي ساعة واحدة (60 دقيقة)'
            });
        }
        if (parsedDuration > 240) {
            return res.status(400).json({
                success: false,
                error: 'الحد الأقصى لمدة الدرس هو 4 ساعات (240 دقيقة)'
            });
        }

        // 🔥 سعر الدرس المدفوع يجب أن يكون 250 دج على الأقل للحصة الواحدة
        if (!isFreeOffer) {
            if (isNaN(parsedPrice) || parsedPrice < 250) {
                return res.status(400).json({
                    success: false,
                    error: 'سعر الدرس المدفوع يجب أن يكون 250 دج على الأقل للحصة الواحدة'
                });
            }
        }

        // 💰 حسابات الرسوم والمبالغ الإجمالية للخطة
        // رسوم المنصة = 50 دج لكل ساعة (60 دقيقة)
        const platformFeePerSession = isFreeOffer ? 0 : Math.round((parsedDuration / 60) * 50);
        const totalPlatformFee = platformFeePerSession * parsedTotalSessions;
        const totalTeacherPrice = isFreeOffer ? 0 : Math.round(parsedPrice * parsedTotalSessions);
        const totalStudentPrice = totalTeacherPrice + totalPlatformFee;

        // 🔥 قيود العرض المجاني: 60 دقيقة كحد أقصى، و20 طالب كحد أقصى
        if (isFreeOffer) {
            if (parsedDuration > 60) {
                return res.status(400).json({
                    success: false,
                    error: 'العرض المجاني متاح لمدة أقصاها ساعة واحدة (60 دقيقة)'
                });
            }
            if (parsedMaxStudents > 20) {
                return res.status(400).json({
                    success: false,
                    error: 'العرض المجاني يتسع لـ 20 شخصاً كحد أقصى'
                });
            }
        }

        // ✅ استخدام teacher_id من التوكن
        const teacher_id = req.user.userId;

        if (teacher_id === -1 || teacher_id === '-1' || req.user.is_guest) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإنشاء درس (حساب زائر)' });
        }

        // ✅ تحويل الوقت من التوقيت المحلي (الجزائر) إلى UTC للتخزين
        let offerDateUTC;
        try {
            if (offer_date && offer_date.includes('T')) {
                const [datePart, timePart] = offer_date.split('T');
                const [year, month, day] = datePart.split('-').map(Number);
                const timeClean = timePart.replace('Z', '').split('+')[0].split('-')[0];
                const [hours, minutes] = timeClean.split(':').map(Number);
                // Algeria is UTC+1. Create Date representing Algeria time, then convert to UTC.
                offerDateUTC = new Date(Date.UTC(year, month - 1, day, hours - 1, minutes));
            } else if (offer_date) {
                offerDateUTC = new Date(offer_date);
            } else {
                offerDateUTC = new Date();
            }
            if (isNaN(offerDateUTC.getTime())) {
                offerDateUTC = new Date();
            }
        } catch (e) {
            offerDateUTC = new Date();
        }

        const { data: recentOffer, error: recentOfferError } = await supabase
            .from('offers')
            .select('id')
            .eq('teacher_id', teacher_id)
            .eq('subject_name', subject_name?.trim())
            .eq('offer_date', offerDateUTC.toISOString())
            .limit(1)
            .maybeSingle();

        if (!recentOfferError && recentOffer) {
            return res.status(409).json({
                success: false,
                error: 'يوجد درس مشابه تم إنشاؤه بالفعل، الرجاء الانتظار قليلاً قبل المحاولة مرة أخرى'
            });
        }

        console.log('📝 محاولة إنشاء درس للأستاذ:', teacher_id);
        console.log('📚 المادة:', subject_name);

        // ✅ التحقق من وجود الأستاذ في جدول teachers
        const { data: teacher, error: teacherError } = await supabase
            .from('teachers')
            .select('id, full_name, status, specialization, teaching_level, balance')
            .eq('id', teacher_id)
            .single();

        if (teacherError || !teacher) {
            logger.error('❌ الأستاذ غير موجود:', teacherError?.message);
            return res.status(404).json({ 
                success: false, 
                error: 'الأستاذ غير موجود في النظام' 
            });
        }

        console.log('👨‍🏫 الأستاذ:', teacher.full_name);
        console.log('📊 الحالة:', teacher.status);

        // ✅ التحقق من أن الحساب معتمد
        if (teacher.status !== 'approved') {
            return res.status(403).json({ 
                success: false, 
                error: 'حسابك غير معتمد بعد، يرجى الانتظار حتى مراجعة الإدارة' 
            });
        }

        // ✅ العروض المجانية (أقصى مدة 60 دقيقة و20 طالب) مجانية 100% بدون أي رسوم سيرفر على الأستاذ
        let sessionCost = 0;

        // ✅ التحقق من وجود المستوى التعليمي للأستاذ
        if (!teacher.teaching_level && !education_level) {
            return res.status(400).json({
                success: false,
                error: 'يرجى تحديد المستوى التعليمي للدرس أو تحديث ملفك الشخصي بالمستوى الذي تدرسه'
            });
        }

        // ✅ استخدام مستوى الأستاذ إذا لم يتم تحديد مستوى للدرس
        const finalEducationLevel = education_level || teacher.teaching_level;

        // ✅ حساب الوقت الكلي بالثواني
        const totalSeconds = parseInt(duration) * 60;

        // ✅ خصم الرصيد إذا كان الدرس مجانياً وللأستاذ رصيد كافٍ
        if (isFreeOffer && sessionCost > 0) {
            const currentTeacherBalance = parseFloat(teacher.balance) || 0;
            const newBalance = currentTeacherBalance - sessionCost;
            
            const { error: updateError } = await supabase
                .from('teachers')
                .update({ balance: newBalance })
                .eq('id', teacher_id);

            if (updateError) {
                logger.error('❌ فشل خصم تكلفة الدرس المجاني من الأستاذ:', updateError.message);
                return res.status(500).json({
                    success: false,
                    error: 'فشل خصم تكلفة الدرس المجاني من حسابك: ' + updateError.message
                });
            }

            try {
                await insert('wallet_transactions', {
                    teacher_id: teacher_id,
                    amount: sessionCost,
                    type: 'fees',
                    status: 'completed',
                    description: `خصم رسوم السيرفر لإنشاء حصة مجانية لمادة "${subject_name.trim()}" لمدة ${duration} دقيقة (200 دج/ساعة)`,
                    created_at: new Date().toISOString()
                });
            } catch (txnError) {
                console.warn('⚠️ تنبيه: فشل تسجيل معاملة خصم رسوم الحصة المجانية:', txnError.message);
            }
            
            teacher.balance = newBalance;
        }

        // ✅ إنشاء كلمات المرور والغرفة
        const room_name = `stream_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        const defaultPassword = crypto.randomBytes(4).toString('hex').toUpperCase();

        let thumbnailUrl = req.body.thumbnail_url || null;
        if (req.file) {
            try {
                const uploadRes = await uploadToSupabase(req.file, 'thumbnails');
                if (uploadRes && uploadRes.url) {
                    thumbnailUrl = uploadRes.url;
                }
            } catch (upErr) {
                logger.warn('⚠️ فشل رفع الصورة المصغرة للدرس:', upErr.message);
            }
        }

        // 📅 إعداد وجدول الحصص بالتفصيل
        let parsedSchedule = [];
        if (sessions_schedule) {
            try {
                parsedSchedule = typeof sessions_schedule === 'string' ? JSON.parse(sessions_schedule) : sessions_schedule;
                if (!Array.isArray(parsedSchedule)) parsedSchedule = [];
            } catch (e) {
                parsedSchedule = [];
            }
        }

        // إذا لم يتم توفير جدول مفصل، نقوم بتوليد المواعيد تلقائياً بناءً على تاريخ البداية
        if (parsedSchedule.length === 0) {
            for (let i = 1; i <= parsedTotalSessions; i++) {
                // للأيام العادية أسبوعياً أو يومياً
                const sessionDate = new Date(offerDateUTC.getTime() + ((i - 1) * 7 * 24 * 60 * 60 * 1000));
                parsedSchedule.push({
                    session_number: i,
                    title: `الحصة ${i}: ${subject_name.trim()}`,
                    session_date: sessionDate.toISOString(),
                    duration: parsedDuration,
                    status: 'upcoming',
                    completed_at: null,
                    teacher_released_amount: 0,
                    is_escrow_released: false
                });
            }
        } else {
            // تنسيق الحصص والتأكد من صحتها
            parsedSchedule = parsedSchedule.map((s, idx) => {
                const rawDate = s.session_date || s.date;
                return {
                    session_number: s.session_number || (idx + 1),
                    title: s.title || `الحصة ${idx + 1}: ${subject_name.trim()}`,
                    session_date: rawDate ? new Date(rawDate).toISOString() : new Date(offerDateUTC.getTime() + (idx * 7 * 24 * 60 * 60 * 1000)).toISOString(),
                    duration: parseInt(s.duration || parsedDuration),
                    status: s.status || 'upcoming',
                    completed_at: s.completed_at || null,
                    teacher_released_amount: 0,
                    is_escrow_released: false
                };
            });
        }

        // ✅ إدخال الدرس في قاعدة البيانات
        const newOffer = {
            teacher_id: teacher_id,
            subject_name: subject_name.trim(),
            duration: parsedDuration,
            offer_date: offerDateUTC.toISOString(),
            price: isFreeOffer ? 0 : parsedPrice,
            is_free: isFreeOffer,
            room_name: room_name,
            room_password: defaultPassword,
            status: 'upcoming',
            education_level: finalEducationLevel,
            thumbnail_url: thumbnailUrl,
            image_url: thumbnailUrl,
            booked_count: 0,
            plan_type: normalizedPlanType,
            total_sessions: parsedTotalSessions,
            session_duration: parsedDuration,
            price_per_session: isFreeOffer ? 0 : parsedPrice,
            platform_fee_per_session: platformFeePerSession,
            total_platform_fee: totalPlatformFee,
            total_teacher_price: totalTeacherPrice,
            total_student_price: totalStudentPrice,
            completed_sessions_count: 0,
            sessions_schedule: parsedSchedule,
            total_released_amount: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        console.log('💾 إدخال الدرس:', newOffer);

        let insertedOffer = null;
        const { data: dbOffer, error: insertError } = await supabase
            .from('offers')
            .insert(newOffer)
            .select()
            .single();

        if (insertError) {
            // في حال عدم وجود الأعمدة الجديدة بعد في جدول offers، نقوم بالإدخال بالأعمدة الأساسية كإجراء احتياطي آمن
            console.warn('⚠️ محاولة الإدخال الاحتياطي الأساسي بسبب أعمدة غير مضافة بعد:', insertError.message);
            const fallbackOffer = {
                teacher_id: teacher_id,
                subject_name: subject_name.trim(),
                duration: parsedDuration,
                offer_date: offerDateUTC.toISOString(),
                price: isFreeOffer ? 0 : parsedPrice,
                is_free: isFreeOffer,
                room_name: room_name,
                room_password: defaultPassword,
                status: 'upcoming',
                education_level: finalEducationLevel,
                thumbnail_url: thumbnailUrl,
                image_url: thumbnailUrl,
                booked_count: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            const { data: fbData, error: fbError } = await supabase
                .from('offers')
                .insert(fallbackOffer)
                .select()
                .single();
            if (fbError) {
                logger.error('❌ خطأ في إدخال الدرس:', fbError);
                return res.status(500).json({ 
                    success: false, 
                    error: 'حدث خطأ في قاعدة البيانات: ' + fbError.message 
                });
            }
            insertedOffer = { ...fbData, ...newOffer, id: fbData.id };
        } else {
            insertedOffer = dbOffer;
        }

        if (!insertedOffer) {
            return res.status(500).json({ 
                success: false, 
                error: 'فشل إنشاء الدرس، يرجى المحاولة مرة أخرى' 
            });
        }

        // 📝 إدخال الحصص المجدولة في جدول stream_sessions
        try {
            const streamSessionsToInsert = parsedSchedule.map(s => ({
                offer_id: insertedOffer.id,
                teacher_id: teacher_id,
                session_number: s.session_number,
                title: s.title,
                session_date: s.session_date,
                duration_minutes: s.duration || parsedDuration,
                price_per_session: isFreeOffer ? 0 : parsedPrice,
                platform_fee: platformFeePerSession,
                status: 'upcoming',
                is_escrow_released: false,
                teacher_released_amount: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }));

            await supabase.from('stream_sessions').insert(streamSessionsToInsert);
        } catch (ssErr) {
            console.warn('⚠️ تنبيه: تعذر إدخال stream_sessions:', ssErr.message);
        }

        console.log('✅ تم إنشاء الدرس بنجاح:', insertedOffer.id);

        // ✅ إشعار المتابعين
        try {
            let allFollowers = [];
            const { data: followers } = await supabase
                .from('teacher_followers')
                .select('follower_id')
                .eq('teacher_id', teacher_id)
                .eq('follower_type', 'student');
            
            if (followers) {
                followers.forEach(f => {
                    allFollowers.push({ follower_id: parseInt(f.follower_id) });
                });
            }

            try {
                const localList = await loadLocalTeacherFollowers();
                localList.forEach(f => {
                    if (parseInt(f.teacher_id) === parseInt(teacher_id) && f.follower_type === 'student') {
                        const exists = allFollowers.some(existing => existing.follower_id === parseInt(f.follower_id));
                        if (!exists) {
                            allFollowers.push({ follower_id: parseInt(f.follower_id) });
                        }
                    }
                });
            } catch (lErr) {}
            
            if (allFollowers.length > 0) {
                for (const f of allFollowers) {
                    await insert('notifications', {
                        user_id: f.follower_id,
                        user_type: 'student',
                        title: '📢 عرض جديد!',
                        message: `قام الأستاذ ${teacher.full_name} بإضافة عرض جديد: ${subject_name}`,
                        offer_id: insertedOffer.id,
                        is_read: false,
                        created_at: new Date().toISOString()
                    });
                    
                    // إرسال إشعار الدفع إذا كان مفعلاً
                    const { data: student } = await supabase.from('students').select('push_subscription').eq('id', f.follower_id).single();
                    if (student && student.push_subscription) {
                        await sendPushNotification(student, '📢 عرض جديد!', `قام الأستاذ ${teacher.full_name} بإضافة عرض جديد: ${subject_name}`);
                    }
                }
            }
        } catch (e) {
            logger.error('❌ خطأ في إرسال إشعارات المتابعين:', e);
        }

        // ✅ إرجاع النتيجة
        res.json({ 
            success: true, 
            message: 'تم إنشاء الدرس بنجاح',
            room_name: room_name,
            default_password: defaultPassword,
            total_seconds: totalSeconds,
            offer: {
                id: insertedOffer.id,
                teacher_id: insertedOffer.teacher_id,
                subject_name: insertedOffer.subject_name,
                duration: insertedOffer.duration,
                offer_date: insertedOffer.offer_date,
                price: insertedOffer.price,
                is_free: insertedOffer.is_free,
                status: insertedOffer.status,
                education_level: insertedOffer.education_level,
                room_name: insertedOffer.room_name,
                room_password: insertedOffer.room_password,
                total_seconds: insertedOffer.total_seconds,
                remaining_seconds: insertedOffer.remaining_seconds,
                created_at: insertedOffer.created_at
            }
        });

    } catch (error) {
        logger.error('❌ خطأ في إنشاء الدرس:', error.message);
        logger.error('📚 Stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ في الخادم أثناء إنشاء الدرس: ' + error.message 
        });
    }
});

// ============================================================
// ✅ تحديث درس (مع دعم تحديث حالة البث)
// ============================================================
router.put('/offer/update/:offer_id', authenticate, authorize(['teacher']), upload.single('thumbnail'), [
    param('offer_id').isInt().withMessage('معرف الدرس غير صالح'),
    body('subject_name').optional().isString().withMessage('اسم المادة يجب أن يكون نصاً'),
    body('duration').optional().isInt({ min: 1, max: 360 }).withMessage('المدة غير صالحة (1-360 دقيقة)'),
    body('offer_date').optional().isISO8601().withMessage('تاريخ غير صالح'),
    body('price').optional().isFloat({ min: 0 }).withMessage('السعر غير صالح'),
    body('is_free').optional().isBoolean().withMessage('is_free يجب أن يكون true أو false'),
    body('education_level').optional().isString().withMessage('المستوى التعليمي يجب أن يكون نصاً'),
    body('status').optional().isIn(['upcoming', 'live', 'paused', 'completed']).withMessage('حالة غير صالحة')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const teacher_id = req.user.userId;

        // ✅ التحقق من وجود الدرس
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        if (teacher_id === -1 || teacher_id === '-1' || req.user.is_guest || offer.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا الدرس' });
        }

        // ✅ تحضير بيانات التحديث
        const updateData = {};
        const allowedFields = ['subject_name', 'duration', 'offer_date', 'price', 'is_free', 'education_level', 'status'];

        for (const field of allowedFields) {
            if (req.body[field] !== undefined && req.body[field] !== null) {
                if (field === 'duration') {
                    updateData[field] = parseInt(req.body[field]);
                } else if (field === 'price') {
                    updateData[field] = parseFloat(req.body[field]);
                } else if (field === 'is_free') {
                    updateData[field] = req.body[field] === true || req.body[field] === 'true';
                } else {
                    updateData[field] = req.body[field];
                }
            }
        }

        const willBeFree = updateData.is_free !== undefined ? updateData.is_free : offer.is_free;
        const targetPrice = updateData.price !== undefined ? updateData.price : offer.price;
        const targetDuration = updateData.duration !== undefined ? updateData.duration : offer.duration;
        const targetMaxStudents = req.body.max_students !== undefined ? parseInt(req.body.max_students) : 20;

        if (!willBeFree) {
            if (isNaN(targetPrice) || targetPrice <= 0) {
                return res.status(400).json({
                    success: false,
                    error: 'سعر العرض المدفوع يجب أن يكون أكبر من 0'
                });
            }
        } else {
            updateData.price = 0;
            if (targetDuration > 60) {
                return res.status(400).json({
                    success: false,
                    error: 'العرض المجاني متاح لمدة أقصاها ساعة واحدة (60 دقيقة)'
                });
            }
            if (targetMaxStudents > 20) {
                return res.status(400).json({
                    success: false,
                    error: 'العرض المجاني يتسع لـ 20 شخصاً كحد أقصى'
                });
            }
        }

        if (req.file) {
            try {
                const uploadRes = await uploadToSupabase(req.file, 'thumbnails');
                if (uploadRes && uploadRes.url) {
                    updateData.thumbnail_url = uploadRes.url;
                    updateData.image_url = uploadRes.url;
                }
            } catch (upErr) {
                logger.warn('⚠️ فشل تحديث الصورة المصغرة للدرس:', upErr.message);
            }
        } else if (req.body.thumbnail_url) {
            updateData.thumbnail_url = req.body.thumbnail_url;
            updateData.image_url = req.body.thumbnail_url;
        }

        updateData.updated_at = new Date().toISOString();

        console.log('📝 تحديث الدرس:', offer_id, updateData);

        const { data: updatedOffer, error: updateError } = await supabase
            .from('offers')
            .update(updateData)
            .eq('id', offer_id)
            .select()
            .single();

        if (updateError) {
            logger.error('❌ خطأ في تحديث الدرس:', updateError);
            return res.status(500).json({ success: false, error: updateError.message });
        }

        res.json({
            success: true,
            message: 'تم تحديث الدرس بنجاح',
            offer: updatedOffer
        });
    } catch (error) {
        logger.error('❌ خطأ في تحديث الدرس:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب جميع الدروس القادمة (مع فلتر المستوى التعليمي)
// ============================================================
router.get('/offers', async (req, res) => {
    try {
        const now = new Date().toISOString();
        
        let query = supabase
            .from('offers')
            .select('*')
            .neq('status', 'cancelled')
            .order('offer_date', { ascending: true });

        // ✅ فلتر حسب المستوى التعليمي مع دعم المجموعات العامة مثل جميع مستويات المتوسط
        if (req.query.education_level) {
            const level = req.query.education_level;
            if (level !== 'all') {
                const middleLevels = ['1ere_am', '2eme_am', '3eme_am', '4eme_am', 'bem'];
                const primaryLevels = ['primary_1', 'primary_2', 'primary_3', 'primary_4', 'primary_5', '5eme_pri'];
                const secondaryLevels = ['1ere_as', '2eme_as', '3eme_as', 'bac'];
                const universityLevels = ['1ere_uni', '2eme_uni', '3eme_uni', 'master', 'doctorat'];

                let levelsToCheck = [level];
                if (middleLevels.includes(level)) {
                    levelsToCheck.push('middle_all');
                } else if (level === 'middle_all') {
                    levelsToCheck = [...middleLevels, 'middle_all'];
                } else if (primaryLevels.includes(level)) {
                    levelsToCheck.push('primary_all');
                } else if (level === 'primary_all') {
                    levelsToCheck = [...primaryLevels, 'primary_all'];
                } else if (secondaryLevels.includes(level)) {
                    levelsToCheck.push('secondary_all');
                } else if (level === 'secondary_all') {
                    levelsToCheck = [...secondaryLevels, 'secondary_all'];
                } else if (universityLevels.includes(level)) {
                    levelsToCheck.push('university');
                } else if (level === 'university') {
                    levelsToCheck = [...universityLevels, 'university'];
                }

                query = query.in('education_level', levelsToCheck);
            }
        }

        const { data: rawOffers, error } = await query;

        if (error) throw error;

        // ✅ إظهار الدروس المتاحة والبث المباشر (المجاني والمدفوع) وإخفاء الدروس المنتهية أو الملغاة فقط
        const offers = (rawOffers || []).filter(offer => {
            if (offer.status === 'cancelled' || offer.status === 'completed' || offer.status === 'ended') {
                return false;
            }
            if (offer.completed_at || offer.force_ended_at) {
                return false;
            }
            return true;
        });

        if (!offers || offers.length === 0) {
            return res.json([]);
        }

        // ✅ جلب معلومات المعلمين
        const teacherIds = [...new Set(offers.map(o => o.teacher_id))];
        const { data: teachers, error: teachersError } = await supabase
            .from('teachers')
            .select('id, full_name, specialization, profile_image, profile_url')
            .in('id', teacherIds);

        if (teachersError) {
            logger.error('خطأ في جلب بيانات المعلمين:', teachersError.message);
        }

        const teachersMap = {};
        if (teachers) {
            for (const teacher of teachers) {
                teachersMap[teacher.id] = teacher;
            }
        }

        // ✅ تنسيق البيانات
        const formatted = offers.map(offer => {
            const teacher = teachersMap[offer.teacher_id] || {};

            // ✅ حساب الوقت المتبقي للدروس المباشرة
            const remainingSeconds = calculateOfferRemainingSeconds(offer);

            const views = getViewCount('offer', offer.id, offer.views_count || offer.views || 0);
            const totalSessions = offer.total_sessions || 1;
            const sessionDuration = offer.session_duration || offer.duration || 60;
            const pricePerSession = parseFloat(offer.price_per_session || offer.price || 0);
            const isFree = (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && pricePerSession === 0;
            const platformFeePerSession = isFree ? 0 : (offer.platform_fee_per_session || Math.round((sessionDuration / 60) * 50));
            const totalPlatformFee = isFree ? 0 : (offer.total_platform_fee || (platformFeePerSession * totalSessions));
            const totalTeacherPrice = isFree ? 0 : (offer.total_teacher_price || (pricePerSession * totalSessions));
            const totalStudentPrice = isFree ? 0 : (offer.total_student_price || (totalTeacherPrice + totalPlatformFee));

            return {
                id: offer.id,
                teacher_id: offer.teacher_id,
                subject_name: offer.subject_name,
                duration: sessionDuration,
                session_duration: sessionDuration,
                offer_date: offer.offer_date,
                price: pricePerSession,
                price_per_session: pricePerSession,
                is_free: isFree,
                plan_type: offer.plan_type || (totalSessions > 1 ? '1_month' : '1_day'),
                total_sessions: totalSessions,
                platform_fee_per_session: platformFeePerSession,
                total_platform_fee: totalPlatformFee,
                total_teacher_price: totalTeacherPrice,
                total_student_price: totalStudentPrice,
                completed_sessions_count: offer.completed_sessions_count || 0,
                sessions_schedule: offer.sessions_schedule || [],
                total_released_amount: offer.total_released_amount || 0,
                status: offer.status,
                education_level: offer.education_level,
                room_password: offer.room_password || null,
                room_name: offer.room_name || null,
                stream_url: offer.stream_url || null,
                stream_platform: offer.stream_platform || 'jitsi',
                total_seconds: offer.total_seconds || (sessionDuration * 60),
                remaining_seconds: remainingSeconds,
                is_paused: offer.is_paused || false,
                booked_count: offer.booked_count || 0,
                views_count: views,
                views: views,
                thumbnail_url: offer.thumbnail_url || offer.image_url || null,
                image_url: offer.thumbnail_url || offer.image_url || null,
                created_at: offer.created_at,
                teacher_name: teacher.full_name || 'غير معروف',
                teacher_specialization: teacher.specialization || '',
                teacher_profile_image: teacher.profile_url || getPublicImageUrl('profiles', 'teachers', teacher.profile_image),
            };
        });

        res.json(formatted);
    } catch (error) {
        logger.error('خطأ في جلب الدروس:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ جلب الدروس المباشرة
// ============================================================
router.get('/live-offers', async (req, res) => {
    try {
        const { data: offers, error } = await supabase
            .from('offers')
            .select('*')
            .in('status', ['live', 'teacher_ready'])
            .order('offer_date', { ascending: false })
            .limit(50);

        if (error) throw error;

        if (!offers || offers.length === 0) {
            return res.json([]);
        }

        // ✅ جلب معلومات المعلمين
        const teacherIds = [...new Set(offers.map(o => o.teacher_id))];
        const { data: teachers, error: teachersError } = await supabase
            .from('teachers')
            .select('id, full_name, specialization, profile_image, profile_url')
            .in('id', teacherIds);

        if (teachersError) {
            logger.error('خطأ في جلب بيانات المعلمين:', teachersError.message);
        }

        const teachersMap = {};
        if (teachers) {
            for (const teacher of teachers) {
                teachersMap[teacher.id] = teacher;
            }
        }

        const formatted = offers.map(offer => {
            const teacher = teachersMap[offer.teacher_id] || {};

            // ✅ حساب الوقت المتبقي
            const remainingSeconds = calculateOfferRemainingSeconds(offer);

            return {
                id: offer.id,
                teacher_id: offer.teacher_id,
                subject_name: offer.subject_name,
                duration: offer.duration,
                offer_date: offer.offer_date,
                price: offer.price,
                is_free: (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && parseFloat(offer.price || 0) === 0,
                status: offer.status,
                education_level: offer.education_level,
                stream_url: offer.stream_url || null,
                stream_platform: offer.stream_platform || 'jitsi',
                room_password: offer.room_password || null,
                room_name: offer.room_name || null,
                total_seconds: offer.total_seconds || (offer.duration * 60),
                remaining_seconds: remainingSeconds,
                is_paused: offer.is_paused || false,
                booked_count: offer.booked_count || 0,
                created_at: offer.created_at,
                teacher_name: teacher.full_name || 'غير معروف',
                teacher_specialization: teacher.specialization || '',
                teacher_profile_image: teacher.profile_url || getPublicImageUrl('profiles', 'teachers', teacher.profile_image)
            };
        });

        res.json(formatted);
    } catch (error) {
        logger.error('خطأ في جلب الدروس المباشرة:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ جلب درس محدد (مع معلومات البث والرصيد المعلق)
// ============================================================
router.get(['/offer/:offer_id', '/teacher/offer/:offer_id'], async (req, res) => {
    try {
        const offer_id = parseInt(req.params.offer_id);
        
        const { data: offer, error } = await supabase
            .from('offers')
            .select('*')
            .eq('id', offer_id)
            .single();

        if (error || !offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        // ✅ جلب معلومات المعلم
        const { data: teacher, error: teacherError } = await supabase
            .from('teachers')
            .select('id, full_name, specialization, profile_image, profile_url')
            .eq('id', offer.teacher_id)
            .single();

        if (teacherError) {
            logger.error('خطأ في جلب بيانات المعلم:', teacherError.message);
        }

        // ✅ جلب عدد الطلاب المسجلين
        const { count: studentsCount, error: countError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id)
            .in('payment_status', ['paid', 'pending_stream']);

        if (countError) {
            logger.error('خطأ في جلب عدد الطلاب:', countError.message);
        }

        // ✅ جلب الرصيد المعلق الإجمالي
        const { data: pendingData, error: pendingError } = await supabase
            .from('sessions')
            .select('payment_amount')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'pending_stream');

        let totalPendingBalance = 0;
        if (!pendingError && pendingData) {
            totalPendingBalance = pendingData.reduce((sum, s) => sum + (s.payment_amount || 0), 0);
        }

        // ✅ حساب الوقت المتبقي
        const remainingSeconds = calculateOfferRemainingSeconds(offer);
        const totalSessions = offer.total_sessions || 1;
        const sessionDuration = offer.session_duration || offer.duration || 60;
        const pricePerSession = parseFloat(offer.price_per_session || offer.price || 0);
        const isFree = (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && pricePerSession === 0;
        const platformFeePerSession = isFree ? 0 : (offer.platform_fee_per_session || Math.round((sessionDuration / 60) * 50));
        const totalPlatformFee = isFree ? 0 : (offer.total_platform_fee || (platformFeePerSession * totalSessions));
        const totalTeacherPrice = isFree ? 0 : (offer.total_teacher_price || (pricePerSession * totalSessions));
        const totalStudentPrice = isFree ? 0 : (offer.total_student_price || (totalTeacherPrice + totalPlatformFee));

        res.json({
            id: offer.id,
            teacher_id: offer.teacher_id,
            subject_name: offer.subject_name,
            duration: sessionDuration,
            session_duration: sessionDuration,
            offer_date: offer.offer_date,
            price: pricePerSession,
            price_per_session: pricePerSession,
            is_free: isFree,
            plan_type: offer.plan_type || (totalSessions > 1 ? '1_month' : '1_day'),
            total_sessions: totalSessions,
            platform_fee_per_session: platformFeePerSession,
            total_platform_fee: totalPlatformFee,
            total_teacher_price: totalTeacherPrice,
            total_student_price: totalStudentPrice,
            completed_sessions_count: offer.completed_sessions_count || 0,
            sessions_schedule: offer.sessions_schedule || [],
            total_released_amount: offer.total_released_amount || 0,
            status: offer.status,
            education_level: offer.education_level,
            stream_url: offer.stream_url || null,
            stream_platform: offer.stream_platform || 'jitsi',
            room_password: offer.room_password || null,
            room_name: offer.room_name || null,
            total_seconds: offer.total_seconds || (sessionDuration * 60),
            remaining_seconds: remainingSeconds,
            is_paused: offer.is_paused || false,
            booked_count: offer.booked_count || 0,
            views_count: getViewCount('offer', offer.id, offer.views_count || offer.views || 0),
            views: getViewCount('offer', offer.id, offer.views_count || offer.views || 0),
            total_pending_balance: totalPendingBalance,
            created_at: offer.created_at,
            updated_at: offer.updated_at,
            stream_started_at: offer.stream_started_at || null,
            completed_at: offer.completed_at || null,
            teacher_name: teacher?.full_name || 'غير معروف',
            teacher_specialization: teacher?.specialization || '',
            teacher_profile_image: teacher?.profile_url || getPublicImageUrl('profiles', 'teachers', teacher?.profile_image),
            students_count: studentsCount || 0
        });
    } catch (error) {
        logger.error('خطأ في جلب الدرس:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب دروس الأستاذ (للوحة التحكم)
// ============================================================
router.get('/teacher/offers/:teacher_id', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacher_id = parseInt(req.params.teacher_id);
        
        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data: offers, error: offersError } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', teacher_id)
            .order('offer_date', { ascending: false });

        if (offersError) throw offersError;

        if (!offers || offers.length === 0) {
            return res.json([]);
        }

        const formatted = offers.map(offer => {
            // ✅ حساب الوقت المتبقي
            const remainingSeconds = calculateOfferRemainingSeconds(offer);
            const views = getViewCount('offer', offer.id, offer.views_count || offer.views || 0);
            const totalSessions = offer.total_sessions || 1;
            const sessionDuration = offer.session_duration || offer.duration || 60;
            const pricePerSession = parseFloat(offer.price_per_session || offer.price || 0);
            const isFree = (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && pricePerSession === 0;
            const platformFeePerSession = isFree ? 0 : (offer.platform_fee_per_session || Math.round((sessionDuration / 60) * 50));
            const totalPlatformFee = isFree ? 0 : (offer.total_platform_fee || (platformFeePerSession * totalSessions));
            const totalTeacherPrice = isFree ? 0 : (offer.total_teacher_price || (pricePerSession * totalSessions));
            const totalStudentPrice = isFree ? 0 : (offer.total_student_price || (totalTeacherPrice + totalPlatformFee));

            return {
                id: offer.id,
                teacher_id: offer.teacher_id,
                subject_name: offer.subject_name,
                duration: sessionDuration,
                session_duration: sessionDuration,
                offer_date: offer.offer_date,
                price: pricePerSession,
                price_per_session: pricePerSession,
                is_free: isFree,
                plan_type: offer.plan_type || (totalSessions > 1 ? '1_month' : '1_day'),
                total_sessions: totalSessions,
                platform_fee_per_session: platformFeePerSession,
                total_platform_fee: totalPlatformFee,
                total_teacher_price: totalTeacherPrice,
                total_student_price: totalStudentPrice,
                completed_sessions_count: offer.completed_sessions_count || 0,
                sessions_schedule: offer.sessions_schedule || [],
                total_released_amount: offer.total_released_amount || 0,
                status: offer.status,
                education_level: offer.education_level,
                room_name: offer.room_name || null,
                room_password: offer.room_password || null,
                stream_url: offer.stream_url || null,
                stream_platform: offer.stream_platform || 'jitsi',
                total_seconds: offer.total_seconds || (sessionDuration * 60),
                remaining_seconds: remainingSeconds,
                is_paused: offer.is_paused || false,
                booked_count: offer.booked_count || 0,
                views_count: views,
                views: views,
                thumbnail_url: offer.thumbnail_url || null,
                image_url: offer.image_url || offer.thumbnail_url || null,
                created_at: offer.created_at,
                updated_at: offer.updated_at,
                stream_started_at: offer.stream_started_at || null
            };
        });

        res.json(formatted);
    } catch (error) {
        logger.error('خطأ في جلب دروس الأستاذ:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ جلب جدول حصص البث المجدولة لدرس معين
// ============================================================
router.get(['/offer/:offer_id/sessions', '/teacher/offer/:offer_id/sessions'], async (req, res) => {
    try {
        const offer_id = parseInt(req.params.offer_id);
        const { data: offer, error: offerError } = await supabase
            .from('offers')
            .select('id, subject_name, plan_type, total_sessions, session_duration, price_per_session, sessions_schedule, completed_sessions_count')
            .eq('id', offer_id)
            .single();

        if (offerError || !offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        // جلب من جدول stream_sessions إن وجد، وإلا إرجاع sessions_schedule المخزن
        const { data: streamSessions, error: ssError } = await supabase
            .from('stream_sessions')
            .select('*')
            .eq('offer_id', offer_id)
            .order('session_number', { ascending: true });

        const sessions = (streamSessions && streamSessions.length > 0) 
            ? streamSessions 
            : (offer.sessions_schedule || []);

        res.json({
            success: true,
            offer_id: offer.id,
            plan_type: offer.plan_type || '1_day',
            total_sessions: offer.total_sessions || 1,
            completed_sessions_count: offer.completed_sessions_count || 0,
            sessions: sessions
        });
    } catch (error) {
        logger.error('خطأ في جلب حصص الدرس:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ حذف درس
// ============================================================
router.delete('/offer/delete/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف الدرس غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const teacher_id = req.user.userId;

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        if (teacher_id === -1 || teacher_id === '-1' || req.user.is_guest || offer.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بحذف هذا الدرس' });
        }

        // ✅ معالجة استرداد أي حجوزات نشطة إن وجدت قبل الحذف
        const { data: activeSessions } = await supabase
            .from('sessions')
            .select('id, student_id, payment_amount, payment_status')
            .eq('offer_id', offer_id)
            .in('payment_status', ['paid', 'pending_stream']);

        if (activeSessions && activeSessions.length > 0) {
            console.log(`⚠️ حذف درس يحتوي على ${activeSessions.length} حجز نشط - البدء في إعادة المبالغ للطلاب`);
            const isOfferFree = (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && parseFloat(offer.price || 0) === 0;

            for (const session of activeSessions) {
                const refundAmount = (!isOfferFree && session.payment_amount > 0) ? session.payment_amount : 0;

                if (refundAmount > 0) {
                    // إعادة المبلغ للطالب
                    const student = await getOne('students', 'id', session.student_id);
                    if (student) {
                        await update('students', session.student_id, {
                            wallet_balance: (student.wallet_balance || 0) + refundAmount
                        });
                    }

                    // خصم من الرصيد المعلق للأستاذ
                    const teacher = await getOne('teachers', 'id', offer.teacher_id);
                    if (teacher) {
                        await update('teachers', offer.teacher_id, {
                            pending_withdraw: Math.max(0, (teacher.pending_withdraw || 0) - refundAmount)
                        });
                    }

                    // تسجيل المعاملة
                    await insert('wallet_transactions', {
                        student_id: session.student_id,
                        amount: refundAmount,
                        type: 'refund',
                        status: 'completed',
                        description: `استرداد مبلغ حجز لدرس محذوف "${offer.subject_name || 'غير معروف'}"`,
                        created_at: new Date().toISOString()
                    });
                }

                // إرسال إشعار للطالب
                try {
                    await supabase.from('notifications').insert({
                        user_id: session.student_id,
                        title: 'إلغاء حجز واسترداد مبلغ (حذف الدرس)',
                        message: `قام الأستاذ بحذف درس "${offer.subject_name || 'غير معروف'}" وتمت إعادة مبلغ ${refundAmount} دج إلى محفظتك.`,
                        type: 'refund',
                        is_read: false,
                        created_at: new Date().toISOString()
                    });
                } catch (notifErr) {
                    console.warn('⚠️ تعذر إرسال إشعار الإلغاء للطالب:', notifErr.message);
                }
            }
        }

        try {
            // استرداد كامل للطلاب عند حذف الدرس من قبل الأستاذ عبر نظام البث
            await processStreamPayments(offer_id, true);
        } catch (refundError) {
            logger.error('❌ خطأ أثناء معالجة الاستردادات عند الحذف:', refundError.message);
        }

        // ✅ أرشفة وسجل تفاصيل البث المحذوف كدليل قاطع للمدير قبل الحذف
        try {
            await archiveStreamLog(offer_id, 'deleted', teacher_id);
        } catch (archErr) {
            logger.error('⚠️ خطأ في أرشفة الدرس المحذوف:', archErr.message);
        }

        // ✅ حذف البيانات المرتبطة
        const tables = [
            'active_stream', 
            'waiting_room', 
            'student_room_passwords', 
            'stream_verification', 
            'stream_chat_messages', 
            'stream_mutes',
            'sessions'
        ];
        for (const table of tables) {
            try {
                await supabase.from(table).delete().eq('offer_id', offer_id);
            } catch (e) {
                logger.error(`خطأ في حذف بيانات ${table}:`, e.message);
            }
        }

        // ✅ حذف الإشعارات المرتبطة
        try {
            await supabase.from('notifications').delete().eq('offer_id', offer_id);
        } catch (e) {
            logger.error('خطأ في حذف الإشعارات:', e.message);
        }

        // ✅ حذف الدرس
        const { error: deleteError } = await supabase
            .from('offers')
            .delete()
            .eq('id', offer_id);

        if (deleteError) {
            logger.error('❌ خطأ في حذف الدرس:', deleteError);
            return res.status(500).json({ success: false, error: deleteError.message });
        }

        res.json({ 
            success: true, 
            message: 'تم حذف الدرس بنجاح'
        });
    } catch (error) {
        logger.error('خطأ في حذف الدرس:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب قائمة الطلاب الحاديين/المسجلين في درس معين (للأستاذ)
// ============================================================
router.get(['/offer/:offer_id/students', '/teacher/offer/:offer_id/students'], authenticate, authorize(['teacher', 'admin']), [
    param('offer_id').isInt().withMessage('معرف الدرس غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);
        const offer = await getOne('offers', 'id', offer_id);

        if (!offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        // التحقق من الملكية إذا كان المستخدم أستاذ
        if (req.user.role === 'teacher' && offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك برؤية طلاب هذا الدرس' });
        }

        const { data: sessions, error: sessionsError } = await supabase
            .from('sessions')
            .select(`
                id,
                student_id,
                offer_id,
                payment_status,
                payment_amount,
                created_at,
                students:student_id (
                    id,
                    full_name,
                    email,
                    phone,
                    education_level,
                    profile_image,
                    profile_url
                )
            `)
            .eq('offer_id', offer_id)
            .in('payment_status', ['paid', 'pending_stream'])
            .order('created_at', { ascending: false });

        if (sessionsError) {
            logger.error('خطأ في جلب طلاب الدرس:', sessionsError.message);
            return res.status(500).json({ success: false, error: 'حدث خطأ في قاعدة البيانات' });
        }

        const students = (sessions || []).map(s => {
            const studentInfo = s.students || {};
            let profileImg = studentInfo.profile_url || studentInfo.profile_image;
            if (profileImg && !profileImg.startsWith('http')) {
                profileImg = getPublicImageUrl('profiles', 'students', profileImg);
            }
            return {
                session_id: s.id,
                student_id: s.student_id,
                student_name: studentInfo.full_name || 'طالب منصة',
                student_email: studentInfo.email || '',
                student_phone: studentInfo.phone || 'غير متوفر',
                student_education_level: studentInfo.education_level || 'غير محدد',
                profile_image: profileImg,
                payment_status: s.payment_status,
                payment_amount: s.payment_amount || 0,
                booked_at: s.created_at
            };
        });

        return res.json({
            success: true,
            offer: {
                id: offer.id,
                subject_name: offer.subject_name,
                booked_count: students.length
            },
            students: students
        });
    } catch (error) {
        logger.error('خطأ في جلب قائمة طلاب الدرس:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب مستويات التعليم المتاحة (للفلترة)
// ============================================================
router.get('/education-levels', async (req, res) => {
    try {
        const { data: offers, error } = await supabase
            .from('offers')
            .select('education_level')
            .not('education_level', 'is', null)
            .neq('education_level', '');

        if (error) throw error;

        const levels = [...new Set(offers.map(o => o.education_level).filter(Boolean))];

        const levelMap = {
            'primary_all': 'التعليم الابتدائي',
            'primary_1': 'السنة الأولى ابتدائي',
            'primary_2': 'السنة الثانية ابتدائي',
            'primary_3': 'السنة الثالثة ابتدائي',
            'primary_4': 'السنة الرابعة ابتدائي',
            'primary_5': 'السنة الخامسة ابتدائي',
            '5eme_pri': 'خامسة ابتدائي',
            'middle_all': 'التعليم المتوسط',
            '1ere_am': 'أولى متوسط',
            '2eme_am': 'ثانية متوسط',
            '3eme_am': 'ثالثة متوسط',
            '4eme_am': 'رابعة متوسط (BEM)',
            'bem': 'رابعة متوسط (BEM)',
            'secondary_all': 'التعليم الثانوي',
            '1ere_as': 'أولى ثانوي',
            '2eme_as': 'ثانية ثانوي',
            '3eme_as': 'ثالثة ثانوي (BAC)',
            'bac': 'ثالثة ثانوي (BAC)',
            'university': 'تعليم جامعي / عالي',
            '1ere_uni': 'أولى جامعي (L1)',
            '2eme_uni': 'ثانية جامعي (L2)',
            '2ere_uni': 'ثانية جامعي (L2)',
            '3eme_uni': 'ثالثة جامعي (L3)',
            '3ere_uni': 'ثالثة جامعي (L3)',
            'master': 'ماستر',
            'doctorat': 'دكتوراه',
            'other': 'مستوى آخر'
        };

        const formattedLevels = levels.map(level => ({
            value: level,
            label: levelMap[level] || level
        }));

        res.json(formattedLevels);
    } catch (error) {
        logger.error('خطأ في جلب مستويات التعليم:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ عدد الدروس المباشرة الجديدة غير المشاهدة
// ============================================================
router.get('/unread-count', async (req, res) => {
    try {
        const { last_viewed } = req.query;

        let query = supabase
            .from('offers')
            .select('id', { count: 'exact', head: true });

        if (last_viewed && last_viewed !== 'null' && last_viewed !== 'undefined' && last_viewed !== '') {
            query = query.gt('created_at', last_viewed);
        } else {
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            query = query.gt('created_at', oneDayAgo);
        }

        const { count, error: countErr } = await query;
        if (countErr && countErr.code !== 'PGRST116') throw countErr;

        res.json({
            success: true,
            unread_count: count || 0
        });
    } catch (error) {
        logger.error('Error getting unread offers count:', error.message);
        res.json({ success: true, unread_count: 0 });
    }
});

module.exports = router;
