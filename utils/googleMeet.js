const GOOGLE_CONFIG = {
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    project_id: process.env.GOOGLE_PROJECT_ID || "cedar-channel-507807-e0",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirect_uris: ["https://www.zoomdz.com/"]
};

// رابط إنشاء غرفة جديدة كمضيف ومتحكم رسمي في Google Meet
const GOOGLE_MEET_HOST_CREATE_URL = "https://meet.google.com/new";

/**
 * التحقق من وتنسيق رابط Google Meet المدخل
 */
function formatGoogleMeetUrl(input) {
    if (!input || typeof input !== 'string') return null;
    let trimmed = input.trim();
    
    // إذا كان المدخل رابطاً كاملاً
    if (/^https?:\/\/meet\.google\.com\/[a-zA-Z0-9_-]+/i.test(trimmed)) {
        return trimmed.replace(/^http:/i, 'https:');
    }
    
    // إذا كان المدخل كود الاجتماع فقط مثل abc-defg-hij
    const codeMatch = trimmed.match(/^[a-zA-Z0-9]{3,4}-[a-zA-Z0-9]{3,4}-[a-zA-Z0-9]{3,4}$/);
    if (codeMatch) {
        return `https://meet.google.com/${trimmed.toLowerCase()}`;
    }

    // إذا كان يحتوي على رابط ضمن نص
    const urlMatch = trimmed.match(/https:\/\/meet\.google\.com\/[a-zA-Z0-9_-]+/i);
    if (urlMatch) {
        return urlMatch[0];
    }

    return null;
}

/**
 * إنشاء تفاصيل رابط غرفة Google Meet للحصص المجانية
 */
function generateGoogleMeetRoom(customUrl = '', offerId = null) {
    const formatted = formatGoogleMeetUrl(customUrl);
    return {
        url: formatted || null,
        host_create_url: GOOGLE_MEET_HOST_CREATE_URL,
        platform: 'google_meet',
        is_free: true
    };
}

module.exports = {
    GOOGLE_CONFIG,
    GOOGLE_MEET_HOST_CREATE_URL,
    formatGoogleMeetUrl,
    generateGoogleMeetRoom
};

