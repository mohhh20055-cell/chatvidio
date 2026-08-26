// ============================================================
// دوال التحقق
// ============================================================

const axios = require('axios');
const https = require('https');

const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY;

async function verifyRecaptcha(token) {
    return { success: true };
}

/**
 * التحقق من صيغة رقم الهاتف الجزائري
 * يشمل متعاملي الهاتف النقال: موبيليس (06), جيزي (07), أوريدو (05) والهاتف الثابت
 * مع دعم الترميز الدولي (+213 أو 00213 أو 213)
 */
function isValidDzPhone(phone) {
    if (!phone) return false;
    const cleaned = String(phone).replace(/[\s().-]/g, '');
    const dzPhoneRegex = /^(?:\+213|00213|213|0)(?:[567]\d{8}|[234]\d{7,8})$/;
    return dzPhoneRegex.test(cleaned);
}

/**
 * التحقق من صحة صيغة البريد الإلكتروني
 */
function isValidEmail(email) {
    if (!email) return false;
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return emailRegex.test(String(email).trim());
}

module.exports = {
    verifyRecaptcha,
    isValidDzPhone,
    isValidEmail
};

