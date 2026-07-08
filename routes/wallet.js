// ============================================================
// مسارات المحفظة - Wallet Routes
// ============================================================

const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');
const crypto = require('crypto');
const axios = require('axios');
const https = require('https');

const { supabase } = require('../config/database');
const { authenticate, checkBanned } = require('../middleware/auth');
const { getOne, insert, update } = require('../utils/helpers');

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

const CHARGILY_API_KEY = process.env.CHARGILY_API_KEY;
const CHARGILY_API_URL = process.env.CHARGILY_API_URL || 'https://pay.chargily.net/api/v2';
const CHARGILY_WEBHOOK_SECRET = process.env.CHARGILY_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');

// ============================================================
// إنشاء طلب شحن عبر Chargily
// ============================================================
async function createChargilyCheckout(amount, studentName, studentEmail, studentPhone, description, successUrl, failureUrl) {
    try {
        let finalAmount = Math.max(Number(amount), 50);
        finalAmount = Math.min(finalAmount, 1000000);
        finalAmount = Math.round(finalAmount);

        const checkoutData = {
            amount: finalAmount,
            currency: 'dzd',
            success_url: successUrl,
            failure_url: failureUrl,
            locale: 'ar',
            description: description || `شحن رصيد بقيمة ${finalAmount} دج`,
            metadata: {
                student_name: studentName || 'طالب',
                student_email: studentEmail || '',
                type: 'wallet_deposit',
                timestamp: Date.now().toString()
            }
        };

        const authMethods = [
            { 'Authorization': `Bearer ${CHARGILY_API_KEY}` },
            { 'X-Authorization': CHARGILY_API_KEY },
            { 'Api-Key': CHARGILY_API_KEY }
        ];

        let lastError = null;

        for (let i = 0; i < authMethods.length; i++) {
            try {
                const response = await axios.post(`${CHARGILY_API_URL}/checkouts`, checkoutData, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        ...authMethods[i]
                    },
                    timeout: 30000,
                    httpsAgent: new https.Agent({ keepAlive: true })
                });

                if (response?.data?.checkout_url) {
                    return {
                        success: true,
                        checkout_url: response.data.checkout_url,
                        checkout_id: response.data.id,
                        amount: finalAmount
                    };
                }
            } catch (error) {
                lastError = error;
                if (i < authMethods.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }

        throw new Error(lastError?.response?.data?.message || lastError?.message || 'فشلت جميع محاولات الدفع');
    } catch (error) {
        console.error('❌ خطأ Chargily:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error
