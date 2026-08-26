const logger = require('../utils/logger');
// ============================================================
// مسارات الإدارة - Admin Routes (معدل بالكامل مع دعم نظام البث والرصيد المعلق)
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { Resend } = require('resend');
const resendApiKey = process.env.RESEND_API_KEY;
const resend = resendApiKey ? new Resend(resendApiKey) : null;
const bcrypt = require('bcryptjs');
const multer = require('multer');

// استيراد الدوال
const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { getOne, insert, update, remove } = require('../utils/helpers');
const { encrypt, maskIP } = require('../utils/encryption');
const { processReferralReward } = require('../utils/referral');
const { uploadToSupabase, validateUploadedFiles, getPublicImageUrl, deleteTeacherVerificationDocs, deleteStorageFile } = require('../utils/upload');
const { sendTeacherApprovalEmail, sendTeacherRejectionEmail, sendEmail } = require('../utils/email');
const { sendPushNotification } = require('../utils/notification');

const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// ✅ تعريف authorize محلياً
function authorize(roles = []) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, error: 'غير مصرح به' });
        }
        if (roles.length > 0 && !roles.includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'صلاحيات غير كافية' });
        }
        next();
    };
}

// ✅ مسار لجلب الأساتذة الذين لم يرفعوا وثائقهم
router.get('/teachers-no-docs', authenticate, authorize(['admin']), async (req, res) => {
    try {
        logger.info('📥 جلب قائمة الأساتذة الذين لم يرفعوا وثائقهم...');
        
        // محاولة الجلب باستخدام الأعمدة الجديدة أولاً مع استثناء الأساتذة المقبولين
        let teachers = [];
        try {
            const { data, error } = await supabase
                .from('teachers')
                .select('*')
                .neq('status', 'approved')
                .or('diploma_image.is.null,id_image.is.null');
            
            if (!error) {
                teachers = data || [];
            } else {
                logger.warn('⚠️ فشل الجلب بالأعمدة الجديدة، المحاولة بالأعمدة القديمة:', error.message);
                // محاولة بالأعمدة القديمة
                const { data: oldData, error: oldError } = await supabase
                    .from('teachers')
                    .select('*')
                    .neq('status', 'approved')
                    .or('certificate_image.is.null,id_card_image.is.null');
                
                if (oldError) throw oldError;
                teachers = oldData || [];
            }
        } catch (innerError) {
            logger.error('❌ فشل كلي في جلب قائمة الأساتذة:', innerError.message);
            throw innerError;
        }
        
        const teachersWithImages = teachers.map(attachTeacherImageUrls);
        res.json(teachersWithImages);
    } catch (error) {
        logger.error('Error fetching teachers no docs:', {
            message: error.message,
            stack: error.stack
        });
        res.status(500).json({ 
            success: false, 
            error: 'فشل جلب قائمة الأساتذة من قاعدة البيانات',
            details: error.message
        });
    }
});

// ✅ مسار لإرسال إيميل تذكير
router.post('/send-email', authenticate, authorize(['admin']), [
    body('email').isEmail().withMessage('بريد إلكتروني غير صالح'),
    body('subject').notEmpty().withMessage('الموضوع مطلوب'),
    body('message').notEmpty().withMessage('الرسالة مطلوبة')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
        const { email, subject, message } = req.body;
        
        const emailResult = await sendEmail({
            to: email,
            subject: subject,
            text: message,
            html: message.replace(/\n/g, '<br>')
        });

        if (!emailResult.success) {
            return res.status(500).json({ success: false, error: 'فشل إرسال الإيميل' });
        }
        
        res.json({ success: true, data: emailResult.data });
    } catch (error) {
        logger.error('Error sending email:', error);
        res.status(500).json({ success: false, error: 'فشل إرسال الإيميل' });
    }
});

// ✅ مسار لجلب عدد الأحداث الجديدة
router.get('/admin-counts', authenticate, authorize(['admin']), async (req, res) => {
    try {
        // Pending teachers
        const { count: pendingTeachersCount, error: pendingError } = await supabase
            .from('teachers')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pending');
        
        // Withdrawals
        const { count: withdrawalsCount, error: withdrawalsError } = await supabase
            .from('withdrawals')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pending');

        // Support (unread)
        const { count: supportCount, error: supportError } = await supabase
            .from('support')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'unread');
            
        // Teachers no docs (الأساتذة غير المعتمدين الذين لم يرفعوا وثائقهم)
        const { data: noDocsData } = await supabase
            .from('teachers')
            .select('id')
            .neq('status', 'approved')
            .or('diploma_image.is.null,id_image.is.null');

        // Upgrade requests (الأساتذة الذين أرسلوا وثائق طلب الترقية وغير معتمدين)
        const { data: upgradeRequestsData } = await supabase
            .from('teachers')
            .select('id')
            .eq('is_certified', false)
            .or('id_image.not.is.null,diploma_image.not.is.null');

            pendingCourses: pendingCoursesCount || 0
        });
    } catch (error) {
        logger.error('Error fetching admin counts:', error);
        res.status(500).json({ success: false, error: 'فشل جلب الإحصائيات' });
    }
});

// ✅ دالة مساعدة لإضافة روابط الصور لبيانات الأستاذ (معدلة)
// تم التصحيح: استخدام أسماء الأعمدة الصحيحة من قاعدة البيانات
// profile_image, id_image, diploma_image
function attachTeacherImageUrls(teacher) {
    if (!teacher) return teacher;
    
    const profileUrl = (teacher.profile_url && teacher.profile_url !== 'null' && teacher.profile_url !== 'undefined' && teacher.profile_url !== 'NULL')
        ? teacher.profile_url
        : null;
        
    const hasProfileImage = (teacher.profile_image && teacher.profile_image !== 'null' && teacher.profile_image !== 'undefined' && teacher.profile_image !== 'NULL');
    
    const profile_image_url = profileUrl || (hasProfileImage ? getPublicImageUrl('profiles', 'teachers', teacher.profile_image) : null);

    const idImageVal = teacher.id_image || teacher.id_card_image;
    const hasIdImage = (idImageVal && idImageVal !== 'null' && idImageVal !== 'undefined' && idImageVal !== 'NULL');
    const id_card_image_url = hasIdImage ? getPublicImageUrl('profiles', 'ids', idImageVal) : null;

    const diplomaImageVal = teacher.diploma_image || teacher.certificate_image;
    const hasDiplomaImage = (diplomaImageVal && diplomaImageVal !== 'null' && diplomaImageVal !== 'undefined' && diplomaImageVal !== 'NULL');
    const certificate_image_url = hasDiplomaImage ? getPublicImageUrl('profiles', 'diplomas', diplomaImageVal) : null;

    return {
        ...teacher,
        profile_image: profile_image_url,
        profile_image_url,
        diploma_image: certificate_image_url,
        id_image: id_card_image_url,
        id_card_image_url,
        certificate_image_url
    };
}

function attachStudentImageUrls(student) {
    if (!student) return student;
    
    const profileUrl = (student.profile_url && student.profile_url !== 'null' && student.profile_url !== 'undefined' && student.profile_url !== 'NULL')
        ? student.profile_url
        : null;
        
    const hasProfileImage = (student.profile_image && student.profile_image !== 'null' && student.profile_image !== 'undefined' && student.profile_image !== 'NULL');
    
    const profile_image_url = profileUrl || (hasProfileImage ? getPublicImageUrl('profiles', 'students', student.profile_image) : null);

    return {
        ...student,
        profile_image: profile_image_url,
        profile_image_url
    };
}

// ============================================================
// ✅ جلب جميع الطلاب (مع المستوى التعليمي)
// ============================================================
router.get('/students', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب جميع الطلاب...');
        
        let { data, error } = await supabase
            .from('students')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('❌ خطأ في جلب الطلاب:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} طالب`);
        const studentsWithImages = (data || []).map(attachStudentImageUrls);
        res.json(studentsWithImages);
    } catch (error) {
        logger.error('❌ خطأ في جلب الطلاب:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب طلبات الترقية للأساتذة (الذين لديهم وثائق ترقية وغير معتمدين)
// ============================================================
router.get('/upgrade-requests', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب طلبات ترقية الأساتذة...');
        const { data, error } = await supabase
            .from('teachers')
            .select('*')
            .eq('is_certified', false)
            .or('id_image.not.is.null,diploma_image.not.is.null')
            .order('created_at', { ascending: false });

        if (error) throw error;
        const teachersWithImages = (data || []).map(attachTeacherImageUrls);
        res.json(teachersWithImages);
    } catch (error) {
        logger.error('❌ خطأ في جلب طلبات الترقية:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ قبول طلب الترقية ومنح الشارة الذهبية
// ============================================================
router.post('/approve-upgrade/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const teacherId = parseInt(req.params.id);
        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        try {
            await deleteTeacherVerificationDocs(teacher);
        } catch (e) {}

        const { error: updateError } = await supabase
            .from('teachers')
            .update({
                is_certified: true,
                status: 'approved',
                rejection_reason: null,
                diploma_image: null,
                id_image: null,
                updated_at: new Date().toISOString()
            })
            .eq('id', teacherId);

        if (updateError) throw updateError;

        try {
            await insert('notifications', {
                user_id: teacherId,
                user_type: 'teacher',
                title: '👑 تهانينا! تم قبول طلب الترقية',
                message: 'تم مراجعة وثائقك واعتماد حسابك بنجاح! تم منحك الشارة الذهبية وكافة ميزات الحساب المعتمد.',
                is_read: false,
                created_at: new Date().toISOString()
            });
        } catch (e) {}

        res.json({ success: true, message: 'تم قبول طلب الترقية ومنح الشارة الذهبية بنجاح' });
    } catch (error) {
        logger.error('Error approving upgrade:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});
router.get('/pending-teachers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب الأساتذة المعلقين...');
        
        let { data, error } = await supabase
            .from('teachers')
            .select('*')
            .or('status.eq.pending,and(is_certified.eq.false,id_image.not.is.null),and(is_certified.eq.false,diploma_image.not.is.null)')
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('❌ خطأ في جلب الأساتذة المعلقين:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        // ✅ إضافة روابط الصور العامة لكل أستاذ
        const teachersWithImages = (data || []).map(attachTeacherImageUrls);

        // ✅ طباعة أول أستاذ مع روابط الصور للتحقق (في سجل الخادم)
        if (teachersWithImages.length > 0) {
            console.log('✅ أول أستاذ مع روابط الصور:', {
                profile_image_url: teachersWithImages[0].profile_image_url,
                id_card_image_url: teachersWithImages[0].id_card_image_url,
                certificate_image_url: teachersWithImages[0].certificate_image_url
            });
        }

        console.log(`✅ تم جلب ${teachersWithImages.length} أستاذ معلق`);
        res.json(teachersWithImages);
    } catch (error) {
        logger.error('❌ خطأ في جلب الأساتذة المعلقين:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب جميع الأساتذة المقبولين (مع روابط الصور)
// ============================================================
router.get('/approved-teachers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب الأساتذة المقبولين...');
        
        let { data, error } = await supabase
            .from('teachers')
            .select('*')
            .eq('status', 'approved')
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('❌ خطأ في جلب الأساتذة المقبولين:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        const teachersWithImages = (data || []).map(attachTeacherImageUrls);

        console.log(`✅ تم جلب ${teachersWithImages.length} أستاذ مقبول`);
        res.json(teachersWithImages);
    } catch (error) {
        logger.error('❌ خطأ في جلب الأساتذة المقبولين:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب جميع الأساتذة (جميع الحالات) مع إحصائيات البث وروابط الصور
// ============================================================
router.get('/all-teachers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب جميع الأساتذة...');
        
        const { data: teachers, error } = await supabase
            .from('teachers')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('❌ خطأ في جلب الأساتذة:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        // ✅ جلب إحصائيات البث لكل أستاذ
        const teacherIds = teachers.map(t => t.id);
        let streamStats = {};
        
        if (teacherIds.length > 0) {
            const { data: offers, error: offersError } = await supabase
                .from('offers')
                .select('teacher_id, status, booked_count, duration')
                .in('teacher_id', teacherIds)
                .in('status', ['live', 'teacher_ready', 'paused']);

            if (!offersError && offers) {
                for (const offer of offers) {
                    if (!streamStats[offer.teacher_id]) {
                        streamStats[offer.teacher_id] = {
                            active_streams: 0,
                            total_students: 0,
                            total_pending: 0
                        };
                    }
                    streamStats[offer.teacher_id].active_streams++;
                    streamStats[offer.teacher_id].total_students += (offer.booked_count || 0);
                }
            }

            // ✅ جلب الرصيد المعلق لكل أستاذ
            const { data: sessions, error: sessionsError } = await supabase
                .from('sessions')
                .select('payment_amount, offers!inner(teacher_id)')
                .eq('payment_status', 'pending_stream');

            if (!sessionsError && sessions) {
                for (const session of sessions) {
                    const tid = session.offers?.teacher_id || session.teacher_id;
                    if (tid && streamStats[tid]) {
                        streamStats[tid].total_pending += (session.payment_amount || 0);
                    }
                }
            }
        }

        // ✅ تنسيق البيانات مع روابط الصور
        const formatted = teachers.map(teacher => {
            const stats = streamStats[teacher.id] || {
                active_streams: 0,
                total_students: 0,
                total_pending: 0
            };
            
            return attachTeacherImageUrls({
                ...teacher,
                active_streams: stats.active_streams,
                total_students: stats.total_students,
                total_pending_balance: stats.total_pending
            });
        });

        console.log(`✅ تم جلب ${formatted.length} أستاذ مع إحصائياتهم`);
        res.json(formatted);
    } catch (error) {
        logger.error('❌ خطأ في جلب الأساتذة:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ قبول الأستاذ (مع إرسال بريد قبول)
// ============================================================
router.post('/approve-teacher/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacherId = parseInt(req.params.id);
        console.log(`📥 قبول الأستاذ ID: ${teacherId}`);

        // ✅ جلب بيانات الأستاذ
        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        console.log(`👤 الأستاذ: ${teacher.full_name}, المستوى: ${teacher.teaching_level || 'غير محدد'}`);

        // ✅ 1. الحذف الفوري والتدمير النهائي لوثائق الهوية والشهادات للامتثال للقانون الجزائري 18-07 لحماية المعطيات الشخصية
        // يتم الاحتفاظ فقط بالصورة الشخصية للملف الشخصي (profile_image)
        try {
            await deleteTeacherVerificationDocs(teacher);
            console.log(`🔒 [DATA PRIVACY] Verified documents purged for approved teacher ID: ${teacherId}`);
        } catch (purgeErr) {
            console.warn(`⚠️ [DATA PRIVACY] Purge warning for teacher ${teacherId}:`, purgeErr.message);
        }

        // ✅ 2. تحديث حالة الأستاذ إلى approved مع منح الشارة الذهبية (is_certified = true) وتصفير حقول المستندات
        const { error: updateError } = await supabase
            .from('teachers')
            .update({ 
                status: 'approved',
                is_certified: true,
// ✅ رفض الأستاذ (مع إرسال بريد رفض)
// ============================================================
router.post('/reject-teacher/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الأستاذ غير صالح'),
    body('reason').optional().isString().withMessage('سبب الرفض غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacherId = parseInt(req.params.id);
        const { reason } = req.body;

        console.log(`📥 رفض الأستاذ ID: ${teacherId}, السبب: ${reason || 'غير محدد'}`);

        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        // ✅ حذف وإتلاف وثائق الهوية والشهادات فور رفض الطلب للامتثال للقانون الجزائري لحماية المعطيات الشخصية
        try {
            await deleteTeacherVerificationDocs(teacher);
        } catch (purgeErr) {
            console.warn(`⚠️ [DATA PRIVACY] Rejection purge warning:`, purgeErr.message);
        }

        const { error: updateError } = await supabase
            .from('teachers')
            .update({
                status: 'rejected',
                rejection_reason: reason || 'لم يتم تحديد سبب',
                diploma_image: null,
                id_image: null,
                updated_at: new Date().toISOString()
            })
            .eq('id', teacherId);

        if (updateError) {
            logger.error('❌ خطأ في رفض الأستاذ:', updateError);
            return res.status(500).json({ success: false, error: updateError.message });
        }

        let emailSent = false;
        try {
            emailSent = await sendTeacherRejectionEmail(teacher.email, teacher.full_name, reason);
            console.log(`📧 بريد الرفض: ${emailSent ? 'تم الإرسال ✅' : 'فشل الإرسال ❌'}`);
        } catch (emailError) {
            logger.error('❌ خطأ في إرسال بريد الرفض:', emailError.message);
        }

        // ✅ إرسال إشعار للأستاذ (داخل المنصة)
        try {
            await insert('notifications', {
                user_id: teacherId,
                user_type: 'teacher',
                title: '⚠️ تحديث بخصوص طلب اعتماد حسابك',
                message: `تم رفض طلب الاعتماد للسبب التالي: ${reason || 'لم يتم تحديد سبب'}. يمكنك إكمال وثائقك وملفك الشخصي لإعادة إرسال الطلب.`,
                is_read: false,
                created_at: new Date().toISOString()
            });
        } catch (notifErr) {
            console.warn('⚠️ فشل إرسال إشعار الرفض للأستاذ:', notifErr.message);
        }

        // ✅ إرسال إشعار دفع (Push Notification) للأستاذ
        try {
            await sendPushNotification(
                teacher,
                '⚠️ تحديث بخصوص طلب اعتماد حسابك',
                `تم رفض طلب الاعتماد للسبب التالي: ${reason || 'لم يتم تحديد سبب'}. يمكنك التعديل وإعادة الإرسال.`
            );
        } catch (pushErr) {
            console.warn('⚠️ فشل إرسال إشعار الدفع للأستاذ:', pushErr.message);
        }

        // ✅ إرسال إشعار للمدير في admin_notifications
        try {
            await supabase.from('admin_notifications').insert({
                title: '❌ تم رفض طلب أستاذ',
                message: `تم رفض طلب الأستاذ ${teacher.full_name}. السبب: ${reason || 'لم يتم تحديد سبب'}`,
                sent_to_all: false,
                students_count: 1,
                created_at: new Date().toISOString()
            });
        } catch (adminNotifErr) {
            console.warn('⚠️ فشل تسجيل إشعار الإدارة:', adminNotifErr.message);
        }

        console.log(`✅ تم رفض الأستاذ ${teacherId}`);
        res.json({ 
            success: true,
            message: emailSent
                ? '❌ تم رفض الأستاذ! تم إرسال بريد إعلامي إليه.'
                : '❌ تم رفض الأستاذ! لكن تعذر إرسال البريد الإلكتروني.',
            email_sent: emailSent
        });
    } catch (error) {
        logger.error('❌ خطأ في رفض الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب إحصائيات المنصة (مع دعم البث والرصيد المعلق)
// ============================================================
router.get('/stats', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب إحصائيات المنصة...');

        const { count: studentsCount, error: studentsError } = await supabase
            .from('students')
            .select('*', { count: 'exact', head: true });

        if (studentsError) logger.error('❌ خطأ في جلب عدد الطلاب:', studentsError);

        const { count: teachersCount, error: teachersError } = await supabase
            .from('teachers')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'approved');

        if (teachersError) logger.error('❌ خطأ في جلب عدد الأساتذة:', teachersError);

        const { count: pendingTeachers, error: pendingError } = await supabase
            .from('teachers')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending');

        if (pendingError) logger.error('❌ خطأ في جلب عدد الأساتذة المعلقين:', pendingError);

        const { count: liveStreams, error: liveError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .in('status', ['live', 'teacher_ready']);

        if (liveError) logger.error('❌ خطأ في جلب عدد البث المباشر:', liveError);

        const { count: pausedStreams, error: pausedError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'paused');

        if (pausedError) logger.error('❌ خطأ في جلب عدد البث المتوقف:', pausedError);

        const { data: pendingData, error: pendingBalanceError } = await supabase
            .from('sessions')
            .select('payment_amount')
            .eq('payment_status', 'pending_stream');

        let totalPendingBalance = 0;
        if (!pendingBalanceError && pendingData) {
            totalPendingBalance = pendingData.reduce((sum, s) => sum + (s.payment_amount || 0), 0);
        }

        const { data: paidData, error: paidError } = await supabase
            .from('sessions')
            .select('teacher_earned')
            .eq('payment_status', 'paid');

        let totalPaid = 0;
        if (!paidError && paidData) {
            totalPaid = paidData.reduce((sum, s) => sum + (s.teacher_earned || 0), 0);
        }

        const { count: activeStudents, error: activeError } = await supabase
            .from('active_stream')
            .select('*', { count: 'exact', head: true });

        if (activeError) logger.error('❌ خطأ في جلب عدد الطلاب النشطين:', activeError);

        const { count: totalOffers, error: offersError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true });

        if (offersError) logger.error('❌ خطأ في جلب عدد الدروس:', offersError);

        const { count: totalSessions, error: sessionsError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true });

        if (sessionsError) logger.error('❌ خطأ في جلب عدد الحجوزات:', sessionsError);

        res.json({
            success: true,
            stats: {
                students: studentsCount || 0,
                teachers: teachersCount || 0,
                pending_teachers: pendingTeachers || 0,
                live_streams: liveStreams || 0,
                paused_streams: pausedStreams || 0,
                total_streams: (liveStreams || 0) + (pausedStreams || 0),
                active_students_in_stream: activeStudents || 0,
                total_pending_balance: totalPendingBalance,
                total_paid_earnings: totalPaid,
                total_offers: totalOffers || 0,
                total_sessions: totalSessions || 0
            }
        });
    } catch (error) {
        logger.error('❌ خطأ في جلب إحصائيات المنصة:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب جميع الدروس (للمدير)
// ============================================================
router.get('/all-offers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب جميع الدروس...');
        
        const { data: offers, error } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (full_name, email, specialization)')
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('❌ خطأ في جلب الدروس:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        for (const offer of offers || []) {
            const { count, error: countError } = await supabase
                .from('sessions')
                .select('*', { count: 'exact', head: true })
                .eq('offer_id', offer.id)
                .in('payment_status', ['paid', 'pending_stream']);

            if (!countError) {
                offer.students_count = count || 0;
            }
        }

        console.log(`✅ تم جلب ${offers?.length || 0} درس`);
        res.json(offers || []);
    } catch (error) {
        logger.error('❌ خطأ في جلب الدروس:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ إلغاء درس (من قبل المدير)
// ============================================================
router.post('/cancel-offer/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الدرس غير صالح'),
    body('reason').optional().isString().withMessage('سبب الإلغاء غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offerId = parseInt(req.params.id);
        const { reason } = req.body;

        console.log(`📥 إلغاء الدرس ID: ${offerId}, السبب: ${reason || 'غير محدد'}`);

        const offer = await getOne('offers', 'id', offerId);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }

        await supabase
            .from('offers')
            .update({
                status: 'cancelled',
                updated_at: new Date().toISOString()
            })
            .eq('id', offerId);

        const { data: sessions } = await supabase
            .from('sessions')
            .select('id, student_id, payment_amount')
            .eq('offer_id', offerId)
            .eq('payment_status', 'pending_stream');

        if (sessions && sessions.length > 0) {
            const isOfferFree = offer ? (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1 || offer.price === 0 || parseFloat(offer.price) === 0) : false;
            for (const session of sessions) {
                const refundAmount = (!isOfferFree && session.payment_amount > 0) ? session.payment_amount : 0;
                if (refundAmount > 0) {
                    const student = await getOne('students', 'id', session.student_id);
                    if (student) {
                        await update('students', session.student_id, {
                            wallet_balance: (student.wallet_balance || 0) + refundAmount
                        });
                    }
                }

                await update('sessions', session.id, {
                    payment_status: 'cancelled',
                    refund_amount: refundAmount
                });
            }
        }

        await supabase.from('active_stream').delete().eq('offer_id', offerId);
        await supabase.from('waiting_room').delete().eq('offer_id', offerId);

        const { data: allSessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offerId)
            .in('payment_status', ['paid', 'pending_stream']);

        if (allSessions && allSessions.length > 0) {
            const notifications = allSessions.map(s => ({
                user_id: s.student_id,
                user_type: 'student',
                title: '❌ تم إلغاء الحصة',
                message: `تم إلغاء الحصة "${offer.subject_name}" من قبل الإدارة. السبب: ${reason || 'لم يتم تحديد سبب'}`,
                offer_id: offerId,
                is_read: false,
                created_at: new Date().toISOString()
            }));
            await supabase.from('notifications').insert(notifications);
        }

        await insert('notifications', {
            user_id: offer.teacher_id,
            user_type: 'teacher',
            title: '❌ تم إلغاء درسك',
            message: `تم إلغاء درس "${offer.subject_name}" من قبل الإدارة. السبب: ${reason || 'لم يتم تحديد سبب'}`,
            offer_id: offerId,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({
            success: true,
            message: '✅ تم إلغاء الدرس واسترداد المبالغ للطلاب'
        });
    } catch (error) {
        logger.error('❌ خطأ في إلغاء الدرس:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب سجل العمليات (للمدير)
// ============================================================
router.get('/logs', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب سجل العمليات...');
        
        const { data: loginLogs, error } = await supabase
            .from('login_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) {
            logger.error('❌ خطأ في جلب السجل:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        const formatted = (loginLogs || []).map(log => ({
            ...log,
            user_name: log.users?.full_name || 'غير معروف',
            user_email: log.users?.email || 'غير معروف'
        }));

        res.json(formatted);
    } catch (error) {
        logger.error('❌ خطأ في جلب السجل:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ جلب أرشيف وسجلات البث المحذوفة (مع كافة التفاصيل والأدلة القاطعة)
// ============================================================
router.get('/archived-streams', authenticate, authorize(['admin']), async (req, res) => {
    try {
        logger.info('📥 جلب أرشيف وسجلات البث المحذوفة...');
        let logsList = [];

        // 1. تجربة الجلب من جدول archived_stream_logs في Supabase
        try {
            const { data, error } = await supabase
                .from('archived_stream_logs')
                .select('*')
                .order('archived_at', { ascending: false })
                .limit(200);

            if (!error && data && data.length > 0) {
                logsList = data;
            }
        } catch (dbErr) {
            logger.warn('⚠️ فشل الجلب من جدول archived_stream_logs، الجلب من platform_settings:', dbErr.message);
        }

        // 2. إذا كان الجدول فارغاً أو غير موجود، تجربة الجلب من platform_settings
        if (logsList.length === 0) {
            try {
                const { data: psData } = await supabase
                    .from('platform_settings')
                    .select('value')
                    .eq('key', 'archived_stream_logs')
                    .single();

                if (psData && Array.isArray(psData.value)) {
                    logsList = psData.value;
                }
            } catch (psErr) {
                logger.warn('⚠️ تعذر الجلب من platform_settings:', psErr.message);
            }
        }

        res.json({ success: true, count: logsList.length, logs: logsList });
    } catch (error) {
        logger.error('❌ خطأ في جلب أرشيف البث:', error.message);
        res.status(500).json({ success: false, error: 'فشل جلب أرشيف البث', details: error.message });
    }
});

// ✅ حذف سجل أرشيف محدد من الإدارة
router.delete('/archived-streams/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const logId = req.params.id;

        // حذف من جدول archived_stream_logs إن وجد
        try {
            await supabase.from('archived_stream_logs').delete().eq('id', logId);
        } catch (e) {}

        // حذف من platform_settings
        try {
            const { data: psData } = await supabase
                .from('platform_settings')
                .select('value')
                .eq('key', 'archived_stream_logs')
                .single();

            if (psData && Array.isArray(psData.value)) {
                const updated = psData.value.filter(item => item.id !== logId && String(item.offer_id) !== String(logId));
                await supabase
                    .from('platform_settings')
                    .upsert({ key: 'archived_stream_logs', value: updated });
            }
        } catch (e) {}

        res.json({ success: true, message: 'تم حذف سجل الأرشيف بنجاح' });
    } catch (error) {
        logger.error('❌ خطأ في حذف سجل الأرشيف:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ إطلاق إصدار جديد للمنصة (تنبيه جميع الطلبة والأساتذة بضرورة التحديث)
// ============================================================
router.post('/broadcast-release', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const note = req.body.note || 'هناك إصدار جديد للمنصة، قم بعمل تحديث الآن للحصول على أحدث المميزات.';
        const newVersion = Date.now();

        const releaseData = {
            version: newVersion,
            note: note,
            released_at: new Date().toISOString()
        };

        global.latestPlatformVersion = releaseData;

        // 1. الحفظ في platform_settings
        try {
            await supabase
                .from('platform_settings')
                .upsert({ key: 'platform_version', value: releaseData });
        } catch (dbErr) {
            logger.warn('⚠️ تعذر الحفظ في platform_settings، تم الاعتماد على الذاكرة:', dbErr.message);
        }

        // 2. إرسال إشعار في جدول notifications لجميع الطلاب والأساتذة
        try {
            const { data: students } = await supabase.from('students').select('id');
            const { data: teachers } = await supabase.from('teachers').select('id');

            const notifications = [];
            if (students && students.length > 0) {
                students.forEach(s => notifications.push({
                    user_id: s.id,
                    user_type: 'student',
                    title: '🚀 إصدار جديد للمنصة متوفر!',
                    message: note,
                    type: 'system',
                    is_read: false
                }));
            }
            if (teachers && teachers.length > 0) {
                teachers.forEach(t => notifications.push({
                    user_id: t.id,
                    user_type: 'teacher',
                    title: '🚀 إصدار جديد للمنصة متوفر!',
                    message: note,
                    type: 'system',
                    is_read: false
                }));
            }

            if (notifications.length > 0) {
                await supabase.from('notifications').insert(notifications);
            }
        } catch (notifErr) {
            logger.warn('⚠️ تعذر إدخال إشعارات الاصدار في جدول notifications:', notifErr.message);
        }

        logger.info(`🚀 تم إطلاق الاصدار الجديد بنجاح! Version: ${newVersion}`);
        res.json({ success: true, version: newVersion, message: 'تم إطلاق الاصدار الجديد بنجاح' });
    } catch (error) {
        logger.error('❌ خطأ في إطلاق الاصدار الجديد:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء إطلاق الاصدار' });
    }
});

// ============================================================
// ✅ حذف الأستاذ
// ============================================================
router.delete('/delete-teacher/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacherId = parseInt(req.params.id);
        console.log(`📥 حذف الأستاذ ID: ${teacherId}`);

        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        // ✅ حذف كافة المستندات والصور الخاصة بالأستاذ من التخزين السحابي والمحلي
        try {
            await deleteTeacherVerificationDocs(teacher);
            if (teacher?.profile_image) {
                await deleteStorageFile('teachers', teacher.profile_image);
            }
        } catch (storageError) {
            console.warn('⚠️ خطأ في حذف ملفات الأستاذ:', storageError.message);
        }

        const tables = ['sessions', 'waiting_room', 'active_stream', 'offers', 'withdraw_requests'];
        for (const table of tables) {
            try {
                await supabase.from(table).delete().eq('teacher_id', teacherId);
            } catch (e) {
                console.warn(`⚠️ خطأ في حذف بيانات ${table}:`, e.message);
            }
        }

        await supabase.from('notifications').delete().eq('user_id', teacherId).eq('user_type', 'teacher');

        const { error } = await supabase.from('teachers').delete().eq('id', teacherId);

        if (error) {
            logger.error('❌ خطأ في حذف الأستاذ:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم حذف الأستاذ ${teacherId}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('❌ خطأ في حذف الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ حذف المستخدم (طالب أو أستاذ)
// ============================================================
router.post('/delete-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role, ban } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        console.log(`📥 حذف المستخدم ID: ${user_id}, الدور: ${role}, حظر: ${ban}`);

        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }
        
        let userIp = null;
        try {
            const { data: loginLog } = await supabase
                .from('login_logs')
                .select('ip_address')
                .eq('user_id', user_id)
                .eq('user_role', role)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
            
            userIp = loginLog?.ip_address || null;
        } catch (logError) {
            console.warn('⚠️ لا يوجد سجل دخول لهذا المستخدم:', logError.message);
        }
        
        const { error } = await supabase
            .from(tableName)
            .delete()
            .eq('id', user_id);

        if (error) {
            logger.error('❌ خطأ في حذف المستخدم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
        
        if (ban && userIp) {
            const { data: existingBan } = await supabase
                .from('banned_users')
                .select('*')
                .eq('ip_address', userIp)
                .single();
            
            if (!existingBan) {
                await insert('banned_users', {
                    user_id: user_id,
                    user_role: role,
                    full_name: user.full_name,
                    email: user.email,
                    ip_address: userIp,
                    ban_reason: 'تم حظر المستخدم تلقائياً عند حذف الحساب',
                    banned_at: new Date().toISOString(),
                    banned_by: 'admin'
                });
                console.log(`🔒 تم حظر IP المستخدم ${user_id}`);
            }
        }
        
        console.log(`✅ تم حذف المستخدم ${user_id}`);
        res.json({ 
            success: true, 
            message: 'تم حذف المستخدم بنجاح',
            banned: ban && userIp ? true : false
        });
    } catch (error) {
        logger.error('❌ خطأ في حذف المستخدم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ حظر المستخدم
// ============================================================
router.post('/ban-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role, reason } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        console.log(`📥 حظر المستخدم ID: ${user_id}, الدور: ${role}`);

        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }
        
        let userIp = null;
        try {
            const { data: loginLog } = await supabase
                .from('login_logs')
                .select('ip_address')
                .eq('user_id', user_id)
                .eq('user_role', role)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
            
            userIp = loginLog?.ip_address || null;
        } catch (logError) {
            console.warn('⚠️ لا يوجد سجل دخول لهذا المستخدم:', logError.message);
        }
        
        if (!userIp) {
            console.log(`⚠️ لا يمكن تحديد IP للمستخدم ${user_id}, سيتم استخدام معرف المستخدم للحظر`);
            userIp = `user_${user_id}_${role}_${Date.now()}`;
        }
        
        const { data: existingBan } = await supabase
            .from('banned_users')
            .select('*')
            .eq('ip_address', userIp)
            .single();
        
        if (existingBan) {
            await supabase
                .from('banned_users')
                .update({
                    ban_reason: reason || 'تم تحديث سبب الحظر',
                    banned_at: new Date().toISOString(),
                    banned_by: 'admin'
                })
                .eq('id', existingBan.id);
            
            await supabase
                .from(tableName)
                .update({ is_banned: true, ban_reason: reason || 'لم يتم تحديد سبب' })
                .eq('id', user_id);
            
            console.log(`🔒 تم تحديث حظر المستخدم ${user_id}`);
            return res.json({ success: true, message: 'تم تحديث حظر المستخدم بنجاح' });
        }
        
        await insert('banned_users', {
            user_id: user_id,
            user_role: role,
            full_name: user.full_name,
            email: user.email,
            ip_address: userIp,
            ban_reason: reason || 'لم يتم تحديد سبب',
            banned_at: new Date().toISOString(),
            banned_by: 'admin'
        });
        
        const { error } = await supabase
            .from(tableName)
            .update({ is_banned: true, ban_reason: reason || 'لم يتم تحديد سبب' })
            .eq('id', user_id);

        if (error) {
            logger.error('❌ خطأ في حظر المستخدم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
        
        console.log(`🔒 تم حظر المستخدم ${user_id}`);
        res.json({ success: true, message: 'تم حظر المستخدم بنجاح' });
    } catch (error) {
        logger.error('❌ خطأ في حظر المستخدم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ إلغاء حظر المستخدم
// ============================================================
router.post('/unban-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('role').isIn(['student', 'teacher']).withMessage('دور غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, role } = req.body;
        const tableName = role === 'student' ? 'students' : 'teachers';
        
        console.log(`📥 إلغاء حظر المستخدم ID: ${user_id}, الدور: ${role}`);
        
        const { data: banRecord } = await supabase
            .from('banned_users')
            .select('*')
            .eq('user_id', user_id)
            .eq('user_role', role)
            .single();
        
        if (!banRecord) {
            return res.status(404).json({ success: false, error: 'المستخدم غير محظور' });
        }
        
        await supabase
            .from('banned_users')
            .delete()
            .eq('id', banRecord.id);
        
        const { error } = await supabase
            .from(tableName)
            .update({ is_banned: false, ban_reason: null })
            .eq('id', user_id);

        if (error) {
            logger.error('❌ خطأ في إلغاء حظر المستخدم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
        
        console.log(`✅ تم إلغاء حظر المستخدم ${user_id}`);
        res.json({ success: true, message: 'تم إلغاء حظر المستخدم بنجاح' });
    } catch (error) {
        logger.error('❌ خطأ في إلغاء الحظر:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب المستخدمين المحظورين
// ============================================================
router.get('/banned-users', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب المستخدمين المحظورين...');
        
        let { data, error } = await supabase
            .from('banned_users')
            .select('*')
            .order('banned_at', { ascending: false });

        if (error) {
            logger.error('❌ خطأ في جلب المحظورين:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} مستخدم محظور`);
        res.json(data || []);

    } catch (error) {
        logger.error('❌ خطأ في جلب المحظورين:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ طلبات السحب
// ============================================================
router.get('/withdraw-requests', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب طلبات السحب...');
        
        let { data, error } = await supabase
            .from('withdraw_requests')
            .select('*, teachers:teacher_id (full_name, email, phone, ccp_account)')
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error) {
            logger.error('❌ خطأ في جلب طلبات السحب:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} طلب سحب`);
        res.json((data || []).sort((a,b) => (a.order_index || 0) - (b.order_index || 0)));
    } catch (error) {
        logger.error('❌ خطأ في جلب طلبات السحب:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ قبول طلب سحب
// ============================================================
router.post('/withdraw-requests/:id/approve', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الطلب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { id } = req.params;
        console.log(`📥 قبول طلب سحب ID: ${id}`);

        const request = await getOne('withdraw_requests', 'id', id);
        if (!request) {
            return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
        }

        const { error: updateError } = await supabase
            .from('withdraw_requests')
            .update({
                status: 'completed',
                processed_at: new Date().toISOString()
            })
            .eq('id', id);

        if (updateError) {
            logger.error('❌ خطأ في تحديث طلب السحب:', updateError);
            return res.status(500).json({ success: false, error: updateError.message });
        }

        const teacher = await getOne('teachers', 'id', request.teacher_id);
        if (teacher) {
            const originalAmt = request.original_amount || (request.fee_amount ? (request.amount + request.fee_amount) : Math.round(request.amount / 0.99));
            await supabase
                .from('teachers')
                .update({
                    total_withdrawn: (teacher.total_withdrawn || 0) + request.amount,
                    pending_withdraw: Math.max(0, (teacher.pending_withdraw || 0) - originalAmt)
                })
                .eq('id', request.teacher_id);
        }

        try {
            await insert('notifications', {
                user_id: request.teacher_id,
                user_type: 'teacher',
                title: '💰 تمت معالجة طلب السحب',
                message: `تم تحويل مبلغ ${request.amount} دج إلى محفظة SofizPay الخاصة بك`,
                is_read: false,
                created_at: new Date().toISOString()
            });
            if (teacher) {
                await sendPushNotification(
                    teacher,
                    '💰 تمت معالجة طلب السحب',
                    `تم تحويل مبلغ ${request.amount} دج إلى محفظة SofizPay الخاصة بك`
                );
            }
        } catch (notifErr) {
            console.warn('⚠️ فشل إرسال إشعار قبول طلب السحب:', notifErr.message);
        }

        console.log(`✅ تم قبول طلب السحب ${id}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('❌ خطأ في قبول طلب سحب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ رفض طلب سحب
// ============================================================
router.post('/withdraw-requests/:id/reject', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الطلب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { id } = req.params;
        const { reason } = req.body;
        
        console.log(`📥 رفض طلب سحب ID: ${id}, السبب: ${reason || 'غير محدد'}`);

        const request = await getOne('withdraw_requests', 'id', id);
        if (!request) {
            return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
        }

        const { error: updateError } = await supabase
            .from('withdraw_requests')
            .update({
                status: 'rejected',
                rejection_reason: reason || 'لم يتم تحديد سبب',
                processed_at: new Date().toISOString()
            })
            .eq('id', id);

        if (updateError) {
            logger.error('❌ خطأ في تحديث طلب السحب:', updateError);
            return res.status(500).json({ success: false, error: updateError.message });
        }

        const teacher = await getOne('teachers', 'id', request.teacher_id);
        if (teacher) {
            const refundAmt = request.original_amount || (request.fee_amount ? (request.amount + request.fee_amount) : Math.round(request.amount / 0.99));
            await supabase
                .from('teachers')
                .update({
                    balance: (teacher.balance || 0) + refundAmt,
                    pending_withdraw: Math.max(0, (teacher.pending_withdraw || 0) - refundAmt)
                })
                .eq('id', request.teacher_id);
        }

        try {
            await insert('notifications', {
                user_id: request.teacher_id,
                user_type: 'teacher',
                title: '❌ تم رفض طلب السحب',
                message: `تم رفض طلب سحب مبلغ ${request.amount} دج. السبب: ${reason || 'لم يتم تحديد سبب'}`,
                is_read: false,
                created_at: new Date().toISOString()
            });
            if (teacher) {
                await sendPushNotification(
                    teacher,
                    '❌ تم رفض طلب السحب',
                    `تم رفض طلب سحب مبلغ ${request.amount} دج. السبب: ${reason || 'لم يتم تحديد سبب'}`
                );
            }
        } catch (notifErr) {
            console.warn('⚠️ فشل إرسال إشعار رفض طلب السحب:', notifErr.message);
        }

        console.log(`✅ تم رفض طلب السحب ${id}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('❌ خطأ في رفض طلب سحب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ إرسال إشعار لجميع الطلاب
// ============================================================
router.post('/send-notification-to-all-students', [
    authenticate,
    authorize(['admin']),
    body('title').notEmpty().withMessage('العنوان مطلوب').isLength({ max: 100 }),
    body('message').notEmpty().withMessage('المحتوى مطلوب').isLength({ max: 500 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { title, message } = req.body;
        console.log(`📥 إرسال إشعار لجميع الطلاب: ${title}`);

        const { data: students, error: studentsError } = await supabase
            .from('students')
            .select('id')
            .eq('email_verified', true);

        if (studentsError) {
            logger.error('❌ خطأ في جلب الطلاب:', studentsError);
            return res.status(500).json({ success: false, error: studentsError.message });
        }

        if (!students || students.length === 0) {
            return res.status(404).json({ success: false, error: 'لا يوجد طلاب مسجلين' });
        }

        const notifications = students.map(s => ({
            user_id: s.id,
            user_type: 'student',
            title: title.trim(),
            message: message.trim(),
            is_read: false,
            created_at: new Date().toISOString()
        }));

        const { error } = await supabase
            .from('notifications')
            .insert(notifications);

        if (error) {
            logger.error('❌ خطأ في إرسال الإشعارات:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        await supabase
            .from('admin_notifications')
            .insert({
                title: title.trim(),
                message: message.trim(),
                sent_to_all: true,
                students_count: students.length,
                created_at: new Date().toISOString()
            });

        console.log(`✅ تم إرسال الإشعار إلى ${students.length} طالب`);
        res.json({
            success: true,
            students_count: students.length,
            message: `تم إرسال الإشعار إلى ${students.length} طالب`
        });
    } catch (error) {
        logger.error('❌ خطأ في إرسال الإشعار:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ إرسال إشعار لمستخدم محدد (طالب أو أستاذ)
// ============================================================
router.post('/send-notification-to-user', [
    authenticate,
    authorize(['admin']),
    body('user_id').isInt().withMessage('معرف المستخدم مطلوب'),
    body('user_type').isIn(['student', 'teacher']).withMessage('نوع المستخدم غير صالح'),
    body('title').notEmpty().withMessage('العنوان مطلوب').isLength({ max: 100 }),
    body('message').notEmpty().withMessage('المحتوى مطلوب').isLength({ max: 500 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { user_id, user_type, title, message } = req.body;
        const tableName = user_type === 'student' ? 'students' : 'teachers';
        
        console.log(`📥 إرسال إشعار لمستخدم ${user_id} (${user_type}): ${title}`);

        const user = await getOne(tableName, 'id', user_id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
        }

        await insert('notifications', {
            user_id: user_id,
            user_type: user_type,
            title: title.trim(),
            message: message.trim(),
            is_read: false,
            created_at: new Date().toISOString()
        });

        await supabase
            .from('admin_notifications')
            .insert({
                title: title.trim(),
                message: message.trim(),
                sent_to_all: false,
                students_count: 1,
                created_at: new Date().toISOString()
            });

        console.log(`✅ تم إرسال الإشعار إلى المستخدم ${user_id} (${user_type})`);
        res.json({
            success: true,
            message: `تم إرسال الإشعار إلى ${user.full_name} بنجاح`
        });
    } catch (error) {
        logger.error('❌ خطأ في إرسال الإشعار:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ جلب الإشعارات المرسلة
// ============================================================
router.get('/sent-notifications', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب الإشعارات المرسلة...');
        
        let { data, error } = await supabase
            .from('admin_notifications')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('❌ خطأ في جلب الإشعارات المرسلة:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم جلب ${data?.length || 0} إشعار مرسل`);
        res.json((data || []).sort((a,b) => (a.order_index || 0) - (b.order_index || 0)));
    } catch (error) {
        logger.error('❌ خطأ في جلب الإشعارات المرسلة:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ حذف إشعار
// ============================================================
router.delete('/delete-notification/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الإشعار غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const id = parseInt(req.params.id);
        console.log(`📥 حذف إشعار ID: ${id}`);

        const { error } = await supabase
            .from('admin_notifications')
            .delete()
            .eq('id', id);

        if (error) {
            logger.error('❌ خطأ في حذف الإشعار:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم حذف الإشعار ${id}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('❌ خطأ في حذف الإشعار:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ مراقبة الأداء (معدلة مع دعم البث)
// ============================================================
router.get('/performance', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب معلومات الأداء...');
        
        const { data: connections, error: connError } = await supabase
            .from('active_stream')
            .select('count', { count: 'exact' });

        if (connError) logger.error('❌ خطأ في جلب البث المباشر:', connError);

        const { data: sessions, error: sessError } = await supabase
            .from('sessions')
            .select('count', { count: 'exact' });

        if (sessError) logger.error('❌ خطأ في جلب الجلسات:', sessError);

        const { count: liveOffers, error: liveError } = await supabase
            .from('offers')
            .select('count', { count: 'exact' })
            .in('status', ['live', 'teacher_ready']);

        if (liveError) logger.error('❌ خطأ في جلب الدروس المباشرة:', liveError);

        const { count: pausedOffers, error: pausedError } = await supabase
            .from('offers')
            .select('count', { count: 'exact' })
            .eq('status', 'paused');

        if (pausedError) logger.error('❌ خطأ في جلب الدروس المتوقفة:', pausedError);

        const memoryUsage = process.memoryUsage();
        const uptime = process.uptime();

        res.json({
            status: 'healthy',
            uptime: Math.floor(uptime),
            memory: {
                heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
                rss: Math.round(memoryUsage.rss / 1024 / 1024)
            },
            active_streams: connections?.count || 0,
            live_offers: liveOffers || 0,
            paused_offers: pausedOffers || 0,
            total_sessions: sessions?.count || 0
        });
    } catch (error) {
        logger.error('❌ خطأ في مراقبة الأداء:', error.message);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// ============================================================
// ✅ رسائل الدعم - باستخدام جدول support_messages
// ============================================================
router.get('/support-messages', authenticate, authorize(['admin']), async (req, res) => {
    try {
        console.log('📥 جلب رسائل الدعم...');
        
        let { data, error } = await supabase
            .from('support_messages')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('❌ خطأ في جلب رسائل الدعم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        const formattedMessages = (data || []).map(msg => ({
            id: msg.id,
            name: msg.name,
            email: msg.email,
            phone: msg.phone,
            subject: msg.subject,
            message: msg.message,
            status: msg.status,
            created_at: msg.created_at
        }));

        console.log(`✅ تم جلب ${formattedMessages.length} رسالة دعم`);
        res.json(formattedMessages);
    } catch (error) {
        logger.error('❌ خطأ في جلب رسائل الدعم:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ تحديث رسالة دعم كمقروءة
// ============================================================
router.put('/support-messages/:id/read', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الرسالة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const id = parseInt(req.params.id);
        console.log(`📥 تحديث رسالة دعم ID: ${id} كمقروءة`);

        const { error } = await supabase
            .from('support_messages')
            .update({ status: 'read' })
            .eq('id', id);

        if (error) {
            logger.error('❌ خطأ في تحديث رسالة الدعم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم تحديث رسالة الدعم ${id}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('❌ خطأ في تحديث رسالة الدعم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ حذف رسالة دعم
// ============================================================
router.delete('/support-messages/:id', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الرسالة غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const id = parseInt(req.params.id);
        console.log(`📥 حذف رسالة دعم ID: ${id}`);

        const { error } = await supabase
            .from('support_messages')
            .delete()
            .eq('id', id);

        if (error) {
            logger.error('❌ خطأ في حذف رسالة الدعم:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ تم حذف رسالة الدعم ${id}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('❌ خطأ في حذف رسالة الدعم:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});


// ============================================================
// ✅ الرد على رسالة دعم
// ============================================================
router.post('/support-messages/:id/reply', [
    authenticate,
    authorize(['admin']),
    param('id').isInt().withMessage('معرف الرسالة غير صالح'),
    body('reply').notEmpty().withMessage('نص الرد مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const id = parseInt(req.params.id);
        const { reply } = req.body;

        // 1. Get the message
        const { data: message, error: fetchError } = await supabase
            .from('support_messages')
            .select('email, subject')
            .eq('id', id)
            .single();

        if (fetchError || !message) {
            return res.status(404).json({ success: false, error: 'الرسالة غير موجودة' });
        }

        // 2. Send the email
        const emailResult = await sendEmail({
            to: message.email,
            subject: `رد على رسالتك بخصوص: ${message.subject || 'رسالة دعم'}`,
            html: `<p>مرحباً،</p><p>وصلنا رد من فريق الدعم بخصوص رسالتك:</p><p>${reply.replace(/\n/g, '<br>')}</p>`,
            fromEmail: 'support@zoomdz.com',
            fromName: 'ZoomDz Support'
        });

        if (!emailResult.success) {
            logger.error('❌ خطأ في إرسال البريد الإلكتروني:', emailResult.error);
            return res.status(500).json({ success: false, error: 'حدث خطأ في إرسال البريد' });
        }

        // 3. Update status
        await supabase
            .from('support_messages')
            .update({ status: 'responded' })
            .eq('id', id);

        console.log(`✅ تم الرد على رسالة الدعم ${id}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('❌ خطأ في الرد على الرسالة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// مسارات إدارة المطورين (Developers)
// ============================================================

// 1. جلب جميع المطورين
router.get('/developers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        let { data, error } = await supabase
            .from('developers')
            .select('*');
        if (error) {
            logger.error('Error fetching developers:', error);
            if (error.code === '42P01') { 
                return res.json([{id: 1, name: 'تنبيه', role: 'خطأ', description: 'الجدول developers غير موجود في Supabase. يرجى تنفيذ ملف SQL.', image_url: '/images/default-avatar.svg'}]);
            }
            return res.status(500).json({ success: false, error: error.message });
        }

        const defaultDevelopers = [
            {
                id: 1,
                name: 'عثمانية محمد الصالح',
                role: 'مطور الواجهة الخلفية',
                image_url: '/images/othmaniya.jpg',
                skills: [{"name": "Backend", "icon": "fas fa-server", "class": "backend"}, {"name": "قاعدة البيانات", "icon": "fas fa-database", "class": "database"}],
                description: 'مسؤول عن الخادم، واجهات API، وتصميم وإدارة قاعدة البيانات وتطوير المنصة',
                badge_icon: 'fas fa-crown',
                badge_color: 'var(--gold)',
                border_color: 'var(--gold)',
                order_index: 1
            },
            {
                id: 2,
                name: 'يسرى لموشي',
                role: 'مسؤولة الدعم ومشرفة منصات التواصل الاجتماعي للمنصة',
                image_url: '/images/default-avatar.svg',
                skills: [{"name": "الدعم الفني", "icon": "fas fa-headset", "style": "background:#e0f2fe; color:#0369a1;"}, {"name": "إدارة التواصل", "icon": "fas fa-hashtag", "style": "background:#f3e8ff; color:#7e22ce;"}],
                description: 'مسؤولة عن متابعة ودعم المستخدمين، إدارة وحملات منصات التواصل الاجتماعي للمنصة',
                badge_icon: 'fas fa-headset',
                badge_color: '#8b5cf6',
                border_color: '#8b5cf6',
                order_index: 2
            },
            {
                id: 3,
                name: 'صالح مليك',
                role: 'مسؤول التسويق والمبيعات',
                image_url: '/images/salah.png',
                skills: [{"name": "التسويق", "icon": "fas fa-bullhorn", "class": "marketing"}, {"name": "المبيعات", "icon": "fas fa-chart-line", "style": "background:#dcfce7; color:#15803d;"}],
                description: 'مسؤول عن التسويق الرقمي، استراتيجيات النمو، وتوسيع نطاق المنصة',
                badge_icon: 'fas fa-bullhorn',
                badge_color: '#0369a1',
                border_color: null,
                order_index: 3
            },
            {
                id: 4,
                name: 'نفيسة هلابي',
                role: 'مطورة الواجهة الأمامية',
                image_url: '/images/nafissa.jpg',
                skills: [{"name": "Frontend", "icon": "fas fa-palette", "class": "frontend"}, {"name": "تجربة المستخدم", "icon": "fas fa-magic", "style": "background:#fef3c7; color:#b45309;"}],
                description: 'مسؤولة عن تصميم الواجهة، تجربة المستخدم (UX/UI)، وتطوير المظهر التفاعلي',
                badge_icon: 'fas fa-laptop-code',
                badge_color: '#c62828',
                border_color: null,
                order_index: 4
            }
        ];

        // Auto-seed if empty
        if (!data || data.length === 0) {
            const { data: insertedData, error: insertError } = await supabase
                .from('developers')
                .upsert(defaultDevelopers, { onConflict: 'id' })
                .select();
                
            if (!insertError && insertedData) {
                data = insertedData;
            } else {
                data = defaultDevelopers;
            }
        } else {
            // تحقق صريح من وجود يسرى لموشي بالاسم
            const hasYousra = data.some(d => d.name && d.name.includes('يسرى'));
            if (!hasYousra) {
                // إيجاد معرّف حر
                const existingIds = data.map(d => parseInt(d.id, 10)).filter(n => !isNaN(n));
                const newId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 2;
                const yousra = { ...defaultDevelopers[1], id: newId };
                await supabase.from('developers').upsert(yousra, { onConflict: 'id' });
                data.push(yousra);
            }
        }

        const formattedData = (data || []).map(dev => {
            let img = dev.image_url ? String(dev.image_url).trim() : '';
            if (!img) {
                img = '/images/default-avatar.svg';
            } else if (img.startsWith('http://') || img.startsWith('https://')) {
                img = `/api/public/image-proxy?url=${encodeURIComponent(img)}`;
            }
            return { ...dev, image_url: img };
        }).sort((a,b) => (a.order_index || 0) - (b.order_index || 0));

        res.json(formattedData);
    } catch (error) {
        logger.error('Server error fetching developers:', error);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// 2. إضافة مطور / عضو جديد للفريق
router.post('/developers', authenticate, authorize(['admin']), async (req, res) => {
    try {
        let { name, role, description, image_url, order_index, skills, badge_icon, badge_color, border_color } = req.body;
        if (!name || !role) {
            return res.status(400).json({ success: false, error: 'الاسم والدور مطلوبان' });
        }

        let finalImageUrl = image_url;
        if (finalImageUrl && typeof finalImageUrl === 'string') {
            finalImageUrl = finalImageUrl.trim();
            if (finalImageUrl.includes('imgur.com') && !finalImageUrl.includes('i.imgur.com')) {
                const match = finalImageUrl.match(/imgur\.com\/(?:a\/|gallery\/|r\/[a-zA-Z0-9]+\/)?([a-zA-Z0-9]+)/);
                if (match && match[1]) {
                    finalImageUrl = `https://i.imgur.com/${match[1]}.png`;
                }
            }
        }
        if (!finalImageUrl) finalImageUrl = '/images/default-avatar.svg';

        // جلب أعلى ID لمعرفة المعرف التالي
        const { data: existingDevs } = await supabase.from('developers').select('id, order_index');
        const existingIds = (existingDevs || []).map(d => parseInt(d.id, 10)).filter(n => !isNaN(n));
        const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;
        const nextOrder = order_index || (existingIds.length + 1);

        const newDeveloper = {
            id: nextId,
            name: name.trim(),
            role: role.trim(),
            description: (description || '').trim(),
            image_url: finalImageUrl,
            order_index: parseInt(nextOrder, 10) || nextId,
            skills: Array.isArray(skills) ? skills : [{"name": role.trim(), "icon": badge_icon || "fas fa-user-tag"}],
            badge_icon: badge_icon || 'fas fa-user',
            badge_color: badge_color || 'var(--primary)',
            border_color: border_color || null
        };

        const { data, error } = await supabase
            .from('developers')
            .upsert(newDeveloper, { onConflict: 'id' })
            .select();

        if (error) {
            logger.error('[Developer Create] Error creating developer in supabase:', error);
            return res.status(500).json({ success: false, error: `فشل حفظ المطور: ${error.message}` });
        }

        res.json({ success: true, message: 'تمت إضافة العضو إلى فريق المطورين بنجاح', data: data?.[0] || newDeveloper });
    } catch (error) {
        logger.error('Server error creating developer:', error);
        res.status(500).json({ success: false, error: `حدث خطأ في الخادم: ${error.message}` });
    }
});

// 3. تحديث بيانات مطور (رابط صورة خارجي)
router.post('/developers/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const rawDevId = req.params.id;
        const devId = parseInt(rawDevId, 10) || rawDevId;
        const { name, role, description, image_url, order_index, badge_icon, badge_color, border_color, skills } = req.body;
        
        let finalImageUrl = image_url;
        if (finalImageUrl && typeof finalImageUrl === 'string') {
            finalImageUrl = finalImageUrl.trim();
            // Convert Imgur page or album link to direct image URL if not already direct
            if (finalImageUrl.includes('imgur.com') && !finalImageUrl.includes('i.imgur.com')) {
                const match = finalImageUrl.match(/imgur\.com\/(?:a\/|gallery\/|r\/[a-zA-Z0-9]+\/)?([a-zA-Z0-9]+)/);
                if (match && match[1]) {
                    finalImageUrl = `https://i.imgur.com/${match[1]}.png`;
                    console.log(`[Developer Update] Imgur URL transformed from "${image_url}" to direct link: "${finalImageUrl}"`);
                }
            }
        }
        
        console.log(`[Developer Update] Target ID: ${devId}, Name: ${name}, Final Image URL: ${finalImageUrl}`);
        
        const updatePayload = {
            name,
            role,
            description,
            image_url: finalImageUrl
        };
        if (order_index !== undefined) updatePayload.order_index = parseInt(order_index, 10);
        if (badge_icon !== undefined) updatePayload.badge_icon = badge_icon;
        if (badge_color !== undefined) updatePayload.badge_color = badge_color;
        if (border_color !== undefined) updatePayload.border_color = border_color;
        if (skills !== undefined) updatePayload.skills = skills;

        // Try updating existing row
        let { data, error } = await supabase
            .from('developers')
            .update(updatePayload)
            .eq('id', devId)
            .select();
            
        if (error) {
            logger.error('[Developer Update] Error updating developer:', error);
        }
        
        // If update returned empty array, row might not exist in Supabase yet -> Upsert!
        if (!data || data.length === 0) {
            console.log(`[Developer Update] Developer ID ${devId} not found in database, upserting...`);
            const numericId = parseInt(devId, 10);
            const targetId = !isNaN(numericId) ? numericId : devId;
            const { data: upsertData, error: upsertError } = await supabase
                .from('developers')
                .upsert({
                    id: targetId,
                    name,
                    role,
                    description,
                    image_url: finalImageUrl,
                    order_index: order_index || (targetId === 1 ? 1 : targetId === 2 ? 2 : targetId === 3 ? 3 : 4),
                    badge_icon: badge_icon || 'fas fa-code',
                    badge_color: badge_color || 'var(--primary)',
                    border_color: border_color || null,
                    skills: skills || []
                }, { onConflict: 'id' })
                .select();
                
            if (upsertError) {
                logger.error('[Developer Update] Error upserting developer:', upsertError);
                return res.status(500).json({ success: false, error: `فشل حفظ البيانات في قاعدة البيانات: ${upsertError.message}` });
            }
            data = upsertData;
        }
        
        if (!data || data.length === 0) {
            logger.error(`[Developer Update] Developer ID ${devId} could not be updated or inserted.`);
            return res.status(404).json({ success: false, error: 'المطور غير موجود أو لم يتم التحديث' });
        }
        
        console.log(`[Developer Update] Successfully saved developer ${devId}`);
        const responseDev = { ...data[0] };
        if (responseDev.image_url && (responseDev.image_url.startsWith('http://') || responseDev.image_url.startsWith('https://'))) {
            responseDev.image_url = `/api/public/image-proxy?url=${encodeURIComponent(responseDev.image_url)}`;
        }
        res.json({ success: true, message: 'تم تحديث بيانات المطور بنجاح', data: responseDev });
    } catch (error) {
        logger.error('Server error updating developer:', error);
        res.status(500).json({ success: false, error: `حدث خطأ في الخادم: ${error.message}` });
    }
});

// 4. حذف مطور / عضو من الفريق
router.delete('/developers/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const rawDevId = req.params.id;
        const devId = parseInt(rawDevId, 10) || rawDevId;
        const { error } = await supabase
            .from('developers')
            .delete()
            .eq('id', devId);

        if (error) {
            logger.error('Error deleting developer:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
        res.json({ success: true, message: 'تم حذف العضو من الفريق بنجاح' });
    } catch (error) {
        logger.error('Server error deleting developer:', error);
        res.status(500).json({ success: false, error: `حدث خطأ في الخادم: ${error.message}` });
    }
});

// ============================================================
// 📊 مسارات إدارة الإبلاغات (Admin Reports Routes)
// ============================================================

// GET /api/admin/reports - جلب جميع الإبلاغات
router.get('/reports', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data: reports, error } = await supabase
            .from('reports')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('❌ خطأ في جلب الإبلاغات:', error.message);
            // إن لم يكن الجدول موجوداً نرجع مصفوفة فارغة
            return res.json({ success: true, reports: [] });
        }

        const enrichedReports = await Promise.all((reports || []).map(async (r) => {
            const rep = { ...r };
            if (r.target_type === 'post') {
                let postTitle = '';
                let publisherName = '';

                if (r.target_id) {
                    try {
                        const targetInt = parseInt(r.target_id);
                        let post = null;
                        if (!isNaN(targetInt)) {
                            const { data } = await supabase
                                .from('posts')
                                .select('id, title, content, teacher_id')
                                .eq('id', targetInt)
                                .maybeSingle();
                            post = data;
                        }
                        if (!post) {
                            const { data } = await supabase
                                .from('posts')
                                .select('id, title, content, teacher_id')
                                .eq('id', r.target_id)
                                .maybeSingle();
                            post = data;
                        }

                        if (post) {
                            postTitle = post.title || (post.content ? post.content.substring(0, 80) : '');
                            if (post.teacher_id) {
                                const teacherInt = parseInt(post.teacher_id);
                                let teacher = null;
                                if (!isNaN(teacherInt)) {
                                    const { data } = await supabase
                                        .from('teachers')
                                        .select('id, full_name, name')
                                        .eq('id', teacherInt)
                                        .maybeSingle();
                                    teacher = data;
                                }
                                if (!teacher) {
                                    const { data } = await supabase
                                        .from('teachers')
                                        .select('id, full_name, name')
                                        .eq('id', post.teacher_id)
                                        .maybeSingle();
                                    teacher = data;
                                }
                                if (teacher) {
                                    rep.publisher_teacher_id = teacher.id;
                                    publisherName = teacher.full_name || teacher.name || '';
                                }
                            }
                        }
                    } catch (e) {
                        logger.error('Error enriching report post:', e);
                    }
                }

                // If teacher name is not found directly from database, attempt parsing from target_name
                if (r.target_name) {
                    const match = r.target_name.match(/^(.*?)\s*\((?:الأستاذ الناشر|الناشر|الأستاذ):\s*([^)]+)\)$/);
                    if (match) {
                        if (!postTitle) postTitle = match[1].trim();
                        if (!publisherName) publisherName = match[2].trim();
                    } else if (!postTitle) {
                        postTitle = r.target_name;
                    }
                }

                rep.post_title = postTitle || r.target_name || `منشور #${r.target_id}`;
                rep.publisher_teacher_name = publisherName || 'غير محدد';

            } else if (r.target_type === 'teacher' && r.target_id) {
                try {
                    const teacherInt = parseInt(r.target_id);
                    let teacher = null;
                    if (!isNaN(teacherInt)) {
                        const { data } = await supabase
                            .from('teachers')
                            .select('id, full_name, name')
                            .eq('id', teacherInt)
                            .maybeSingle();
                        teacher = data;
                    }
                    if (!teacher) {
                        const { data } = await supabase
                            .from('teachers')
                            .select('id, full_name, name')
                            .eq('id', r.target_id)
                            .maybeSingle();
                        teacher = data;
                    }
                    if (teacher) {
                        rep.publisher_teacher_id = teacher.id;
                        rep.publisher_teacher_name = teacher.full_name || teacher.name || r.target_name;
                    } else {
                        rep.publisher_teacher_name = r.target_name || `أستاذ #${r.target_id}`;
                    }
                } catch (e) {
                    rep.publisher_teacher_name = r.target_name || 'غير محدد';
                }
            }
            return rep;
        }));

        res.json({ success: true, reports: enrichedReports || [] });
    } catch (error) {
        logger.error('❌ خطأ في جلب الإبلاغات:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// PATCH /api/admin/reports/:id/status - تحديث حالة البلاغ
router.patch('/reports/:id/status', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const reportId = parseInt(req.params.id);
        const { status } = req.body; // 'resolved', 'dismissed', 'pending'

        if (!status || !['resolved', 'dismissed', 'pending'].includes(status)) {
            return res.status(400).json({ success: false, error: 'حالة البلاغ غير صالحة' });
        }

        const { data, error } = await supabase
            .from('reports')
            .update({ status })
            .eq('id', reportId)
            .select();

        if (error) {
            logger.error('❌ خطأ في تحديث حالة البلاغ:', error.message);
            return res.status(500).json({ success: false, error: error.message });
        }

        res.json({ success: true, message: 'تم تحديث حالة البلاغ بنجاح', report: data?.[0] });
    } catch (error) {
        logger.error('❌ خطأ في تحديث البلاغ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/admin/reports/:id - حذف بلاغ
router.delete('/reports/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const reportId = parseInt(req.params.id);

        const { error } = await supabase
            .from('reports')
            .delete()
            .eq('id', reportId);

        if (error) {
            logger.error('❌ خطأ في حذف البلاغ:', error.message);
            return res.status(500).json({ success: false, error: error.message });
        }

        res.json({ success: true, message: 'تم حذف البلاغ بنجاح' });
    } catch (error) {
        logger.error('❌ خطأ في حذف البلاغ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ إدارة مراجعة الدورات (Admin Course Approval)
// ============================================================

// GET /api/admin/pending-courses - جلب الدورات المعلقة للمراجعة
router.get('/pending-courses', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('courses')
            .select('*, teachers:teacher_id (id, full_name, email, phone, specialization, profile_image, profile_url)')
            .eq('status', 'pending')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const formatted = (data || []).map(course => ({
            ...course,
            teacher_name: course.teachers?.full_name || 'أستاذ غير معروف',
            teacher_specialization: course.teachers?.specialization || '',
            teacher_email: course.teachers?.email || '',
            teacher_phone: course.teachers?.phone || '',
            teacher_profile_image: course.teachers?.profile_url || getPublicImageUrl('profiles', 'teachers', course.teachers?.profile_image) || null
        }));

        res.json({ success: true, courses: formatted });
    } catch (error) {
        logger.error('❌ خطأ في جلب الدورات المعلقة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء جلب الدورات المعلقة' });
    }
});

// POST /api/admin/courses/:id/approve - موافقة وقبول نشر الدورة
router.post('/courses/:id/approve', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const courseId = parseInt(req.params.id);
        if (!courseId || isNaN(courseId)) {
            return res.status(400).json({ success: false, error: 'معرف الدورة غير صالح' });
        }

        const { data, error } = await supabase
            .from('courses')
            .update({ status: 'published' })
            .eq('id', courseId)
            .select();

        if (error) {
            logger.error('❌ خطأ في قبول نشر الدورة:', error.message);
            return res.status(500).json({ success: false, error: error.message });
        }

        res.json({ success: true, message: '✅ تم قبول الدورة ونشرها بنجاح', course: data?.[0] });
    } catch (error) {
        logger.error('❌ خطأ في قبول نشر الدورة:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/admin/courses/:id/reject - رفض طلب نشر الدورة
router.post('/courses/:id/reject', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const courseId = parseInt(req.params.id);
        if (!courseId || isNaN(courseId)) {
            return res.status(400).json({ success: false, error: 'معرف الدورة غير صالح' });
        }

        const { data, error } = await supabase
            .from('courses')
            .update({ status: 'rejected' })
            .eq('id', courseId)
            .select();

        if (error) {
            logger.error('❌ خطأ في رفض الدورة:', error.message);
            return res.status(500).json({ success: false, error: error.message });
        }

        res.json({ success: true, message: '❌ تم رفض طلب نشر الدورة', course: data?.[0] });
    } catch (error) {
        logger.error('❌ خطأ في رفض الدورة:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
