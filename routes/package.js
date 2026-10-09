const logger = require('../utils/logger');
// ============================================================
// مسارات الباقات التعليمية - Package Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const { supabase } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { getOne, insert, update, remove } = require('../utils/helpers');
const { getPublicImageUrl, uploadToSupabase } = require('../utils/upload');
const { sendPushNotification } = require('../utils/notification');
const multer = require('multer');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB for PDFs / materials
});

// ============================================================
// 📤 رفع ملف مرفق للباقة (PDF ملخص / PDF تمارين / صورة)
// ============================================================
router.post('/upload-attachment', authenticate, authorize(['teacher', 'admin']), upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'لم يتم اختيار أي ملف' });
        }

        const folder = req.body.folder || 'package_materials';
        const uploadRes = await uploadToSupabase(req.file, folder);

        if (uploadRes && uploadRes.url) {
            return res.json({
                success: true,
                url: uploadRes.url,
                file_name: req.file.originalname,
                file_size: req.file.size
            });
        }

        res.status(500).json({ success: false, error: 'فشل رفع الملف إلى السيرفر' });
    } catch (error) {
        logger.error('❌ خطأ في رفع مرفقات الباقة:', error.message);
        res.status(500).json({ success: false, error: error.message || 'حدث خطأ أثناء رفع الملف' });
    }
});

// ============================================================
// 📦 1. إنشاء باقة تعليمية جديدة (للأستاذ / الإدارة)
// ============================================================
router.post('/create', authenticate, authorize(['teacher', 'admin']), upload.single('thumbnail'), [
    body('title').notEmpty().withMessage('عنوان الباقة مطلوب').isLength({ max: 250 }),
    body('education_level').notEmpty().withMessage('المستوى التعليمي المستهدف مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, error: errors.array()[0].msg, errors: errors.array() });
        }

        const teacherId = req.user.userId;
        const teacher = await getOne('teachers', 'id', teacherId);
        const teacherName = teacher ? (teacher.full_name || teacher.name || 'أستاذ') : 'أستاذ';

        const {
            title,
            description,
            education_level,
            term_price = 0,
            annual_price = 0,
            has_term = 'true',
            has_annual = 'true',
            is_free = false,
            subjects = '[]'
        } = req.body;

        let parsedSubjects = [];
        try {
            parsedSubjects = typeof subjects === 'string' ? JSON.parse(subjects) : subjects;
        } catch (e) {
            parsedSubjects = [];
        }

        let thumbnailUrl = req.body.thumbnail_url || null;
        if (req.file) {
            try {
                const uploadRes = await uploadToSupabase(req.file, 'thumbnails');
                if (uploadRes && uploadRes.url) {
                    thumbnailUrl = uploadRes.url;
                }
            } catch (upErr) {
                logger.warn('⚠️ فشل رفع غلاف الباقة:', upErr.message);
            }
        }

        const isFreePackage = is_free === true || is_free === 'true' || is_free === 1 || is_free === '1';
        const parsedTermPrice = isFreePackage ? 0 : (parseFloat(term_price) || 0);
        const parsedAnnualPrice = isFreePackage ? 0 : (parseFloat(annual_price) || 0);
        const enableTerm = isFreePackage ? true : (has_term === true || has_term === 'true' || has_term === 1 || has_term === '1');
        const enableAnnual = isFreePackage ? true : (has_annual === true || has_annual === 'true' || has_annual === 1 || has_annual === '1');

        if (!isFreePackage && !enableTerm && !enableAnnual) {
            return res.status(400).json({ success: false, error: 'يجب تحديد سعر للاشتراك الفصلي أو السنوي على الأقل' });
        }

        // حساب إجمالي الدروس والمواد
        let totalLessonsCount = 0;
        if (Array.isArray(parsedSubjects)) {
            parsedSubjects.forEach(subj => {
                if (Array.isArray(subj.modules)) {
                    subj.modules.forEach(mod => {
                        if (Array.isArray(mod.lessons)) {
                            totalLessonsCount += mod.lessons.length;
                        }
                    });
                }
            });
        }

        const packageData = {
            teacher_id: teacherId,
            teacher_name: teacherName,
            title: title.trim(),
            description: description ? description.trim() : '',
            education_level: education_level.trim(),
            term_price: parsedTermPrice,
            annual_price: parsedAnnualPrice,
            has_term: enableTerm,
            has_annual: enableAnnual,
            is_free: isFreePackage,
            sales_count: 0,
            average_rating: 0.0,
            ratings_count: 0,
            thumbnail_url: thumbnailUrl,
            subjects_data: parsedSubjects,
            total_subjects: parsedSubjects.length || 0,
            total_lessons: totalLessonsCount,
            status: 'active',
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        const newPackage = await insert('packages', packageData);
        const packageId = newPackage.id;

        // إدراج البيانات في الجداول الفرعية إذا توفرت
        if (packageId && Array.isArray(parsedSubjects) && parsedSubjects.length > 0) {
            for (let sIdx = 0; sIdx < parsedSubjects.length; sIdx++) {
                const s = parsedSubjects[sIdx];
                try {
                    const { data: subData } = await supabase.from('package_subjects').insert({
                        package_id: packageId,
                        subject_name: s.subject_name || `المادة ${sIdx + 1}`,
                        teacher_name: s.teacher_name || teacherName,
                        order_index: sIdx + 1
                    }).select().single();

                    const subjectId = subData ? subData.id : null;

                    if (subjectId && Array.isArray(s.modules)) {
                        for (let mIdx = 0; mIdx < s.modules.length; mIdx++) {
                            const m = s.modules[mIdx];
                            const { data: modData } = await supabase.from('package_modules').insert({
                                package_subject_id: subjectId,
                                title: m.title || `المحور ${mIdx + 1}`,
                                description: m.description || '',
                                order_index: mIdx + 1
                            }).select().single();

                            const moduleId = modData ? modData.id : null;

                            if (moduleId && Array.isArray(m.lessons)) {
                                for (let lIdx = 0; lIdx < m.lessons.length; lIdx++) {
                                    const l = m.lessons[lIdx];
                                    await supabase.from('package_lessons').insert({
                                        package_module_id: moduleId,
                                        title: l.title || `الدرس ${lIdx + 1}`,
                                        video_url: l.video_url || '',
                                        summary_pdf_url: l.summary_pdf_url || '',
                                        exercise_pdf_url: l.exercise_pdf_url || '',
                                        solution_video_url: l.solution_video_url || '',
                                        order_index: lIdx + 1
                                    });
                                }
                            }
                        }
                    }

                    // إدراج الدورات المكثفة إذا وجدت
                    if (subjectId && s.intensive_courses) {
                        if (s.intensive_courses.term_review) {
                            await supabase.from('package_intensive_courses').insert({
                                package_subject_id: subjectId,
                                course_type: 'term_review',
                                title: s.intensive_courses.term_review.title || 'دورة مراجعة الفصل',
                                videos_json: s.intensive_courses.term_review.videos || [],
                                pdf_materials_json: s.intensive_courses.term_review.pdfs || []
                            });
                        }
                        if (s.intensive_courses.final_review) {
                            await supabase.from('package_intensive_courses').insert({
                                package_subject_id: subjectId,
                                course_type: 'final_review',
                                title: s.intensive_courses.final_review.title || 'دورة المراجعة النهائية',
                                videos_json: s.intensive_courses.final_review.videos || [],
                                pdf_materials_json: s.intensive_courses.final_review.pdfs || []
                            });
                        }
                    }
                } catch (subErr) {
                    logger.warn('⚠️ تعذر إدراج تفاصيل المادة في الجداول الفرعية (سيتم الاعتماد على JSON):', subErr.message);
                }
            }
        }

        res.json({
            success: true,
            message: '✅ تم إنشاء الباقة التعليمية بنجاح!',
            package: newPackage
        });
    } catch (error) {
        logger.error('❌ خطأ في إنشاء الباقة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء إنشاء الباقة: ' + error.message });
    }
});

// ============================================================
// ✏️ 2. تحديث باقة تعليمية (للأستاذ المالك / الإدارة)
// ============================================================
router.put('/update/:id', authenticate, authorize(['teacher', 'admin']), upload.single('thumbnail'), [
    param('id').isInt().withMessage('معرف الباقة غير صالح')
], async (req, res) => {
    try {
        const packageId = parseInt(req.params.id);
        const teacherId = req.user.userId;

        const pkg = await getOne('packages', 'id', packageId);
        if (!pkg) {
            return res.status(404).json({ success: false, error: 'الباقة غير موجودة' });
        }

        if (req.user.role !== 'admin' && pkg.teacher_id !== teacherId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتعديل هذه الباقة' });
        }

        const {
            title,
            description,
            education_level,
            term_price,
            annual_price,
            has_term,
            has_annual,
            is_free,
            status,
            subjects
        } = req.body;

        const updateData = {
            updated_at: new Date().toISOString()
        };

        if (title) updateData.title = title.trim();
        if (description !== undefined) updateData.description = description.trim();
        if (education_level) updateData.education_level = education_level.trim();
        if (is_free !== undefined) {
            const isFreePackage = is_free === true || is_free === 'true' || is_free === 1 || is_free === '1';
            updateData.is_free = isFreePackage;
            if (isFreePackage) {
                updateData.term_price = 0;
                updateData.annual_price = 0;
            }
        }
        if (term_price !== undefined && !updateData.is_free) updateData.term_price = parseFloat(term_price) || 0;
        if (annual_price !== undefined && !updateData.is_free) updateData.annual_price = parseFloat(annual_price) || 0;
        if (has_term !== undefined) updateData.has_term = has_term === 'true' || has_term === true;
        if (has_annual !== undefined) updateData.has_annual = has_annual === 'true' || has_annual === true;
        if (status) updateData.status = status;

        if (req.file) {
            const uploadRes = await uploadToSupabase(req.file, 'thumbnails');
            if (uploadRes && uploadRes.url) {
                updateData.thumbnail_url = uploadRes.url;
            }
        } else if (req.body.thumbnail_url) {
            updateData.thumbnail_url = req.body.thumbnail_url;
        }

        if (subjects !== undefined) {
            let parsedSubjects = [];
            try {
                parsedSubjects = typeof subjects === 'string' ? JSON.parse(subjects) : subjects;
            } catch (e) {
                parsedSubjects = [];
            }
            updateData.subjects_data = parsedSubjects;
            updateData.total_subjects = parsedSubjects.length;

            let totalLessons = 0;
            parsedSubjects.forEach(s => {
                if (Array.isArray(s.modules)) {
                    s.modules.forEach(m => {
                        if (Array.isArray(m.lessons)) totalLessons += m.lessons.length;
                    });
                }
            });
            updateData.total_lessons = totalLessons;
        }

        const updatedPackage = await update('packages', packageId, updateData);

        res.json({
            success: true,
            message: '✅ تم تحديث الباقة بنجاح!',
            package: updatedPackage
        });
    } catch (error) {
        logger.error('❌ خطأ في تحديث الباقة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// 🗑️ 3. حذف باقة تعليمية
// ============================================================
router.delete('/delete/:id', authenticate, authorize(['teacher', 'admin']), [
    param('id').isInt().withMessage('معرف الباقة غير صالح')
], async (req, res) => {
    try {
        const packageId = parseInt(req.params.id);
        const teacherId = req.user.userId;

        const pkg = await getOne('packages', 'id', packageId);
        if (!pkg) {
            return res.status(404).json({ success: false, error: 'الباقة غير موجودة' });
        }

        if (req.user.role !== 'admin' && pkg.teacher_id !== teacherId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بحذف هذه الباقة' });
        }

        // حذف فرعي اختياري
        try {
            await supabase.from('package_subscriptions').delete().eq('package_id', packageId);
            await supabase.from('package_subjects').delete().eq('package_id', packageId);
        } catch (e) {}

        await remove('packages', 'id', packageId);

        res.json({
            success: true,
            message: '✅ تم حذف الباقة التعليمية بنجاح'
        });
    } catch (error) {
        logger.error('❌ خطأ في حذف الباقة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء حذف الباقة' });
    }
});

// ============================================================
// 📋 4. استعراض جميع الباقات العامة (للطلاب والزوار) - يدعم التواتر والتقسيم (Batch Pagination)
// ============================================================
const handlePublicPackages = async (req, res) => {
    try {
        const { education_level, search } = req.query;
        const page = parseInt(req.query.page) || 1;
        const limit = req.query.limit ? parseInt(req.query.limit) : 20;

        let data = null;

        // محاولة جلب الباقات مع بيانات الأساتذة أولاً
        try {
            let q = supabase
                .from('packages')
                .select('*, teachers:teacher_id(full_name, specialization, profile_image, profile_url)')
                .order('created_at', { ascending: false });

            if (education_level && education_level !== 'all' && education_level !== 'الكل') {
                q = q.or(`education_level.eq.${education_level},education_level.ilike.%${education_level}%`);
            }

            const resQuery = await q;
            if (resQuery.error) throw resQuery.error;
            data = resQuery.data;
        } catch (joinErr) {
            logger.warn('⚠️ متعذر الجلب بالربط العلاقي مع الأساتذة، جاري الجلب المباشر:', joinErr?.message || joinErr);
            let qFallback = supabase
                .from('packages')
                .select('*')
                .order('created_at', { ascending: false });

            if (education_level && education_level !== 'all' && education_level !== 'الكل') {
                qFallback = qFallback.or(`education_level.eq.${education_level},education_level.ilike.%${education_level}%`);
            }

            const resFallback = await qFallback;
            if (resFallback.error) throw resFallback.error;
            data = resFallback.data;
        }

        // تصفية الباقات النشطة (status !== 'inactive' و is_active !== false)
        const activeData = (data || []).filter(pkg => pkg.is_active !== false && pkg.status !== 'inactive' && pkg.status !== 'archived');

        // جلب إحصائيات المبيعات من جدول package_subscriptions لكل باقة
        let packages = await Promise.all(activeData.map(async (pkg) => {
            const { count } = await supabase
                .from('package_subscriptions')
                .select('id', { count: 'exact', head: true })
                .eq('package_id', pkg.id);

            const salesCountFromSubs = (count !== null && count !== undefined) ? count : 0;
            const salesCount = Math.max(Number(pkg.sales_count) || 0, salesCountFromSubs);

            let rawSubjects = pkg.subjects_data || pkg.subjects || [];
            if (typeof rawSubjects === 'string') {
                try {
                    rawSubjects = JSON.parse(rawSubjects);
                } catch (e) {
                    logger.warn('⚠️ فشل تحليل subjects_data كـ JSON:', e.message);
                    rawSubjects = [];
                }
            }
            if (!Array.isArray(rawSubjects)) {
                rawSubjects = [];
            }

            // إخفاء روابط الفيديوهات المباشرة للعامة، مع إبقاء العناوين والهيكل
            const sanitizedSubjects = rawSubjects.map(s => {
                let modules = s.modules || [];
                if (typeof modules === 'string') {
                    try { modules = JSON.parse(modules); } catch (e) { modules = []; }
                }
                if (!Array.isArray(modules)) modules = [];

                return {
                    subject_name: s.subject_name || s.name || s.title,
                    teacher_name: s.teacher_name || pkg.teacher_name,
                    modules_count: modules.length,
                    lessons_count: modules.reduce((acc, m) => {
                        let lessons = m.lessons || [];
                        if (typeof lessons === 'string') {
                            try { lessons = JSON.parse(lessons); } catch (e) { lessons = []; }
                        }
                        return acc + (Array.isArray(lessons) ? lessons.length : 0);
                    }, 0),
                    modules: modules.map(m => {
                        let lessons = m.lessons || [];
                        if (typeof lessons === 'string') {
                            try { lessons = JSON.parse(lessons); } catch (e) { lessons = []; }
                        }
                        if (!Array.isArray(lessons)) lessons = [];

                        return {
                            title: m.title,
                            description: m.description,
                            lessons: lessons.map(l => ({
                                title: l.title,
                                has_video: !!l.video_url,
                                has_summary: !!l.summary_pdf_url,
                                has_exercise: !!l.exercise_pdf_url,
                                has_solution: !!l.solution_video_url
                            }))
                        };
                    }),
                    has_intensive_courses: !!(s.intensive_courses && (s.intensive_courses.term_review || s.intensive_courses.final_review))
                };
            });

            const computedTotalSubjects = pkg.total_subjects || rawSubjects.length;
            const computedTotalLessons = pkg.total_lessons || rawSubjects.reduce((acc, s) => {
                let modules = s.modules || [];
                if (typeof modules === 'string') {
                    try { modules = JSON.parse(modules); } catch (e) { modules = []; }
                }
                if (!Array.isArray(modules)) modules = [];
                return acc + modules.reduce((mAcc, m) => {
                    let lessons = m.lessons || [];
                    if (typeof lessons === 'string') {
                        try { lessons = JSON.parse(lessons); } catch (e) { lessons = []; }
                    }
                    return mAcc + (Array.isArray(lessons) ? lessons.length : 0);
                }, 0);
            }, 0);

            return {
                ...pkg,
                sales_count: salesCount,
                subscribers_count: salesCount,
                subjects_data: rawSubjects,
                total_subjects: computedTotalSubjects,
                total_lessons: computedTotalLessons,
                subjects_preview: sanitizedSubjects,
                thumbnail_url: pkg.thumbnail_url || 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=600&q=80',
                teacher_name: pkg.teachers?.full_name || pkg.teacher_name || 'أستاذ معتمد ZoomDz',
                teacher_specialization: pkg.teachers?.specialization || 'أستاذ متميز',
                teacher_profile_image: pkg.teachers?.profile_url || (typeof getPublicImageUrl === 'function' ? getPublicImageUrl('profiles', 'teachers', pkg.teachers?.profile_image) : null) || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'
            };
        }));

        if (search) {
            const qStr = search.toLowerCase();
            packages = packages.filter(p => 
                (p.title && p.title.toLowerCase().includes(qStr)) ||
                (p.description && p.description.toLowerCase().includes(qStr)) ||
                (p.education_level && p.education_level.toLowerCase().includes(qStr))
            );
        }

        // 🏆 تصدر الباقات الأكثر مبيعات وتقييماً في المقدمة والصدارة
        packages.sort((a, b) => {
            const aSales = Number(a.sales_count) || 0;
            const bSales = Number(b.sales_count) || 0;
            if (bSales !== aSales) return bSales - aSales;

            const aRating = Number(a.average_rating) || 0;
            const bRating = Number(b.average_rating) || 0;
            if (bRating !== aRating) return bRating - aRating;

            return new Date(b.created_at || 0) - new Date(a.created_at || 0);
        });

        // 📊 تقسيم النتيجة بتواتر (Batch Pagination)
        const total = packages.length;
        let paginatedPackages = packages;
        if (limit > 0 && limit < total) {
            const startIndex = (page - 1) * limit;
            paginatedPackages = packages.slice(startIndex, startIndex + limit);
        }

        res.json({
            success: true,
            packages: paginatedPackages,
            total,
            page,
            limit,
            has_more: (page * limit) < total
        });
    } catch (error) {
        logger.error('❌ خطأ في جلب الباقات العامة:', error.message);
        res.status(500).json({ success: false, packages: [], error: 'حدث خطأ في الخادم' });
    }
};

router.get('/', handlePublicPackages);
router.get('/public', handlePublicPackages);

// ============================================================
// 👨‍🏫 5. جلب باقات الأستاذ المسجل
// ============================================================
router.get('/my-packages', authenticate, authorize(['teacher', 'admin']), async (req, res) => {
    try {
        const teacherId = req.user.userId;

        const { data, error } = await supabase
            .from('packages')
            .select('*')
            .eq('teacher_id', teacherId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // جلب عدد المشتركين والمبيعات لكل باقة من جدول package_subscriptions
        const packagesWithStats = await Promise.all((data || []).map(async (pkg) => {
            const { count } = await supabase
                .from('package_subscriptions')
                .select('id', { count: 'exact', head: true })
                .eq('package_id', pkg.id);

            const salesCountFromSubs = (count !== null && count !== undefined) ? count : 0;
            const salesCount = Math.max(Number(pkg.sales_count) || 0, salesCountFromSubs);

            return {
                ...pkg,
                subscribers_count: salesCount,
                sales_count: salesCount
            };
        }));

        res.json({ success: true, packages: packagesWithStats });
    } catch (error) {
        logger.error('❌ خطأ في جلب باقات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// 🛠️ 6. جلب جميع الباقات للإدارة مع بيانات الجداول التابعة
// ============================================================
router.get('/admin/all', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data: packages, error } = await supabase
            .from('packages')
            .select(`
                id, teacher_id, teacher_name, title, description, education_level,
                term_price, annual_price, has_term, has_annual, thumbnail_url,
                subjects_data, total_subjects, total_lessons, status, is_active,
                created_at, updated_at,
                teachers:teacher_id(full_name, specialization, profile_image, profile_url),
                package_subjects(id, subject_name, order_index)
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        const result = await Promise.all((packages || []).map(async (pkg) => {
            const { count } = await supabase
                .from('package_subscriptions')
                .select('id', { count: 'exact', head: true })
                .eq('package_id', pkg.id)
                .eq('status', 'active');
            return {
                ...pkg,
                subjects: pkg.package_subjects || [],
                subscribers_count: count || 0,
                teacher: pkg.teachers || null,
                is_active: pkg.is_active !== false && pkg.status === 'active'
            };
        }));

        res.json({ success: true, packages: result });
    } catch (error) {
        logger.error('❌ خطأ في جلب باقات الإدارة:', error.message);
        res.status(500).json({ success: false, error: 'تعذر جلب الباقات التعليمية' });
    }
});

// ============================================================
// 🔍 7. جلب تفاصيل باقة واحدة
// ============================================================
router.get('/:id(\\d+)', async (req, res) => {
    try {
        const packageId = parseInt(req.params.id);
        if (isNaN(packageId)) {
            return res.status(400).json({ success: false, error: 'معرف الباقة غير صالح' });
        }

        const { data: pkg, error } = await supabase
            .from('packages')
            .select('*, teachers:teacher_id(full_name, specialization, profile_image, profile_url, bio)')
            .eq('id', packageId)
            .single();

        if (error || !pkg) {
            return res.status(404).json({ success: false, error: 'الباقة غير موجودة' });
        }

        // التحقق مما إذا كان المستخدم مسجلاً ولديه اشتراك نشط أو هو الأستاذ المالك
        let isSubscribed = false;
        let subscriptionDetails = null;

        // فحص رأس Authorization يدوياً إذا وُجد
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            const { verifyToken } = require('../utils/jwt');
            const decoded = verifyToken(token);
            if (decoded) {
                if (decoded.role === 'admin' || (decoded.role === 'teacher' && pkg.teacher_id === decoded.userId)) {
                    isSubscribed = true;
                } else if (decoded.role === 'student') {
                    const { data: sub } = await supabase
                        .from('package_subscriptions')
                        .select('*')
                        .eq('package_id', packageId)
                        .eq('student_id', decoded.userId)
                        .eq('status', 'active')
                        .maybeSingle();

                    if (sub) {
                        const now = new Date();
                        const endDate = new Date(sub.end_date);
                        if (endDate >= now) {
                            isSubscribed = true;
                            subscriptionDetails = sub;
                        }
                    }
                }
            }
        }

        // إذا كان مشتركاً نعيد المحتوى كاملاً، وإذا لم يكن مشتركاً نحجب الروابط الحساسة فقط
        let subjects = pkg.subjects_data || [];
        if (typeof subjects === 'string') {
            try { subjects = JSON.parse(subjects); } catch (e) { subjects = []; }
        }
        if (!Array.isArray(subjects)) subjects = [];

        if (!isSubscribed) {
            subjects = subjects.map(s => {
                let modules = s.modules || [];
                if (typeof modules === 'string') {
                    try { modules = JSON.parse(modules); } catch (e) { modules = []; }
                }
                if (!Array.isArray(modules)) modules = [];

                return {
                    ...s,
                    modules: modules.map(m => {
                        let lessons = m.lessons || [];
                        if (typeof lessons === 'string') {
                            try { lessons = JSON.parse(lessons); } catch (e) { lessons = []; }
                        }
                        if (!Array.isArray(lessons)) lessons = [];

                        return {
                            ...m,
                            lessons: lessons.map(l => ({
                                title: l.title,
                                is_locked: true,
                                has_video: !!l.video_url,
                                has_summary: !!l.summary_pdf_url,
                                has_exercise: !!l.exercise_pdf_url,
                                has_solution: !!l.solution_video_url
                            }))
                        };
                    }),
                    intensive_courses: s.intensive_courses ? {
                        term_review: s.intensive_courses.term_review ? { title: s.intensive_courses.term_review.title, is_locked: true } : null,
                        final_review: s.intensive_courses.final_review ? { title: s.intensive_courses.final_review.title, is_locked: true } : null
                    } : null
                };
            });
        }

        res.json({
            success: true,
            package: {
                ...pkg,
                subjects,
                is_subscribed: isSubscribed,
                subscription: subscriptionDetails,
                teacher_name: pkg.teachers?.full_name || pkg.teacher_name || 'أستاذ معتمد',
                teacher_specialization: pkg.teachers?.specialization || 'أستاذ متميز',
                teacher_profile_image: pkg.teachers?.profile_url || getPublicImageUrl('profiles', 'teachers', pkg.teachers?.profile_image) || null,
                teacher_bio: pkg.teachers?.bio || ''
            }
        });
    } catch (error) {
        logger.error('❌ خطأ في جلب تفاصيل الباقة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// 💳 7. اشتراك الطالب في باقة تعليمية (خصم من رصيد المحفظة)
// ============================================================
router.post('/subscribe', authenticate, authorize(['student']), [
    body('package_id').isInt().withMessage('معرف الباقة غير صالح'),
    body('subscription_type').isIn(['term', 'annual']).withMessage('نوع الاشتراك يجب أن يكون فصلي (term) أو سنوي (annual)')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, error: errors.array()[0].msg });
        }

        const studentId = req.user.userId;
        const { package_id, subscription_type } = req.body;

        const student = await getOne('students', 'id', studentId);
        if (!student) {
            return res.status(404).json({ success: false, error: 'حساب الطالب غير موجود' });
        }

        const pkg = await getOne('packages', 'id', package_id);
        if (!pkg || pkg.status !== 'active') {
            return res.status(404).json({ success: false, error: 'الباقة التعليمية غير متوفرة حالياً' });
        }

        // تحديد السعر وفترة الاشتراك
        let price = 0;
        let daysToAdd = 120; // 4 أشهر للاشتراك الفصلي
        if (subscription_type === 'term') {
            if (!pkg.has_term) {
                return res.status(400).json({ success: false, error: 'الاشتراك الفصلي غير متاح لهذه الباقة' });
            }
            price = parseFloat(pkg.term_price) || 0;
            daysToAdd = 120;
        } else if (subscription_type === 'annual') {
            if (!pkg.has_annual) {
                return res.status(400).json({ success: false, error: 'الاشتراك السنوي غير متاح لهذه الباقة' });
            }
            price = parseFloat(pkg.annual_price) || 0;
            daysToAdd = 365;
        }

        // تطبيق إعدادات العوائد المحفوظة: الخصم أولاً ثم نسبة المنصة على السعر الصافي
        const { data: revenueRow } = await supabase.from('platform_settings').select('value').eq('key', 'revenue_settings').maybeSingle();
        const revenueSettings = revenueRow?.value || {};
        const grossPrice = price;
        const fixedDiscount = Math.min(grossPrice, Math.max(0, Number(revenueSettings.package_fixed_discount) || 0));
        price = Math.max(0, grossPrice - fixedDiscount);
        const rawPackageCommission = revenueSettings.package_platform_commission;
        const platformCommissionPercent = (rawPackageCommission !== undefined && rawPackageCommission !== null && !isNaN(Number(rawPackageCommission)))
            ? Math.min(100, Math.max(0, Number(rawPackageCommission)))
            : 10;
        const platformFee = Math.round(price * platformCommissionPercent / 100 * 100) / 100;
        const teacherShare = Math.max(0, price - platformFee);

        // التحقق من وجود اشتراك ساري بالفعل
        const { data: existingSub } = await supabase
            .from('package_subscriptions')
            .select('*')
            .eq('package_id', package_id)
            .eq('student_id', studentId)
            .eq('status', 'active')
            .maybeSingle();

        if (existingSub) {
            const now = new Date();
            const existingEnd = new Date(existingSub.end_date);
            if (existingEnd > now) {
                return res.status(400).json({
                    success: false,
                    error: `أنت مشترك بالفعل في هذه الباقة، اشتراكك ساري حتى ${existingEnd.toLocaleDateString('ar-DZ')}`
                });
            }
        }

        // التحقق من كفاية رصيد المحفظة
        const currentBalance = student.wallet_balance || 0;
        if (currentBalance < price) {
            return res.status(400).json({
                success: false,
                error: `رصيد محفظتك غير كافٍ. المطلوب: ${price} دج، رصيدك الحالي: ${currentBalance} دج. يرجى شحن محفظتك للمتابعة.`,
                required_balance: price,
                current_balance: currentBalance,
                missing_amount: price - currentBalance
            });
        }

        // خصم المبلغ من رصيد الطالب
        const newStudentBalance = currentBalance - price;
        const { data: updateRes, error: updateErr } = await supabase.from('students').update({
            wallet_balance: newStudentBalance,
            updated_at: new Date().toISOString()
        }).eq('id', studentId).eq('wallet_balance', currentBalance).select();

        if (updateErr || !updateRes || updateRes.length === 0) {
            return res.status(409).json({ success: false, error: 'حدث تغيير في الرصيد أثناء المعالجة، يرجى المحاولة مرة أخرى' });
        }

        // تسجيل المعاملة المالية في wallet_transactions
        const typeLabel = subscription_type === 'term' ? 'فصلي' : 'سنوي';
        await insert('wallet_transactions', {
            student_id: studentId,
            amount: price,
            type: 'withdraw',
            status: 'completed',
            description: `اشتراك ${typeLabel} في الباقة التعليمية "${pkg.title}"`,
            created_at: new Date().toISOString()
        });

        // تحويل أو تسجيل أرباح الأستاذ بعد خصم رسوم المنصة على الباقات
        let teacherData = null;
        if (price > 0 && pkg.teacher_id) {
            teacherData = await getOne('teachers', 'id', pkg.teacher_id);
            if (!teacherData) {
                const { data: directTeacher } = await supabase.from('teachers').select('*').eq('id', pkg.teacher_id).maybeSingle();
                teacherData = directTeacher;
            }

            if (teacherData) {
                const currentBalance = parseFloat(teacherData.balance) || 0;
                const newTeacherBalance = Math.round((currentBalance + teacherShare) * 100) / 100;
                
                // تحديث رصيد الأستاذ في قاعدة البيانات
                await update('teachers', pkg.teacher_id, {
                    balance: newTeacherBalance,
                    updated_at: new Date().toISOString()
                });

                // تأكيد التحديث عبر استعلام Supabase مباشر
                await supabase.from('teachers').update({
                    balance: newTeacherBalance,
                    updated_at: new Date().toISOString()
                }).eq('id', pkg.teacher_id);

                logger.info(`✅ تم إضافة رصيد الأستاذ #${pkg.teacher_id}: +${teacherShare} دج (الرصيد السابق: ${currentBalance} دج، الجديد: ${newTeacherBalance} دج) بعد خصم رسوم المنصة (${platformFee} دج بنسبة ${platformCommissionPercent}%)`);
                
                await insert('wallet_transactions', {
                    teacher_id: pkg.teacher_id,
                    amount: teacherShare,
                    type: 'deposit',
                    status: 'completed',
                    description: `أرباح اشتراك طالب جديد في باقة "${pkg.title}" (${typeLabel}) - تم إضافة ${teacherShare} دج بعد خصم رسوم المنصة على الباقات (${platformFee} دج بنسبة ${platformCommissionPercent}%)`,
                    created_at: new Date().toISOString()
                });
            } else {
                logger.warn(`⚠️ لم يتم العثور على حساب الأستاذ #${pkg.teacher_id} لتحويل أرباح الباقة.`);
            }
        }

        // حساب تواريخ البداية والنهاية
        const startDate = new Date();
        const endDate = new Date();
        endDate.setDate(startDate.getDate() + daysToAdd);

        // إنشاء سجل الاشتراك
        const subscriptionData = {
            package_id: package_id,
            student_id: studentId,
            teacher_id: pkg.teacher_id,
            subscription_type: subscription_type,
            price_paid: price,
            gross_price: grossPrice,
            platform_fee: platformFee,
            teacher_net_amount: teacherShare,
            start_date: startDate.toISOString(),
            end_date: endDate.toISOString(),
            status: 'active',
            created_at: new Date().toISOString()
        };

        const subscription = await insert('package_subscriptions', subscriptionData);

        // 📈 زيادة عداد مبيعات الباقة
        try {
            const currentSales = Number(pkg.sales_count) || 0;
            await update('packages', package_id, { sales_count: currentSales + 1 });
        } catch (salesErr) {
            logger.warn('⚠️ فشل زيادة عداد مبيعات الباقة:', salesErr.message);
        }

        // إشعار الطالب والأستاذ
        try {
            await insert('notifications', {
                user_id: studentId,
                user_type: 'student',
                title: '🎉 تم تفعيل اشتراكك في الباقة بنجاح!',
                content: `تم تفعيل اشتراكك ال${typeLabel} في باقة "${pkg.title}". يمكنك الآن الوصول لجميع المواد والفيديوهات والمرفقات.`,
                is_read: false,
                created_at: new Date().toISOString()
            });

            if (pkg.teacher_id) {
                const teacherNotifTitle = '💰 تم إضافة أرباح اشتراك جديد في باقتك!';
                const teacherNotifContent = `قام الطالب "${student.full_name || 'طالب'}" بالاشتراك في باقتك التعليمية "${pkg.title}" (${typeLabel}). تم إضافة ${teacherShare} دج إلى رصيدك بعد خصم رسوم المنصة على الباقات (${platformFee} دج بنسبة ${platformCommissionPercent}% من إجمالي سعر الباقة ${price} دج).`;

                await insert('notifications', {
                    user_id: pkg.teacher_id,
                    user_type: 'teacher',
                    title: teacherNotifTitle,
                    content: teacherNotifContent,
                    is_read: false,
                    created_at: new Date().toISOString()
                });

                if (teacherData) {
                    try {
                        await sendPushNotification(teacherData, teacherNotifTitle, teacherNotifContent);
                    } catch (pushErr) {
                        logger.warn('⚠️ فشل إرسال إشعار الدفع الفوري للأستاذ:', pushErr.message);
                    }
                }
            }
        } catch (notifErr) {
            logger.warn('⚠️ تعذر إرسال الإشعار:', notifErr.message);
        }

        res.json({
            success: true,
            message: `🎉 تهانينا! تم تفعيل اشتراكك ال${typeLabel} في باقة "${pkg.title}" بنجاح!`,
            subscription,
            new_balance: newStudentBalance
        });
    } catch (error) {
        logger.error('❌ خطأ أثناء عملية الاشتراك في الباقة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء تفعيل الاشتراك: ' + error.message });
    }
});

// ============================================================
// 🎓 8. جلب الباقات المشترك ��يها الطالب
// ============================================================
router.get('/student/my-subscriptions', authenticate, authorize(['student']), async (req, res) => {
    try {
        const studentId = req.user.userId;

        const { data: subs, error: subsErr } = await supabase
            .from('package_subscriptions')
            .select('*, packages:package_id(*, teachers:teacher_id(full_name, specialization, profile_image, profile_url))')
            .eq('student_id', studentId)
            .order('created_at', { ascending: false });

        if (subsErr) throw subsErr;

        const now = new Date();
        const activeSubscriptions = (subs || []).map(sub => {
            const endDate = new Date(sub.end_date);
            const isStillActive = endDate >= now && sub.status === 'active';
            const daysRemaining = Math.max(0, Math.ceil((endDate - now) / (1000 * 60 * 60 * 24)));

            return {
                ...sub,
                is_active: isStillActive,
                days_remaining: daysRemaining,
                package: sub.packages ? {
                    ...sub.packages,
                    teacher_name: sub.packages.teachers?.full_name || sub.packages.teacher_name || 'أستاذ معتمد'
                } : null
            };
        });

        res.json({ success: true, subscriptions: activeSubscriptions });
    } catch (error) {
        logger.error('❌ خطأ في جلب اشتراكات الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// 👥 9. جلب المشتركين في باقة معينة (للأستاذ صاحب الباقة)
// ============================================================
router.get('/subscribers/:package_id', authenticate, authorize(['teacher', 'admin']), async (req, res) => {
    try {
        const packageId = parseInt(req.params.package_id);
        const teacherId = req.user.userId;

        const pkg = await getOne('packages', 'id', packageId);
        if (!pkg) {
            return res.status(404).json({ success: false, error: 'الباقة غير موجودة' });
        }

        if (req.user.role !== 'admin' && pkg.teacher_id !== teacherId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك باستعراض مشتركي هذه الباقة' });
        }

        const { data, error } = await supabase
            .from('package_subscriptions')
            .select('*, students:student_id(id, full_name, phone, email, avatar, education_level)')
            .eq('package_id', packageId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            package_title: pkg.title,
            subscribers: data || []
        });
    } catch (error) {
        logger.error('❌ خطأ في جلب المشتركين:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ⭐ 10. تقييم باقة تعليمية (للطالب المشترك)
// ============================================================
router.post('/rate/:id', authenticate, authorize(['student']), [
    param('id').isInt().withMessage('معرف الباقة غير صالح'),
    body('rating').isInt({ min: 1, max: 5 }).withMessage('التقييم يجب أن يكون من 1 إلى 5 نجوم')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, error: errors.array()[0].msg });
        }

        const packageId = parseInt(req.params.id);
        const studentId = req.user.userId;
        const { rating, review = '' } = req.body;

        const pkg = await getOne('packages', 'id', packageId);
        if (!pkg) {
            return res.status(404).json({ success: false, error: 'الباقة غير موجودة' });
        }

        // التحقق من اشتراك الطالب في الباقة
        const { data: sub } = await supabase
            .from('package_subscriptions')
            .select('*')
            .eq('package_id', packageId)
            .eq('student_id', studentId)
            .maybeSingle();

        if (!sub) {
            return res.status(403).json({ success: false, error: 'يجب أن تكون مشتركاً في الباقة لتتمكن من تقييمها' });
        }

        // التحقق مما إذا كان الطالب قد قيم الباقة سابقاً (مرة واحدة فقط)
        const { data: existingRating } = await supabase
            .from('package_ratings')
            .select('*')
            .eq('package_id', packageId)
            .eq('student_id', studentId)
            .maybeSingle();

        if (existingRating) {
            return res.status(400).json({ success: false, error: 'لقد قمت بتقييم هذه الباقة سابقاً. التقييم مسموح به لمرة واحدة فقط.' });
        }

        // تسجيل التقييم
        await supabase.from('package_ratings').insert({
            package_id: packageId,
            student_id: studentId,
            rating: parseInt(rating),
            review: review.trim(),
            created_at: new Date().toISOString()
        });

        // إعادة حساب متوسط التقييمات وعددها
        const { data: ratingsData } = await supabase
            .from('package_ratings')
            .select('rating')
            .eq('package_id', packageId);

        const rCount = ratingsData ? ratingsData.length : 0;
        const rSum = ratingsData ? ratingsData.reduce((acc, r) => acc + (r.rating || 0), 0) : 0;
        const avgRating = rCount > 0 ? Math.round((rSum / rCount) * 10) / 10 : 0;

        await update('packages', packageId, {
            average_rating: avgRating,
            ratings_count: rCount,
            updated_at: new Date().toISOString()
        });

        res.json({
            success: true,
            message: '🌟 شكراً لك! تم تسجيل تقييمك للباقة بنجاح.',
            average_rating: avgRating,
            ratings_count: rCount
        });
    } catch (error) {
        logger.error('❌ خطأ في تقييم الباقة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء تسجيل التقييم' });
    }
});

// ============================================================
// ⭐ 11. جلب تقييم الطالب لباقة معينة
// ============================================================
router.get('/:id/my-rating', authenticate, authorize(['student']), async (req, res) => {
    try {
        const packageId = parseInt(req.params.id);
        const studentId = req.user.userId;

        const { data: ratingRow } = await supabase
            .from('package_ratings')
            .select('*')
            .eq('package_id', packageId)
            .eq('student_id', studentId)
            .maybeSingle();

        res.json({
            success: true,
            has_rated: !!ratingRow,
            rating: ratingRow || null
        });
    } catch (error) {
        res.json({ success: true, has_rated: false, rating: null });
    }
});

// ============================================================
// 👨‍🏫 12. جلب جميع باقات الأساتذة (لتبويبة لوحة تحكم الأستاذ)
// ============================================================
router.get('/teachers-packages', authenticate, authorize(['teacher', 'admin']), async (req, res) => {
    try {
        const teacherId = req.user.userId;

        const { data, error } = await supabase
            .from('packages')
            .select('*, teachers:teacher_id(full_name, specialization, profile_image, profile_url)')
            .eq('status', 'active')
            .order('sales_count', { ascending: false });

        if (error) throw error;

        const packages = await Promise.all((data || []).map(async (pkg) => {
            const { count } = await supabase
                .from('package_subscriptions')
                .select('id', { count: 'exact', head: true })
                .eq('package_id', pkg.id);

            const salesCountFromSubs = (count !== null && count !== undefined) ? count : 0;
            const salesCount = Math.max(Number(pkg.sales_count) || 0, salesCountFromSubs);

            return {
                ...pkg,
                is_own: pkg.teacher_id === teacherId,
                sales_count: salesCount,
                subscribers_count: salesCount,
                teacher_name: pkg.teachers?.full_name || pkg.teacher_name || 'أستاذ معتمد ZoomDz',
                teacher_specialization: pkg.teachers?.specialization || 'أستاذ متميز',
                teacher_profile_image: pkg.teachers?.profile_url || getPublicImageUrl('profiles', 'teachers', pkg.teachers?.profile_image) || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'
            };
        }));

        res.json({ success: true, packages });
    } catch (error) {
        logger.error('❌ خطأ في جلب باقات الأساتذة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ⭐ جلب تقييمات ومراجعات باقة محددة مع أسماء الطلاب (للأساتذة والطلاب قبل وبعد الشراء)
// ============================================================
router.get('/:id/reviews', async (req, res) => {
    try {
        const packageId = parseInt(req.params.id);
        if (isNaN(packageId)) {
            return res.status(400).json({ success: false, error: 'معرف الباقة غير صالح' });
        }

        const { data: ratings, error } = await supabase
            .from('package_ratings')
            .select(`
                id,
                rating,
                review,
                created_at,
                students:student_id (
                    id,
                    full_name,
                    profile_image,
                    profile_url
                )
            `)
            .eq('package_id', packageId)
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('❌ خطأ في جلب تقييمات الباقة:', error.message);
            return res.status(500).json({ success: false, error: 'فشل جلب التقييمات والمراجعات للباقة' });
        }

        const formattedReviews = (ratings || []).map(r => ({
            id: r.id,
            rating: r.rating,
            review: r.review,
            created_at: r.created_at,
            student_name: r.students?.full_name || 'طالب بالمنصة',
            student_image: r.students?.profile_url || (r.students?.profile_image ? (typeof getPublicImageUrl === 'function' ? getPublicImageUrl('profiles', 'students', r.students.profile_image) : null) : null) || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'
        }));

        res.json({
            success: true,
            reviews: formattedReviews
        });
    } catch (error) {
        logger.error('❌ خطأ في جلب مراجعات الباقة:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
