// ============================================================
// مسارات عامة - Public Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { param, validationResult } = require('express-validator');

const { supabase } = require('../config/database');
const { getOne } = require('../utils/helpers');

// ============================================================
// جلب قائمة الأساتذة المعتمدين
// ============================================================
async function fetchApprovedTeachers() {
    const { data, error } = await supabase
        .from('teachers')
        .select('id, full_name, specialization, experience, bio, profile_url, facebook_url, instagram_url, linkedin_url, youtube_url, twitter_url, website_url, whatsapp_url, status, is_banned')
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
// تنسيق بيانات العروض
// ============================================================
async function formatOffers(offers) {
    if (!offers || offers.length === 0) return [];

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

    const offerIds = offers.map(o => o.id);
    const { data: jitsiRooms, error: jitsiError } = await supabase
        .from('jitsi_rooms')
        .select('offer_id, password, room_name, room_url')
        .in('offer_id', offerIds);

    if (jitsiError) {
        console.error('خطأ في جلب بيانات Jitsi:', jitsiError.message);
    }

    const jitsiMap = {};
    if (jitsiRooms) {
        for (const room of jitsiRooms) {
            jitsiMap[room.offer_id] = room;
        }
    }

    return offers.map(offer => {
        const jitsiData = jitsiMap[offer.id] || {};
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
            room_password: jitsiData.password || offer.room_password || null,
            room_name: jitsiData.room_name || offer.room_name || null,
            stream_url: offer.stream_url || jitsiData.room_url || null,
            stream_platform: offer.stream_platform || 'jitsi',
            created_at: offer.created_at,
            teacher_name: teacher.full_name || 'غير معروف',
            teacher_specialization: teacher.specialization || '',
            teacher_profile_url: teacher.profile_url || null
        };
    });
}

// ============================================================
// GET /api/teachers و /api/public/teachers
// ============================================================
router.get(['/teachers', '/public/teachers'], async (req, res) => {
    try {
        const teachers = await fetchApprovedTeachers();
        res.json(teachers);
    } catch (error) {
        console.error('خطأ في جلب قائمة الأساتذة:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// GET /api/public/offers
// ============================================================
router.get('/public/offers', async (req, res) => {
    try {
        const now = new Date();

        const { data: offers, error } = await supabase
            .from('offers')
            .select('*')
            .in('status', ['upcoming', 'live', 'teacher_ready'])
            .order('offer_date', { ascending: true })
            .limit(100);

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
// GET /api/public/teacher/:teacherId
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
                .eq('payment_status', 'paid');

            if (studentsError) {
                console.error('خطأ في حساب عدد الطلاب:', studentsError.message);
            } else {
                totalStudents = studentsCount || 0;
            }
        }

        res.json({
            ...teacher,
            offers: filteredOffers,
            posts: posts || [],
            stats: {
                total_offers: totalOffers || 0,
                total_students: totalStudents
            }
        });
    } catch (error) {
        console.error('خطأ في جلب بيانات الأستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// GET /api/public/stats
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
            console.error('خطأ في حساب البثوث المباشرة:', liveError.message);
        }

        res.json({
            teachers: teachersCount || 0,
            students: studentsCount || 0,
            live: liveCount || 0
        });
    } catch (error) {
        console.error('خطأ في جلب الإحصائيات:', error.message);
        res.status(500).json({ teachers: 0, students: 0, live: 0 });
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

module.exports = router;
