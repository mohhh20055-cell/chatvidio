// ============================================================
// مسارات عامة - Public Routes (معدل بالكامل مع دعم نظام البث)
// ============================================================

const express = require('express');
const router = express.Router();
const { param, validationResult } = require('express-validator');

const { supabase } = require('../config/database');
const { getOne } = require('../utils/helpers');

// ============================================================
// جلب قائمة الأساتذة المعتمدين (مع مستوى التعليم)
// ============================================================
async function fetchApprovedTeachers() {
    const { data, error } = await supabase
        .from('teachers')
        .select('id, full_name, specialization, experience, bio, profile_url, teaching_level, facebook_url, instagram_url, linkedin_url, youtube_url, twitter_url, website_url, whatsapp_url, status, is_banned')
        .eq('status', 'approved')
        .eq('is_banned', false)
        .order('created_at', { ascending: false });

    if (error) {
        console.error('خطأ في جلب الأساتذة:', error.message);
        return [];
    }
    return data || [];
}

// ============================================================
// خريطة المستويات التعليمية
// ============================================================
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

// ============================================================
// تنسيق بيانات العروض (مع الوقت المتبقي)
// ============================================================
async function formatOffers(offers) {
    if (!offers || offers.length === 0) return [];

    const teacherIds = [...new Set(offers.map(o => o.teacher_id))];
    const { data: teachers, error: teachersError } = await supabase
        .from('teachers')
        .select('id, full_name, specialization, profile_url, teaching_level')
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

    return offers.map(offer => {
        const teacher = teachersMap[offer.teacher_id] || {};

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
            booked_count: offer.booked_count || 0,
            created_at: offer.created_at,
            teacher_name: teacher.full_name || 'غير معروف',
            teacher_specialization: teacher.specialization || '',
            teacher_profile_url: teacher.profile_url || null,
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

        // ✅ فلتر حسب المستوى التعليمي
        if (level && level !== 'all') {
            teachers = teachers.filter(t => t.teaching_level === level);
        }

        // ✅ إضافة معلومات البث لكل أستاذ
        const teacherIds = teachers.map(t => t.id);
        let streamInfo = {};
        
        if (teacherIds.length > 0) {
            const { data: liveOffers, error: liveError } = await supabase
                .from('offers')
                .select('teacher_id, status, booked_count, duration')
                .in('teacher_id', teacherIds)
                .in('status', ['live', 'teacher_ready', 'paused']);

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
        }

        // ✅ تنسيق البيانات
        const formatted = teachers.map(teacher => {
            const stream = streamInfo[teacher.id] || {
                has_live_stream: false,
                stream_status: null,
                stream_students: 0,
                remaining_seconds: 0
            };

            return {
                ...teacher,
                has_live_stream: stream.has_live_stream,
                stream_status: stream.stream_status,
                stream_students: stream.stream_students,
                stream_remaining_seconds: stream.remaining_seconds,
                teaching_level_display: levelMap[teacher.teaching_level] || teacher.teaching_level || null
            };
        });

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب قائمة الأساتذة:', error.message);
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
            .in('status', ['upcoming', 'live', 'teacher_ready'])
            .order('offer_date', { ascending: true })
            .limit(100);

        // ✅ فلتر حسب المستوى التعليمي
        if (level && level !== 'all') {
            query = query.eq('education_level', level);
        }

        const { data: offers, error } = await query;

        if (error) {
            console.error('خطأ في جلب العروض العامة:', error.message);
            return res.json([]);
        }

        const filtered = (offers || []).filter(offer => {
            if (offer.status === 'live' || offer.status === 'teacher_ready') return true;
            return new Date(offer.offer_date) >= now;
        });

        const formatted = await formatOffers(filtered);
        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب العروض العامة:', error.message);
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
        if (!teacher || teacher.status !== 'approved' || teacher.is_banned) {
            return res.status(404).json({ success: false, error: 'الأستاذ غير موجود' });
        }

        delete teacher.password;

        const now = new Date();
        const { data: offers, error: offersError } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', teacherId)
            .in('status', ['upcoming', 'live', 'teacher_ready'])
            .order('offer_date', { ascending: true });

        if (offersError) {
            console.error('خطأ في جلب عروض الأستاذ:', offersError.message);
        }

        const filteredOffers = (offers || []).filter(offer => {
            if (offer.status === 'live' || offer.status === 'teacher_ready') return true;
            return new Date(offer.offer_date) >= now;
        });

        // ✅ تنسيق العروض مع الوقت المتبقي
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

        const { data: posts, error: postsError } = await supabase
            .from('posts')
            .select('*')
            .eq('teacher_id', teacherId)
            .order('created_at', { ascending: false });

        if (postsError) {
            console.error('خطأ في جلب منشورات الأستاذ:', postsError.message);
        }

        const { count: totalOffers, error: countError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .eq('teacher_id', teacherId);

        if (countError) {
            console.error('خطأ في حساب عدد العروض:', countError.message);
        }

        const { data: offersIds } = await supabase
            .from('offers')
            .select('id')
            .eq('teacher_id', teacherId);

        let totalStudents = 0;
        if (offersIds && offersIds.length > 0) {
            const offerIds = offersIds.map(o => o.id);
            const { count: studentsCount, error: studentsError } = await supabase
                .from('sessions')
                .select('*', { count: 'exact', head: true })
                .in('offer_id', offerIds)
                .in('payment_status', ['paid', 'pending_stream']);

            if (studentsError) {
                console.error('خطأ في حساب عدد الطلاب:', studentsError.message);
            } else {
                totalStudents = studentsCount || 0;
            }
        }

        // ✅ حساب الرصيد المعلق
        let pendingBalance = 0;
        if (offersIds && offersIds.length > 0) {
            const offerIds = offersIds.map(o => o.id);
            const { data: pendingData, error: pendingError } = await supabase
                .from('sessions')
                .select('payment_amount')
                .in('offer_id', offerIds)
                .eq('payment_status', 'pending_stream');

            if (!pendingError && pendingData) {
                pendingBalance = pendingData.reduce((sum, s) => sum + (s.payment_amount || 0), 0);
            }
        }

        res.json({
            ...teacher,
            teaching_level_display: levelMap[teacher.teaching_level] || teacher.teaching_level || null,
            offers: formattedOffers,
            live_stream: liveStreamInfo,
            posts: posts || [],
            stats: {
                total_offers: totalOffers || 0,
                total_students: totalStudents,
                pending_balance: pendingBalance
            }
        });
    } catch (error) {
        console.error('خطأ في جلب بيانات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// GET /api/public/stats (مع إضافة البث المباشر والمتوقف)
// ============================================================
router.get('/public/stats', async (req, res) => {
    try {
        const { count: teachersCount, error: teachersError } = await supabase
            .from('teachers')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'approved')
            .eq('is_banned', false);

        if (teachersError) {
            console.error('خطأ في حساب الأساتذة:', teachersError.message);
        }

        const { count: studentsCount, error: studentsError } = await supabase
            .from('students')
            .select('*', { count: 'exact', head: true })
            .eq('is_banned', false);

        if (studentsError) {
            console.error('خطأ في حساب الطلاب:', studentsError.message);
        }

        const { count: liveCount, error: liveError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .in('status', ['live', 'teacher_ready']);

        if (liveError) {
            console.error('خطأ في حساب البث المباشر:', liveError.message);
        }

        const { count: pausedCount, error: pausedError } = await supabase
            .from('offers')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'paused');

        if (pausedError) {
            console.error('خطأ في حساب البث المتوقف:', pausedError.message);
        }

        // ✅ جلب عدد الطلاب في البث
        const { count: activeStudents, error: activeError } = await supabase
            .from('active_stream')
            .select('*', { count: 'exact', head: true });

        if (activeError) {
            console.error('خطأ في حساب الطلاب النشطين:', activeError.message);
        }

        // ✅ جلب مستويات التعليم المتاحة
        const { data: levelsData, error: levelsError } = await supabase
            .from('teachers')
            .select('teaching_level')
            .eq('status', 'approved')
            .not('teaching_level', 'is', null);

        let availableLevels = [];
        if (!levelsError && levelsData) {
            const uniqueLevels = [...new Set(levelsData.map(t => t.teaching_level).filter(Boolean))];
            availableLevels = uniqueLevels.map(level => ({
                value: level,
                label: levelMap[level] || level
            }));
        }

        res.json({
            teachers: teachersCount || 0,
            students: studentsCount || 0,
            live: liveCount || 0,
            paused: pausedCount || 0,
            active_students: activeStudents || 0,
            levels: availableLevels
        });
    } catch (error) {
        console.error('خطأ في جلب الإحصائيات:', error.message);
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
        console.error('خطأ في حساب إجمالي العروض:', error.message);
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
        console.error('خطأ في جلب مستويات التعليم:', error.message);
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
            .select('*, teachers:teacher_id (full_name, profile_url, specialization)')
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
                teacher_profile_url: offer.teachers?.profile_url || null,
                teacher_specialization: offer.teachers?.specialization || '',
                created_at: offer.created_at
            };
        });

        res.json(formatted);
    } catch (error) {
        console.error('خطأ في جلب البث المباشر:', error.message);
        res.status(500).json([]);
    }
});

module.exports = router;
