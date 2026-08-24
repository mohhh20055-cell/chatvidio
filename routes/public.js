const logger = require('../utils/logger');
// ============================================================
// مسارات عامة - Public Routes (معدل بالكامل مع دعم نظام البث)
// ============================================================

const express = require('express');
const router = express.Router();
const { param, validationResult } = require('express-validator');

const { supabase } = require('../config/database');
const { getOne, loadLocalTeacherFollowers } = require('../utils/helpers');
const { getPublicImageUrl, processUserProfile } = require('../utils/upload');
const { getViewCount } = require('../utils/viewsTracker');
const { verifyToken, generateToken } = require('../utils/jwt');
const { authenticate } = require('../middleware/auth');

// ============================================================
// توليد توكن زائر
// ============================================================
const handleGuestToken = async (req, res) => {
    try {
        const role = req.params.role === 'teacher' ? 'teacher' : 'student';
        const token = generateToken(-1, role, 'guest@zoomdz.com');
        res.json({ success: true, token });
    } catch (e) {
        logger.error('Error generating guest token', e);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

router.get('/guest-token/:role', handleGuestToken);
router.get('/public/guest-token/:role', handleGuestToken);

// ============================================================
// جلب قائمة الأساتذة المعتمدين (مع مستوى التعليم)
// ============================================================
async function fetchApprovedTeachers() {
    let data = null;
    try {
        const res = await supabase
            .from('teachers')
            .select('id, full_name, specialization, experience, bio, profile_image, profile_url, teaching_level, facebook_url, instagram_url, linkedin_url, youtube_url, twitter_url, website_url, whatsapp_url, status, is_banned')
            .eq('status', 'approved')
            .eq('is_banned', false)
            .order('created_at', { ascending: false });
        data = res.data;
    } catch (e) {
        logger.error('خطأ في جلب الأساتذة:', e.message);
    }

    if (!data || data.length === 0) {
        try {
            const resFallback = await supabase
                .from('teachers')
                .select('id, full_name, specialization, experience, bio, profile_image, profile_url, teaching_level, facebook_url, instagram_url, linkedin_url, youtube_url, twitter_url, website_url, whatsapp_url, status, is_banned')
                .neq('status', 'rejected')
                .order('created_at', { ascending: false });
            data = resFallback.data || [];
        } catch (e2) {
            logger.error('خطأ في جلب الأساتذة الاحتياطي:', e2.message);
            data = [];
        }
    }
    return (data || []).map(t => processUserProfile(t, 'teacher'));
}

// ============================================================
// خريطة المستويات التعليمية
// ============================================================
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

// ============================================================
// تنسيق بيانات الدروس (مع الوقت المتبقي)
// ============================================================
async function formatOffers(offers) {
    if (!offers || offers.length === 0) return [];

    const teacherIds = [...new Set(offers.map(o => o.teacher_id))];
    const { data: teachers, error: teachersError } = await supabase
        .from('teachers')
        .select('id, full_name, specialization, profile_image, profile_url, teaching_level')
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

    return offers.map(offer => {
        const teacher = teachersMap[offer.teacher_id] || {};
        const views = getViewCount('offer', offer.id, offer.views_count || offer.views || 0);

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
            room_password: offer.room_password || null,
            room_name: offer.room_name || null,
            stream_url: offer.stream_url || null,
            stream_platform: offer.stream_platform || 'jitsi',
            booked_count: offer.booked_count || 0,
            views_count: views,
            views: views,
            created_at: offer.created_at,
            teacher_name: teacher.full_name || 'غير معروف',
            teacher_specialization: teacher.specialization || '',
            teacher_profile_image: teacher.profile_url || getPublicImageUrl('profiles', 'teachers', teacher.profile_image),
            teacher_teaching_level: teacher.teaching_level || null
        };
    });
}

// ============================================================
// GET /api/teachers و /api/public/teachers (مع دعم فلتر المستوى)
// ============================================================
router.get(['/teachers', '/public/teachers'], async (req, res) => {
    try {
        const { level } = req.query;

        let teachers = await fetchApprovedTeachers();

        // ✅ فلتر حسب المستوى التعليمي مع دعم المجموعات العامة مثل جميع مستويات المتوسط
        if (level && level !== 'all') {
            const middleLevels = ['1ere_am', '2eme_am', '3eme_am', '4eme_am', 'bem'];
            const primaryLevels = ['primary_1', 'primary_2', 'primary_3', 'primary_4', 'primary_5', '5eme_pri'];
            const secondaryLevels = ['1ere_as', '2eme_as', '3eme_as', 'bac'];
            const universityLevels = ['1ere_uni', '2eme_uni', '3eme_uni', 'master', 'doctorat'];

            teachers = teachers.filter(t => {
                if (!t.teaching_level || t.teaching_level === '' || t.teaching_level === 'other') return true;
                if (t.teaching_level === level) return true;

                if (middleLevels.includes(level) && (t.teaching_level === 'middle_all' || middleLevels.includes(t.teaching_level))) return true;
                if (level === 'middle_all' && (middleLevels.includes(t.teaching_level) || t.teaching_level === 'middle_all')) return true;

                if (primaryLevels.includes(level) && (t.teaching_level === 'primary_all' || primaryLevels.includes(t.teaching_level))) return true;
                if (level === 'primary_all' && (primaryLevels.includes(t.teaching_level) || t.teaching_level === 'primary_all')) return true;

                if (secondaryLevels.includes(level) && (t.teaching_level === 'secondary_all' || secondaryLevels.includes(t.teaching_level))) return true;
                if (level === 'secondary_all' && (secondaryLevels.includes(t.teaching_level) || t.teaching_level === 'secondary_all')) return true;

                if (universityLevels.includes(level) && (t.teaching_level === 'university' || universityLevels.includes(t.teaching_level))) return true;
                if (level === 'university' && (universityLevels.includes(t.teaching_level) || t.teaching_level === 'university')) return true;

                return false;
            });
        }

        // ✅ إضافة معلومات البث لكل أستاذ
        const teacherIds = teachers.map(t => t.id);
        let streamInfo = {};
        let ratingMap = {};

        if (teacherIds.length > 0) {
            const [liveOffersResult, allRatingsResult] = await Promise.all([
                supabase
                    .from('offers')
                    .select('teacher_id, status, booked_count, duration')
                    .in('teacher_id', teacherIds)
                    .in('status', ['live', 'teacher_ready', 'paused']),
                supabase
                    .from('teacher_ratings')
                    .select('teacher_id, rating')
                    .in('teacher_id', teacherIds)
            ]);

            const liveOffers = liveOffersResult.data;
            const liveError = liveOffersResult.error;
            if (!liveError && liveOffers) {
                for (const offer of liveOffers) {
                    if (!streamInfo[offer.teacher_id]) {
                        streamInfo[offer.teacher_id] = {
                            has_live_stream: false,
                            stream_status: null,
                            stream_students: 0,
                            remaining_seconds: 0
                        };
                    }

                    if (offer.status === 'live' || offer.status === 'teacher_ready') {
                        streamInfo[offer.teacher_id].has_live_stream = true;
                        streamInfo[offer.teacher_id].stream_status = offer.status;
                        streamInfo[offer.teacher_id].stream_students += (offer.booked_count || 0);
                        streamInfo[offer.teacher_id].remaining_seconds = (offer.duration || 0) * 60;
                    }
                }
            }

            const allRatings = allRatingsResult.data;
            const allRatingsError = allRatingsResult.error;
            if (!allRatingsError && allRatings) {
                for (const r of allRatings) {
                    if (!ratingMap[r.teacher_id]) {
                        ratingMap[r.teacher_id] = { total: 0, count: 0 };
                    }
                    ratingMap[r.teacher_id].total += r.rating;
                    ratingMap[r.teacher_id].count += 1;
                }
            }
        }

        // ✅ التحقق من المتابعات إذا وُجد توكن للزائر
        const followedTeacherIds = new Set();
        try {
            let authHeader = req.headers.authorization;
            let token = null;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                token = authHeader.substring(7);
            }
            if (!token && req.query.token) {
                token = req.query.token;
            }
            if (token) {
                const decoded = verifyToken(token);
                if (decoded && decoded.userId && decoded.role && teacherIds.length > 0) {
                    const { data: userFollows } = await supabase
                        .from('teacher_followers')
                        .select('teacher_id')
                        .in('teacher_id', teacherIds)
                        .eq('follower_id', decoded.userId)
                        .eq('follower_type', decoded.role);
                    if (userFollows) {
                        userFollows.forEach(f => followedTeacherIds.add(f.teacher_id));
                    }

                    // دمج المتابعات المحلية
                    try {
                        const localList = await loadLocalTeacherFollowers();
                        localList.forEach(f => {
                            if (parseInt(f.follower_id) === parseInt(decoded.userId) && f.follower_type === decoded.role) {
                                followedTeacherIds.add(parseInt(f.teacher_id));
                            }
                        });
                    } catch (lErr) {}
                }
            }
        } catch (fErr) {
            console.warn('⚠️ خطأ في التحقق من متابعات قائمة الأساتذة:', fErr.message);
        }

        // ✅ تنسيق البيانات
        const formatted = teachers.map(teacher => {
            const stream = streamInfo[teacher.id] || {
                has_live_stream: false,
                stream_status: null,
                stream_students: 0,
                remaining_seconds: 0
            };

            const ratingInfo = ratingMap[teacher.id] || { total: 0, count: 0 };
            const avgRating = ratingInfo.count > 0 ? Number((ratingInfo.total / ratingInfo.count).toFixed(1)) : 0;

            return {
                ...teacher,
                has_live_stream: stream.has_live_stream,
                stream_status: stream.stream_status,
                stream_students: stream.stream_students,
                stream_remaining_seconds: stream.remaining_seconds,
                teaching_level_display: levelMap[teacher.teaching_level] || teacher.teaching_level || null,
                avg_rating: avgRating,
                ratings_count: ratingInfo.count,
                is_following: followedTeacherIds.has(teacher.id)
            };
        });

        res.json(formatted);
    } catch (error) {
        logger.error('خطأ في جلب قائمة الأساتذة:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// GET /api/public/offers (مع دعم فلتر المستوى والوقت المتبقي)
// ============================================================
router.get('/public/offers', async (req, res) => {
    try {
        const { level } = req.query;
        const now = new Date();

        let query = supabase
            .from('offers')
            .select('*')
            .eq('status', 'upcoming')
            .is('stream_url', null)
            .order('offer_date', { ascending: true })
            .limit(100);

        // ✅ فلتر حسب المستوى التعليمي مع دعم المجموعات العامة
        if (level && level !== 'all') {
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

        const { data: offers, error } = await query;

        if (error) {
            logger.error('خطأ في جلب الدروس العامة:', error.message);
            return res.json([]);
        }

        const filtered = (offers || []).filter(offer => {
            return offer.status === 'upcoming' && !offer.stream_url && !offer.stream_started_at && !offer.completed_at && new Date(offer.offer_date) >= now;
        });

        const formatted = await formatOffers(filtered);
        res.json(formatted);
    } catch (error) {
        logger.error('خطأ في جلب الدروس العامة:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// GET /api/public/teacher/:teacherId (مع معلومات البث)
// ============================================================
router.get('/public/teacher/:teacherId', [
    param('teacherId').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const teacherId = parseInt(req.params.teacherId);

        const teacher = await getOne('teachers', 'id', teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        const processedTeacher = processUserProfile(teacher, 'teacher');
        delete processedTeacher.password;

        // التحقق مما إذا كان الطالب الحالي يتابع هذا الأستاذ
        let isFollowing = false;
        try {
            let authHeader = req.headers.authorization;
            let token = null;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                token = authHeader.substring(7);
            }
            if (!token && req.query.token) {
                token = req.query.token;
            }
            if (token) {
                const decoded = verifyToken(token);
                if (decoded && decoded.userId) {
                    const { data: followRecord } = await supabase
                        .from('teacher_followers')
                        .select('id')
                        .eq('teacher_id', teacherId)
                        .eq('follower_id', decoded.userId)
                        .eq('follower_type', decoded.role)
                        .limit(1);
                    if (followRecord && followRecord.length > 0) {
                        isFollowing = true;
                    } else {
                        // التحقق من الملف المحلي الاحتياطي
                        try {
                            const localList = await loadLocalTeacherFollowers();
                            isFollowing = localList.some(
                                f => parseInt(f.teacher_id) === parseInt(teacherId) && parseInt(f.follower_id) === parseInt(decoded.userId) && f.follower_type === decoded.role
                            );
                        } catch (lErr) {}
                    }
                }
            }
        } catch (followErr) {
            logger.error('Error checking follow status in public profile:', followErr.message);
        }

        const now = new Date();
        const { data: offers, error: offersError } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', teacherId)
            .in('status', ['upcoming', 'live', 'teacher_ready'])
            .order('offer_date', { ascending: true });

        if (offersError) {
            logger.error('خطأ في جلب دروس الأستاذ:', offersError.message);
        }

        const filteredOffers = (offers || []).filter(offer => {
            if (offer.status === 'live' || offer.status === 'teacher_ready') return true;
            return new Date(offer.offer_date) >= now;
        });

        // ✅ تنسيق الدروس مع الوقت المتبقي
        const formattedOffers = await formatOffers(filteredOffers);

        // ✅ جلب معلومات البث النشط
        const { data: liveOffer, error: liveError } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', teacherId)
            .in('status', ['live', 'teacher_ready'])
            .single();

        let liveStreamInfo = null;
        if (liveOffer && !liveError) {
            liveStreamInfo = {
                id: liveOffer.id,
                subject_name: liveOffer.subject_name,
                status: liveOffer.status,
                stream_url: liveOffer.stream_url,
                room_password: liveOffer.room_password,
                duration: liveOffer.duration || 0,
                booked_count: liveOffer.booked_count || 0
            };
        }

        // ============================================================
        // استخدام Promise.all لتنفيذ الطلبات بشكل متزامن
        // ============================================================
        const [postsResult, totalOffersResult, studentsResult, pendingResult, coursesResult, followersResult] = await Promise.all([
            supabase.from('posts').select('*').eq('teacher_id', teacherId).order('created_at', { ascending: false }).then(r => r).catch(e => ({ data: [], error: e })),
            supabase.from('offers').select('*', { count: 'exact', head: true }).eq('teacher_id', teacherId).then(r => r).catch(e => ({ count: 0, error: e })),
            (async () => {
                try {
                    const { data: offersIds } = await supabase.from('offers').select('id').eq('teacher_id', teacherId);
                    if (offersIds && offersIds.length > 0) {
                        const offerIds = offersIds.map(o => o.id);
                        return await supabase.from('sessions').select('*', { count: 'exact', head: true }).in('offer_id', offerIds).in('payment_status', ['paid', 'pending_stream']);
                    }
                } catch (e) {}
                return { data: null, count: 0, error: null };
            })(),
            (async () => {
                try {
                    const { data: offersIds } = await supabase.from('offers').select('id').eq('teacher_id', teacherId);
                    if (offersIds && offersIds.length > 0) {
                        const offerIds = offersIds.map(o => o.id);
                        return await supabase.from('sessions').select('payment_amount').in('offer_id', offerIds).eq('payment_status', 'pending_stream');
                    }
                } catch (e) {}
                return { data: [], error: null };
            })(),
            supabase.from('courses').select('*').eq('teacher_id', teacherId).eq('status', 'published').order('created_at', { ascending: false }).then(r => r).catch(e => ({ data: [], error: e })),
            supabase.from('teacher_followers').select('*', { count: 'exact', head: true }).eq('teacher_id', teacherId).then(r => r).catch(e => ({ count: 0, error: e }))
        ]);

        // معالجة نتائج المنشورات
        const posts = postsResult.data || [];
        if (postsResult.error) {
            logger.error('خطأ في جلب منشورات الأستاذ:', postsResult.error.message);
        }

        // معالجة نتائج إجمالي الدروس
        const totalOffers = totalOffersResult.count || 0;
        if (totalOffersResult.error) {
            logger.error('خطأ في حساب عدد الدروس:', totalOffersResult.error.message);
        }

        // معالجة نتائج عدد الطلاب
        let totalStudents = 0;
        if (studentsResult.error) {
            logger.error('خطأ في حساب عدد الطلاب:', studentsResult.error.message);
        } else {
            totalStudents = studentsResult.count || 0;
        }

        // معالجة نتائج الرصيد المعلق
        let pendingBalance = 0;
        if (pendingResult.error) {
            logger.error('خطأ في حساب الرصيد المعلق:', pendingResult.error.message);
        } else if (pendingResult.data) {
            pendingBalance = pendingResult.data.reduce((sum, s) => sum + (s.payment_amount || 0), 0);
        }

        let followersCount = followersResult.count || 0;
        try {
            const localList = await loadLocalTeacherFollowers();
            const localCount = localList.filter(f => parseInt(f.teacher_id) === parseInt(teacherId)).length;
            if (localCount > followersCount) followersCount = localCount;
        } catch (lErr) {}

        // ✅ جلب التقييمات ومراجعات الأستاذ
        const { data: ratingsData, error: ratingsError } = await supabase
            .from('teacher_ratings')
            .select('id, rating, review, created_at, student_id, students(full_name, profile_image, profile_url)')
            .eq('teacher_id', teacherId);

        let avgRating = 0;
        let ratingsCount = 0;
        let ratingsList = [];

        if (!ratingsError && ratingsData) {
            ratingsCount = ratingsData.length;
            if (ratingsCount > 0) {
                const totalRating = ratingsData.reduce((sum, r) => sum + r.rating, 0);
                avgRating = Number((totalRating / ratingsCount).toFixed(1));
            }
            ratingsList = ratingsData.map(r => ({
                id: r.id,
                rating: r.rating,
                review: r.review,
                created_at: r.created_at,
                student_id: r.student_id,
                student_name: r.students ? r.students.full_name : 'طالب مجهول',
                student_image: r.students ? (r.students.profile_url || r.students.profile_image) : null
            }));
        }

        res.json({
            ...processedTeacher,
            followers_count: followersCount,
            is_following: isFollowing,
            teaching_level_display: levelMap[processedTeacher.teaching_level] || processedTeacher.teaching_level || null,
            offers: formattedOffers,
            live_stream: liveStreamInfo,
            posts: posts || [],
            courses: coursesResult.data || [],
            avg_rating: avgRating,
            ratings_count: ratingsCount,
            ratings: ratingsList,
            stats: {
                total_offers: totalOffers || 0,
                total_students: totalStudents,
                pending_balance: pendingBalance,
                followers_count: followersCount
            }
        });
    } catch (error) {
        logger.error('خطأ في جلب بيانات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// GET /api/public/stats (مع إضافة البث المباشر والمتوقف)
// ============================================================
router.get('/public/stats', async (req, res) => {
    try {
        // ============================================================
        // استخدام Promise.all لتنفيذ جميع طلبات الإحصائيات بشكل متزامن
        // ============================================================
        const [
            teachersResult,
            studentsResult,
            liveResult,
            pausedResult,
            activeResult,
            levelsResult
        ] = await Promise.all([
            supabase
                .from('teachers')
                .select('*', { count: 'exact', head: true })
                .eq('status', 'approved')
                .eq('is_banned', false),

            supabase
                .from('students')
                .select('*', { count: 'exact', head: true })
                .eq('is_banned', false),

            supabase
                .from('offers')
                .select('*', { count: 'exact', head: true })
                .in('status', ['live', 'teacher_ready']),

            supabase
                .from('offers')
                .select('*', { count: 'exact', head: true })
                .eq('status', 'paused'),

            supabase
                .from('active_stream')
                .select('*', { count: 'exact', head: true }),

            supabase
                .from('teachers')
                .select('teaching_level')
                .eq('status', 'approved')
                .not('teaching_level', 'is', null)
        ]);

        // معالجة النتائج
        if (teachersResult.error) {
            logger.error('خطأ في حساب الأساتذة:', teachersResult.error.message);
        }

        if (studentsResult.error) {
            logger.error('خطأ في حساب الطلاب:', studentsResult.error.message);
        }

        if (liveResult.error) {
            logger.error('خطأ في حساب البث المباشر:', liveResult.error.message);
        }

        if (pausedResult.error) {
            logger.error('خطأ في حساب البث المتوقف:', pausedResult.error.message);
        }

        if (activeResult.error) {
            logger.error('خطأ في حساب الطلاب النشطين:', activeResult.error.message);
        }

        // معالجة مستويات التعليم
        let availableLevels = [];
        if (!levelsResult.error && levelsResult.data) {
            const uniqueLevels = [...new Set(levelsResult.data.map(t => t.teaching_level).filter(Boolean))];
            availableLevels = uniqueLevels.map(level => ({
                value: level,
                label: levelMap[level] || level
            }));
        }

        res.json({
            teachers: teachersResult.count || 0,
            students: studentsResult.count || 0,
            live: liveResult.count || 0,
            paused: pausedResult.count || 0,
            active_students: activeResult.count || 0,
            levels: availableLevels
        });
    } catch (error) {
        logger.error('خطأ في جلب الإحصائيات:', error.message);
        res.status(500).json({ teachers: 0, students: 0, live: 0, paused: 0, active_students: 0, levels: [] });
    }
});

// ============================================================
// GET /api/public/total-offers
// ============================================================
router.get('/public/total-offers', async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true });

        if (error) throw error;

        res.json({ total: count || 0 });
    } catch (error) {
        logger.error('خطأ في حساب إجمالي الدروس:', error.message);
        res.status(500).json({ total: 0 });
    }
});

// ============================================================
// GET /api/public/education-levels (جلب مستويات التعليم المتاحة)
// ============================================================
router.get('/public/education-levels', async (req, res) => {
    try {
        const { data: teachers, error } = await supabase
            .from('teachers')
            .select('teaching_level')
            .eq('status', 'approved')
            .not('teaching_level', 'is', null);

        if (error) throw error;

        const uniqueLevels = [...new Set(teachers.map(t => t.teaching_level).filter(Boolean))];
        const formattedLevels = uniqueLevels.map(level => ({
            value: level,
            label: levelMap[level] || level
        }));

        // ✅ إضافة خيار "الكل"
        formattedLevels.unshift({ value: 'all', label: 'جميع المستويات' });

        res.json(formattedLevels);
    } catch (error) {
        logger.error('خطأ في جلب مستويات التعليم:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// GET /api/public/live-streams (جلب البث المباشر النشط)
// ============================================================
router.get('/public/live-streams', async (req, res) => {
    try {
        const { data: offers, error } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (full_name, profile_image, profile_url, specialization)')
            .in('status', ['live', 'teacher_ready'])
            .order('created_at', { ascending: false });

        if (error) throw error;

        const now = new Date();
        const formatted = (offers || []).map(offer => {
            let remainingSeconds = offer.remaining_seconds || 0;
            if (offer.status === 'live' && !offer.is_paused && offer.stream_started_at) {
                const startedAt = new Date(offer.stream_started_at);
                const elapsed = Math.floor((now - startedAt) / 1000);
                const total = offer.total_seconds || (offer.duration * 60);
                remainingSeconds = Math.max(0, total - elapsed);
            }

            return {
                id: offer.id,
                teacher_id: offer.teacher_id,
                subject_name: offer.subject_name,
                status: offer.status,
                stream_url: offer.stream_url,
                room_password: offer.room_password,
                total_seconds: offer.total_seconds || (offer.duration * 60),
                remaining_seconds: remainingSeconds,
                is_paused: offer.is_paused || false,
                booked_count: offer.booked_count || 0,
                teacher_name: offer.teachers?.full_name || 'غير معروف',
                teacher_profile_image: offer.teachers?.profile_url || getPublicImageUrl('profiles', 'teachers', offer.teachers?.profile_image),
                teacher_specialization: offer.teachers?.specialization || '',
                created_at: offer.created_at
            };
        });

        res.json(formatted);
    } catch (error) {
        logger.error('خطأ في جلب البث المباشر:', error.message);
        res.status(500).json([]);
    }
});

// Image Proxy endpoint to bypass CORS / hotlink / referrer restrictions for external images (Imgur, Google Drive, etc.)
router.get(['/image-proxy', '/public/image-proxy'], async (req, res) => {
    try {
        let imageUrl = req.query.url;
        if (!imageUrl) {
            return res.redirect('/images/default-avatar.svg');
        }

        imageUrl = decodeURIComponent(imageUrl).trim();

        // Convert Imgur album or post URL to direct i.imgur.com image URL
        if (imageUrl.includes('imgur.com') && !imageUrl.includes('i.imgur.com')) {
            const match = imageUrl.match(/imgur\.com\/(?:a\/|gallery\/|r\/[a-zA-Z0-9]+\/)?([a-zA-Z0-9]+)/);
            if (match && match[1]) {
                imageUrl = `https://i.imgur.com/${match[1]}.png`;
            }
        } else if (imageUrl.includes('drive.google.com')) {
            const match = imageUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
            if (match && match[1]) {
                imageUrl = `https://lh3.googleusercontent.com/d/${match[1]}`;
            }
        }

        if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
            return res.redirect(imageUrl.startsWith('/') ? imageUrl : '/' + imageUrl);
        }

        // Fetch image with browser-like headers
        let response = await fetch(imageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Referer': 'https://imgur.com/'
            }
        });

        // Retry logic for Imgur if png fails
        if (!response.ok && imageUrl.includes('i.imgur.com') && imageUrl.endsWith('.png')) {
            const jpgUrl = imageUrl.replace(/\.png$/, '.jpg');
            response = await fetch(jpgUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'image/*,*/*',
                    'Referer': 'https://imgur.com/'
                }
            });
        }

        if (!response.ok) {
            return res.redirect('/images/default-avatar.svg');
        }

        const contentType = response.headers.get('content-type') || 'image/png';
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(buffer);
    } catch (err) {
        logger.error('Image proxy error:', err);
        return res.redirect('/images/default-avatar.svg');
    }
});

// ============================================================
// مسارات المطورين
// ============================================================
router.get(['/developers', '/public/developers'], async (req, res) => {
    try {
        let { data, error } = await supabase
            .from('developers')
            .select('*');
        if (error) {
            if (error.code === '42P01') { 
                return res.json([]);
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

        if (!data || data.length === 0) {
            await supabase.from('developers').upsert(defaultDevelopers, { onConflict: 'id' }).select();
            data = defaultDevelopers;
        } else {
            // تحقق صريح من وجود يسرى لموشي بالاسم
            const hasYousra = data.some(d => d.name && d.name.includes('يسرى'));
            if (!hasYousra) {
                const existingIds = data.map(d => parseInt(d.id, 10)).filter(n => !isNaN(n));
                const newId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 2;
                const yousra = { ...defaultDevelopers[1], id: newId };
                await supabase.from('developers').upsert(yousra, { onConflict: 'id' });
                data.push(yousra);
            }
        }

        const finalData = (data || []).map(dev => {
            let img = dev.image_url ? String(dev.image_url).trim() : '';
            if (!img) {
                img = '/images/default-avatar.svg';
            } else if (img.startsWith('http://') || img.startsWith('https://')) {
                img = `/api/public/image-proxy?url=${encodeURIComponent(img)}`;
            }
            return { ...dev, image_url: img };
        }).sort((a,b) => (a.order_index || 0) - (b.order_index || 0));
        res.json(finalData);

    } catch (error) {
        logger.error('Error fetching developers:', error);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// 📊 تقديم بلاغ (عن منشور أو أستاذ)
// ============================================================
router.post('/reports', authenticate, async (req, res) => {
    try {
        const { target_type, target_id, reason } = req.body;
        const reporter_id = req.user.userId;
        const reporter_role = req.user.role || 'student';

        if (!target_type || !['post', 'teacher'].includes(target_type)) {
            return res.status(400).json({ success: false, error: 'نوع البلاغ غير صحيح (يجب أن يكون منشور أو أستاذ)' });
        }

        if (!target_id) {
            return res.status(400).json({ success: false, error: 'معرف الهدف مطلوب' });
        }

        if (!reason || !reason.trim()) {
            return res.status(400).json({ success: false, error: 'سبب الإبلاغ مطلوب' });
        }

        // جلب اسم المُبلِغ
        let reporter_name = 'مستخدم';
        if (reporter_role === 'student') {
            const student = await getOne('students', 'id', reporter_id);
            if (student && student.full_name) reporter_name = student.full_name;
        } else if (reporter_role === 'teacher') {
            const teacher = await getOne('teachers', 'id', reporter_id);
            if (teacher && teacher.full_name) reporter_name = teacher.full_name;
        }

        // جلب تفاصيل الهدف المُبلَغ عنه
        let target_name = '';
        if (target_type === 'post') {
            const post = (await getOne('posts', 'id', target_id)) || (await getOne('posts', 'id', parseInt(target_id)));
            if (!post) {
                return res.status(404).json({ success: false, error: 'المنشور غير موجود' });
            }
            let teacherName = '';
            if (post.teacher_id) {
                const teacher = (await getOne('teachers', 'id', post.teacher_id)) || (await getOne('teachers', 'id', parseInt(post.teacher_id)));
                if (teacher) {
                    teacherName = teacher.full_name || teacher.name || '';
                }
            }
            const postTitle = post.title || post.content?.substring(0, 80) || `منشور #${target_id}`;
            target_name = teacherName ? `${postTitle} (الأستاذ الناشر: ${teacherName})` : postTitle;
        } else if (target_type === 'teacher') {
            const teacher = (await getOne('teachers', 'id', target_id)) || (await getOne('teachers', 'id', parseInt(target_id)));
            if (!teacher) {
                return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
            }
            target_name = teacher.full_name || teacher.name || `أستاذ #${target_id}`;
        }

        // إدخال البلاغ في جدول reports
        const { data: newReport, error: insertErr } = await supabase
            .from('reports')
            .insert({
                reporter_id,
                reporter_name,
                reporter_role,
                target_type,
                target_id: parseInt(target_id),
                target_name,
                reason: reason.trim(),
                status: 'pending',
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (insertErr) {
            logger.error('❌ خطأ في حفظ البلاغ:', insertErr.message);
            return res.status(500).json({ success: false, error: 'فشل في تقديم البلاغ: ' + insertErr.message });
        }

        res.json({
            success: true,
            message: 'تم تقديم البلاغ بنجاح، وسيتم مراجعته من قبل الإدارة.',
            report: newReport
        });
    } catch (error) {
        logger.error('❌ استثناء في تقديم البلاغ:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 🔍 GET /api/search/users & /api/public/search/users
// البحث الموحد في قاعدة البيانات عن الأساتذة والطلاب
// ============================================================
router.get(['/search/users', '/public/search/users'], async (req, res) => {
    try {
        const query = (req.query.q || req.query.query || '').trim();
        const role = (req.query.role || 'all').toLowerCase().trim(); // 'all' | 'teacher' | 'student'
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);

        let teachers = [];
        let students = [];

        // 1. جلب وبحث الأساتذة
        if (role === 'all' || role === 'teacher') {
            try {
                let tData = null;
                // جلب الأساتذة أولاً أو بالبحث
                if (query) {
                    try {
                        const { data, error } = await supabase
                            .from('teachers')
                            .select('*')
                            .neq('is_banned', true)
                            .or(`full_name.ilike.%${query}%,specialization.ilike.%${query}%,bio.ilike.%${query}%`)
                            .limit(limit);
                        if (!error && data && data.length > 0) {
                            tData = data;
                        }
                    } catch (e) {
                        logger.warn('⚠️ تصفية الأساتذة بـ ilike واجهت خطأ:', e.message);
                    }
                }

                if (!tData || tData.length === 0) {
                    const { data, error } = await supabase
                        .from('teachers')
                        .select('*')
                        .neq('is_banned', true)
                        .limit(50);
                    if (!error && data) {
                        tData = data;
                    }
                }

                if (!tData || tData.length === 0) {
                    tData = await fetchApprovedTeachers();
                }

                if (tData && tData.length > 0) {
                    const processed = tData.map(t => processUserProfile(t, 'teacher'));
                    teachers = processed.filter(t => {
                        if (t.is_banned === true) return false;
                        if (!query) return true;
                        const q = query.toLowerCase();
                        const rawLevel = (t.teaching_level || '').toLowerCase();
                        const transLevel = (levelMap[t.teaching_level] || '').toLowerCase();
                        const matchName = (t.full_name || t.name || '').toLowerCase().includes(q);
                        const matchSpec = (t.specialization || t.subject || '').toLowerCase().includes(q);
                        const matchBio = (t.bio || '').toLowerCase().includes(q);
                        const matchRank = (t.rank || '').toLowerCase().includes(q);
                        const matchLevel = rawLevel.includes(q) || transLevel.includes(q);
                        return matchName || matchSpec || matchBio || matchRank || matchLevel;
                    });
                }
            } catch (te) {
                logger.error('Exception searching teachers:', te.message);
            }
        }

        // 2. جلب وبحث الطلاب من جدول students
        if (role === 'all' || role === 'student') {
            try {
                let sData = null;
                if (query) {
                    try {
                        const { data, error } = await supabase
                            .from('students')
                            .select('*')
                            .neq('is_banned', true)
                            .or(`full_name.ilike.%${query}%,education_level.ilike.%${query}%`)
                            .limit(limit);
                        if (!error && data && data.length > 0) {
                            sData = data;
                        }
                    } catch (e) {
                        logger.warn('⚠️ تصفية الطلاب بـ ilike واجهت خطأ:', e.message);
                    }
                }

                if (!sData || sData.length === 0) {
                    try {
                        const { data, error } = await supabase
                            .from('students')
                            .select('*')
                            .neq('is_banned', true)
                            .order('created_at', { ascending: false })
                            .limit(100);
                        if (!error && data && data.length > 0) {
                            sData = data;
                        } else {
                            // محاولة استعلام بسيط بدون order
                            const { data: rawD, error: rawE } = await supabase
                                .from('students')
                                .select('*')
                                .limit(100);
                            if (!rawE && rawD) {
                                sData = rawD;
                            }
                        }
                    } catch (e) {
                        logger.warn('⚠️ خطأ في جلب الطلاب العام:', e.message);
                    }
                }

                if (sData && sData.length > 0) {
                    const processed = sData.map(s => processUserProfile(s, 'student'));
                    students = processed.filter(s => {
                        if (s.is_banned === true) return false;
                        if (!query) return true;
                        const q = query.toLowerCase();
                        const rawLevel = (s.education_level || s.grade || '').toLowerCase();
                        const transLevel = (levelMap[s.education_level] || '').toLowerCase();
                        const matchName = (s.full_name || s.name || '').toLowerCase().includes(q);
                        const matchLevel = rawLevel.includes(q) || transLevel.includes(q);
                        const matchWilaya = (s.wilaya || s.city || '').toLowerCase().includes(q);
                        const matchEmail = (s.email || '').toLowerCase().includes(q);
                        const matchPhone = (s.phone || '').includes(q);
                        return matchName || matchLevel || matchWilaya || matchEmail || matchPhone;
                    });
                }
            } catch (se) {
                logger.error('Exception searching students:', se.message);
            }
        }

        // 3. تنسيق النتائج وتوحيدها
        const formattedTeachers = teachers.map(t => {
            const rawImg = t.profile_url || t.profile_image;
            let img = '/images/default-avatar.svg';
            if (rawImg && rawImg !== 'null' && rawImg !== 'undefined' && rawImg !== 'NULL') {
                if (rawImg.startsWith('http://') || rawImg.startsWith('https://') || rawImg.startsWith('data:') || rawImg.startsWith('/')) {
                    img = rawImg;
                } else {
                    img = getPublicImageUrl('profiles', 'teachers', rawImg) || rawImg;
                }
            }

            return {
                id: t.id,
                user_role: 'teacher',
                full_name: t.full_name || t.name || 'أستاذ',
                subject: t.specialization || t.subject || 'أستاذ معتمد',
                rank: t.rank || '',
                bio: t.bio || '',
                teaching_level: t.teaching_level || '',
                profile_image: img,
                avatar: img
            };
        });

        const formattedStudents = students.map(s => {
            const rawImg = s.profile_url || s.profile_image;
            let img = '/images/default-avatar.svg';
            if (rawImg && rawImg !== 'null' && rawImg !== 'undefined' && rawImg !== 'NULL') {
                if (rawImg.startsWith('http://') || rawImg.startsWith('https://') || rawImg.startsWith('data:') || rawImg.startsWith('/')) {
                    img = rawImg;
                } else {
                    img = getPublicImageUrl('profiles', 'students', rawImg) || rawImg;
                }
            }

            const gradeDisplay = levelMap[s.education_level] || s.education_level || s.grade || 'طالب مسجل';

            return {
                id: s.id,
                user_role: 'student',
                name: s.full_name || s.name || 'طالب',
                full_name: s.full_name || s.name || 'طالب',
                grade: gradeDisplay,
                education_level: s.education_level || '',
                wilaya: s.wilaya || s.city || '',
                profile_image: img,
                avatar: img
            };
        });

        let combined = [];
        if (role === 'teacher') {
            combined = formattedTeachers;
        } else if (role === 'student') {
            combined = formattedStudents;
        } else {
            // دمج النتائج بشكل متوازن
            const maxLength = Math.max(formattedTeachers.length, formattedStudents.length);
            for (let i = 0; i < maxLength; i++) {
                if (i < formattedTeachers.length) combined.push(formattedTeachers[i]);
                if (i < formattedStudents.length) combined.push(formattedStudents[i]);
            }
        }

        res.json({
            success: true,
            total: combined.length,
            users: combined.slice(0, limit)
        });

    } catch (error) {
        logger.error('❌ Exception in /api/search/users:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء البحث' });
    }
});

module.exports = router;

