// ============================================================
// مسارات العروض - Offer Routes (معدل بالكامل مع دعم نظام البث والرصيد المعلق)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const crypto = require('crypto');

const { supabase } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { getOne, insert, update } = require('../utils/helpers');

// ============================================================
// ✅ إنشاء عرض جديد (مع دعم نظام البث والرصيد المعلق)
// ============================================================
router.post('/offer/create', authenticate, authorize(['teacher']), [
    body('subject_name').notEmpty().withMessage('اسم المادة مطلوب').isLength({ max: 100 }),
    body('duration').isInt({ min: 1, max: 360 }).withMessage('المدة غير صالحة (1-360 دقيقة)'),
    body('offer_date').notEmpty().withMessage('تاريخ العرض مطلوب').isISO8601().withMessage('تاريخ غير صالح'),
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
                errors: errors.array() 
            });
        }

        const { 
            subject_name, 
            duration, 
            offer_date, 
            price, 
            is_free = false, 
            education_level = null 
        } = req.body;

        // ✅ استخدام teacher_id من التوكن
        const teacher_id = req.user.userId;

        console.log('📝 محاولة إنشاء عرض للأستاذ:', teacher_id);
        console.log('📚 المادة:', subject_name);

        // ✅ التحقق من وجود الأستاذ في جدول teachers
        const { data: teacher, error: teacherError } = await supabase
            .from('teachers')
            .select('id, full_name, status, specialization, teaching_level')
            .eq('id', teacher_id)
            .single();

        if (teacherError || !teacher) {
            console.error('❌ الأستاذ غير موجود:', teacherError?.message);
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

        // ✅ التحقق من وجود المستوى التعليمي للأستاذ
        if (!teacher.teaching_level && !education_level) {
            return res.status(400).json({
                success: false,
                error: 'يرجى تحديد المستوى التعليمي للعرض أو تحديث ملفك الشخصي بالمستوى الذي تدرسه'
            });
        }

        // ✅ استخدام مستوى الأستاذ إذا لم يتم تحديد مستوى للعرض
        const finalEducationLevel = education_level || teacher.teaching_level;

        // ✅ حساب الوقت الكلي بالثواني
        const totalSeconds = parseInt(duration) * 60;

        // ✅ إنشاء كلمات المرور والغرفة
        const room_name = `stream_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        const defaultPassword = crypto.randomBytes(4).toString('hex').toUpperCase();

        // ✅ تحويل الوقت من التوقيت المحلي (الجزائر) إلى UTC للتخزين
        // datetime-local يرسل الوقت بدون معلومات المنطقة الزمنية، نفترض أنه التوقيت المحلي
        const [datePart, timePart] = offer_date.split('T');
        const [year, month, day] = datePart.split('-').map(Number);
        const [hours, minutes] = timePart.split(':').map(Number);
        
        // إنشاء كائن تاريخ بالتوقيت المحلي ثم تحويله إلى UTC
        const localDate = new Date(year, month - 1, day, hours, minutes);
        const offerDateUTC = new Date(localDate.getTime() - (localDate.getTimezoneOffset() * 60000));

        // ✅ إدخال العرض في قاعدة البيانات
        const newOffer = {
            teacher_id: teacher_id,
            subject_name: subject_name.trim(),
            duration: parseInt(duration),
            offer_date: offerDateUTC.toISOString(),
            price: parseFloat(price) || 0,
            is_free: is_free ? true : false,
            room_name: room_name,
            room_password: defaultPassword,
            status: 'upcoming',
            education_level: finalEducationLevel,
            booked_count: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        console.log('💾 إدخال العرض:', newOffer);

        const { data: insertedOffer, error: insertError } = await supabase
            .from('offers')
            .insert(newOffer)
            .select()
            .single();

        if (insertError) {
            console.error('❌ خطأ في إدخال العرض:', insertError);
            return res.status(500).json({ 
                success: false, 
                error: 'حدث خطأ في قاعدة البيانات: ' + insertError.message 
            });
        }

        if (!insertedOffer) {
            return res.status(500).json({ 
                success: false, 
                error: 'فشل إنشاء العرض، يرجى المحاولة مرة أخرى' 
            });
        }

        console.log('✅ تم إنشاء العرض بنجاح:', insertedOffer.id);

        // ✅ إرجاع النتيجة
        res.json({ 
            success: true, 
            message: 'تم إنشاء العرض بنجاح',
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
        console.error('❌ خطأ في إنشاء العرض:', error.message);
        console.error('📚 Stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ في الخادم أثناء إنشاء العرض: ' + error.message 
        });
    }
});

// ============================================================
// ✅ تحديث عرض (مع دعم تحديث حالة البث)
// ============================================================
router.put('/offer/update/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
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

        // ✅ التحقق من وجود العرض
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتحديث هذا العرض' });
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

        updateData.updated_at = new Date().toISOString();

        console.log('📝 تحديث العرض:', offer_id, updateData);

        const { data: updatedOffer, error: updateError } = await supabase
            .from('offers')
            .update(updateData)
            .eq('id', offer_id)
            .select()
            .single();

        if (updateError) {
            console.error('❌ خطأ في تحديث العرض:', updateError);
            return res.status(500).json({ success: false, error: updateError.message });
        }

        res.json({
            success: true,
            message: 'تم تحديث العرض بنجاح',
            offer: updatedOffer
        });
    } catch (error) {
        console.error('❌ خطأ في تحديث العرض:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب جميع العروض القادمة (مع فلتر المستوى التعليمي)
// ============================================================
router.get('/offers', async (req, res) => {
    try {
        const now = new Date().toISOString();
        
        let query = supabase
            .from('offers')
            .select('*')
            .in('status', ['upcoming', 'live', 'teacher_ready'])
            .order('offer_date', { ascending: true });

        // ✅ فلتر حسب المستوى التعليمي (اختياري)
        if (req.query.education_level) {
            const level = req.query.education_level;
            if (level !== 'all') {
                query = query.eq('education_level', level);
            }
        }

        const { data: offers, error } = await query;

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
            console.error('خطأ في جلب بيانات المعلمين:', teachersError.message);
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

            // ✅ حساب الوقت المتبقي للعروض المباشرة
            let remainingSeconds = offer.remaining_seconds || 0;
            if (offer.status === 'live' && !offer.is_paused && offer.stream_started_at) {
                const startedAt = new Date(offer.stream_started_at);
                const nowTime = new Date();
                const elapsed = Math.floor((nowTime - startedAt) / 1000);
                const total = offer.total_seconds || (offer.duration * 60);
                remainingSeconds = Math.max(0, total - elapsed);
            }

            return {
                id: offer.id,
                teacher_id: offer.teacher_id,
                subject_name: offer.subject_name,
                duration: offer.duration,
                offer_date: offer.offer_date,
                price: offer.price,
                is_free: offer.is_free,
                status: offer.status,
                education_level: offer.education_level,
                room_password: offer.room_password || null,
                room_name: offer.room_name || null,
                stream_url: offer.stream_url || null,
                stream_platform: offer.stream_platform || 'jitsi',
                total_seconds: offer.total_seconds || (offer.duration * 60),
                remaining_seconds: remainingSeconds,
                is_paused: offer.is_paused || false,
                booked_count: offer.booked_count || 0,
                created_at: offer.created_at,
                teacher_name: teacher.full_name || 'غير معروف',
                teacher_specialization: teacher.specialization || '',
                teacher_profile_image: teacher.profile_image || null,
                teacher_profile_url: teacher.profile_url || null
            };
        });

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب العروض:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ جلب العروض المباشرة
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
            .select('id, full_name, specialization, profile_url')
            .in('id', teacherIds);

        if (teachersError) {
            console.error('خطأ في جلب بيانات المعلمين:', teachersError.message);
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
            let remainingSeconds = offer.remaining_seconds || 0;
            if (offer.status === 'live' && !offer.is_paused && offer.stream_started_at) {
                const startedAt = new Date(offer.stream_started_at);
                const nowTime = new Date();
                const elapsed = Math.floor((nowTime - startedAt) / 1000);
                const total = offer.total_seconds || (offer.duration * 60);
                remainingSeconds = Math.max(0, total - elapsed);
            }

            return {
                id: offer.id,
                teacher_id: offer.teacher_id,
                subject_name: offer.subject_name,
                duration: offer.duration,
                offer_date: offer.offer_date,
                price: offer.price,
                is_free: offer.is_free,
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
                teacher_profile_url: teacher.profile_url || null
            };
        });

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب العروض المباشرة:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ جلب عرض محدد (مع معلومات البث والرصيد المعلق)
// ============================================================
router.get('/offer/:offer_id', async (req, res) => {
    try {
        const offer_id = parseInt(req.params.offer_id);
        
        const { data: offer, error } = await supabase
            .from('offers')
            .select('*')
            .eq('id', offer_id)
            .single();

        if (error || !offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        // ✅ جلب معلومات المعلم
        const { data: teacher, error: teacherError } = await supabase
            .from('teachers')
            .select('id, full_name, specialization, profile_image, profile_url')
            .eq('id', offer.teacher_id)
            .single();

        if (teacherError) {
            console.error('خطأ في جلب بيانات المعلم:', teacherError.message);
        }

        // ✅ جلب عدد الطلاب المسجلين
        const { count: studentsCount, error: countError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id)
            .in('payment_status', ['paid', 'pending_stream']);

        if (countError) {
            console.error('خطأ في جلب عدد الطلاب:', countError.message);
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
        let remainingSeconds = offer.remaining_seconds || 0;
        if (offer.status === 'live' && !offer.is_paused && offer.stream_started_at) {
            const startedAt = new Date(offer.stream_started_at);
            const nowTime = new Date();
            const elapsed = Math.floor((nowTime - startedAt) / 1000);
            const total = offer.total_seconds || (offer.duration * 60);
            remainingSeconds = Math.max(0, total - elapsed);
        }

        res.json({
            id: offer.id,
            teacher_id: offer.teacher_id,
            subject_name: offer.subject_name,
            duration: offer.duration,
            offer_date: offer.offer_date,
            price: offer.price,
            is_free: offer.is_free,
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
            total_pending_balance: totalPendingBalance,
            created_at: offer.created_at,
            updated_at: offer.updated_at,
            stream_started_at: offer.stream_started_at || null,
            completed_at: offer.completed_at || null,
            teacher_name: teacher?.full_name || 'غير معروف',
            teacher_specialization: teacher?.specialization || '',
            teacher_profile_image: teacher?.profile_image || null,
            teacher_profile_url: teacher?.profile_url || null,
            students_count: studentsCount || 0
        });
    } catch (error) {
        console.error('خطأ في جلب العرض:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب عروض الأستاذ (للوحة التحكم)
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
            let remainingSeconds = offer.remaining_seconds || 0;
            if (offer.status === 'live' && !offer.is_paused && offer.stream_started_at) {
                const startedAt = new Date(offer.stream_started_at);
                const nowTime = new Date();
                const elapsed = Math.floor((nowTime - startedAt) / 1000);
                const total = offer.total_seconds || (offer.duration * 60);
                remainingSeconds = Math.max(0, total - elapsed);
            }

            return {
                id: offer.id,
                teacher_id: offer.teacher_id,
                subject_name: offer.subject_name,
                duration: offer.duration,
                offer_date: offer.offer_date,
                price: offer.price,
                is_free: offer.is_free,
                status: offer.status,
                education_level: offer.education_level,
                room_name: offer.room_name || null,
                room_password: offer.room_password || null,
                stream_url: offer.stream_url || null,
                stream_platform: offer.stream_platform || 'jitsi',
                total_seconds: offer.total_seconds || (offer.duration * 60),
                remaining_seconds: remainingSeconds,
                is_paused: offer.is_paused || false,
                booked_count: offer.booked_count || 0,
                created_at: offer.created_at,
                updated_at: offer.updated_at,
                stream_started_at: offer.stream_started_at || null
            };
        });

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب عروض الأستاذ:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// ✅ حذف عرض
// ============================================================
router.delete('/offer/delete/:offer_id', authenticate, authorize(['teacher']), [
    param('offer_id').isInt().withMessage('معرف العرض غير صالح')
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
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بحذف هذا العرض' });
        }

        if (offer.status === 'live' || offer.status === 'teacher_ready') {
            return res.status(400).json({ 
                success: false, 
                error: 'لا يمكن حذف العرض أثناء البث المباشر' 
            });
        }

        // ✅ حذف البيانات المرتبطة
        const tables = ['sessions', 'waiting_room', 'active_stream', 'student_room_passwords'];
        for (const table of tables) {
            try {
                await supabase.from(table).delete().eq('offer_id', offer_id);
            } catch (e) {
                console.error(`خطأ في حذف ${table}:`, e.message);
            }
        }

        // ✅ حذف الإشعارات المرتبطة
        try {
            await supabase.from('notifications').delete().eq('offer_id', offer_id);
        } catch (e) {
            console.error('خطأ في حذف الإشعارات:', e.message);
        }

        // ✅ حذف العرض
        const { error: deleteError } = await supabase
            .from('offers')
            .delete()
            .eq('id', offer_id);

        if (deleteError) {
            console.error('❌ خطأ في حذف العرض:', deleteError);
            return res.status(500).json({ success: false, error: deleteError.message });
        }

        res.json({ 
            success: true, 
            message: 'تم حذف العرض بنجاح'
        });
    } catch (error) {
        console.error('خطأ في حذف العرض:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
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
            '5eme_pri': 'خامسة ابتدائي',
            '1ere_am': 'أولى متوسط',
            '2eme_am': 'ثانية متوسط',
            '3eme_am': 'ثالثة متوسط',
            '4eme_am': 'رابعة متوسط',
            '5eme_am': 'خامسة متوسط',
            '1ere_as': 'أولى ثانوي',
            '2eme_as': 'ثانية ثانوي',
            '3eme_as': 'ثالثة ثانوي',
            'bac': 'بكالوريا',
            '1ere_uni': 'أولى جامعي',
            '2eme_uni': 'ثانية جامعي',
            '3eme_uni': 'ثالثة جامعي',
            'master': 'ماستر',
            'doctorat': 'دكتوراه'
        };

        const formattedLevels = levels.map(level => ({
            value: level,
            label: levelMap[level] || level
        }));

        res.json(formattedLevels);
    } catch (error) {
        console.error('خطأ في جلب مستويات التعليم:', error.message);
        res.status(500).json([]);
    }
});

module.exports = router;
