const crypto = require('crypto');

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
 * التحقق من وتنسيق رابط Google Meet المدخل
 */
function formatGoogleMeetUrl(input) {
    if (!input || typeof input !== 'string') return null;
    let trimmed = input.trim();
    
    // إذا كان المدخل رابطاً كاملاً لـ Google Meet
    if (/^https?:\/\/meet\.google\.com\/[a-zA-Z0-9_-]+/i.test(trimmed)) {
        return trimmed.replace(/^http:/i, 'https:');
    }
    
    // إذا كان المدخل كود اجتماع Google Meet فقط مثل abc-defg-hij
    const codeMatch = trimmed.match(/^[a-zA-Z0-9]{3,4}-[a-zA-Z0-9]{3,4}-[a-zA-Z0-9]{3,4}$/);
    if (codeMatch) {
        return `https://meet.google.com/${trimmed.toLowerCase()}`;
    }

    // إذا كان يحتوي على رابط ضمن نص
    const urlMatch = trimmed.match(/https:\/\/meet\.google\.com\/[a-zA-Z0-9_-]+/i);
    if (urlMatch) {
        return urlMatch[0];
    }

    // إذا كان رابط Jitsi Meet
    if (/^https?:\/\/meet\.jit\.si\/[a-zA-Z0-9_-]+/i.test(trimmed)) {
        return trimmed.replace(/^http:/i, 'https:');
    }

    return null;
}

/**
 * توليد غرفة بث تفاعلية مباشرة ومؤتمتة 100% بدون أي خطوات يدوية
 * تتيح للأستاذ الدخول كمضيف ومدير للجلسة مباشرة، وتتيح للطلاب الانضمام الفوري بضغطة زر
 */
function generateFreeStreamRoom(offerId = null, subjectName = '', customUrl = '') {
    // إذا قام الأستاذ بتوفير رابط خاص (Google Meet أو غيره)، نستخدمه مباشرة
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

    // توليد غرفة مباشرة وفورية بدون أي إعدادات يدوية أو أخطاء تحقق
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

/**
 * إنشاء تفاصيل رابط غرفة Google Meet للحصص المجانية (مع التوافق الرجعي)
 */
function generateGoogleMeetRoom(customUrl = '', offerId = null) {
    return generateFreeStreamRoom(offerId, '', customUrl);
}

module.exports = {
    GOOGLE_CONFIG,
    GOOGLE_MEET_HOST_CREATE_URL,
    formatGoogleMeetUrl,
    generateFreeStreamRoom,
    generateGoogleMeetRoom
};


