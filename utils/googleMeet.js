const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const tokensFilePath = path.join(__dirname, '../data/google_tokens.json');

const GOOGLE_CONFIG = {
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    project_id: process.env.GOOGLE_PROJECT_ID || "cedar-channel-507807-e0",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirect_uris: ["https://www.zoomdz.com/"]
};

// رابط إنشاء غرفة جديدة كمضيف ومتحكم رسمي في Google Meet (اختياري)
const GOOGLE_MEET_HOST_CREATE_URL = "https://meet.google.com/new";

/**
 * تحميل المخزن المحلي لمفاتيح جوجل
 */
async function loadTokensStore() {
    try {
        if (fs.existsSync(tokensFilePath)) {
            const content = await fs.promises.readFile(tokensFilePath, 'utf8');
            return JSON.parse(content) || {};
        }
    } catch (e) {
        console.error('Error loading google tokens store:', e.message);
    }
    return {};
}

/**
 * حفظ مفاتيح Google والبريد الإلكتروني للأستاذ
 */
async function saveTeacherGoogleToken(teacherId, tokens, email = '') {
    if (!teacherId) return null;
    const store = await loadTokensStore();
    const strId = String(teacherId);
    const existing = store[strId] || {};

    store[strId] = {
        teacher_id: teacherId,
        refresh_token: tokens.refresh_token || existing.refresh_token || null,
        access_token: tokens.access_token || null,
        expires_at: tokens.expires_in ? (Date.now() + tokens.expires_in * 1000) : (existing.expires_at || null),
        google_email: email || tokens.email || existing.google_email || null,
        updated_at: new Date().toISOString()
    };

    try {
        const dir = path.dirname(tokensFilePath);
        if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(tokensFilePath, JSON.stringify(store, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving Google tokens to disk:', e.message);
    }

    // محاولة التحديث في Supabase إن وجد العمود
    try {
        const { supabase } = require('../config/database');
        await supabase.from('teachers').update({
            google_refresh_token: store[strId].refresh_token,
            google_email: store[strId].google_email
        }).eq('id', teacherId);
    } catch (e) {}

    return store[strId];
}

/**
 * جلب مفتاح التجديد المريح للأستاذ
 */
async function getTeacherGoogleToken(teacherId) {
    if (!teacherId) return null;
    const store = await loadTokensStore();
    const strId = String(teacherId);
    if (store[strId] && store[strId].refresh_token) {
        return store[strId];
    }

    try {
        const { supabase } = require('../config/database');
        const { data } = await supabase.from('teachers').select('google_refresh_token, google_email').eq('id', teacherId).single();
        if (data && data.google_refresh_token) {
            return {
                teacher_id: teacherId,
                refresh_token: data.google_refresh_token,
                google_email: data.google_email
            };
        }
    } catch (e) {}

    return null;
}

/**
 * إلغاء ربط حساب جوجل للأستاذ
 */
async function removeTeacherGoogleToken(teacherId) {
    if (!teacherId) return false;
    const store = await loadTokensStore();
    delete store[String(teacherId)];
    try {
        await fs.promises.writeFile(tokensFilePath, JSON.stringify(store, null, 2), 'utf8');
    } catch (e) {}

    try {
        const { supabase } = require('../config/database');
        await supabase.from('teachers').update({
            google_refresh_token: null,
            google_email: null
        }).eq('id', teacherId);
    } catch (e) {}

    return true;
}

/**
 * إنشاء رابط تفويض OAuth 2.0 لجوجل بطلب مفتاح دائم offline refresh_token
 */
function getGoogleAuthUrl(redirectUri, teacherId) {
    const clientId = process.env.GOOGLE_CLIENT_ID || GOOGLE_CONFIG.client_id;
    const scope = encodeURIComponent('https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar userinfo.email');
    const state = encodeURIComponent(JSON.stringify({ teacherId, ts: Date.now() }));

    return `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${clientId}&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `response_type=code&` +
        `scope=${scope}&` +
        `access_type=offline&` +
        `prompt=consent&` +
        `state=${state}`;
}

/**
 * تبديل كود التفويض بمفاتيح الدخول وتجديد الجلسة
 */
async function exchangeCodeForTokens(code, redirectUri) {
    const clientId = process.env.GOOGLE_CLIENT_ID || GOOGLE_CONFIG.client_id;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || GOOGLE_CONFIG.client_secret;

    const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
    });

    const res = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    let googleEmail = null;
    if (res.data.access_token) {
        try {
            const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${res.data.access_token}` }
            });
            googleEmail = userRes.data.email;
        } catch (e) {}
    }

    return {
        ...res.data,
        email: googleEmail
    };
}

/**
 * الحصول على access_token جديد وصالح باستخدام refresh_token
 */
async function getValidAccessToken(teacherId) {
    const record = await getTeacherGoogleToken(teacherId);
    if (!record || !record.refresh_token) {
        return null;
    }

    // إذا كان access_token الحالي لا يزال صالماً
    if (record.access_token && record.expires_at && record.expires_at > Date.now() + 60000) {
        return record.access_token;
    }

    const clientId = process.env.GOOGLE_CLIENT_ID || GOOGLE_CONFIG.client_id;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || GOOGLE_CONFIG.client_secret;

    try {
        const params = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: record.refresh_token,
            grant_type: 'refresh_token'
        });

        const res = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (res.data && res.data.access_token) {
            await saveTeacherGoogleToken(teacherId, {
                access_token: res.data.access_token,
                expires_in: res.data.expires_in,
                refresh_token: record.refresh_token
            }, record.google_email);
            return res.data.access_token;
        }
    } catch(e) {
        console.error('❌ Error refreshing Google Access Token:', e.response?.data || e.message);
    }

    return null;
}

/**
 * إنشاء غرفة Google Meet رسمية تلقائياً وبشكل برمجي في الخلفية عبر Google Calendar API
 */
async function createGoogleMeetRoomViaApi(teacherId, subjectName = '', offerDate = null, durationMinutes = 60) {
    try {
        const accessToken = await getValidAccessToken(teacherId);
        if (!accessToken) {
            return { success: false, reason: 'NOT_CONNECTED' };
        }

        const startIso = offerDate ? new Date(offerDate).toISOString() : new Date().toISOString();
        const endIso = new Date(new Date(startIso).getTime() + (durationMinutes * 60 * 1000)).toISOString();
        const requestId = `meet_${teacherId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        const eventData = {
            summary: `حصة مباشرة: ${subjectName || 'درس منصة ZoomDz'}`,
            description: `بث مباشر عبر Google Meet لمنصة ZoomDz التعليمية.`,
            start: { dateTime: startIso, timeZone: 'Africa/Algiers' },
            end: { dateTime: endIso, timeZone: 'Africa/Algiers' },
            conferenceData: {
                createRequest: {
                    requestId: requestId,
                    conferenceSolutionKey: { type: 'hangoutsMeet' }
                }
            }
        };

        const response = await axios.post(
            'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1',
            eventData,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const data = response.data;
        let meetUrl = data.hangoutLink;
        if (!meetUrl && data.conferenceData && data.conferenceData.entryPoints) {
            const videoEntryPoint = data.conferenceData.entryPoints.find(ep => ep.entryPointType === 'video');
            if (videoEntryPoint) meetUrl = videoEntryPoint.uri;
        }

        if (meetUrl) {
            console.log(`✅ تم إنشاء غرفة Google Meet رسمية برمجياً عبر API للأستاذ ${teacherId}: ${meetUrl}`);
            return {
                success: true,
                url: meetUrl,
                event_id: data.id,
                platform: 'google_meet',
                is_free: true
            };
        }

        return { success: false, reason: 'NO_LINK_RETURNED', details: data };
    } catch(err) {
        console.error('❌ Error creating Google Meet event via API:', err.response?.data || err.message);
        return { success: false, reason: 'API_ERROR', error: err.response?.data?.error?.message || err.message };
    }
}

/**
 * التحقق من وتنسيق رابط Google Meet المدخل
 */
function formatGoogleMeetUrl(input) {
    if (!input || typeof input !== 'string') return null;
    let trimmed = input.trim();
    
    if (/^https?:\/\/meet\.google\.com\/[a-zA-Z0-9_-]+/i.test(trimmed)) {
        return trimmed.replace(/^http:/i, 'https:');
    }
    
    const codeMatch = trimmed.match(/^[a-zA-Z0-9]{3,4}-[a-zA-Z0-9]{3,4}-[a-zA-Z0-9]{3,4}$/);
    if (codeMatch) {
        return `https://meet.google.com/${trimmed.toLowerCase()}`;
    }

    const urlMatch = trimmed.match(/https:\/\/meet\.google\.com\/[a-zA-Z0-9_-]+/i);
    if (urlMatch) {
        return urlMatch[0];
    }

    if (/^https?:\/\/meet\.jit\.si\/[a-zA-Z0-9_-]+/i.test(trimmed)) {
        return trimmed.replace(/^http:/i, 'https:');
    }

    return null;
}

/**
 * توليد غرفة بث تفاعلية مع أولوية لـ Google Meet API في حال ربط حساب الأستاذ
 */
function generateFreeStreamRoom(offerId = null, subjectName = '', customUrl = '') {
    if (customUrl) {
        const formatted = formatGoogleMeetUrl(customUrl);
        if (formatted) {
            return {
                url: formatted,
                room_name: formatted,
                platform: formatted.includes('meet.google.com') ? 'google_meet' : 'jitsi',
                is_free: true,
                is_custom: true
            };
        }
    }

    const safeOfferId = offerId ? String(offerId).replace(/[^a-zA-Z0-9]/g, '') : Date.now();
    const hash = crypto.randomBytes(4).toString('hex');
    const roomName = `ZoomDz_Free_${safeOfferId}_${hash}`;
    const directRoomUrl = `https://meet.jit.si/${roomName}#config.prejoinPageEnabled=false&config.startWithAudioMuted=false&config.startWithVideoMuted=false`;

    return {
        url: directRoomUrl,
        room_name: roomName,
        platform: 'jitsi',
        is_free: true,
        is_custom: false
    };
}

function generateGoogleMeetRoom(customUrl = '', offerId = null) {
    return generateFreeStreamRoom(offerId, '', customUrl);
}

module.exports = {
    GOOGLE_CONFIG,
    GOOGLE_MEET_HOST_CREATE_URL,
    saveTeacherGoogleToken,
    getTeacherGoogleToken,
    removeTeacherGoogleToken,
    getGoogleAuthUrl,
    exchangeCodeForTokens,
    getValidAccessToken,
    createGoogleMeetRoomViaApi,
    formatGoogleMeetUrl,
    generateFreeStreamRoom,
    generateGoogleMeetRoom
};


