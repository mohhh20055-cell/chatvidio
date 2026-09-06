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

/**
 * توليد كود ورابط غرفة Google Meet قياسي وفق نسق (xxx-yyyy-zzz)
 */
function generateGoogleMeetCode() {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    const getRandomSegment = (len) => {
        let res = '';
        const bytes = crypto.randomBytes(len);
        for (let i = 0; i < len; i++) {
            res += chars[bytes[i] % chars.length];
        }
        return res;
    };
    
    const part1 = getRandomSegment(3);
    const part2 = getRandomSegment(4);
    const part3 = getRandomSegment(3);
    
    return `${part1}-${part2}-${part3}`;
}

/**
 * إنشاء تفاصيل رابط غرفة Google Meet للحصص المجانية
 */
function generateGoogleMeetRoom(subjectName = '', offerId = null) {
    const code = generateGoogleMeetCode();
    const url = `https://meet.google.com/${code}`;
    return {
        code,
        url,
        platform: 'google_meet',
        is_free: true,
        client_id: GOOGLE_CONFIG.client_id
    };
}

module.exports = {
    GOOGLE_CONFIG,
    generateGoogleMeetCode,
    generateGoogleMeetRoom
};
