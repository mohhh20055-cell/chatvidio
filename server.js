// ============================================================
// خادم منصة التعليم - الملف الرئيسي (معدل بالكامل)
// ============================================================

require('dotenv').config();

// دعم WebSocket على Node.js < 22 (يحتاجه Supabase realtime-js)
if (typeof global.WebSocket === 'undefined') {
    global.WebSocket = require('ws');
}

const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const crypto = require('crypto');
const logger = require('./utils/logger');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const axios = require('axios');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const webpush = require('web-push');

webpush.setVapidDetails(
    'mailto:hamodi20052@gmail.com',
    'BB1Dcbh6jxa4PZCvCWX0-fq-MQD2SjeKq2uworSRnKmTRIiFhZlPsan1waIPDY3tjhxqaK_7Ww7rj2Ymmr3AF9w',
    'Ee2Xf4Ftxaxo_65RXaLZAMn8IioJFyZpUU615LZgbT0'
);

// ✅ استيراد الدوال المساعدة من ملفات منفصلة
const { generateToken, verifyToken } = require('./utils/jwt');
const { encrypt, maskIP } = require('./utils/encryption');
const { recordUniqueView, getViewCount, syncItemViews } = require('./utils/viewsTracker');

// ============================================================
// ✅ استيراد Middleware من الملف الخارجي
// ============================================================
const { authenticate, authorize, checkBanned, checkActiveStream, validateOfferOwnership, validateStudentAccess, checkStreamActive, checkNoActiveStream } = require('./middleware/auth');
const { antiRapidClickLimiter } = require('./middleware/rateLimit');

// ============================================================
// الثوابت والإعدادات الأساسية
// ============================================================

const JWT_SECRET = process.env.JWT_SECRET || 'zoomdz_secret_key_2024_for_testing_only';
const JWT_EXPIRY = '24h';
const SALT_ROUNDS = 12;
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'https://zoomdz.com';
const PUBLIC_CACHE_TTL_MS = 30000;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// --- دمج الدوال المساعدة والاتصال بقاعدة البيانات ---
const { supabase, getOne, insert, update, remove, sanitizeObject } = require('./utils/db');

function generateVerificationToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateReferralCode(name, id) {
    const prefix = name.substring(0, 3).toUpperCase();
    const suffix = id.toString(36).toUpperCase();
    return `${prefix}${suffix}`;
}

// ============================================================
// إعدادات CORS
// ============================================================

// قائمة النطاقات المسموحة (يمكن تجاوزها عبر CORS_ORIGIN من البيئة)
const DEFAULT_CORS_ORIGINS = [
    'https://zoomdz.com',
    'https://www.zoomdz.com',
    'http://zoomdz.com',
    'http://www.zoomdz.com',
    'https://zooooooom-mown.vercel.app',
    'https://chatvidio.vercel.app',
    'https://chatvidio.onrender.com',
    'https://chatvidio-git-*.vercel.app',
    'https://chatvidio-*.vercel.app',
    'https://*.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002'
];

const ENV_CORS_ORIGINS = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN
        .split(',')
        .map(origin => origin.trim())
        .filter(origin => origin.length > 0)
    : [];

// دمج origins من البيئة مع الافتراضية لضمان عدم فقدان نطاقات أساسية (مثل www.zoomdz.com)
const CORS_ORIGIN = [...new Set([...ENV_CORS_ORIGINS, ...DEFAULT_CORS_ORIGINS])];

logger.info('CORS Origins configured:', {
    count: CORS_ORIGIN.length,
    origins: CORS_ORIGIN.slice(0, 5),
    isFromEnv: !!process.env.CORS_ORIGIN
});

function isOriginAllowed(origin) {
    // اسمح بالطلبات بدون origin
    if (!origin) {
        return true;
    }

    // التحقق المباشر
    if (CORS_ORIGIN.includes(origin)) {
        return true;
    }

    // التحقق من Wildcard patterns
    for (const allowed of CORS_ORIGIN) {
        if (allowed.includes('*')) {
            const pattern = allowed
                .replace(/\./g, '\\.')
                .replace(/\*/g, '.*');
            const regex = new RegExp(`^${pattern}$`);
            if (regex.test(origin)) {
                return true;
            }
        }
    }

    // رفض المصدر وتسجيل التفاصيل للتصحيح
    logger.warn('CORS origin rejected', {
        origin: origin,
        allowedOrigins: CORS_ORIGIN,
        checkPassed: false
    });
    
    return false;
}

// ============================================================
// تهيئة التطبيق
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;

// LRU-like simple cache to prevent memory leak
const publicCache = new Map();
const MAX_CACHE_SIZE = 100;

app.set('trust proxy', 1);
app.disable('x-powered-by');

function cachePublicResponses(ttlMs = PUBLIC_CACHE_TTL_MS) {
    return (req, res, next) => {
        if (req.method !== 'GET') return next();

        const cacheKey = `${req.method}:${req.originalUrl}`;
        const cached = publicCache.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < ttlMs) {
            res.set('X-Cache', 'HIT');
            return res.json(cached.body);
        }

        const originalJson = res.json.bind(res);
        res.json = (body) => {
            // Prevent cache from growing indefinitely
            if (publicCache.size >= MAX_CACHE_SIZE) {
                const firstKey = publicCache.keys().next().value;
                publicCache.delete(firstKey);
            }
            
            publicCache.set(cacheKey, { timestamp: Date.now(), body });
            res.set('X-Cache', 'MISS');
            return originalJson(body);
        };

        next();
    };
}

// ============================================================
// Middleware الأساسية
// ============================================================

// Compression
app.use(compression());

// Helmet - Jitsi, Agora & Google AdSense / Ad Traffic Quality Support
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'", "'unsafe-inline'", "'unsafe-eval'",
                "https://download.agora.io", "https://cdn.jsdelivr.net", "https://unpkg.com",
                "https://cdnjs.cloudflare.com", "https://vercel.live", "https://*.vercel.app",
                "https://*.google.com", "https://*.gstatic.com", "https://*.google",
                "https://*.adtrafficquality.google", "https://*.googleadservices.com",
                "https://pagead2.googlesyndication.com", "https://pagead2.googleadservices.com",
                "https://adservice.google.com", "https://www.googletagservices.com",
                "https://googleads.g.doubleclick.net", "https://*.googlesyndication.com"
            ],
            scriptSrcElem: [
                "'self'", "'unsafe-inline'", "'unsafe-eval'",
                "https://download.agora.io", "https://cdn.jsdelivr.net", "https://unpkg.com",
                "https://cdnjs.cloudflare.com", "https://vercel.live", "https://*.vercel.app",
                "https://*.google.com", "https://*.gstatic.com", "https://*.google",
                "https://*.adtrafficquality.google", "https://*.googleadservices.com",
                "https://pagead2.googlesyndication.com", "https://pagead2.googleadservices.com",
                "https://adservice.google.com", "https://www.googletagservices.com",
                "https://googleads.g.doubleclick.net", "https://*.googlesyndication.com"
            ],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: [
                "'self'", "data:", "blob:", "https://ui-avatars.com", "https://api.qrserver.com",
                "https://*.supabase.co", "https://*.google.com", "https://*.gstatic.com", "https://*.google",
                "https://*.adtrafficquality.google", "https://*.googleadservices.com",
                "https://pagead2.googlesyndication.com", "https://*.doubleclick.net",
                "https://*.googlesyndication.com",
                "https://*.imgur.com", "https://imgur.com", "https://i.imgur.com", "https://*.githubusercontent.com", "https:"
            ],
            mediaSrc: ["'self'", "blob:", "data:", "https://assets.mixkit.co", "https:"],
            connectSrc: [
                "'self'", "https://*.agora.io", "wss://*.agora.io", "https://*.sd-rtn.com",
                "wss://*.sd-rtn.com", "https://*.agoraio.cn", "wss://*.agoraio.cn",
                "https://*.supabase.co", "https://sofizpay.com", "https://*.vercel.app",
                "https://*.google.com", "https://*.gstatic.com", "https://*.google",
                "https://*.adtrafficquality.google", "https://*.googleadservices.com",
                "https://pagead2.googlesyndication.com", "https://*.google-analytics.com",
                "https://*.analytics.google.com", "https://*.googlesyndication.com", "https://*.doubleclick.net"
            ],
            frameSrc: [
                "'self'", "https://meet.jit.si", "https://*.google.com", "https://*.gstatic.com", "https://*.google",
                "https://*.adtrafficquality.google", "https://*.googleadservices.com",
                "https://googleads.g.doubleclick.net", "https://*.doubleclick.net",
                "https://*.googlesyndication.com", "https://tpc.googlesyndication.com"
            ]
        }
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    },
    frameguard: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false
}));

// CORS Configuration
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) {
            logger.debug('CORS: Allowing request without Origin header');
            return callback(null, true);
        }

        const allowed = isOriginAllowed(origin);
        
        if (allowed) {
            logger.debug('CORS: Origin allowed', { origin });
            callback(null, true);
        } else {
            logger.warn('CORS: Origin rejected but allowing (configured to warn)', { 
                origin,
                allowedCount: CORS_ORIGIN.length 
            });
            callback(null, true);
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'X-CSRF-Token',
        'X-Signature',
        'Accept',
        'Origin',
        'X-HTTP-Method-Override',
        'Access-Control-Request-Headers',
        'Access-Control-Request-Method',
        'X-API-Key'
    ],
    credentials: true,
    maxAge: 86400,
    optionsSuccessStatus: 200,
    preflightContinue: false
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ملفات ثابتة للموقع (يجب أن تكون قبل JSON/Sanitization)
const staticOptions = {
    maxAge: '1d',
    etag: true,
    lastModified: true,
    index: false, // منع تقديم index.html تلقائياً للمسا�� الرئيسي لخدمته عبر الموجه المخصص بالكاش
    setHeaders: (res, filePath) => {
        if (filePath.match(/\.(png|jpg|jpeg|gif|webp|svg|ico|woff2|woff|ttf|eot)$/i)) {
            res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
        } else if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
        }
    }
};
app.use(express.static('public', staticOptions));
app.use('/public', express.static('public', staticOptions));

// Cookie Parser
app.use(cookieParser());

// Webhook SofizPay
app.use('/api/wallet/sofizpay-callback', express.raw({ type: 'application/json' }));

// JSON و URL-encoded (with rawBody verification support for webhooks)
app.use(express.json({
    limit: '1gb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.urlencoded({ extended: true, limit: '1gb' }));


// تنقية جميع المدخلات
app.use((req, res, next) => {
    if (req.body) {
        req.body = sanitizeObject(req.body);
    }
    if (req.query) {
        req.query = sanitizeObject(req.query);
    }
    if (req.params) {
        req.params = sanitizeObject(req.params);
    }
    next();
});

// ✅ حماية ضد ثغرة النقر المتكرر لجميع مسارات الـ API
app.use('/api', antiRapidClickLimiter);

// --- MYSTERY BOX API & DUAL STORAGE (DISK JSON + SUPABASE) ---
const os = require('os');
let claimsDataDir = path.join(__dirname, 'data');
let claimsFilePath = path.join(claimsDataDir, 'mystery_box_claims.json');
const memoryMysteryBoxClaims = new Map();

function loadLocalMysteryBoxClaims() {
    try {
        if (!fs.existsSync(claimsDataDir)) {
            fs.mkdirSync(claimsDataDir, { recursive: true });
        }
    } catch (e) {
        claimsDataDir = os.tmpdir();
        claimsFilePath = path.join(claimsDataDir, 'mystery_box_claims.json');
    }

    try {
        if (fs.existsSync(claimsFilePath)) {
            const raw = fs.readFileSync(claimsFilePath, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            Object.keys(parsed).forEach(key => {
                memoryMysteryBoxClaims.set(key, parsed[key]);
            });
            console.log(`[Mystery Box] Loaded ${memoryMysteryBoxClaims.size} claims from disk persistence.`);
        }
    } catch (e) {
        console.warn('[Mystery Box] Disk load warning:', e.message);
    }
}
loadLocalMysteryBoxClaims();

function syncLocalMysteryBoxFile() {
    try {
        if (!fs.existsSync(claimsDataDir)) {
            fs.mkdirSync(claimsDataDir, { recursive: true });
        }
        const obj = {};
        for (const [key, val] of memoryMysteryBoxClaims.entries()) {
            obj[key] = val;
        }
        fs.writeFileSync(claimsFilePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        if (e.code === 'EROFS' || e.message?.includes('read-only')) {
            try {
                claimsFilePath = path.join(os.tmpdir(), 'mystery_box_claims.json');
                const obj = {};
                for (const [key, val] of memoryMysteryBoxClaims.entries()) {
                    obj[key] = val;
                }
                fs.writeFileSync(claimsFilePath, JSON.stringify(obj, null, 2), 'utf8');
            } catch (tmpErr) {}
        } else {
            console.warn('[Mystery Box] Disk save warning:', e.message);
        }
    }
}

async function getMysteryBoxClaim(userId) {
    const key = String(userId);
    let claim = memoryMysteryBoxClaims.get(key);

    try {
        if (supabase && typeof supabase.from === 'function') {
            const { data, error } = await supabase
                .from('mystery_box_claims')
                .select('*')
                .eq('user_id', key)
                .maybeSingle();

            if (!error && data) {
                claim = {
                    is_telegram_verified: !!data.is_telegram_verified,
                    telegram_username: data.telegram_username || '',
                    telegram_user_id: data.telegram_user_id || '',
                    last_claimed_at: data.last_claimed_at
                };
                memoryMysteryBoxClaims.set(key, claim);
                syncLocalMysteryBoxFile();
            } else if (error) {
                console.warn('[Supabase Mystery Box Read Warning]:', error.message || error);
            }
        }
    } catch (e) {
        console.warn('[Supabase Mystery Box Exception]:', e.message || e);
    }

    return claim || { is_telegram_verified: false, telegram_username: '', telegram_user_id: '', last_claimed_at: null };
}

async function saveMysteryBoxClaim(userId, isVerified, lastClaimedAt, telegramUsername, telegramUserId) {
    const key = String(userId);
    const existing = memoryMysteryBoxClaims.get(key) || { is_telegram_verified: false, telegram_username: '', telegram_user_id: '', last_claimed_at: null };

    const updated = {
        is_telegram_verified: isVerified !== undefined && isVerified !== null ? Boolean(isVerified) : existing.is_telegram_verified,
        telegram_username: telegramUsername !== undefined && telegramUsername !== null ? telegramUsername : existing.telegram_username,
        telegram_user_id: telegramUserId !== undefined && telegramUserId !== null ? telegramUserId : existing.telegram_user_id,
        last_claimed_at: lastClaimedAt !== undefined && lastClaimedAt !== null ? lastClaimedAt : existing.last_claimed_at
    };

    memoryMysteryBoxClaims.set(key, updated);
    syncLocalMysteryBoxFile();

    try {
        if (supabase && typeof supabase.from === 'function') {
            const { error } = await supabase
                .from('mystery_box_claims')
                .upsert({
                    user_id: key,
                    is_telegram_verified: updated.is_telegram_verified,
                    telegram_username: updated.telegram_username,
                    telegram_user_id: updated.telegram_user_id,
                    last_claimed_at: updated.last_claimed_at,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'user_id' });

            if (error) {
                console.error('[Supabase Mystery Box Save Error]:', error.message || error);
            } else {
                console.log(`[Supabase Mystery Box Save Success] user_id: ${key}`);
            }
        }
    } catch (e) {
        console.error('[Supabase Mystery Box Save Exception]:', e.message || e);
    }

    return updated;
}

app.get('/api/mystery-box/status', async (req, res) => {
    try {
        let userId = req.query.userId;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const decoded = verifyToken(token);
            if (decoded && decoded.userId) {
                userId = decoded.userId;
            }
        }

        if (!userId) {
            return res.json({ success: true, is_verified: false, can_claim: false, remaining_hours: 0, require_login: true, chances: 0 });
        }

        const claim = await getMysteryBoxClaim(userId);

        let canClaim = true;
        let remainingHours = 0;

        if (claim.last_claimed_at) {
            const lastClaimed = new Date(claim.last_claimed_at);
            const now = new Date();
            const diffHours = (now - lastClaimed) / (1000 * 60 * 60);

            if (diffHours < 24) {
                canClaim = false;
                remainingHours = Math.ceil(24 - diffHours);
            }
        }

        let chances = 0;
        try {
            const student = await getOne('students', 'id', userId);
            if (student) {
                chances = student.gift_box_chances || 0;
            }
        } catch (studentErr) {
            console.warn('Error fetching student chances in status:', studentErr);
        }

        res.json({
            success: true,
            is_verified: !!claim.is_telegram_verified,
            telegram_username: claim.telegram_username || '',
            can_claim: canClaim,
            remaining_hours: remainingHours,
            last_claimed_at: claim.last_claimed_at,
            chances: chances
        });
    } catch (e) {
        console.error('Mystery box status error:', e);
        res.json({ success: true, is_verified: false, can_claim: true, remaining_hours: 0, chances: 0 });
    }
});

app.post('/api/mystery-box/verify-telegram', async (req, res) => {
    try {
        let { userId, telegramId, username } = req.body || {};
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const decoded = verifyToken(token);
            if (decoded && decoded.userId) {
                userId = decoded.userId;
            }
        }

        if (!userId) {
            return res.status(400).json({ success: false, error: 'يرجى تسجيل الدخول أولاً لتفعيل صندوق الهدايا' });
        }

        let rawInput = (telegramId || username || '').toString().trim();
        rawInput = rawInput.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').trim();
        let cleanId = rawInput.replace(/[^\d]/g, '');
        let cleanUsername = rawInput;

        if (!rawInput) {
            return res.status(400).json({
                success: false,
                error: 'يرجى إدخال معرف التلغرام الرقمي الخاص بك (Telegram ID). يمكنك معرفته بإرسال /start للبوت @userinfobot'
            });
        }

        const rawBotToken = (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '7691722011:AAFcsFzRtiSPwmi1UoL6n3yDl0tl_v09Qbs').trim();
        const cleanBotToken = rawBotToken.replace(/^bot/i, '').replace(/[<> "'`]/g, '').trim();

        let rawChannel = (process.env.TELEGRAM_CHANNEL || '@zoomdz1').trim();
        rawChannel = rawChannel.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').replace(/[<> "'`]/g, '').trim();
        let channelId = rawChannel.startsWith('-') ? rawChannel : `@${rawChannel}`;

        if (!cleanBotToken) {
            console.warn('[Telegram Verification] TELEGRAM_BOT_TOKEN is missing in environment!');
            return res.status(400).json({
                success: false,
                error: 'عذراً، لم يتم ضبط توكن البوت TELEGRAM_BOT_TOKEN في السيرفر.'
            });
        }

        // 1. If numeric Telegram ID is provided (e.g. 123456789)
        if (cleanId && cleanId.length >= 5) {
            try {
                const tgUrl = `https://api.telegram.org/bot${cleanBotToken}/getChatMember`;
                const numericUserId = parseInt(cleanId, 10);

                const tgRes = await axios.get(tgUrl, {
                    params: {
                        chat_id: channelId,
                        user_id: numericUserId
                    },
                    timeout: 8000
                });

                const memberResult = tgRes.data?.result;
                const memberStatus = memberResult?.status;
                const isMember = memberResult?.is_member;

                const debugInfo = {
                    input_telegram_id: rawInput,
                    parsed_numeric_id: numericUserId,
                    channel_id: channelId,
                    telegram_status: memberStatus,
                    telegram_is_member: isMember,
                    telegram_raw_response: tgRes.data
                };

                // Status check: creator, administrator, member, or restricted member
                if (['creator', 'administrator', 'member'].includes(memberStatus) || (memberStatus === 'restricted' && isMember === true)) {
                    await saveMysteryBoxClaim(userId, true, undefined, cleanUsername ? `@${cleanUsername}` : 'verified_user', cleanId);
                    return res.json({
                        success: true,
                        is_verified: true,
                        message: 'تم التحقق من انضمامك لقناة المنصة بنجاح وتفعيل صندوق الهدايا! 🎉'
                    });
                } else {
                    return res.status(400).json({
                        success: false,
                        error: `عذراً، يجب الانضمام لقناة المنصة أولاً (${channelId})`
                    });
                }
            } catch (tgErr) {
                console.warn('[Telegram getChatMember Error]:', tgErr.response?.data || tgErr.message);
                const tgErrData = tgErr.response?.data || { message: tgErr.message };
                const desc = tgErrData.description || '';

                if (desc.includes('chat not found') || desc.includes('bot is not a member') || desc.includes('not in the chat')) {
                    return res.status(400).json({
                        success: false,
                        error: `يرجى التأكد من إضافة البوت كمشرف في قناة المنصة (${channelId})`
                    });
                } else if (desc.includes('USER_NOT_PARTICIPANT') || desc.includes('user not found') || desc.includes('left')) {
                    return res.status(400).json({
                        success: false,
                        error: `عذراً، يجب الانضمام لقناة المنصة أولاً (${channelId})`
                    });
                } else if (desc.includes('user_id must be integer')) {
                    return res.status(400).json({
                        success: false,
                        error: `يرجى إدخال معرف التلغرام الرقمي الخاص بك (أرقام فقط م��ال: 123456789) عبر البوت @userinfobot`
                    });
                } else {
                    return res.status(400).json({
                        success: false,
                        error: desc ? `خطأ من تلغرام: ${desc}` : `عذراً، يجب الانضمام لقناة المنصة أولاً (${channelId})`
                    });
                }
            }
        } else if (cleanUsername) {
            // 2. If user entered username (e.g. @username) instead of numeric ID
            try {
                const adminsUrl = `https://api.telegram.org/bot${cleanBotToken}/getChatAdministrators`;
                const adminsRes = await axios.get(adminsUrl, {
                    params: { chat_id: channelId },
                    timeout: 8000
                });

                const admins = adminsRes.data?.result || [];
                const matchedAdmin = admins.find(a => 
                    a.user?.username?.toLowerCase() === cleanUsername.toLowerCase()
                );

                if (matchedAdmin) {
                    await saveMysteryBoxClaim(userId, true, undefined, `@${cleanUsername}`, matchedAdmin.user.id);
                    return res.json({
                        success: true,
                        is_verified: true,
                        message: 'تم التحقق من انضمامك لقناة المنصة بنجاح وتفعيل صندوق الهدايا! 🎉'
                    });
                } else {
                    return res.status(400).json({
                        success: false,
                        error: `يتطلب تلغرام المعرف الرقمي (Telegram ID) المكون من أرقام فقط (مثل 123456789). يمكنك الحصول عليه بإرسال /start للبوت @userinfobot في التلغرام.`
                    });
                }
            } catch (admErr) {
                return res.status(400).json({
                    success: false,
                    error: `يتطلب تلغرام المعرف الرقمي (Telegram ID) المكون من أرقام فقط (مثال: 123456789). احصل عليه عبر @userinfobot`
                });
            }
        } else {
            return res.status(400).json({
                success: false,
                error: 'يرجى إدخال معرف التلغرام الرقمي الصحيح (Telegram ID).'
            });
        }
    } catch (e) {
        console.error('Telegram verification server error:', e);
        return res.status(400).json({ success: false, error: 'حدث خطأ في الاتصال بالتلغرام' });
    }
});

app.post('/api/mystery-box/claim', async (req, res) => {
    try {
        let { userId, useChance } = req.body || {};
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const decoded = verifyToken(token);
            if (decoded && decoded.userId) {
                userId = decoded.userId;
            }
        }

        if (!userId) {
            return res.status(400).json({ success: false, error: 'يرجى تسجيل الدخول أولاً للحصول على المكافأة' });
        }

        let updatedBalance = 0;
        let chancesLeft = 0;

        if (useChance) {
            // Option 1: Claiming using a Referral Gift Box Chance
            const student = await getOne('students', 'id', userId);
            if (!student) {
                return res.status(400).json({ success: false, error: 'هذا الإجراء متاح لطلاب المنصة فقط' });
            }

            const currentChances = student.gift_box_chances || 0;
            if (currentChances <= 0) {
                return res.status(400).json({ success: false, error: 'ليس لديك فرص كافية لفتح صندوق الهدايا' });
            }

            // Decrement chance
            chancesLeft = currentChances - 1;
            await supabase.from('students').update({ gift_box_chances: chancesLeft }).eq('id', userId);

            // Weighted reward between 10 and 50 DZD (Biased heavily towards 10 and 20 to protect platform economy)
            const randVal = Math.random() * 100;
            let reward = 10;
            if (randVal < 60) {
                // 60% chance: 10 to 15 DZD
                reward = Math.floor(Math.random() * (15 - 10 + 1)) + 10;
            } else if (randVal < 85) {
                // 25% chance: 16 to 25 DZD (centered around 20 DZD)
                reward = Math.floor(Math.random() * (25 - 16 + 1)) + 16;
            } else if (randVal < 95) {
                // 10% chance: 26 to 40 DZD
                reward = Math.floor(Math.random() * (40 - 26 + 1)) + 26;
            } else {
                // 5% chance: 41 to 50 DZD
                reward = Math.floor(Math.random() * (50 - 41 + 1)) + 41;
            }

            updatedBalance = (parseFloat(student.wallet_balance) || 0) + reward;
            await supabase.from('students').update({ wallet_balance: updatedBalance }).eq('id', userId);

            // Log transaction
            await supabase.from('wallet_transactions').insert({
                student_id: userId,
                amount: reward,
                type: 'referral_gift',
                status: 'completed',
                description: `مكافأة إحالة ����ن صندوق الهدايا - ${reward} دج`,
                created_at: new Date().toISOString()
            });

            // Log referral reward
            await supabase.from('referral_rewards').insert({
                student_id: userId,
                amount: reward,
                type: 'gift_box_reward',
                description: `صندوق هدايا (فرصة إحالة) - ${reward} دج`,
                created_at: new Date().toISOString()
            });

            return res.json({
                success: true,
                reward: reward,
                new_balance: updatedBalance,
                chances: chancesLeft,
                message: `🎉 تهانينا! لقد حصلت على ${reward} دج من صندوق الهدايا باستخدام فرصة الإحالة!`
            });

        } else {
            // Option 2: Daily Free Claim (once every 24h, requires Telegram)
            const claim = await getMysteryBoxClaim(userId);

            if (!claim || !claim.is_telegram_verified || !claim.telegram_user_id) {
                return res.status(400).json({ success: false, error: 'يجب الانضمام لقناة التلغرام والتحقق أولاً' });
            }

            // Verify live channel subscription status every time they claim
            const rawBotToken = (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '7691722011:AAFcsFzRtiSPwmi1UoL6n3yDl0tl_v09Qbs').trim();
            const cleanBotToken = rawBotToken.replace(/^bot/i, '').replace(/[<> "'`]/g, '').trim();

            let rawChannel = (process.env.TELEGRAM_CHANNEL || '@zoomdz1').trim();
            rawChannel = rawChannel.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').replace(/[<> "'`]/g, '').trim();
            let channelId = rawChannel.startsWith('-') ? rawChannel : `@${rawChannel}`;

            if (cleanBotToken && claim.telegram_user_id) {
                try {
                    const tgUrl = `https://api.telegram.org/bot${cleanBotToken}/getChatMember`;
                    const numericUserId = parseInt(claim.telegram_user_id, 10);

                    const tgRes = await axios.get(tgUrl, {
                        params: {
                            chat_id: channelId,
                            user_id: numericUserId
                        },
                        timeout: 5000
                    });

                    const memberResult = tgRes.data?.result;
                    const memberStatus = memberResult?.status;
                    const isMember = memberResult?.is_member;

                    const isSubscribed = ['creator', 'administrator', 'member'].includes(memberStatus) || (memberStatus === 'restricted' && isMember === true);
                    if (!isSubscribed) {
                        // Mark as unverified so they must verify or join again
                        await saveMysteryBoxClaim(userId, false, claim.last_claimed_at, claim.telegram_username, claim.telegram_user_id);
                        return res.status(400).json({ success: false, error: 'عذراً، لقد قمت بإلغاء اشتراكك في القناة! يرجى إعادة الانضمام والتحقق لتتمكن من الحصول على المكافأة اليومية.' });
                    }
                } catch (tgErr) {
                    console.warn('[Telegram Verification in Claim Error]:', tgErr.message);
                    const desc = tgErr.response?.data?.description || '';
                    if (desc.includes('USER_NOT_PARTICIPANT') || desc.includes('user not found') || desc.includes('left')) {
                        await saveMysteryBoxClaim(userId, false, claim.last_claimed_at, claim.telegram_username, claim.telegram_user_id);
                        return res.status(400).json({ success: false, error: 'عذراً، يجب أن تكون مشتركاً في قناة المنصة أولاً للحصول على المكافأة اليومية.' });
                    }
                }
            }

            if (claim.last_claimed_at) {
                const lastClaimed = new Date(claim.last_claimed_at);
                const now = new Date();
                const diffHours = (now - lastClaimed) / (1000 * 60 * 60);

                if (diffHours < 24) {
                    const remainingHours = Math.ceil(24 - diffHours);
                    return res.status(400).json({ success: false, error: `يمكنك فتح الصندوق مرة كل 24 ساعة. المتبقي: ${remainingHours} ساعة` });
                }
            }

            // Weighted reward between 10 and 50 DZD (Biased heavily towards 10 and 20 to protect platform economy)
            const randVal = Math.random() * 100;
            let reward = 10;
            if (randVal < 60) {
                // 60% chance: 10 to 15 DZD
                reward = Math.floor(Math.random() * (15 - 10 + 1)) + 10;
            } else if (randVal < 85) {
                // 25% chance: 16 to 25 DZD (centered around 20 DZD)
                reward = Math.floor(Math.random() * (25 - 16 + 1)) + 16;
            } else if (randVal < 95) {
                // 10% chance: 26 to 40 DZD
                reward = Math.floor(Math.random() * (40 - 26 + 1)) + 26;
            } else {
                // 5% chance: 41 to 50 DZD
                reward = Math.floor(Math.random() * (50 - 41 + 1)) + 41;
            }

            const now = new Date().toISOString();
            await saveMysteryBoxClaim(userId, true, now);

            // Fetch current student balance
            const student = await getOne('students', 'id', userId);
            if (student) {
                updatedBalance = (parseFloat(student.wallet_balance) || 0) + reward;
                await supabase.from('students').update({ wallet_balance: updatedBalance }).eq('id', userId);
                chancesLeft = student.gift_box_chances || 0;

                // Log transaction
                await supabase.from('wallet_transactions').insert({
                    student_id: userId,
                    amount: reward,
                    type: 'gift_reward',
                    status: 'completed',
                    description: `مكافأة صندوق الهدايا اليومي - ${reward} دج`,
                    created_at: new Date().toISOString()
                });

                // Log referral reward
                await supabase.from('referral_rewards').insert({
                    student_id: userId,
                    amount: reward,
                    type: 'gift_box_reward',
                    description: `صندوق هدايا يومي - ${reward} دج`,
                    created_at: new Date().toISOString()
                });
            } else {
                const teacher = await getOne('teachers', 'id', userId);
                if (teacher) {
                    updatedBalance = (parseFloat(teacher.balance) || 0) + reward;
                    await supabase.from('teachers').update({ balance: updatedBalance }).eq('id', userId);
                }
            }

            return res.json({
                success: true,
                reward: reward,
                new_balance: updatedBalance,
                chances: chancesLeft,
                message: `🎉 تهانينا! لقد حصلت على ${reward} دج من صندوق الهدايا اليومي!`
            });
        }
    } catch (e) {
        console.error('Mystery box claim error:', e);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء فتح صندوق الهدايا' });
    }
});

// مراقبة وتسجيل أخطاء طلبات الصور والملفات المرفوعة محلياً
app.use('/uploads', (req, res, next) => {
    const targetPath = path.join(__dirname, 'public/uploads', req.path);
    console.log(`[IMAGE REQ] Local upload request: /uploads${req.path}`);
    if (!fs.existsSync(targetPath)) {
        console.error(`[IMAGE LOG ERROR] Local file not found on disk: /uploads${req.path} (Full path: ${targetPath})`);
    }
    next();
});

// ============================================================
// ✅ مسارات سيو (SEO Routes) المتكاملة للأرشفة وجلب الزوار
// ============================================================

// دالة لتنظيف وتنسيق النصوص في Meta tags
function cleanMetaText(text) {
    if (!text) return '';
    return text.toString()
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, ' ')
        .trim()
        .substring(0, 160);
}

// دالة استبدال آمنة لمنع مشاكل علامة الدولار ($) في replace
function safeReplaceAll(html, placeholder, value) {
    return html.split(placeholder).join(value || '');
}

// 1. مسار الأستاذ الديناميكي (SEO + Auto-load)
app.get(['/teacher/:id', '/teacher-profile.html'], async (req, res, next) => {
    try {
        const teacherId = parseInt(req.params.id || req.query.id || req.query.teacherId);
        if (!teacherId || isNaN(teacherId)) {
            if (req.path.endsWith('/teacher-profile.html')) {
                return res.sendFile(path.join(__dirname, 'public', 'teacher-profile.html'));
            }
            return next();
        }

        const { data: teacher, error } = await supabase
            .from('teachers')
            .select('*')
            .eq('id', teacherId)
            .single();

        if (error || !teacher || teacher.status !== 'approved' || teacher.is_banned) {
            if (req.path.endsWith('/teacher-profile.html')) {
                return res.sendFile(path.join(__dirname, 'public', 'teacher-profile.html'));
            }
            return res.redirect('/');
        }

        const filePath = path.join(__dirname, 'public', 'teacher-profile.html');
        if (!fs.existsSync(filePath)) {
            return res.redirect('/');
        }
        
        let html = await fs.promises.readFile(filePath, 'utf8');

        const name = teacher.full_name || 'أستاذ متميز';
        const spec = teacher.specialization || 'دروس خصوصية';
        const title = `${name} - أستاذ ${spec} على منصة ZoomDz`;
        const bioClean = cleanMetaText(teacher.bio || `تصفح الملف الشخصي للأستاذ ${name}، أستاذ متخصص في ${spec} على منصة ZoomDz للتعليم عن بعد في الجزائر. سجل لمتابعة الدروس والبث المباشر.`);
        const keywords = `${name}, أستاذ ${spec}, دروس خصوصية, بكالوريا الجزائر, متوسط, ZoomDz, بث مباشر`;
        const url = `https://zoomdz.com/teacher/${teacherId}`;
        const imageUrl = teacher.profile_url || `https://zoomdz.com/images/zoomdz.png`;

        html = html.replace(/<title>.*?<\/title>/gi, `<title>${title}</title>`);
        html = html.replace(/<meta\s+name="description"\s+content=".*?">/gi, `<meta name="description" content="${bioClean}">`);
        html = html.replace(/<meta\s+name="keywords"\s+content=".*?">/gi, `<meta name="keywords" content="${keywords}">`);
        
        // Use split/join to be super safe with links and image URLs
        html = safeReplaceAll(html, 'https://zoomdz.com/images/zoomdz.jpg', imageUrl);
        html = safeReplaceAll(html, 'https://zoomdz.com/', url);

        // Inject FORCE_TEACHER_ID
        const injectScript = `<script>window.FORCE_TEACHER_ID = ${teacherId};</script>`;
        html = html.replace('</head>', `${injectScript}\n</head>`);

        res.setHeader('X-Robots-Tag', 'index, follow, max-image-preview:large');
        return res.send(html);
    } catch (err) {
        console.error('SEO Teacher Route Error:', err);
        if (req.path.endsWith('/teacher-profile.html')) {
            return res.sendFile(path.join(__dirname, 'public', 'teacher-profile.html'));
        }
        return res.redirect('/');
    }
});

// 2. مسار الدورة الديناميكي (SEO Course template)
app.get('/course/:id', async (req, res) => {
    try {
        const courseId = parseInt(req.params.id);
        if (!courseId || isNaN(courseId)) {
            return res.redirect('/');
        }

        const viewResult = await recordUniqueView('courses', 'id', courseId, req, 'course');

        const { data: course, error } = await supabase
            .from('courses')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_image, profile_url, bio)')
            .eq('id', courseId)
            .single();

        if (error || !course || course.status !== 'published') {
            return res.redirect('/');
        }

        const filePath = path.join(__dirname, 'public', 'course-seo.html');
        if (!fs.existsSync(filePath)) {
            return res.redirect('/');
        }

        let html = await fs.promises.readFile(filePath, 'utf8');

        const teacherName = course.teachers?.full_name || 'أستاذ متميز';
        const teacherSpec = course.teachers?.specialization || 'دروس خصوصية';
        const courseTitle = course.title || 'دورة تعليمية جديدة';
        const courseDesc = course.description || `انضم إلى هذه الدورة المميزة بعنوان "${courseTitle}" مع الأستاذ ${teacherName} على منصة ZoomDz للتعليم عن بعد في الجزائر.`;
        const courseDescRaw = cleanMetaText(courseDesc);
        const courseUrl = `https://zoomdz.com/course/${courseId}`;
        const teacherImage = course.teachers?.profile_url || `https://zoomdz.com/images/zoomdz.png`;
        const courseImage = course.thumbnail_url || course.image_url || teacherImage;
        
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
            'other': 'مستوى آخر'
        };
        const levelText = levelMap[course.education_level] || course.education_level || 'جميع المستويات';
        
        let priceText = 'مجانية بالكامل';
        let priceClass = 'free';
        if (course.price && course.price > 0) {
            priceText = `سعر الدورة: ${course.price} دج`;
            priceClass = 'paid';
        }

        const dateText = course.created_at ? new Date(course.created_at).toLocaleDateString('ar-DZ') : 'حديثاً';

        html = safeReplaceAll(html, '{{COURSE_TITLE}}', courseTitle);
        html = safeReplaceAll(html, '{{COURSE_DESCRIPTION}}', courseDescRaw);
        html = safeReplaceAll(html, '{{COURSE_DESCRIPTION_RAW}}', courseDescRaw);
        html = safeReplaceAll(html, '{{COURSE_DESCRIPTION_HTML}}', courseDesc.replace(/\n/g, '<br>'));
        html = safeReplaceAll(html, '{{COURSE_URL}}', courseUrl);
        html = safeReplaceAll(html, '{{TEACHER_NAME}}', teacherName);
        html = safeReplaceAll(html, '{{TEACHER_SPECIALIZATION}}', teacherSpec);
        html = safeReplaceAll(html, '{{COURSE_IMAGE}}', courseImage);
        html = safeReplaceAll(html, '{{TEACHER_IMAGE}}', teacherImage);
        html = safeReplaceAll(html, '{{TEACHER_BIO}}', course.teachers?.bio || 'أستاذ معتمد ومتميز على منصة ZoomDz للتعليم عن بعد.');
        html = safeReplaceAll(html, '{{COURSE_LEVEL}}', levelText);
        html = safeReplaceAll(html, '{{COURSE_PRICE}}', course.price || '0');
        html = safeReplaceAll(html, '{{COURSE_PRICE_TEXT}}', priceText);
        html = safeReplaceAll(html, '{{PRICE_CLASS}}', priceClass);
        html = safeReplaceAll(html, '{{COURSE_DATE}}', dateText);

        res.setHeader('X-Robots-Tag', 'index, follow, max-image-preview:large');
        return res.send(html);
    } catch (err) {
        console.error('SEO Course Route Error:', err);
        return res.redirect('/');
    }
});

// ============================================================
// نظام تتبع المشاهدات الفريد (مرة كل 24 ساعة لكل مستخدم/IP مع استثناء صاحب المحتوى)
// ============================================================

// مسارات API لتسجيل المشاهدات الفريدة
app.post('/api/offers/:id/view', async (req, res) => {
    try {
        const offerId = parseInt(req.params.id);
        if (!offerId || isNaN(offerId)) {
            return res.status(400).json({ success: false, error: 'معرف الدرس غير صالح' });
        }
        const result = await recordUniqueView('offers', 'id', offerId, req, 'offer');
        if (!result) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }
        res.json({ success: true, counted: result.counted, views: result.views });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/course/:id/view', async (req, res) => {
    try {
        const courseId = parseInt(req.params.id);
        if (!courseId || isNaN(courseId)) {
            return res.status(400).json({ success: false, error: 'معرف الدورة غير صالح' });
        }
        const result = await recordUniqueView('courses', 'id', courseId, req, 'course');
        if (!result) {
            return res.status(404).json({ success: false, error: 'الدورة غير موجودة' });
        }
        res.json({ success: true, counted: result.counted, views: result.views });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2b. مسار الدرس/العرض الديناميكي (SEO Offer/Lesson template)
app.get(['/offer/:id', '/offers/:id', '/lesson/:id', '/lessons/:id'], async (req, res) => {
    try {
        const offerId = parseInt(req.params.id);
        if (!offerId || isNaN(offerId)) {
            return res.redirect('/');
        }

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.socket.remoteAddress || '127.0.0.1';
        const viewResult = await recordUniqueView('offers', 'id', offerId, req, 'offer');

        const { data: offer, error } = await supabase
            .from('offers')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_image, profile_url, bio)')
            .eq('id', offerId)
            .single();

        if (error || !offer) {
            return res.redirect('/');
        }

        const filePath = path.join(__dirname, 'public', 'offer-seo.html');
        let html = '';
        if (fs.existsSync(filePath)) {
            html = await fs.promises.readFile(filePath, 'utf8');
        } else {
            const fallbackPath = path.join(__dirname, 'public', 'course-seo.html');
            if (fs.existsSync(fallbackPath)) {
                html = await fs.promises.readFile(fallbackPath, 'utf8');
            } else {
                return res.redirect('/');
            }
        }

        const protocol = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
        const host = req.headers['x-forwarded-host'] || req.get('host') || 'zoomdz.com';
        const baseUrl = `${protocol}://${host}`;

        const teacherName = offer.teachers?.full_name || 'أستاذ متميز';
        const teacherSpec = offer.teachers?.specialization || 'دروس خصوصية';
        const lessonTitle = offer.subject_name || 'درس تعليمي جديد';
        const levelText = offer.education_level || 'جميع المستويات';
        const lessonDesc = `احضر درس خصوصي مباشر أونلاين بعنوان "${lessonTitle}" (${teacherSpec}) مع الأستاذ ${teacherName} للمستوى ${levelText} على منصة ZoomDz.`;
        const lessonDescRaw = cleanMetaText(lessonDesc);
        const lessonUrl = `${baseUrl}/offer/${offerId}`;

        let rawTeacherImg = offer.teachers?.profile_url || offer.teachers?.profile_image;
        if (rawTeacherImg && !rawTeacherImg.startsWith('http://') && !rawTeacherImg.startsWith('https://')) {
            if (!rawTeacherImg.startsWith('/')) rawTeacherImg = '/' + rawTeacherImg;
            rawTeacherImg = baseUrl + rawTeacherImg;
        }
        if (!rawTeacherImg) rawTeacherImg = `${baseUrl}/images/zoomdz.png`;

        let rawLessonImg = offer.thumbnail_url || offer.image_url || offer.thumbnail || offer.cover_image;
        if (rawLessonImg && !rawLessonImg.startsWith('http://') && !rawLessonImg.startsWith('https://')) {
            if (!rawLessonImg.startsWith('/')) rawLessonImg = '/' + rawLessonImg;
            rawLessonImg = baseUrl + rawLessonImg;
        }

        const lessonImage = rawLessonImg || rawTeacherImg;
        const teacherImage = rawTeacherImg;

        const isFreeOffer = (offer.is_free === true || offer.is_free === 'true' || offer.is_free === 1) && parseFloat(offer.price || 0) === 0;
        let priceText = isFreeOffer ? 'مجاني بالكامل' : `سعر الدرس: ${offer.price} دج`;
        let priceClass = isFreeOffer ? 'free' : 'paid';

        const dateText = offer.offer_date ? new Date(offer.offer_date).toLocaleDateString('ar-DZ') : 'حديثاً';
        const exactTimeText = offer.offer_date ? new Date(offer.offer_date).toLocaleString('ar-DZ', { dateStyle: 'full', timeStyle: 'short' }) : 'قريباً';
        const viewsCount = viewResult ? viewResult.views : (offer.views_count || offer.views || 0);

        html = safeReplaceAll(html, '{{COURSE_TITLE}}', lessonTitle);
        html = safeReplaceAll(html, '{{LESSON_TITLE}}', lessonTitle);
        html = safeReplaceAll(html, '{{COURSE_DESCRIPTION}}', lessonDescRaw);
        html = safeReplaceAll(html, '{{COURSE_DESCRIPTION_RAW}}', lessonDescRaw);
        html = safeReplaceAll(html, '{{COURSE_DESCRIPTION_HTML}}', lessonDesc);
        html = safeReplaceAll(html, '{{COURSE_URL}}', lessonUrl);
        html = safeReplaceAll(html, '{{TEACHER_NAME}}', teacherName);
        html = safeReplaceAll(html, '{{TEACHER_SPECIALIZATION}}', teacherSpec);
        html = safeReplaceAll(html, '{{COURSE_IMAGE}}', lessonImage);
        html = safeReplaceAll(html, '{{LESSON_IMAGE}}', lessonImage);
        html = safeReplaceAll(html, '{{TEACHER_IMAGE}}', teacherImage);
        html = safeReplaceAll(html, '{{TEACHER_BIO}}', offer.teachers?.bio || 'أستاذ معتمد ومتميز على منصة ZoomDz للتعليم عن بعد.');
        html = safeReplaceAll(html, '{{COURSE_LEVEL}}', levelText);
        html = safeReplaceAll(html, '{{COURSE_PRICE}}', offer.price || '0');
        html = safeReplaceAll(html, '{{COURSE_PRICE_TEXT}}', priceText);
        html = safeReplaceAll(html, '{{PRICE_CLASS}}', priceClass);
        html = safeReplaceAll(html, '{{COURSE_DATE}}', dateText);
        html = safeReplaceAll(html, '{{LESSON_EXACT_TIME}}', exactTimeText);
        html = safeReplaceAll(html, '{{LESSON_VIEWS}}', viewsCount);
        html = safeReplaceAll(html, '{{OFFER_ID}}', offerId);

        res.setHeader('X-Robots-Tag', 'index, follow, max-image-preview:large');
        return res.send(html);
    } catch (err) {
        console.error('SEO Lesson Route Error:', err);
        return res.redirect('/');
    }
});

// 3. مسار المنشور الديناميكي (SEO Post template)
app.post('/api/post/:id/view', async (req, res) => {
    try {
        const postId = parseInt(req.params.id);
        if (!postId || isNaN(postId)) {
            return res.status(400).json({ success: false, error: 'معرف المنشور غير صالح' });
        }
        const result = await recordUniqueView('posts', 'id', postId, req, 'post');
        if (!result) {
            return res.status(404).json({ success: false, error: 'المنشور غير موجود' });
        }
        res.json({ success: true, counted: result.counted, views: result.views });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/post/:id', async (req, res) => {
    try {
        const postId = parseInt(req.params.id);
        if (!postId || isNaN(postId)) {
            return res.redirect('/');
        }

        const viewResult = await recordUniqueView('posts', 'id', postId, req, 'post');

        const { data: post, error } = await supabase
            .from('posts')
            .select('*, teachers:teacher_id (id, full_name, specialization, profile_image, profile_url, bio)')
            .eq('id', postId)
            .single();

        if (error || !post) {
            return res.redirect('/student-dashboard.html?section=posts');
        }

        const filePath = path.join(__dirname, 'public', 'post-seo.html');
        if (!fs.existsSync(filePath)) {
            return res.redirect(`/student-dashboard.html?post=${postId}`);
        }

        let html = await fs.promises.readFile(filePath, 'utf8');

        const protocol = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
        const host = req.headers['x-forwarded-host'] || req.get('host') || 'zoomdz.com';
        const baseUrl = `${protocol}://${host}`;

        const teacherName = post.teachers?.full_name || 'أستاذ متميز';
        const teacherSpec = post.teachers?.specialization || 'دروس خصوصية';
        const postTitle = post.title || post.subject || 'منشور تعليمي جديد';
        const postContent = post.content || post.body || '';
        const postDescRaw = cleanMetaText(postContent || postTitle);
        const postUrl = `${baseUrl}/post/${postId}`;

        let rawTeacherImg = post.teachers?.profile_url || post.teachers?.profile_image;
        if (rawTeacherImg && !rawTeacherImg.startsWith('http://') && !rawTeacherImg.startsWith('https://')) {
            if (!rawTeacherImg.startsWith('/')) rawTeacherImg = '/' + rawTeacherImg;
            rawTeacherImg = baseUrl + rawTeacherImg;
        }
        if (!rawTeacherImg) rawTeacherImg = `${baseUrl}/images/zoomdz.png`;

        const dateText = post.created_at ? new Date(post.created_at).toLocaleDateString('ar-DZ') : 'حديثاً';
        const dateIso = post.created_at ? new Date(post.created_at).toISOString() : new Date().toISOString();
        const viewsCount = viewResult ? viewResult.views : (post.views_count || post.views || 0);

        let attachmentsHtml = '';
        if (post.attachment_url || post.file_url) {
            const fileUrl = post.attachment_url || post.file_url;
            const fileName = post.attachment_name || 'ملف مرفق للتحميل';
            attachmentsHtml = `
                <div style="margin: 20px 0; padding: 15px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;">
                    <h3 style="font-size: 1rem; color: #1e293b; margin-bottom: 10px;"><i class="fas fa-paperclip" style="color: #1e40af;"></i> الملفات المرفقة:</h3>
                    <a href="${fileUrl}" target="_blank" download class="attachment-link" style="display: inline-flex; align-items: center; gap: 8px; text-decoration: none; padding: 8px 16px; background: #eff6ff; color: #1e40af; border-radius: 8px; font-weight: 700; border: 1px solid #bfdbfe;">
                        <i class="fas fa-download"></i> ${escapeHtml(fileName)}
                    </a>
                </div>
            `;
        }

        html = safeReplaceAll(html, '{{POST_TITLE}}', postTitle);
        html = safeReplaceAll(html, '{{POST_DESCRIPTION}}', postDescRaw);
        html = safeReplaceAll(html, '{{POST_DESCRIPTION_RAW}}', postDescRaw);
        html = safeReplaceAll(html, '{{POST_CONTENT_HTML}}', postContent.replace(/\n/g, '<br>'));
        html = safeReplaceAll(html, '{{POST_ATTACHMENTS_HTML}}', attachmentsHtml);
        html = safeReplaceAll(html, '{{POST_URL}}', postUrl);
        html = safeReplaceAll(html, '{{TEACHER_NAME}}', teacherName);
        html = safeReplaceAll(html, '{{TEACHER_SPECIALIZATION}}', teacherSpec);
        html = safeReplaceAll(html, '{{TEACHER_IMAGE}}', rawTeacherImg);
        html = safeReplaceAll(html, '{{POST_DATE}}', dateText);
        html = safeReplaceAll(html, '{{POST_DATE_ISO}}', dateIso);
        html = safeReplaceAll(html, '{{POST_VIEWS}}', viewsCount);

        res.setHeader('X-Robots-Tag', 'index, follow, max-image-preview:large');
        return res.send(html);
    } catch (err) {
        console.error('SEO Post Route Error:', err);
        return res.redirect('/student-dashboard.html?section=posts');
    }
});

// تقديم robots.txt مع الترويسات الصحيحة محركات البحث
app.get(['/robots.txt', '/public/robots.txt'], (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

// 4. خريطة الموقع الديناميكية (Dynamic Sitemap)
app.get(['/sitemap.xml', '/public/sitemap.xml'], async (req, res) => {
    try {
        const lastmod = new Date().toISOString().split('T')[0];
        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://zoomdz.com/</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://zoomdz.com/docs.html</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://zoomdz.com/blog</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://zoomdz.com/privacy-policy.html</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>https://zoomdz.com/terms.html</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>`;

        // Fetch teachers
        const { data: teachers } = await supabase
            .from('teachers')
            .select('id')
            .eq('status', 'approved')
            .eq('is_banned', false);

        if (teachers && teachers.length > 0) {
            teachers.forEach(t => {
                xml += `
  <url>
    <loc>https://zoomdz.com/teacher/${t.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
            });
        }

        // Fetch courses
        const { data: courses } = await supabase
            .from('courses')
            .select('id')
            .eq('status', 'published');

        if (courses && courses.length > 0) {
            courses.forEach(c => {
                xml += `
  <url>
    <loc>https://zoomdz.com/course/${c.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
            });
        }

        // Fetch offers / lessons
        const { data: offers } = await supabase
            .from('offers')
            .select('id');

        if (offers && offers.length > 0) {
            offers.forEach(o => {
                xml += `
  <url>
    <loc>https://zoomdz.com/offer/${o.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`;
            });
        }

        // Fetch posts
        const { data: posts } = await supabase
            .from('posts')
            .select('id');

        if (posts && posts.length > 0) {
            posts.forEach(p => {
                xml += `
  <url>
    <loc>https://zoomdz.com/post/${p.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`;
            });
        }

        // Fetch blog articles (SEO enhancement)
        const { data: blogs } = await supabase
            .from('blogs')
            .select('slug');

        if (blogs && blogs.length > 0) {
            blogs.forEach(b => {
                if (b.slug) {
                    xml += `
  <url>
    <loc>https://zoomdz.com/blog/${encodeURIComponent(b.slug)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
                }
            });
        }

        xml += '\n</urlset>';
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(xml);
    } catch (err) {
        console.error('Error generating dynamic sitemap:', err);
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
    }
});

// تقديم config.js ديناميكياً لتجنب خطأ النظام القابل للقراءة فقط (EROFS: read-only file system)
app.get('/config.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`window.RECAPTCHA_SITE_KEY = ${JSON.stringify(recaptchaSiteKey || '')};\nwindow.API_BASE_URL = ${JSON.stringify(process.env.API_BASE_URL || '')};\n`);
});

// ملفات ثابتة لتطبيق الهاتف (React Frontend) تحت مسار /app
const getAppIndexContent = async () => {
    const possiblePaths = [
        path.join(process.cwd(), 'index.html'),
        path.join(__dirname, 'index.html'),
        path.join(process.cwd(), 'dist', 'index.html'),
        path.join(__dirname, 'dist', 'index.html'),
        path.join(process.cwd(), 'public', 'app.html'),
        path.join(__dirname, 'public', 'app.html'),
        path.join(process.cwd(), 'public', 'index.html'),
        path.join(__dirname, 'public', 'index.html')
    ];
    for (const filePath of possiblePaths) {
        if (filePath && fs.existsSync(filePath)) {
            try {
                return await fs.promises.readFile(filePath, 'utf-8');
            } catch (e) {}
        }
    }
    return '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>تطبيق المنصة</title></head><body><div id="root"></div></body></html>';
};

const sendAppIndexFile = async (req, res, next) => {
    const possiblePaths = [
        path.join(process.cwd(), 'dist', 'index.html'),
        path.join(__dirname, 'dist', 'index.html'),
        path.join(__dirname, 'index.html'),
        path.join(process.cwd(), 'index.html'),
        path.join(process.cwd(), 'public', 'app.html'),
        path.join(__dirname, 'public', 'app.html'),
        path.join(process.cwd(), 'public', 'index.html'),
        path.join(__dirname, 'public', 'index.html')
    ];

    for (const filePath of possiblePaths) {
        if (filePath && fs.existsSync(filePath)) {
            return res.sendFile(filePath, (err) => {
                if (err && !res.headersSent) {
                    console.error(`⚠️ Error sending file ${filePath}:`, err.message);
                    if (next) next(err);
                }
            });
        }
    }

    return res.status(200).send(await getAppIndexContent());
};

if (process.env.NODE_ENV !== 'production') {
    let vitePromise = null;
    const getVite = () => {
        if (!vitePromise) {
            vitePromise = import('vite').then(({ createServer }) => 
                createServer({
                    server: { middlewareMode: true },
                    appType: 'custom',
                    base: '/app/'
                })
            );
        }
        return vitePromise;
    };

    app.use('/app', async (req, res, next) => {
        try {
            const vite = await getVite();
            vite.middlewares(req, res, next);
        } catch (err) {
            next(err);
        }
    });

    const handleViteAppRequest = async (req, res, next) => {
        try {
            const vite = await getVite();
            const html = await getAppIndexContent();
            const transformedHtml = await vite.transformIndexHtml(req.originalUrl, html);
            res.status(200).set({ 'Content-Type': 'text/html' }).end(transformedHtml);
        } catch (err) {
            next(err);
        }
    };

    app.get('/app/*', handleViteAppRequest);
    app.get('/app', handleViteAppRequest);
} else {
    const distPath = path.join(process.cwd(), 'dist');
    const distDirnamePath = path.join(__dirname, 'dist');
    const publicPath = path.join(process.cwd(), 'public');
    const publicDirnamePath = path.join(__dirname, 'public');

    if (fs.existsSync(distPath)) app.use('/app', express.static(distPath));
    if (fs.existsSync(distDirnamePath)) app.use('/app', express.static(distDirnamePath));
    if (fs.existsSync(publicPath)) app.use('/app', express.static(publicPath));
    if (fs.existsSync(publicDirnamePath)) app.use('/app', express.static(publicDirnamePath));

    app.get(['/app', '/app/*'], (req, res, next) => {
        sendAppIndexFile(req, res, next);
    });
}

// مسار توفير مكتبة Agora Web SDK محلياً لمنع مشاكل حجب الشبكات أو الحظر
app.get('/js/agora-rtc-sdk.js', (req, res) => {
    try {
        const sdkPath = path.join(__dirname, 'node_modules', 'agora-rtc-sdk-ng', 'AgoraRTC_N-production.js');
        if (fs.existsSync(sdkPath)) {
            res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
            res.setHeader('Cache-Control', 'public, max-age=604800');
            return res.sendFile(sdkPath);
        }
    } catch (e) {
        logger.warn('تعذر العثور على حزمة agora-rtc-sdk-ng المحلية:', e.message);
    }
    return res.redirect('https://download.agora.io/sdk/release/AgoraRTC_N-4.22.0.js');
});

// وكيل الصور لتجاوز قيود المتصفحات وسياسات CORS/Referrer للصور المستضافة في Supabase أو النطاقات الخارجية
app.get('/api/proxy-image', async (req, res) => {
    try {
        let imageUrl = req.query.url;
        if (!imageUrl) {
            return res.redirect('/images/default-avatar.svg');
        }

        imageUrl = decodeURIComponent(imageUrl).trim();

        // The Android WebView should never request Imgur directly. Normalize all
        // Imgur variants to a direct asset URL before proxying them server-side.
        if (imageUrl.includes('imgur.com') && !imageUrl.includes('i.imgur.com')) {
            const match = imageUrl.match(/(?:imgur\.com|i\.imgur\.com)\/(?:a\/|gallery\/|r\/[a-zA-Z0-9_-]+\/)?([a-zA-Z0-9]+)/i);
            if (match && match[1]) imageUrl = `https://i.imgur.com/${match[1]}.png`;
        }

        // Convert Imgur album / post URL to direct i.imgur.com image URL
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

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Access-Control-Allow-Origin', '*');

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        return res.send(buffer);
    } catch (error) {
        logger.error('[Image Proxy Error]', error.message);
        return res.redirect('/images/default-avatar.svg');
    }
});

// Cache بسيط للواجهات العامة لتقليل الضغط على قاعدة البيانات
app.use('/api/public', cachePublicResponses());

// ============================================================
// CSRF Protection
// ============================================================

const csrfExcludedPaths = [
    '/api/login',
    '/api/student/register',
    '/api/teacher/register',
    '/api/forgot-password',
    '/api/reset-password',
    '/api/verify-reset-token',
    '/api/verify-email',
    '/api/resend-verification',
    '/api/csrf-token',
    '/api/get-csrf-token',
    '/api/public',
    '/api/live-offers',
    '/api/offers',
    '/api/offer',
    '/api/course',
    '/api/post',
    '/api/exercise',
    '/api/exercises',
    '/api/stream',
    '/api/teachers',
    '/api/test-cors',
    '/api/proxy-image',
    '/api/ping',
    '/api/verify-token',
    '/api/refresh-token',
    '/api/student',
    '/api/teacher',
    '/api/booking',
    '/api/messages',
    '/api/notifications',
    '/api/notification',
    '/api/join-stream',
    '/api/teacher-start-stream',
    '/api/teacher-stream',
    '/api/referral',
    '/api/wallet',
    '/api/start-jitsi-stream',
    '/api/join-jitsi',
    '/api/support',
    '/api/reports',
    '/api/logs',
    '/api/subscribe',
    '/api/groups',
    '/api/group',
    '/api/ai'
];

app.use((req, res, next) => {
    const publicMethods = ['GET', 'HEAD', 'OPTIONS'];
    
    // استخدام req.originalUrl بدلاً من req.path لأن req.path لا يحتوي على mount path
    const requestPath = req.originalUrl.split('?')[0]; // إزالة query string
    
    const isAdminPath = requestPath.startsWith('/api/admin');
    
    const isPublicPath = csrfExcludedPaths.some(path => {
        if (requestPath === path) return true;
        if (requestPath.startsWith(path + '/')) return true;
        return false;
    });
    
    const isPublicMethod = publicMethods.includes(req.method);
    const hasBearerToken = req.headers.authorization && req.headers.authorization.startsWith('Bearer ');
    
    if (isAdminPath || isPublicPath || isPublicMethod || hasBearerToken) {
        return next();
    }
    
    const csrfToken = req.headers['x-csrf-token'];
    const cookieToken = req.cookies.csrf_token;
    
    if (!csrfToken || !cookieToken || csrfToken !== cookieToken) {
        console.log(`❌ CSRF فشل: ${requestPath}`);
        return res.status(403).json({ 
            success: false, 
            error: 'طلب غير مصرح به (CSRF)',
            code: 'CSRF_ERROR'
        });
    }
    
    next();
});

// ============================================================
// Rate Limiting - Disabled to prevent "Too many requests" errors completely
// ============================================================

const authLimiter = (req, res, next) => next();
const apiLimiter = (req, res, next) => next();

app.use('/api', apiLimiter);

// ============================================================
// CSRF Token Generator
// ============================================================

app.get('/api/csrf-token', (req, res) => {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie('csrf_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 3600000
    });
    res.json({ csrfToken: token });
});

app.get('/api/get-csrf-token', authenticate, (req, res) => {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie('csrf_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 3600000
    });
    res.json({ csrfToken: token });
});

// ============================================================
// API Logs (للوحة الأدمن)
// ============================================================

app.get('/api/logs/stats', authenticate, authorize(['admin', 'teacher']), (req, res) => {
    const stats = logger.getLogStats();
    res.json({ success: true, stats });
});

app.get('/api/logs/errors', authenticate, authorize(['admin', 'teacher']), (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const errors = logger.getRecentErrors(limit);
    res.json({ success: true, errors });
});

app.get('/api/logs/all', authenticate, authorize(['admin', 'teacher']), (req, res) => {
    const type = req.query.type || 'all';
    const limit = parseInt(req.query.limit) || 100;
    const logs = logger.getLogs(type, limit);
    res.json({ success: true, logs });
});

// ============================================================
// ✅ نظام البث المباشر باستخدام Jitsi Meet
// ============================================================

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// ✅ بدء البث باستخدام Jitsi Meet
// ============================================================

// ============================================================
// ✅ Agora.io Token Generation
// ============================================================

function generateAgoraToken(channelName, role, uid) {
    const appId = (process.env.AGORA_APP_ID && process.env.AGORA_APP_ID.trim()) || 'a5571809de0c4678bb4b134adfdc48a3';
    const appCertificate = (process.env.AGORA_APP_CERTIFICATE && process.env.AGORA_APP_CERTIFICATE.trim()) || '427a98bf5bff4725aafb826042bb2f0e';
    if (!appId || !channelName) return null;
    try {
        const expireTime = 3600 * 24; // 24 hours
        const currentTime = Math.floor(Date.now() / 1000);
        const privilegeExpiredTs = currentTime + expireTime;
        const roleValue = role === 'teacher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
        if (appCertificate && appCertificate !== 'agora_app_certificate_default' && appCertificate.length > 5) {
            return RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, channelName, Number(uid) || 0, roleValue, privilegeExpiredTs);
        }
        return null;
    } catch (err) {
        console.error('Error generating Agora token:', err);
        return null;
    }
}

// ============================================================
// ✅ بدء البث باستخدام Zoom Video SDK
// ============================================================

const handleStartZoomStream = async (req, res) => {
    try {
        const errors = require('express-validator').validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id } = req.body;
        
        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'الدرس غير موجود' });
        }
        
        // ✅ التحقق من ملكية الدرس ومنع الأستاذ الزائر
        if (req.user.userId === -1 || req.user.userId === '-1' || req.user.is_guest || offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك ببدء البث لهذا الدرس' });
        }

        // ✅ تم إلغاء قيود الوقت للأستاذ لفتح البث متى شاء دون أي شروط زمنية

        
        let roomName = offer.room_name;
        let password = offer.room_password;

        if (!roomName) {
            const randomSuffix = crypto.randomBytes(8).toString('hex');
            roomName = `zoomdz_session_${offer_id}_${randomSuffix}`;
            password = crypto.randomBytes(4).toString('hex').toUpperCase();
        }
        
        const teacher = await getOne('teachers', 'id', req.user.userId);
        const teacherName = teacher ? teacher.full_name : 'الأستاذ';
        const agoraUid = Math.floor(Math.random() * 100000) + 1;
        const agoraToken = generateAgoraToken(roomName, 'teacher', agoraUid);
        const roomUrl = `/api/teacher-agora/${offer_id}`;

        await supabase
            .from('offers')
            .update({
                stream_url: roomUrl,
                stream_platform: 'agora',
                status: 'live',
                is_paused: false,
], handleStartZoomStream);

app.post('/api/start-jitsi-stream', authenticate, authorize(['teacher']), [
    require('express-validator').body('offer_id').isInt().withMessage('معرف الدرس غير صالح')
], handleStartZoomStream);

app.post('/api/start-zoom-stream', authenticate, authorize(['teacher']), [
    require('express-validator').body('offer_id').isInt().withMessage('معرف الدرس غير صالح')
], handleStartZoomStream);

// ============================================================
// ✅ التحقق من كلمة مرور Zoom Session
// ============================================================

app.post('/api/verify-agora-password', async (req, res) => {
    try {
        const { room_name, password } = req.body;

        const { data } = await supabase
            .from('offers')
            .select('room_password')
            .eq('room_name', room_name)
            .single();

        if (data && data.room_password === password) {
            res.json({ success: true });
        } else {
            res.json({ success: false, error: 'كلمة المرور غير صحيحة' });
        }
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ صفحة دخول الأستاذ للبث عبر Zoom Video SDK
// ============================================================

const handleTeacherZoomView = async (req, res) => {
    try {
        let token = req.query.token;
        if (!token) {
            return res.send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head>
                    <meta charset="UTF-8">
                    <title>جاري التحقق...</title>
                    <script>
                        document.addEventListener('DOMContentLoaded', () => {
                            const token = localStorage.getItem('token');
                            if (token) {
                                window.location.href = window.location.pathname + '?token=' + token;
                            } else {
                                window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
                            }
                        });
                    </script>
                </head>
                <body style="font-family: Cairo, sans-serif; text-align: center; padding-top: 50px; background: #0b0f19; color: #fff;">
                    <p>جاري التحقق من صلاحية الوصول... يرجى الانتظار</p>
                </body>
                </html>
            `);
        }

        const decoded = verifyToken(token);
        if (!decoded || decoded.role !== 'teacher') {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const offerId = parseInt(req.params.offer_id, 10);
        const teacherId = decoded.userId;
        
        const offer = await getOne('offers', 'id', offerId);
        if (!offer || offer.teacher_id !== teacherId) {
            return res.status(403).send('غير مصرح');
        }
        if (!['live', 'teacher_ready', 'paused'].includes(offer.status)) {
            return res.status(400).send('البث لم يبدأ أو تم إنهاؤه');
        }
        
        const teacher = await getOne('teachers', 'id', teacherId);
        
        // التحقق مما إذا كان قد تم إضافة طلاب لمعرفة متى بدأ البث فعلياً
        const { data: activeStudents } = await supabase
            .from('active_stream')
            .select('added_at, joined_at')
            .eq('offer_id', offerId)
            .limit(1);
        
        const studentsAdded = activeStudents && activeStudents.length > 0;
        let actualStartTime = null;
        if (studentsAdded) {
            const firstStudent = activeStudents[0];
            const timeStr = firstStudent.added_at || firstStudent.joined_at;
            if (timeStr) actualStartTime = new Date(timeStr).getTime();
        }

        // حساب الوقت المتبقي (استرجاع الوقت المحفوظ في قاعدة البيانات أولاً إذا وُجد)
        let savedSeconds = null;
        if (offer.remaining_seconds !== undefined && offer.remaining_seconds !== null && !isNaN(Number(offer.remaining_seconds))) {
            savedSeconds = Number(offer.remaining_seconds);
        } else if (offer.remaining_time !== undefined && offer.remaining_time !== null && !isNaN(Number(offer.remaining_time))) {
            savedSeconds = Number(offer.remaining_time);
        }

        if (savedSeconds !== null) {
            offer.remaining_time = savedSeconds;
        } else if (actualStartTime) {
            const now = new Date().getTime();
            const elapsed = Math.floor((now - actualStartTime) / 1000);
            const duration = (offer.duration_minutes || offer.duration || 60) * 60;
            offer.remaining_time = Math.max(0, duration - elapsed);
        } else {
            offer.remaining_time = (offer.duration_minutes || offer.duration || 60) * 60;
        }
        
        offer.studentsAdded = studentsAdded;
        res.send(generateTeacherZoomPage(offer, teacher, token));
    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.status(500).send('حدث خطأ');
    }
};

app.get('/api/teacher-agora/:offer_id', handleTeacherZoomView);
app.get('/api/teacher-jitsi/:offer_id', handleTeacherZoomView);
app.get('/api/teacher-zoom/:offer_id', handleTeacherZoomView);

function generateTeacherZoomPage(offer, teacher, token) {
    const rawRoomName = (offer.room_name && offer.room_name.trim()) ? offer.room_name.trim() : ('class_offer_' + offer.id);
    const roomName = rawRoomName.replace(/[^a-zA-Z0-9_-]/g, '_') || ('class_offer_' + offer.id);
    const subjectName = offer.subject_name || 'غير محدد';
    const teacherName = teacher && teacher.full_name ? teacher.full_name : 'الأستاذ';
    const passCode = offer.room_password || '';
    const teacherUid = Math.floor(Math.random() * 100000) + 1;
    const appId = (process.env.AGORA_APP_ID && process.env.AGORA_APP_ID.trim()) || 'a5571809de0c4678bb4b134adfdc48a3';
    const agoraToken = generateAgoraToken(roomName, 'teacher', teacherUid);

    return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>بث الأستاذ المباشر - ${escapeHtml(subjectName)}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script src="/js/agora-rtc-sdk.js"></script>
    <script src="https://download.agora.io/sdk/release/AgoraRTC_N-4.22.0.js" onerror="console.warn('Official CDN fallback trigger')"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body, html { width: 100%; height: 100%; background: #0b0f19; font-family: 'Cairo', sans-serif; color: #fff; overflow: hidden; }
        .agora-container { display: flex; flex-direction: column; height: 100vh; width: 100vw; overflow: hidden; }
        
        .header-bar { height: 56px; flex-shrink: 0; background: #111827; border-bottom: 1px solid #1f2937; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; z-index: 10; }
        .header-title { font-size: 16px; font-weight: 700; color: #3b82f6; display: flex; align-items: center; gap: 10px; }
        .badge { background: #ef4444; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 20px; font-weight: 700; }
        
        .main-stage { flex: 1; display: flex; position: relative; background: #030712; min-height: 0; overflow: hidden; }
        .video-area { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; padding: 10px; min-width: 0; height: 100%; overflow: hidden; }
        #mediaContainer { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; position: relative; background: #000; border-radius: 12px; overflow: hidden; }
        #localVideo, #remoteVideo { width: 100%; height: 100%; background: #000; border-radius: 12px; object-fit: contain; }
        
        .chat-sidebar { width: 300px; flex-shrink: 0; background: #111827; border-right: 1px solid #1f2937; display: flex; flex-direction: column; height: 100%; overflow: hidden; }
        .chat-header { padding: 10px 14px; border-bottom: 1px solid #1f2937; font-weight: 700; font-size: 14px; color: #60a5fa; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .chat-messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
        .chat-msg { background: #1f2937; padding: 8px 12px; border-radius: 8px; max-width: 90%; font-size: 13px; word-break: break-word; }
        .chat-msg.sent { background: #1d4ed8; align-self: flex-start; }
        .chat-msg .sender { font-size: 11px; color: #9ca3af; margin-bottom: 3px; font-weight: 700; }
        .chat-input-box { padding: 8px 10px; border-top: 1px solid #1f2937; display: flex; gap: 6px; background: #111827; flex-shrink: 0; }
        .chat-input-box input { flex: 1; background: #1f2937; border: 1px solid #374151; color: #fff; padding: 8px 12px; border-radius: 8px; outline: none; font-family: 'Cairo'; font-size: 13px; }
        .chat-input-box button { background: #2563eb; color: white; border: none; padding: 0 12px; border-radius: 8px; cursor: pointer; font-weight: 700; transition: background 0.2s; }
        .chat-input-box button:hover { background: #1d4ed8; }
        
        .controls-bar { height: 64px; flex-shrink: 0; background: #111827; border-top: 1px solid #1f2937; display: flex; align-items: center; justify-content: center; gap: 14px; padding: 0 15px; z-index: 20; }
        .ctrl-btn { background: #1f2937; border: 1px solid #374151; color: #fff; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 17px; cursor: pointer; transition: all 0.2s; }
        .ctrl-btn:hover { background: #374151; transform: translateY(-2px); }
        .ctrl-btn.active { background: #ef4444; border-color: #f87171; color: #fff; }
        .ctrl-btn.end { background: #dc2626; border-color: #f87171; width: auto; padding: 0 20px; border-radius: 22px; font-weight: 700; font-size: 13px; height: 44px; }
        .ctrl-btn.end:hover { background: #b91c1c; }
        
        .status-overlay { position: absolute; inset: 0; background: rgba(3, 7, 18, 0.95); display: none; flex-direction: column; align-items: center; justify-content: center; gap: 15px; z-index: 30; padding: 20px; text-align: center; overflow-y: auto; max-height: 100%; }
        .spinner { width: 40px; height: 40px; border: 4px solid rgba(255,255,255,0.1); border-top-color: #3b82f6; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        
        @media (max-width: 768px) {
            .header-bar { height: auto; min-height: 40px; flex-wrap: wrap; padding: 4px 8px; gap: 4px; }
            .header-title { font-size: 12px; width: auto; max-width: 50%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            #streamTimerContainer { order: -1; padding: 2px 8px; border-radius: 12px; font-size: 11px; margin-right: auto; }
            #timerRemainingLabel { font-size: 10px; }
            #timerRemaining { font-size: 12px; }
            
            .main-stage { flex-direction: column; overflow: hidden; flex: 1; min-height: 0; }
            .video-area { height: 50vh; max-height: 55vh; flex: none; padding: 2px; position: sticky; top: 0; z-index: 10; width: 100%; }
            #mediaContainer { height: 100%; width: 100%; border-radius: 6px; }
            
            .chat-sidebar { width: 100%; flex: 1; min-height: 0; border-right: none; border-top: 1px solid #1f2937; display: flex; flex-direction: column; overflow: hidden; }
            .chat-messages { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; gap: 6px; font-size: 13px; -webkit-overflow-scrolling: touch; }
            .chat-msg { font-size: 13px; padding: 6px 10px; }
            
            .chat-input-box { padding: 8px 10px; }
            .chat-input-box input { padding: 8px 12px; font-size: 13px; border-radius: 8px; }
            .chat-input-box button { padding: 0 12px; border-radius: 8px; }
            
            .controls-bar { height: auto; min-height: 44px; gap: 6px; padding: 4px 8px; flex-wrap: wrap; }
            .ctrl-btn { width: 36px; height: 36px; font-size: 14px; }
            .ctrl-btn.end { width: auto; height: 32px; border-radius: 6px; font-size: 11px; padding: 0 10px; margin-top: 0; }
            #addStudentsBtn { padding: 4px 8px !important; font-size: 11px !important; height: 32px !important; }
        }

        @keyframes pulseAddBtn {
            0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(124, 58, 237, 0.7); }
            50% { transform: scale(1.05); box-shadow: 0 0 0 10px rgba(124, 58, 237, 0); }
            100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(124, 58, 237, 0); }
        }
        .pulse-add-students {
            animation: pulseAddBtn 1.6s infinite !important;
            background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%) !important;
            border: 1.5px solid #a78bfa !important;
        }

        /* Theater Mode Styles */
        .agora-container.theater-mode .header-bar { display: none !important; }
        .agora-container.theater-mode .chat-sidebar { display: none !important; }
        .agora-container.theater-mode .main-stage { height: calc(100vh - 60px) !important; width: 100vw !important; }
        .agora-container.theater-mode .video-area { width: 100vw !important; height: 100% !important; max-height: 100% !important; padding: 0 !important; position: relative !important; background: #000 !important; }
        .agora-container.theater-mode #mediaContainer { border-radius: 0 !important; width: 100% !important; height: 100% !important; }
        .agora-container.theater-mode .controls-bar { position: fixed !important; bottom: 0 !important; left: 0 !important; right: 0 !important; width: 100vw !important; z-index: 100 !important; background: rgba(17, 24, 39, 0.92) !important; backdrop-filter: blur(8px) !important; border-top: 1px solid rgba(255, 255, 255, 0.1) !important; }
    </style>
</head>
<body>
    <div class="agora-container">
        <div class="header-bar">
            <div class="header-title" style="display: flex; align-items: center; gap: 8px; flex-wrap: nowrap;">
                <i class="fas fa-video"></i>
                <span style="font-size: 14px;">بث الأستاذ: ${escapeHtml(subjectName)}</span>
                <span class="badge" style="font-size: 10px; padding: 1px 6px;">مباشر HD</span>
            </div>
            <div id="liveViewersBadge" style="display: flex; align-items: center; gap: 6px; background: rgba(16, 185, 129, 0.2); border: 1px solid #10b981; color: #34d399; padding: 2px 8px; border-radius: 16px; font-size: 11px; font-weight: 700;">
                <i class="fas fa-users"></i>
                <span id="viewersCount" style="color: #6ee7b7; font-size: 12px; font-weight: 800;">0</span>
            </div>
            <div style="font-size: 12px; color: #9ca3af; display: flex; align-items: center; gap: 4px;">
                <i class="fas fa-user-tie"></i> ${escapeHtml(teacherName)}
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
                <button id="addStudentsBtn" class="pulse-add-students" onclick="addStudentsToStream(${offer.id})" style="color: white; border: none; padding: 4px 10px; border-radius: 8px; font-size: 11px; cursor: pointer; font-weight: 800; position: relative; display: inline-flex; align-items: center; gap: 5px; height: 32px;">
                    <i class="fas fa-hand-pointer" style="font-size: 13px; color: #fef08a;"></i> 👆 انقر هنا لإدخال الطلاب وبدء البث
                    <span id="waitingCountBadge" style="position: absolute; top: -6px; left: -6px; background: #ef4444; color: white; border-radius: 50%; width: 18px; height: 18px; display: none; align-items: center; justify-content: center; font-size: 9px; border: 2px solid #111827;">0</span>
                </button>
                <button onclick="leaveSession()" style="background: #dc2626; color: white; border: none; padding: 4px 8px; border-radius: 6px; font-size: 11px; cursor: pointer; font-weight: bold; display: inline-flex; align-items: center; gap: 4px; transition: background 0.2s; height: 28px;">
                    <i class="fas fa-stop-circle"></i> إنهاء البث
                </button>
            </div>
            <div id="streamTimerContainer" style="display: flex; align-items: center; gap: 6px; background: #1f2937; padding: 3px 10px; border-radius: 16px; border: 1px solid #374151; margin-right: auto;">
                <div id="timerRemainingLabel" style="font-size: 11px; color: #9ca3af;"><i class="fas fa-stopwatch"></i> المتبقي:</div>
                <div id="timerRemaining" style="font-family: monospace; font-size: 13px; font-weight: bold; color: #10b981;">00:00:00</div>
                <div style="display: flex; align-items: center; gap: 5px; margin-right: 4px; padding-right: 6px; border-right: 1px solid #374151;" title="نسبة إكتمال البث المباشر">
                    <div style="width: 45px; height: 5px; background: rgba(255,255,255,0.15); border-radius: 3px; overflow: hidden; position: relative;">
                        <div id="streamProgressBar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #10b981, #3b82f6); transition: width 0.3s ease;"></div>
                    </div>
                    <span id="streamProgressPct" style="font-size: 10px; font-weight: 700; color: #60a5fa; font-family: monospace;">0%</span>
                </div>
            </div>
        </div>
        <div style="width: 100%; height: 3px; background: rgba(255,255,255,0.06); position: relative; z-index: 15;">
            <div id="mainStreamProgressBar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #10b981, #3b82f6); transition: width 0.4s ease;"></div>
        </div>
        <div class="main-stage">
            <div class="video-area">
                <div id="statusOverlay" class="status-overlay">
                    <div class="spinner"></div>
                    <div id="statusText" style="width:100%; max-width:650px; text-align:right;">جاري الاتصال بالسيرفر لبدء البث المباشر...</div>
                </div>
                <div id="mediaContainer">
                    <div id="localVideo"></div>
                </div>

            </div>
            <div class="chat-sidebar">
                <div class="chat-header">
                    <i class="fas fa-comments"></i> الدردشة المباشرة
                </div>
                <div class="chat-messages" id="chatMsgs">
                    <div class="chat-msg">
                        <div class="sender">النظام</div>
                        مرحباً بك في الدردشة المباشرة للحصة!
                    </div>
                </div>
                <div class="chat-input-box">
                    <input type="text" id="chatInput" placeholder="اكتب رسالة للطلاب..." onkeypress="if(event.key==='Enter') sendChatMessage()">
                    <button onclick="sendChatMessage()"><i class="fas fa-paper-plane"></i></button>
                </div>
            </div>
        </div>
        <div class="controls-bar">
            <button class="ctrl-btn" id="micBtn" onclick="toggleMic()" title="كتم/تشغيل الميكروفون">
                <i class="fas fa-microphone"></i>
            </button>
            <button class="ctrl-btn" id="camBtn" onclick="toggleCam()" title="تشغيل/إيقاف الكاميرا">
                <i class="fas fa-video"></i>
            </button>
            <button class="ctrl-btn" id="flipCamBtn" onclick="switchCamera()" title="قلب الكاميرا (التبديل بين الأمامية والخلفية)">
                <i class="fas fa-camera-rotate"></i>
            </button>
            <button class="ctrl-btn" id="theaterBtn" onclick="toggleTheaterMode()" title="وضع المسرح (توسيع الشاشة بالكامل)">
                <i class="fas fa-expand"></i>
            </button>
            <button class="ctrl-btn" id="shareBtn" onclick="toggleShare()" title="مشاركة الشاشة لعرض الدروس والمستندات">
                <i class="fas fa-desktop"></i>
            </button>
            
            <!-- زر التحكم بجودة البث -->
            <div style="position: relative; display: inline-block;">
                <button class="ctrl-btn" id="qualityBtn" onclick="toggleQualityMenu()" title="رفع/تغيير جودة البث" style="width: auto; padding: 0 14px; border-radius: 20px; font-size: 12px; font-weight: 700; gap: 6px; background: #2563eb; border-color: #3b82f6;">
                    <i class="fas fa-sliders-h"></i> <span id="currentQualityLabel">الجودة: 480p SD</span>
                </button>
                <div id="qualityMenu" style="display: none; position: absolute; bottom: 52px; right: 0; background: #1f2937; border: 1px solid #374151; border-radius: 10px; padding: 6px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); z-index: 100; min-width: 160px; text-align: right;">
                    <div style="font-size: 11px; color: #9ca3af; padding: 4px 8px; border-bottom: 1px solid #374151; margin-bottom: 4px; font-weight: 700;">جودة بث الفيديو:</div>
                    <button onclick="changeVideoQuality('1080p_1', '1080p Full HD')" style="width: 100%; text-align: right; background: transparent; border: none; color: #fff; padding: 8px 10px; border-radius: 6px; font-family: Cairo; cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: space-between;">
                        <span>1080p Full HD</span> <i class="fas fa-check quality-check" id="check-1080p_1" style="display:none; color: #10b981;"></i>
                    </button>
                    <button onclick="changeVideoQuality('720p_1', '720p HD')" style="width: 100%; text-align: right; background: transparent; border: none; color: #fff; padding: 8px 10px; border-radius: 6px; font-family: Cairo; cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: space-between;">
                        <span>720p HD</span> <i class="fas fa-check quality-check" id="check-720p_1" style="display:none; color: #10b981;"></i>
                    </button>
                    <button onclick="changeVideoQuality('480p_1', '480p SD')" style="width: 100%; text-align: right; background: transparent; border: none; color: #fff; padding: 8px 10px; border-radius: 6px; font-family: Cairo; cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: space-between;">
                        <span>480p SD</span> <i class="fas fa-check quality-check" id="check-480p_1" style="color: #10b981;"></i>
                    </button>
                    <button onclick="changeVideoQuality('360p_1', '360p اقتصادي')" style="width: 100%; text-align: right; background: transparent; border: none; color: #fff; padding: 8px 10px; border-radius: 6px; font-family: Cairo; cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: space-between;">
                        <span>360p اقتصادي</span> <i class="fas fa-check quality-check" id="check-360p_1" style="display:none; color: #10b981;"></i>
                    </button>
                </div>
            </div>

            <button class="ctrl-btn end" onclick="leaveSession()">
                <i class="fas fa-stop-circle"></i> إنهاء البث المباشر
            </button>
        </div>
    </div>

    <script>
        const APP_ID = "${appId}";
        const channelName = "${escapeHtml(roomName)}";
        const teacherUid = ${teacherUid};
        const agoraToken = "${agoraToken || ''}";
        const userName = ${JSON.stringify(teacherName + ' (الأستاذ)')};
        const authToken = ${JSON.stringify(token)};

        let client = null;
        let localAudioTrack = null;
        let localVideoTrack = null;
        let screenTrack = null;
        let isMicOn = true;
        let isCamOn = true;
        let isSharing = false;

        let streamRemainingSeconds = ${offer.remaining_time || 0};
        let streamTotalSeconds = ${offer.total_time || (offer.duration_minutes ? offer.duration_minutes * 60 : (offer.duration ? offer.duration * 60 : 3600))};
        if (!streamTotalSeconds || streamTotalSeconds <= 0) streamTotalSeconds = 3600;
        if (streamRemainingSeconds > streamTotalSeconds) streamTotalSeconds = streamRemainingSeconds;

        let isTimerPaused = true; // لا يبدأ الموقت تلقائياً حتى يضيف الأستاذ الطلبة
        let streamIntervalId = null;
        let lastSyncTime = Date.now();

        function updateTimerDisplay() {
            const display = document.getElementById('timerRemaining');
            if (display) {
                const hours = Math.floor(streamRemainingSeconds / 3600);
                const minutes = Math.floor((streamRemainingSeconds % 3600) / 60);
                const seconds = streamRemainingSeconds % 60;
                const pad = (num) => String(num).padStart(2, '0');
                display.textContent = pad(hours) + ':' + pad(minutes) + ':' + pad(seconds);
                if (isTimerPaused) {
                    display.style.color = '#f59e0b';
                } else if (streamRemainingSeconds <= 300) {
                    display.style.color = '#ef4444';
                } else {
                    display.style.color = '#10b981';
                }
            }

            // حساب شريط إكتمال البث
            const total = Math.max(1, streamTotalSeconds);
            const elapsed = Math.max(0, total - streamRemainingSeconds);
            const pct = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));

            const pBar1 = document.getElementById('streamProgressBar');
            const pBar2 = document.getElementById('mainStreamProgressBar');
            const pText = document.getElementById('streamProgressPct');

            if (pBar1) pBar1.style.width = pct + '%';
            if (pBar2) pBar2.style.width = pct + '%';
            if (pText) pText.textContent = pct + '%';
        }

        function startTimer() {
            if (streamIntervalId) clearInterval(streamIntervalId);
            streamIntervalId = setInterval(() => {
                if (!isTimerPaused && streamRemainingSeconds > 0) {
                    streamRemainingSeconds--;
                    updateTimerDisplay();

                    // مزامنة تلقائية مع قاعدة البيانات كل 5 ثوانٍ
                    if (Date.now() - lastSyncTime >= 5000) {
                        lastSyncTime = Date.now();
                        syncTimerToBackend(streamRemainingSeconds, false);
                    }
                } else if (streamRemainingSeconds <= 0) {
                    clearInterval(streamIntervalId);
                    isTimerPaused = true;
                    alert('🎉 تهانينا تم اكتمال البث وحصلت على عوائدك');
                    fetch('/api/stream/end/${offer.id}', { method: 'POST', headers: { 'Authorization': 'Bearer ' + authToken } }).catch(()=>{});
                    setTimeout(() => {
                        window.location.href = '/teacher-dashboard.html';
                    }, 1500);
                }
            }, 1000);
        }

        async function syncTimerToBackend(seconds, isPaused = false) {
            try {
                const token = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('token') || authToken;
                const payload = JSON.stringify({ remaining_seconds: seconds, is_paused: isPaused, token: token });
                const url = '/api/stream/sync-timer/${offer.id}?token=' + encodeURIComponent(token);

                if (navigator.sendBeacon && isPaused) {
                    const blob = new Blob([payload], { type: 'application/json' });
                    navigator.sendBeacon(url, blob);
                } else {
                    fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: payload,
                        keepalive: true
                    }).catch(() => {});
                }
            } catch(e) {}
        }

        async function addStudentsToStream(offerId) {
            const btn = document.getElementById('addStudentsBtn');
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الإضافة...';
            try {
                const res = await fetch('/api/stream/add-all-students/' + offerId, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ teacher_id: ${teacher ? teacher.id : 0} })
                });
                const data = await res.json();
                if (res.ok && data.success) {
                    alert('✅ ' + (data.message || 'تم إضافة جميع الطلاب المسجلين والانتظار إلى البث بنجاح!'));
                    isTimerPaused = false;
                    if (!streamIntervalId) startTimer();
                    syncTimerToBackend(streamRemainingSeconds, false);
                } else {
                    alert('⚠️ ' + (data.error || 'حدث خطأ أثناء إضافة الطلاب'));
                }
            } catch (e) { 
                console.error(e); 
                alert('❌ حدث خطأ في الاتصال');
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-user-plus"></i> إضافة الطلاب';
            }
        }

        // بدء الموقت فقط بعد إضافة الطلبة (هنا يبدأ في حالة التوقف مؤقتاً بانتظار إضافة الطلاب)
        if (streamRemainingSeconds <= 0) {
            alert('��� ته����ن��نا تم اكتمال البث وحصلت على عوائدك');
            window.location.href = '/teacher-dashboard.html';
        } else {
            isTimerPaused = true;
            updateTimerDisplay();
        }

        window.addEventListener('beforeunload', function () {
            syncTimerToBackend(streamRemainingSeconds, true);
        });
        window.addEventListener('pagehide', function () {
            syncTimerToBackend(streamRemainingSeconds, true);
        });

        async function loadSingleScript(url) {
            return new Promise((resolve) => {
                if (typeof AgoraRTC !== 'undefined') return resolve(true);
                const s = document.createElement('script');
                s.src = url;
                
                let done = false; const finish = (res) => { if (!done) { done = true; resolve(res); } }; s.onload = () => finish(typeof AgoraRTC !== 'undefined'); s.onerror = () => finish(false); setTimeout(() => finish(false), 1200);
                document.head.appendChild(s);
            });
        }

        async function ensureAgoraLoaded() {
            if (typeof AgoraRTC !== 'undefined') return true;
            const cdns = [
                '/js/agora-rtc-sdk.js',
                'https://download.agora.io/sdk/release/AgoraRTC_N-4.22.0.js',
                'https://cdn.jsdelivr.net/npm/agora-rtc-sdk-ng@4.22.0/AgoraRTC_N-production.js',
                'https://unpkg.com/agora-rtc-sdk-ng@4.22.0/AgoraRTC_N-production.js',
                'https://cdnjs.cloudflare.com/ajax/libs/agora-rtc-sdk-ng/4.22.0/AgoraRTC_N-production.js'
            ];
            for (const url of cdns) {
                console.log('جاري محاولة تحميل AgoraRTC من:', url);
                const ok = await loadSingleScript(url);
                if (ok) return true;
            }
            return false;
        }

        async function initAgora() {
            try {
                const statusElem = document.getElementById('statusText');
                if (statusElem) statusElem.innerHTML = "جاري تحميل مكتبات البث...";
                const isLoaded = await ensureAgoraLoaded();
                if (!isLoaded || typeof AgoraRTC === 'undefined') {
                    throw new Error('تعذر تحميل مكتبة AgoraRTC من كافة خوادم CDN');
                }
                if (!APP_ID) {
                    throw new Error('لم يتم تعيين معرف التطبيق AGORA_APP_ID');
                }
                function setupTeacherClient(c) {
                    function updateStudentCount() {
                        // Handled dynamically via backend polling
                    }
                    c.on('user-joined', updateStudentCount);
                    c.on('user-left', updateStudentCount);
                    c.on('user-published', async (user, mediaType) => {
                        updateStudentCount();
                        await c.subscribe(user, mediaType);
                        if (mediaType === 'video') {
                            const remoteVideo = document.createElement('div');
                            remoteVideo.id = 'remote-video-' + user.uid;
                            remoteVideo.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;';
                            document.getElementById('mediaContainer').appendChild(remoteVideo);
                            user.videoTrack.play(remoteVideo);
                        }
                        if (mediaType === 'audio') {
                            user.audioTrack.play();
                        }
                    });
                    c.on('user-unpublished', (user, mediaType) => {
                        updateStudentCount();
                        const el = document.getElementById('remote-video-' + user.uid);
                        if (el) el.remove();
                    });
                }

                client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
                setupTeacherClient(client);

                try {
                    if (statusElem) statusElem.innerHTML = "يرجى الموافقة على صلاحيات الكاميرا والميكروفون من متصفحك...";
                    [localAudioTrack, localVideoTrack] = await AgoraRTC.createMicrophoneAndCameraTracks();
                    if (localVideoTrack && typeof localVideoTrack.setEncoderConfiguration === 'function') {
                        await localVideoTrack.setEncoderConfiguration('480p_1').catch(e => console.warn('Quality set warn:', e));
                    }
                } catch (mediaErr) {
                    console.warn('فشل فتح الكاميرا والميكروفون معاً، جاري تجربة الميكروفون فقط...', mediaErr);
                    try {
                        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
                    } catch (micErr) {
                        console.warn('فشل فتح الميكروفون أيضاً:', micErr);
                        throw mediaErr;
                    }
                }

                if (localVideoTrack) {
                    localVideoTrack.play('localVideo');
                }

                const tokenToUse = (agoraToken && agoraToken !== 'null' && agoraToken !== 'undefined' && agoraToken.trim() !== '') ? agoraToken.trim() : null;
                try {
                    if (statusElem) statusElem.innerHTML = "جاري الاتصال بخوادم البث المباشر...";
                    console.log('جاري الاتصال بالغرفة:', channelName);
                    await client.join(APP_ID, channelName, tokenToUse, teacherUid);
                } catch (joinErr) {
                    console.warn('فشل الانضمام بالمحاولة الأولى (قد يكون التوكن غير مطلوب أو غير متطابق):', joinErr);
                    if (tokenToUse) {
                        try {
                            try { await client.leave(); } catch(e){}
                            client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
                            setupTeacherClient(client);
                            await client.join(APP_ID, channelName, null, teacherUid);
                        } catch (noTokenErr) {
                            throw joinErr;
                        }
                    } else {
                        throw joinErr;
                    }
                }

                if (localVideoTrack) {
                    await client.publish(localAudioTrack ? [localAudioTrack, localVideoTrack] : [localVideoTrack]);
                } else if (localAudioTrack) {
                    await client.publish([localAudioTrack]);
                }

                const ov = document.getElementById('statusOverlay');
                if (ov) ov.style.display = 'none';
                setTimeout(() => {
                    const ov2 = document.getElementById('statusOverlay');
                    if (ov2) ov2.style.display = 'none';
                }, 1000);
            } catch (err) {
                if (isLeaving) return;
                console.error('Stream Init Error:', err);
                const sp = document.querySelector('#statusOverlay .spinner');
                if (sp) sp.style.display = 'none';
                const ov = document.getElementById('statusOverlay');
                if (ov) { ov.style.overflowY = 'auto'; ov.style.justifyContent = 'center'; }

                const rawErrStr = err.message || err.code || String(err) || 'خطأ غير معروف';
                let userFriendlyTitle = '⚠️ تعذر الاتصال بالسيرفر';
                let userFriendlyAdvice = '';

                if (rawErrStr.includes('PERMISSION_DENIED') || rawErrStr.includes('NotAllowedError') || rawErrStr.includes('Permission denied')) {
                    userFriendlyTitle = '📷���� الإذن بالوصول للميكروفون أو الكاميرا مرفوض';
                    userFriendlyAdvice = 'يرجى السماح بفتح الكاميرا والميكروفون من إعدادات المتصفح وإعادة المحاولة.';
                } else if (rawErrStr.includes('NotFoundError') || rawErrStr.includes('DevicesNotFoundError')) {
                    userFriendlyTitle = '🔌 لم يتم العثور على كاميرا أو ميكروفون';
                    userFriendlyAdvice = 'تأكد من توصيل الكاميرا وا��ميكروفون بجهازك بشكل صحيح.';
                } else if (rawErrStr.includes('CANNOT_GET_GATEWAY') || rawErrStr.includes('DYNAMIC_KEY_TIMEOUT') || rawErrStr.includes('INVALID_VENDOR_KEY') || rawErrStr.includes('INVALID_TOKEN') || rawErrStr.includes('WS_ABORT')) {
                    userFriendlyTitle = '🔑 خطأ في الاتصال بالخادم أو مفاتيح البث المباشر (WS_ABORT)';
                    userFriendlyAdvice = 'تأكد من جودة الاتصال بالإنترنت وعدم وجود إضافة تعترض الاتصال (AdBlock/Firewall)، وتحقق من إعدادات المفاتيح بـ Vercel.';
                }

                const errStack = err.stack ? '<pre style="text-align:left;direction:ltr;background:#000;padding:6px;border-radius:6px;font-size:11px;max-height:100px;overflow:auto;margin-top:6px;color:#f87171;word-break:break-all;white-space:pre-wrap;">' + escapeHtml(err.stack) + '</pre>' : '';
                const debugDetails = '<div style="background:#111827; border:1px solid #374151; padding:14px; border-radius:10px; margin-top:10px; text-align:right; font-size:13px; color:#cbd5e1; line-height:1.6; width:100%; box-sizing:border-box;">' +
                    '<div style="font-weight:bold; font-size:15px; color:#ef4444; margin-bottom:8px;">' + userFriendlyTitle + '</div>' +
                    (userFriendlyAdvice ? '<div style="color:#fcd34d; margin-bottom:10px; background:#1e1b4b; padding:10px; border-radius:8px; border-right:4px solid #6366f1;">💡 <b>نصيحة:</b> ' + userFriendlyAdvice + '</div>' : '') +
                    '<div>• <b>تفاصيل الخطأ:</b> <span style="color:#f87171;">' + escapeHtml(String(rawErrStr)) + '</span></div>' +
                    '<div>• <b>اسم الغرفة:</b> <span style="color:#60a5fa;">' + escapeHtml(channelName) + '</span></div>' +
                    '<div>• <b>رمز المعرف:</b> ' + (APP_ID ? 'موجود ✅' : 'غير محدد ❌') + '</div>' +
                    '<div>• <b>رمز المفتاح:</b> ' + (agoraToken ? 'تم توليده ✅' : 'بدون مفتاح (وضع التنمية) ⚠️') + '</div>' +
                    '<div>• <b>حالة المشغل:</b> ' + (typeof AgoraRTC !== 'undefined' ? 'محمّلة بنجاح ✅' : 'لم تُحمل ❌') + '</div>' +
                    errStack +
                '</div>';
                
                const statusElem = document.getElementById('statusText');
                if (statusElem) statusElem.innerHTML = debugDetails +
                '<div style="margin-top:14px; display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">' +
                    '<button onclick="location.reload()" style="background:#2563eb; color:#fff; border:none; padding:10px 20px; border-radius:8px; font-family:Cairo; font-weight:bold; cursor:pointer; font-size:14px;">🔄 إعادة المحاولة</button>' +
                    '<a href="/teacher-dashboard.html" style="color:#e5e7eb; text-decoration:none; padding:10px 20px; background:#374151; border-radius:8px; font-weight:bold; font-size:14px;">العودة للوحة التحكم</a>' +
                '</div>';
            }
        }

        function toggleQualityMenu() {
            const m = document.getElementById('qualityMenu');
            if (m) m.style.display = m.style.display === 'block' ? 'none' : 'block';
        }

        async function changeVideoQuality(profile, label) {
            try {
                if (localVideoTrack && typeof localVideoTrack.setEncoderConfiguration === 'function') {
                    await localVideoTrack.setEncoderConfiguration(profile);
                    document.getElementById('currentQualityLabel').textContent = 'الجودة: ' + label;
                    document.querySelectorAll('.quality-check').forEach(el => el.style.display = 'none');
                    const activeCheck = document.getElementById('check-' + profile);
                    if (activeCheck) activeCheck.style.display = 'inline';
                    toggleQualityMenu();
                    alert('✅ تم ضبط جودة البث المباشر إلى: ' + label);
                } else {
                    alert('⚠️ يرجى تشغيل الكاميرا أولاً لتغيير جودة البث.');
                }
            } catch(e) {
                console.error('Error setting quality profile:', e);
                alert('حدث خطأ أثناء تغيير الجودة: ' + (e.message || e));
            }
        }

        async function toggleMic() {
            if (!localAudioTrack) return;
            if (isMicOn) {
                localAudioTrack.setMuted(true);
                isMicOn = false;
            } else {
                localAudioTrack.setMuted(false);
                isMicOn = true;
            }
            updateBtnState('micBtn', isMicOn);
        }

        async function toggleCam() {
            if (!localVideoTrack) return;
            if (isCamOn) {
                localVideoTrack.setMuted(true);
                isCamOn = false;
            } else {
                localVideoTrack.setMuted(false);
                isCamOn = true;
            }
            updateBtnState('camBtn', isCamOn);
        }

        let isTheaterMode = false;

        async function toggleTheaterMode() {
            const container = document.querySelector('.agora-container');
            const theaterBtn = document.getElementById('theaterBtn');
            const icon = theaterBtn ? theaterBtn.querySelector('i') : null;

            if (!isTheaterMode) {
                container.classList.add('theater-mode');
                isTheaterMode = true;
                if (theaterBtn) theaterBtn.classList.add('active');
                if (icon) icon.className = 'fas fa-compress';
                
                try {
                    const stage = document.querySelector('.main-stage') || container;
                    if (stage.requestFullscreen) {
                        await stage.requestFullscreen();
                    } else if (stage.webkitRequestFullscreen) {
                        await stage.webkitRequestFullscreen();
                    }
                } catch(e) {
                    console.log('Native fullscreen fallback:', e);
                }
            } else {
                container.classList.remove('theater-mode');
                isTheaterMode = false;
                if (theaterBtn) theaterBtn.classList.remove('active');
                if (icon) icon.className = 'fas fa-expand';
                
                try {
                    if (document.fullscreenElement || document.webkitFullscreenElement) {
                        if (document.exitFullscreen) {
                            await document.exitFullscreen();
                        } else if (document.webkitExitFullscreen) {
                            await document.webkitExitFullscreen();
                        }
                    }
                } catch(e) {}
            }
        }

        document.addEventListener('fullscreenchange', () => {
            if (!document.fullscreenElement && isTheaterMode) {
                const container = document.querySelector('.agora-container');
                if (container) container.classList.remove('theater-mode');
                isTheaterMode = false;
                const theaterBtn = document.getElementById('theaterBtn');
                if (theaterBtn) theaterBtn.classList.remove('active');
                const icon = theaterBtn ? theaterBtn.querySelector('i') : null;
                if (icon) icon.className = 'fas fa-expand';
            }
        });

        let currentCamDeviceIndex = 0;
        let currentFacingMode = 'user';

        async function switchCamera() {
            if (!localVideoTrack) {
                alert('⚠️ الكاميرا مغلقة، يرجى تشغيل الكاميرا أولاً للتمكن من التبديل بين الكام��را الأمامية والخلفية.');
                return;
            }

            const flipBtn = document.getElementById('flipCamBtn');
            if (flipBtn) {
                flipBtn.style.pointerEvents = 'none';
                flipBtn.style.opacity = '0.5';
            }

            try {
                const cameras = await AgoraRTC.getCameras();
                if (cameras && cameras.length > 1) {
                    currentCamDeviceIndex = (currentCamDeviceIndex + 1) % cameras.length;
                    const targetCam = cameras[currentCamDeviceIndex];
                    if (typeof localVideoTrack.setDevice === 'function') {
                        await localVideoTrack.setDevice(targetCam.deviceId);
                        console.log('✅ Switched camera device to:', targetCam.label || targetCam.deviceId);
                    } else {
                        await recreateVideoTrackWithFacingMode();
                    }
                } else {
                    await recreateVideoTrackWithFacingMode();
                }
            } catch (err) {
                console.warn('Direct device switch warning, trying facingMode recreation:', err);
                await recreateVideoTrackWithFacingMode();
            } finally {
                if (flipBtn) {
                    flipBtn.style.pointerEvents = 'auto';
                    flipBtn.style.opacity = '1';
                }
            }
        }

        async function recreateVideoTrackWithFacingMode() {
            try {
                currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user';
                
                if (localVideoTrack) {
                    if (client) {
                        try { await client.unpublish(localVideoTrack); } catch(e){}
                    }
                    try { localVideoTrack.close(); } catch(e){}
                }

                localVideoTrack = await AgoraRTC.createCameraVideoTrack({
                    encoderConfig: '480p_1',
                    facingMode: currentFacingMode
                });

                localVideoTrack.play('localVideo');

                if (client) {
                    await client.publish(localVideoTrack);
                }
                console.log('✅ Camera track recreated with facingMode:', currentFacingMode);
            } catch(e) {
                console.error('Error recreating camera track:', e);
                alert('حدث خطأ أثناء تبديل اتجاه الكاميرا: ' + (e.message || e));
            }
        }

        async function toggleShare() {
            try {
                if (!isSharing) {
                    screenTrack = await AgoraRTC.createScreenVideoTrack();
                    await client.publish(screenTrack);
                    isSharing = true;
                    updateBtnState('shareBtn', true);
                } else {
                    await client.unpublish(screenTrack);
                    screenTrack.close();
                    screenTrack = null;
                    isSharing = false;
                    updateBtnState('shareBtn', false);
                }
            } catch(e) { console.error('Share screen error:', e); }
        }

        function updateBtnState(id, active) {
            const btn = document.getElementById(id);
            if (active) btn.classList.remove('active');
            else btn.classList.add('active');
        }

        async function sendChatMessage() {
            const input = document.getElementById('chatInput');
            const msg = input.value.trim();
            if (!msg) return;
            try {
                const token = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('token');
                const res = await fetch('/api/stream/chat/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ offer_id: ${offer.id}, message: msg })
                });
                const data = await res.json();
                if (data.success) {
                    input.value = '';
                    fetchChatMessages();
                } else {
                    alert(data.error || 'فشل إرسال الرسالة');
                }
            } catch(e) { console.error('Send chat error:', e); }
        }

        let mutedStudentIds = new Set();

        async function fetchChatMessages() {
            try {
                const token = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('token');
                const res = await fetch('/api/stream/chat/messages/${offer.id}', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const data = await res.json();
                if (data.success) {
                    if (data.muted_students) {
                        mutedStudentIds = new Set(data.muted_students);
                    }
                    if (data.active_count !== undefined) {
                        const viewersElem = document.getElementById('viewersCount');
                        if (viewersElem) viewersElem.textContent = data.active_count;
                    }
                    renderTeacherChat(data.messages || []);
                }
            } catch(e){}
            fetchWaitingCount();
        }

        async function fetchWaitingCount() {
            try {
                const token = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('token');
                const res = await fetch('/api/stream/waiting-count/${offer.id}', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const data = await res.json();
                const badge = document.getElementById('waitingCountBadge');
                if (data.success && data.count > 0) {
                    badge.textContent = data.count;
                    badge.style.display = 'flex';
                } else if (badge) {
                    badge.style.display = 'none';
                }
            } catch(e){}
        }

        setInterval(fetchChatMessages, 3000);
        fetchChatMessages();

        let isFirstTeacherChatLoad = true;

        function renderTeacherChat(messages) {
            const container = document.getElementById('chatMsgs');
            if (!container) return;
            
            // Check if user is scrolled near bottom BEFORE modifying container
            const isAtBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) <= 80;

            // Update existing mute buttons first
            Array.from(container.children).forEach(child => {
                const btn = child.querySelector('.mute-btn');
                if (btn && btn.dataset.studentId) {
                    const sId = parseInt(btn.dataset.studentId);
                    const isMuted = mutedStudentIds.has(sId);
                    const btnBg = isMuted ? '#10b981' : '#ef4444';
                    const btnTxt = isMuted ? 'إلغاء الكتم 🔊' : 'كتم الطالب 🔇';
                    const nextMute = !isMuted;
                    btn.style.background = btnBg;
                    btn.innerHTML = btnTxt;
                    btn.onclick = () => toggleMuteStudent(sId, nextMute);
                }
            });

            // Track existing message IDs to avoid duplicates if appending
            const existingIds = new Set();
            Array.from(container.children).forEach(child => {
                if(child.dataset.messageId) existingIds.add(child.dataset.messageId);
            });

            let newMsgCount = 0;
            messages.forEach(m => {
                if (existingIds.has(m.id.toString())) return; // Skip if already rendered
                newMsgCount++;

                const teacherId = ${teacher ? teacher.id : 0};
                const isSent = m.sender_id == teacherId || m.sender_role === 'teacher';
                const div = document.createElement('div');
                div.className = 'chat-msg' + (isSent ? ' sent' : '');
                div.dataset.messageId = m.id;
                
                let muteBtnHtml = '';
                if (m.sender_role === 'student' && m.sender_id) {
                    const isMuted = mutedStudentIds.has(m.sender_id);
                    const btnBg = isMuted ? '#10b981' : '#ef4444';
                    const btnTxt = isMuted ? 'إلغاء الكتم 🔊' : 'كتم الطالب 🔇';
                    const nextMute = !isMuted;
                    muteBtnHtml = '<button class="mute-btn" data-student-id="' + m.sender_id + '" onclick="toggleMuteStudent(' + m.sender_id + ', ' + nextMute + ')" style="margin-right:6px; font-size:10px; padding:2px 6px; border-radius:4px; border:none; cursor:pointer; background:' + btnBg + '; color:white;">' + btnTxt + '</button>';
                }
                
                div.innerHTML = '<div class="sender" style="display:flex; justify-content:space-between; align-items:center;"><span>' + escapeHtml(m.sender_name) + '</span>' + muteBtnHtml + '</div>' + escapeHtml(m.message);
                container.appendChild(div);
            });

            if (isFirstTeacherChatLoad || (newMsgCount > 0 && isAtBottom)) {
                container.scrollTop = container.scrollHeight;
                isFirstTeacherChatLoad = false;
            }
        }
        
        function sendTeacherLeaveBeacon() {
            try {
                const token = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('token');
                const url = '/api/stream/teacher-leave/' + ${offer.id} + '?token=' + encodeURIComponent(token);
                if (navigator.sendBeacon) {
                    navigator.sendBeacon(url);
                } else {
                    fetch(url, { method: 'POST', keepalive: true }).catch(e => {});
                }
            } catch(e) {}
        }

        window.addEventListener('beforeunload', function (e) {
            sendTeacherLeaveBeacon();
            e.preventDefault();
            e.returnValue = 'أنك لن تحصل على اي عائد اذا قمت باغلاق البث مبكرا. هل أنت متأكد؟';
        });

        window.addEventListener('unload', sendTeacherLeaveBeacon);

        async function toggleMuteStudent(studentId, mute) {
            try {
                const token = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('token');
                const res = await fetch('/api/stream/chat/mute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ offer_id: ${offer.id}, student_id: studentId, mute: mute })
                });
                const data = await res.json();
                if (data.success) {
                    fetchChatMessages();
                } else {
                    alert(data.error || 'فشل تغيير حالة الكتم');
                }
            } catch(e){ console.error(e); }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.innerText = text;
            return div.innerHTML;
        }

        let isLeaving = false;
        async function leaveSession() {
            if (!confirm('⏹ هل أنت متأكد من إنهاء البث المباشر؟ سيتم توزيع المستحقات أو استرداد الأموال للطلاب وحذف الدرس نهائياً.')) return;
            isLeaving = true;
            
            // Notify backend first before tearing down network
            try {
                const token = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('token');
                const res = await fetch('/api/stream/end/${offer.id}', { 
                    method: 'POST', 
                    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ early_end: false, remaining_seconds: typeof streamRemainingSeconds !== 'undefined' ? streamRemainingSeconds : null })
                });
                const data = await res.json();
                if (data && data.success) {
                    alert('✅ تم إنهاء البث وحذف الدرس بنجاح.');
                } else if (data && data.error) {
                    alert('⚠️ تنبيه: ' + data.error);
                }
            } catch(e) {
                console.error('Error ending stream:', e);
            }

            try {
                if (localAudioTrack) { try { localAudioTrack.stop(); localAudioTrack.close(); } catch(e){} }
                if (localVideoTrack) { try { localVideoTrack.stop(); localVideoTrack.close(); } catch(e){} }
                if (client) { client.leave().catch(e => console.warn('Agora client leave:', e)); }
            } catch(e){}
            
            try { window.close(); } catch(e){}
            window.location.href = '/teacher-dashboard.html';
        }

        // حفظ وإيق����ف الموقت تلقائياً عند إغلاق التبويب أو مغادرة الصفحة دون إنهاء البث
        window.addEventListener('pagehide', function() {
            if (isLeaving) return;
            isTimerPaused = true;
            syncTimerToBackend(streamRemainingSeconds, true);
            try {
                if (localAudioTrack) { localAudioTrack.stop(); localAudioTrack.close(); }
                if (localVideoTrack) { localVideoTrack.stop(); localVideoTrack.close(); }
                if (client) { client.leave().catch(e => {}); }
            } catch(e){}
        });

        window.addEventListener('beforeunload', function() {
            isTimerPaused = true;
            syncTimerToBackend(streamRemainingSeconds, true);
        });

        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'hidden') {
                syncTimerToBackend(streamRemainingSeconds, isTimerPaused);
            }
        });

        document.addEventListener('DOMContentLoaded', () => {
            initAgora();
            fetchChatMessages();
            setInterval(fetchChatMessages, 2500);
        });
    </script>
</body>
</html>
    `;
}

// ============================================================
// ✅ صفحة دخول الطالب للبث عبر Zoom Video SDK
// ============================================================

const handleStudentZoomView = async (req, res) => {
    try {
        let token = req.query.token || (req.body && req.body.token);
        if (!token) {
            return res.send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head>
                    <meta charset="UTF-8">
                    <title>جاري التحقق...</title>
                    <script>
                        document.addEventListener('DOMContentLoaded', () => {
                            const token = localStorage.getItem('token');
                            if (token) {
                                const form = document.createElement('form');
                                form.method = 'POST';
                                form.action = window.location.pathname;
                                const input = document.createElement('input');
                                input.type = 'hidden';
                                input.name = 'token';
                                input.value = token;
                                form.appendChild(input);
                                document.body.appendChild(form);
                                form.submit();
                            } else {
                                window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
                            }
                        });
                    </script>
                </head>
                <body style="font-family: Cairo, sans-serif; text-align: center; padding-top: 50px; background: #0b0f19; color: #fff;">
                    <p>جاري التحقق من صلاحية الوصول... يرجى الانتظار</p>
                </body>
                </html>
            `);
        }

        const decoded = verifyToken(token);
        if (!decoded || decoded.role !== 'student') {
            return res.status(403).send('<p style="text-align:center;font-family:Cairo;padding:50px;">غير مصرح</p>');
        }
        
        const offerId = parseInt(req.params.offer_id, 10);
        const urlStudentId = parseInt(req.params.student_id, 10);
        const studentId = decoded.userId;
        
        if (urlStudentId && urlStudentId !== studentId) {
            return res.status(403).send('<p style="text-align:center;font-family:Cairo;padding:50px;">عذراً، هذا الرابط مخصص لطالب آخر ولا يمكنك الدخول من خلاله.</p>');
        }
        
        const { data: session } = await supabase
            .from('sessions')
            .select('*')
            .eq('offer_id', offerId)
            .eq('student_id', studentId)
            .in('payment_status', ['paid', 'pending_stream'])
            .maybeSingle();

        if (!session) {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head>
                    <meta charset="UTF-8">
                    <title>وصول مرفوض</title>
                    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700&display=swap" rel="stylesheet">
                </head>
                <body style="font-family:Cairo;text-align:center;padding:50px;background:#f8fafc;">
                    <div style="max-width:500px;margin:0 auto;background:white;padding:30px;border-radius:15px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1);">
                        <div style="font-size:60px;margin-bottom:20px;">🚫</div>
                        <h1 style="color:#ef4444;margin-bottom:15px;">يجب حجز الحصة أولاً</h1>
                        <p style="color:#64748b;margin-bottom:25px;">لم نجد حجزاً نشطاً لك في هذه الحصة. يرجى التأكد من الدفع والحجز عبر لوحة التحكم.</p>
                        <a href="/student-dashboard.html" style="display:inline-block;padding:12px 25px;background:#0f5cbf;color:white;text-decoration:none;border-radius:8px;font-weight:700;">العودة للوحة التحكم</a>
                    </div>
                </body></html>
            `);
        }
        
        const offer = await getOne('offers', 'id', offerId);
        if (!offer || (offer.status !== 'live' && offer.status !== 'teacher_ready' && offer.status !== 'paused')) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head><meta charset="UTF-8"><title>خطأ</title></head>
                <body style="font-family:Cairo;text-align:center;padding:50px;">
                    <h1 style="color:#f59e0b;">⏳ البث لم يبدأ بعد</h1>
                    <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
                </body></html>
            `);
        }
        
        const student = await getOne('students', 'id', studentId);
        
        // حساب الوقت المتبقي للبث
        let savedSeconds = null;
        if (offer.remaining_seconds !== undefined && offer.remaining_seconds !== null && !isNaN(Number(offer.remaining_seconds))) {
            savedSeconds = Number(offer.remaining_seconds);
        } else if (offer.remaining_time !== undefined && offer.remaining_time !== null && !isNaN(Number(offer.remaining_time))) {
            savedSeconds = Number(offer.remaining_time);
        }

        if (savedSeconds !== null) {
            offer.remaining_time = savedSeconds;
        } else {
            offer.remaining_time = (offer.duration_minutes || offer.duration || 60) * 60;
        }

        res.send(generateStudentZoomPage(offer, student));
    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.status(500).send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head><meta charset="UTF-8"><title>خطأ</title></head>
            <body style="font-family:Cairo;text-align:center;padding:50px;">
                <h1 style="color:#ef4444;">❌ حدث خطأ</h1>
                <p style="color:#64748b;">${error.message}</p>
                <a href="/student-dashboard.html" style="color:#0f5cbf;font-weight:700;">العودة للوحة التحكم</a>
            </body></html>
        `);
    }
};

app.get('/api/join-agora/:offer_id', handleStudentZoomView);
app.post('/api/join-agora/:offer_id', handleStudentZoomView);
app.get('/api/join-agora/:offer_id/:student_id', handleStudentZoomView);
app.post('/api/join-agora/:offer_id/:student_id', handleStudentZoomView);
app.get('/api/join-jitsi/:offer_id/:student_id', handleStudentZoomView);
app.post('/api/join-jitsi/:offer_id/:student_id', handleStudentZoomView);
app.get('/api/join-zoom/:offer_id/:student_id', handleStudentZoomView);
app.post('/api/join-zoom/:offer_id/:student_id', handleStudentZoomView);

function generateStudentZoomPage(offer, student) {
    const rawRoomName = (offer.room_name && offer.room_name.trim()) ? offer.room_name.trim() : ('class_offer_' + offer.id);
    const roomName = rawRoomName.replace(/[^a-zA-Z0-9_-]/g, '_') || ('class_offer_' + offer.id);
    const subjectName = offer.subject_name || 'غير محدد';
    const studentName = student && student.full_name ? student.full_name : 'طالب';
    const studentDbId = student ? student.id : 0;
    const studentUid = Math.floor(Math.random() * 100000) + 100001;
    const appId = (process.env.AGORA_APP_ID && process.env.AGORA_APP_ID.trim()) || 'a5571809de0c4678bb4b134adfdc48a3';
    const agoraToken = generateAgoraToken(roomName, 'student', studentUid);

    return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>متابعة البث - ${escapeHtml(subjectName)}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script src="/js/agora-rtc-sdk.js"></script>
    <script src="https://download.agora.io/sdk/release/AgoraRTC_N-4.22.0.js" onerror="console.warn('Official Agora CDN fallback trigger')"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body, html { width: 100%; height: 100%; background: #0b0f19; font-family: 'Cairo', sans-serif; color: #fff; overflow: hidden; }
        .agora-container { display: flex; flex-direction: column; height: 100vh; width: 100vw; overflow: hidden; }
        
        .header-bar { height: 56px; flex-shrink: 0; background: #111827; border-bottom: 1px solid #1f2937; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; z-index: 10; }
        .header-title { font-size: 16px; font-weight: 700; color: #10b981; display: flex; align-items: center; gap: 10px; }
        .badge { background: #10b981; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 20px; font-weight: 700; }
        
        .main-stage { flex: 1; display: flex; position: relative; background: #030712; min-height: 0; overflow: hidden; }
        .video-area { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; padding: 10px; min-width: 0; height: 100%; overflow: hidden; }
        #mediaContainer { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; position: relative; background: #000; border-radius: 12px; overflow: hidden; }
        #remoteVideo { width: 100%; height: 100%; background: #000; border-radius: 12px; object-fit: contain; }
        
        .chat-sidebar { width: 300px; flex-shrink: 0; background: #111827; border-right: 1px solid #1f2937; display: flex; flex-direction: column; height: 100%; overflow: hidden; }
        .chat-header { padding: 10px 14px; border-bottom: 1px solid #1f2937; font-weight: 700; font-size: 14px; color: #34d399; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .chat-messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
        .chat-msg { background: #1f2937; color: #f3f4f6; padding: 8px 12px; border-radius: 8px; max-width: 90%; font-size: 13px; word-break: break-word; align-self: flex-start; }
        .chat-msg.sent { background: #059669; color: #ffffff; align-self: flex-end; }
        .chat-msg .sender { font-size: 11px; color: #9ca3af; margin-bottom: 3px; font-weight: 700; }
        .chat-msg.sent .sender { color: #d1fae5; }
        .chat-input-box { padding: 8px 10px; border-top: 1px solid #1f2937; display: flex; gap: 6px; background: #111827; flex-shrink: 0; }
        .chat-input-box input { flex: 1; background: #1f2937; border: 1px solid #374151; color: #fff; padding: 8px 12px; border-radius: 8px; outline: none; font-family: 'Cairo'; font-size: 13px; }
        .chat-input-box button { background: #10b981; color: white; border: none; padding: 0 12px; border-radius: 8px; cursor: pointer; font-weight: 700; transition: background 0.2s; }
        .chat-input-box button:hover { background: #059669; }
        
        .controls-bar { height: 64px; flex-shrink: 0; background: #111827; border-top: 1px solid #1f2937; display: flex; align-items: center; justify-content: center; gap: 14px; padding: 0 15px; z-index: 20; }
        .ctrl-btn { background: #1f2937; border: 1px solid #374151; color: #fff; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 17px; cursor: pointer; transition: all 0.2s; }
        .ctrl-btn:hover { background: #374151; transform: translateY(-2px); }
        .ctrl-btn.active { background: #ef4444; border-color: #f87171; color: #fff; }
        .ctrl-btn.end { background: #dc2626; border-color: #f87171; width: auto; padding: 0 20px; border-radius: 22px; font-weight: 700; font-size: 13px; height: 44px; }
        .ctrl-btn.end:hover { background: #b91c1c; }
        
        .status-overlay { position: absolute; inset: 0; background: rgba(3, 7, 18, 0.95); display: none; flex-direction: column; align-items: center; justify-content: center; gap: 15px; z-index: 30; padding: 20px; text-align: center; overflow-y: auto; max-height: 100%; }
        .spinner { width: 40px; height: 40px; border: 4px solid rgba(255,255,255,0.1); border-top-color: #10b981; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        
        @media (max-width: 768px) {
            .header-bar { height: auto; min-height: 40px; flex-wrap: wrap; padding: 4px 8px; gap: 4px; }
            .header-title { font-size: 12px; width: auto; max-width: 50%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            #streamTimerContainer { order: -1; padding: 2px 8px; border-radius: 12px; font-size: 11px; margin-right: auto; }
            #studentTimerLabel { font-size: 10px; }
            #studentTimerDisplay { font-size: 12px; }
            
            .main-stage { flex-direction: column; overflow: hidden; flex: 1; min-height: 0; }
            .video-area { height: 50vh; max-height: 55vh; flex: none; padding: 2px; position: sticky; top: 0; z-index: 10; width: 100%; }
            #mediaContainer { height: 100%; width: 100%; border-radius: 6px; }
            
            .chat-sidebar { width: 100%; flex: 1; min-height: 0; border-right: none; border-top: 1px solid #1f2937; display: flex; flex-direction: column; overflow: hidden; }
            .chat-messages { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; gap: 6px; font-size: 13px; -webkit-overflow-scrolling: touch; }
            .chat-msg { font-size: 13px; padding: 6px 10px; }
            
            .chat-input-box { padding: 8px 10px; }
            .chat-input-box input { padding: 8px 12px; font-size: 13px; border-radius: 8px; }
            .chat-input-box button { padding: 0 16px; border-radius: 8px; }
            
            .controls-bar { height: auto; min-height: 44px; gap: 6px; padding: 4px 8px; flex-wrap: wrap; }
            .ctrl-btn { width: 36px; height: 36px; font-size: 14px; }
            .ctrl-btn.end { width: auto; height: 32px; border-radius: 6px; font-size: 11px; padding: 0 10px; margin-top: 0; }
        }
    </style>
</head>
<body>
    <div class="agora-container">
        <div class="header-bar">
            <div class="header-title" style="display: flex; align-items: center; gap: 8px; flex-wrap: nowrap;">
                <i class="fas fa-play-circle"></i>
                <span style="font-size: 14px;">البث المباشر: ${escapeHtml(subjectName)}</span>
                <span class="badge" style="font-size: 10px; padding: 1px 6px;">مباشر</span>
            </div>
            <div id="liveViewersBadge" style="display: flex; align-items: center; gap: 6px; background: rgba(16, 185, 129, 0.2); border: 1px solid #10b981; color: #34d399; padding: 2px 8px; border-radius: 16px; font-size: 11px; font-weight: 700;">
                <i class="fas fa-users"></i>
                <span id="viewersCount" style="color: #6ee7b7; font-size: 12px; font-weight: 800;">0</span>
            </div>
            <div style="font-size: 12px; color: #9ca3af; display: flex; align-items: center; gap: 4px;">
                <i class="fas fa-user"></i> ${escapeHtml(studentName)}
            </div>
            <div id="streamTimerContainer" style="display: flex; align-items: center; gap: 6px; background: #1f2937; padding: 3px 10px; border-radius: 16px; border: 1px solid #374151; margin-right: auto;">
                <div id="studentTimerLabel" style="font-size: 11px; color: #9ca3af;"><i class="fas fa-stopwatch"></i> المتبقي:</div>
                <div id="studentTimerDisplay" style="font-family: monospace; font-size: 13px; font-weight: bold; color: #10b981;">00:00:00</div>
                <div style="display: flex; align-items: center; gap: 5px; margin-right: 4px; padding-right: 6px; border-right: 1px solid #374151;" title="نسبة إكتمال البث المباشر">
                    <div style="width: 45px; height: 5px; background: rgba(255,255,255,0.15); border-radius: 3px; overflow: hidden; position: relative;">
                        <div id="streamProgressBar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #10b981, #3b82f6); transition: width 0.3s ease;"></div>
                    </div>
                    <span id="streamProgressPct" style="font-size: 10px; font-weight: 700; color: #60a5fa; font-family: monospace;">0%</span>
                </div>
            </div>
        </div>
        <div style="width: 100%; height: 3px; background: rgba(255,255,255,0.06); position: relative; z-index: 15;">
            <div id="mainStreamProgressBar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #10b981, #3b82f6); transition: width 0.4s ease;"></div>
        </div>
        <div class="main-stage">
            <div class="video-area">
                <div id="statusOverlay" class="status-overlay">
                    <div class="spinner"></div>
                    <div id="statusText" style="width:100%; max-width:650px; text-align:right;">جاري الانضمام للبث المباشر...</div>
                </div>
                <div id="mediaContainer" onclick="toggleFullscreen()" style="cursor: pointer; position: relative;" title="انقر لتكبير الشاشة / إلغاء ملء الشاشة">
                    <div id="remoteVideo"></div>
                    <div id="fullscreenBadge" style="position: absolute; top: 12px; right: 12px; background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(4px); color: #fff; padding: 5px 12px; border-radius: 20px; font-size: 11px; font-weight: 700; display: flex; align-items: center; gap: 6px; pointer-events: none; z-index: 5; border: 1px solid rgba(255,255,255,0.15);">
                        <i class="fas fa-expand"></i> انقر لملء الشاشة
                    </div>
                </div>
            </div>
            <div class="chat-sidebar">
                <div class="chat-header">
                    <i class="fas fa-comments"></i> الدردشة التفاعلية
                </div>
                <div class="chat-messages" id="chatMsgs">
                    <div class="chat-msg">
                        <div class="sender">النظام</div>
                        أهلاً بك يا ${escapeHtml(studentName)} في البث المباشر!
                    </div>
                </div>
                <div class="chat-input-box">
                    <input type="text" id="chatInput" placeholder="اسأل الأستاذ..." onkeypress="if(event.key==='Enter') sendChatMessage()">
                    <button onclick="sendChatMessage()"><i class="fas fa-paper-plane"></i></button>
                </div>
            </div>
        </div>
        <div class="controls-bar">
            <button class="ctrl-btn" id="audioBoostBtn" onclick="toggleAudioBoost()" title="تقوية الصوت (100%)" style="position: relative;">
                <i class="fas fa-volume-up"></i>
            </button>
            <button class="ctrl-btn" id="fullscreenBtn" onclick="toggleFullscreen()" title="ملء الشاشة">
                <i class="fas fa-expand"></i>
            </button>
            <button class="ctrl-btn end" onclick="leaveSession()">
                <i class="fas fa-sign-out-alt"></i> مغادرة
            </button>
        </div>
    </div>

    <script>
        const APP_ID = "${appId}";
        const channelName = "${escapeHtml(roomName)}";
        const studentUid = ${studentUid};
        const agoraToken = "${agoraToken || ''}";
        const userName = "${escapeHtml(studentName)}";

        let client = null;
        let localAudioTrack = null;
        let isMicOn = false;

        async function loadSingleScript(url) {
            return new Promise((resolve) => {
                if (typeof AgoraRTC !== 'undefined') return resolve(true);
                const s = document.createElement('script');
                s.src = url;
                
                let done = false; const finish = (res) => { if (!done) { done = true; resolve(res); } }; s.onload = () => finish(typeof AgoraRTC !== 'undefined'); s.onerror = () => finish(false); setTimeout(() => finish(false), 1200);
                document.head.appendChild(s);
            });
        }

        async function ensureAgoraLoaded() {
            if (typeof AgoraRTC !== 'undefined') return true;
            const cdns = [
                '/js/agora-rtc-sdk.js',
                'https://download.agora.io/sdk/release/AgoraRTC_N-4.22.0.js',
                'https://cdn.jsdelivr.net/npm/agora-rtc-sdk-ng@4.22.0/AgoraRTC_N-production.js',
                'https://unpkg.com/agora-rtc-sdk-ng@4.22.0/AgoraRTC_N-production.js',
                'https://cdnjs.cloudflare.com/ajax/libs/agora-rtc-sdk-ng/4.22.0/AgoraRTC_N-production.js'
            ];
            for (const url of cdns) {
                console.log('جاري محاولة تحميل AgoraRTC من:', url);
                const ok = await loadSingleScript(url);
                if (ok) return true;
            }
            return false;
        }

        async function initAgora() {
            try {
                const statusElem = document.getElementById('statusText');
                if (statusElem) statusElem.innerHTML = "جاري تحميل مكتبات البث...";
                const isLoaded = await ensureAgoraLoaded();
                if (!isLoaded || typeof AgoraRTC === 'undefined') {
                    throw new Error('تعذر تحميل مكتبة AgoraRTC من كافة خوادم CDN');
                }
                if (!APP_ID) {
                    throw new Error('لم يتم تعيين معرف التطبيق AGORA_APP_ID');
                }
                function setupStudentClient(c) {
                    function updateViewersCount() {
                        // Handled dynamically via backend polling
                    }

                    c.on('user-joined', updateViewersCount);
                    c.on('user-left', updateViewersCount);

                    c.on('user-published', async (user, mediaType) => {
                        updateViewersCount();
                        const ov = document.getElementById('statusOverlay');
                        if (ov) ov.style.display = 'none';
                        await c.subscribe(user, mediaType);
                        if (mediaType === 'video') {
                            const remoteEl = document.getElementById('remoteVideo');
                            remoteEl.innerHTML = '';
                            user.videoTrack.play(remoteEl);
                        }
                        if (mediaType === 'audio') {
                            user.audioTrack.play();
                        }
                    });

                    c.on('user-unpublished', (user) => {
                        updateViewersCount();
                        document.getElementById('remoteVideo').innerHTML = '';
                    });
                }

                client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
                setupStudentClient(client);

                const tokenToUse = (agoraToken && agoraToken !== 'null' && agoraToken !== 'undefined' && agoraToken.trim() !== '') ? agoraToken.trim() : null;
                try {
                    if (statusElem) statusElem.innerHTML = "جاري الاتصال بخوادم البث المباشر...";
                    console.log('جاري الاتصال بالغرفة:', channelName);
                    await client.join(APP_ID, channelName, tokenToUse, studentUid);
                } catch (joinErr) {
                    console.warn('فشل الانضمام بالمحاولة الأولى (قد يكون التوكن غير مطلوب أو غير متطابق):', joinErr);
                    if (tokenToUse) {
                        try {
                            try { await client.leave(); } catch(e){}
                            client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
                            setupStudentClient(client);
                            await client.join(APP_ID, channelName, null, studentUid);
                        } catch (noTokenErr) {
                            throw joinErr;
                        }
                    } else {
                        throw joinErr;
                    }
                }
                const statusOv = document.getElementById('statusOverlay');
                if (statusOv) statusOv.style.display = 'none';
                setTimeout(() => {
                    const ov = document.getElementById('statusOverlay');
                    if (ov) ov.style.display = 'none';
                }, 1200);
            } catch (err) {
                if (typeof isLeaving !== 'undefined' && isLeaving) return;
                console.error('Agora Init Error:', err);
                const sp = document.querySelector('#statusOverlay .spinner');
                if (sp) sp.style.display = 'none';
                const ov = document.getElementById('statusOverlay');
                if (ov) { ov.style.overflowY = 'auto'; ov.style.justifyContent = 'center'; }

                const rawErrStr = err.message || err.code || String(err) || 'خطأ غير معروف';
                let userFriendlyTitle = '⚠️ تعذر الاتصال بالسيرفر';
                let userFriendlyAdvice = '';

                if (rawErrStr.includes('PERMISSION_DENIED') || rawErrStr.includes('NotAllowedError') || rawErrStr.includes('Permission denied')) {
                    userFriendlyTitle = '📷🎤 الإذن بالوصول للميكروفون أو الكاميرا مرفوض';
                    userFriendlyAdvice = '��رجى السما�� بفتح الكاميرا والميكروفون من إعدادات المتصفح وإعادة المحاولة.';
                } else if (rawErrStr.includes('NotFoundError') || rawErrStr.includes('DevicesNotFoundError')) {
                    userFriendlyTitle = '🔌 لم يتم العثور على كاميرا أو ميكروفون';
                    userFriendlyAdvice = 'تأكد من توصيل الكاميرا والميكروفون بجهازك بشكل صحيح.';
                } else if (rawErrStr.includes('CANNOT_GET_GATEWAY') || rawErrStr.includes('DYNAMIC_KEY_TIMEOUT') || rawErrStr.includes('INVALID_VENDOR_KEY') || rawErrStr.includes('INVALID_TOKEN') || rawErrStr.includes('WS_ABORT')) {
                    userFriendlyTitle = '🔑 خطأ في الاتصال بالخادم أو مفاتيح البث المباشر (WS_ABORT)';
                    userFriendlyAdvice = 'تأكد من جودة الاتصال بالإنترنت وعدم وجود إضافة تعترض الاتصال (AdBlock/Firewall)، وتحقق من إعدادات المفاتيح بـ Vercel.';
                }

                const errStack = err.stack ? '<pre style="text-align:left;direction:ltr;background:#000;padding:6px;border-radius:6px;font-size:11px;max-height:100px;overflow:auto;margin-top:6px;color:#f87171;word-break:break-all;white-space:pre-wrap;">' + escapeHtml(err.stack) + '</pre>' : '';
                const debugDetails = '<div style="background:#111827; border:1px solid #374151; padding:14px; border-radius:10px; margin-top:10px; text-align:right; font-size:13px; color:#cbd5e1; line-height:1.6; width:100%; box-sizing:border-box;">' +
                    '<div style="font-weight:bold; font-size:15px; color:#ef4444; margin-bottom:8px;">' + userFriendlyTitle + '</div>' +
                    (userFriendlyAdvice ? '<div style="color:#fcd34d; margin-bottom:10px; background:#1e1b4b; padding:10px; border-radius:8px; border-right:4px solid #6366f1;">💡 <b>نصيحة:</b> ' + userFriendlyAdvice + '</div>' : '') +
                    '<div>• <b>تفاصيل الخطأ:</b> <span style="color:#f87171;">' + escapeHtml(String(rawErrStr)) + '</span></div>' +
                    '<div>• <b>اسم الغرفة:</b> <span style="color:#34d399;">' + escapeHtml(channelName) + '</span></div>' +
                    '<div>• <b>رمز المعرف:</b> ' + (APP_ID ? 'موجود ✅' : 'غير محدد ❌') + '</div>' +
                    '<div>• <b>رمز المفتاح:</b> ' + (agoraToken ? 'تم توليده ✅' : 'بدون مفتاح (وضع التنمية) ⚠️') + '</div>' +
                    '<div>• <b>حالة المشغل:</b> ' + (typeof AgoraRTC !== 'undefined' ? 'محمّلة بنجاح ✅' : 'لم تُحمل ❌') + '</div>' +
                    errStack +
                '</div>';
                
                const statusElem = document.getElementById('statusText');
                if (statusElem) statusElem.innerHTML = debugDetails +
                '<div style="margin-top:14px; display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">' +
                    '<button onclick="location.reload()" style="background:#10b981; color:#fff; border:none; padding:10px 20px; border-radius:8px; font-family:Cairo; font-weight:bold; cursor:pointer; font-size:14px;">🔄 إعادة المحاولة</button>' +
                    '<a href="/student-dashboard.html" style="color:#e5e7eb; text-decoration:none; padding:10px 20px; background:#374151; border-radius:8px; font-weight:bold; font-size:14px;">العودة للوحة التحكم</a>' +
                '</div>';
            }
        }

        async function toggleMic() {
            if (!client) return;
            const btn = document.getElementById('micBtn');
            try {
                if (!isMicOn) {
                    if (!localAudioTrack) {
                        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
                        await client.publish(localAudioTrack);
                        client.setClientRole('host');
                    } else {
                        localAudioTrack.setMuted(false);
                    }
                    isMicOn = true;
                    if (btn) {
                        btn.classList.remove('active');
                        btn.innerHTML = '<i class="fas fa-microphone"></i>';
                    }
                } else {
                    if (localAudioTrack) localAudioTrack.setMuted(true);
                    isMicOn = false;
                    if (btn) {
                        btn.classList.add('active');
                        btn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
                    }
                }
            } catch(e) { console.error(e); }
        }

        function toggleCam() {
            alert('الكاميرا مغلقة للطالب لخصوصيتك أثناء البث');
        }

        // ===== 🖥️ ملء الشاشة (Fullscreen Toggle) =====
        function toggleFullscreen() {
            const target = document.getElementById('mediaContainer') || document.querySelector('.video-area');
            if (!target) return;

            const isFS = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
            if (!isFS) {
                if (target.requestFullscreen) {
                    target.requestFullscreen();
                } else if (target.webkitRequestFullscreen) {
                    target.webkitRequestFullscreen();
                } else if (target.mozRequestFullScreen) {
                    target.mozRequestFullScreen();
                } else if (target.msRequestFullscreen) {
                    target.msRequestFullscreen();
                }
            } else {
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                } else if (document.mozCancelFullScreen) {
                    document.mozCancelFullScreen();
                } else if (document.msExitFullscreen) {
                    document.msExitFullscreen();
                }
            }
        }

        function updateFullscreenUI() {
            const isFS = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
            const btn = document.getElementById('fullscreenBtn');
            const badge = document.getElementById('fullscreenBadge');
            
            if (btn) {
                if (isFS) {
                    btn.classList.add('active');
                    btn.style.background = '#059669';
                    btn.style.borderColor = '#10b981';
                    btn.innerHTML = '<i class="fas fa-compress"></i>';
                    btn.title = 'إلغاء ملء الشاشة';
                } else {
                    btn.classList.remove('active');
                    btn.style.background = '#1f2937';
                    btn.style.borderColor = '#374151';
                    btn.innerHTML = '<i class="fas fa-expand"></i>';
                    btn.title = 'ملء الشاشة';
                }
            }
            if (badge) {
                badge.innerHTML = isFS ? '<i class="fas fa-compress"></i> إلغاء ملء الشاشة' : '<i class="fas fa-expand"></i> انقر لملء الشاشة';
            }
        }

        document.addEventListener('fullscreenchange', updateFullscreenUI);
        document.addEventListener('webkitfullscreenchange', updateFullscreenUI);
        document.addEventListener('mozfullscreenchange', updateFullscreenUI);
        document.addEventListener('MSFullscreenChange', updateFullscreenUI);

        // ===== 🔊 تقوية الصوت (Audio Boost) =====
        let audioBoostLevel = 1; // 1 = 100%, 2 = 200%, 3 = 300%
        let audioCtx = null;
        const mediaSourceMap = new WeakMap();

        function toggleAudioBoost() {
            if (audioBoostLevel === 1) audioBoostLevel = 2;
            else if (audioBoostLevel === 2) audioBoostLevel = 3;
            else audioBoostLevel = 1;

            const btn = document.getElementById('audioBoostBtn');
            if (btn) {
                if (audioBoostLevel === 1) {
                    btn.classList.remove('active');
                    btn.style.background = '#1f2937';
                    btn.style.borderColor = '#374151';
                    btn.style.color = '#fff';
                    btn.innerHTML = '<i class="fas fa-volume-up"></i>';
                    btn.title = 'تقوية الصوت (حالية: 100%)';
                } else if (audioBoostLevel === 2) {
                    btn.classList.add('active');
                    btn.style.background = '#059669';
                    btn.style.borderColor = '#10b981';
                    btn.style.color = '#fff';
                    btn.innerHTML = '<i class="fas fa-volume-up"></i><span style="font-size:9px; font-weight:800; position:absolute; bottom:1px; right:3px; color:#fef08a;">200%</span>';
                    btn.title = 'تقوية الصوت (مضاعف 200%)';
                } else {
                    btn.classList.add('active');
                    btn.style.background = '#d97706';
                    btn.style.borderColor = '#f59e0b';
                    btn.style.color = '#fff';
                    btn.innerHTML = '<i class="fas fa-bullhorn"></i><span style="font-size:9px; font-weight:800; position:absolute; bottom:1px; right:3px; color:#ffffff;">300%</span>';
                    btn.title = 'تقوية الصوت (فائق 300%)';
                }
            }

            // 1. Adjust AgoraRTC Remote Audio Track Volume (Agora SDK)
            if (typeof client !== 'undefined' && client && client.remoteUsers) {
                client.remoteUsers.forEach(user => {
                    if (user.audioTrack && typeof user.audioTrack.setVolume === 'function') {
                        try {
                            user.audioTrack.setVolume(audioBoostLevel * 100);
                        } catch(e) { console.warn('Agora setVolume err:', e); }
                    }
                });
            }

            // 2. Web Audio GainNode for HTML Audio/Video Elements
            try {
                if (!audioCtx) {
                    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                }
                if (audioCtx.state === 'suspended') {
                    audioCtx.resume();
                }
                const mediaElems = document.querySelectorAll('video, audio');
                mediaElems.forEach(media => {
                    let entry = mediaSourceMap.get(media);
                    if (!entry) {
                        try {
                            const source = audioCtx.createMediaElementSource(media);
                            const gainNode = audioCtx.createGain();
                            source.connect(gainNode);
                            gainNode.connect(audioCtx.destination);
                            entry = { source, gainNode };
                            mediaSourceMap.set(media, entry);
                        } catch(err) {
                            console.warn('Media element source attach error:', err);
                        }
                    }
                    if (entry && entry.gainNode) {
                        entry.gainNode.gain.value = audioBoostLevel;
                    }
                });
            } catch(e) {
                console.warn('WebAudio Boost Error:', e);
            }
        }

        let isStudentMuted = false;
        let studentRemainingSeconds = ${offer.remaining_time || 0};
        let studentTotalSeconds = ${offer.total_time || (offer.duration_minutes ? offer.duration_minutes * 60 : (offer.duration ? offer.duration * 60 : 3600))};
        if (!studentTotalSeconds || studentTotalSeconds <= 0) studentTotalSeconds = 3600;
        if (studentRemainingSeconds > studentTotalSeconds) studentTotalSeconds = studentRemainingSeconds;

        let isStreamPaused = ${offer.status === 'paused' ? 'true' : 'false'};
        let studentTimerInterval = null;

        function updateStudentTimerDisplay() {
            const display = document.getElementById('studentTimerDisplay');
            if (display) {
                const hours = Math.floor(studentRemainingSeconds / 3600);
                const minutes = Math.floor((studentRemainingSeconds % 3600) / 60);
                const seconds = studentRemainingSeconds % 60;
                const pad = (num) => String(num).padStart(2, '0');
                display.textContent = pad(hours) + ':' + pad(minutes) + ':' + pad(seconds);
                if (isStreamPaused) {
                    display.style.color = '#f59e0b';
                    display.title = 'البث متوقف مؤقتاً';
                } else {
                    display.style.color = '#10b981';
                    display.title = 'البث جاري';
                }
            }

            // حساب شريط إكتمال البث للطالب
            const total = Math.max(1, studentTotalSeconds);
            const elapsed = Math.max(0, total - studentRemainingSeconds);
            const pct = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));

            const pBar1 = document.getElementById('streamProgressBar');
            const pBar2 = document.getElementById('mainStreamProgressBar');
            const pText = document.getElementById('streamProgressPct');

            if (pBar1) pBar1.style.width = pct + '%';
            if (pBar2) pBar2.style.width = pct + '%';
            if (pText) pText.textContent = pct + '%';
        }

        function togglePauseOverlay(show) {
            let overlay = document.getElementById('pauseOverlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'pauseOverlay';
                overlay.style.cssText = 'display:none; position:absolute; inset:0; background:rgba(3, 7, 18, 0.92); backdrop-filter:blur(8px); z-index:50; flex-direction:column; align-items:center; justify-content:center; padding:20px; text-align:center; color:#fff; gap:12px; font-family:Cairo, sans-serif;';
                overlay.innerHTML = '<div style="width:56px; height:56px; border-radius:50%; background:rgba(245, 158, 11, 0.2); border:2px solid #f59e0b; display:flex; align-items:center; justify-content:center; font-size:24px; color:#f59e0b; margin-bottom:4px; animation:pulse 2s infinite;"><i class="fas fa-pause"></i></div><div style="font-size:18px; font-weight:800; color:#fef08a;">الأستاذ أوقف البث مؤقتاً</div><div style="font-size:13px; color:#cbd5e1; max-width:320px; line-height:1.6;">قد يستأنفه قريباً، يرجى الانتظار وعدم المغادرة...</div>';
                const targetContainer = document.getElementById('mediaContainer') || document.querySelector('.video-area');
                if (targetContainer) targetContainer.appendChild(overlay);
            }
            if (overlay) {
                overlay.style.display = show ? 'flex' : 'none';
            }
        }

        function startStudentTimer() {
            if (studentTimerInterval) clearInterval(studentTimerInterval);
            studentTimerInterval = setInterval(() => {
                if (!isStreamPaused && studentRemainingSeconds > 0) {
                    studentRemainingSeconds--;
                    updateStudentTimerDisplay();
                }
            }, 1000);
        }

        async function fetchStudentChatMessages() {
            try {
                const token = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('token');
                const res = await fetch('/api/stream/chat/messages/${offer.id}', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const data = await res.json();
                if (data.success) {
                    if (data.stream_ended) {
                        if (isLeaving) return;
                        isLeaving = true;
                        try { if (client) client.leave(); } catch(e){}
                        alert('🔴 قام الأستاذ بإنهاء البث المباشر.');
                        try { window.close(); } catch(e){}
                        window.location.href = '/student-dashboard.html';
                        return;
                    }
                    if (data.total_seconds && !isNaN(Number(data.total_seconds))) {
                        studentTotalSeconds = Math.max(Number(data.total_seconds), studentRemainingSeconds);
                    }
                    if (data.stream_status !== undefined || data.is_paused !== undefined) {
                        // إظهار التوقف فقط إذا كانت حالة البث صريحة paused
                        const pauseCondition = (data.stream_status === 'paused');
                        isStreamPaused = !!pauseCondition;
                        togglePauseOverlay(isStreamPaused);
                    }
                    if (data.remaining_seconds !== undefined && data.remaining_seconds !== null) {
                        studentRemainingSeconds = Number(data.remaining_seconds);
                        updateStudentTimerDisplay();
                    }
                    isStudentMuted = !!data.is_muted;
                    const input = document.getElementById('chatInput');
                    if (isStudentMuted) {
                        if (input) {
                            input.placeholder = '🔒 تم كتمك من قبل الأستاذ في هذه الحصة';
                            input.disabled = true;
                        }
                    } else {
                        if (input && input.disabled) {
                            input.placeholder = 'اسأل الأستاذ...';
                            input.disabled = false;
                        }
                    }
                    if (data.active_count !== undefined) {
                        const viewersElem = document.getElementById('viewersCount');
                        if (viewersElem) viewersElem.textContent = data.active_count;
                    }
                    renderStudentChat(data.messages || []);
                }
            } catch(e){}
        }

        const currentStudentDbId = ${studentDbId};
        let isFirstStudentChatLoad = true;

        function renderStudentChat(messages) {
            const container = document.getElementById('chatMsgs');
            if (!container) return;

            const isAtBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) <= 80;

            const existingMsgKeys = new Set();
            Array.from(container.children).forEach(child => {
                if (child.dataset && child.dataset.msgKey) {
                    existingMsgKeys.add(child.dataset.msgKey);
                }
            });

            let newMsgCount = 0;
            messages.forEach(m => {
                const msgKey = (m.id || (m.created_at + '_' + m.sender_id)).toString();
                if (existingMsgKeys.has(msgKey)) return;
                newMsgCount++;

                const isSentByMe = (m.sender_id == currentStudentDbId && m.sender_role === 'student');
                const isTeacher = (m.sender_role === 'teacher');

                const div = document.createElement('div');
                div.className = 'chat-msg' + (isSentByMe ? ' sent' : '');
                div.dataset.msgKey = msgKey;

                let roleBadge = '';
                if (isTeacher) {
                    roleBadge = ' <span style="background:#2563eb; color:white; font-size:10px; padding:1px 5px; border-radius:4px; margin-right:4px;">الأستاذ</span>';
                } else if (!isSentByMe) {
                    roleBadge = ' <span style="background:#374151; color:#9ca3af; font-size:10px; padding:1px 5px; border-radius:4px; margin-right:4px;">طالب</span>';
                }

                const senderDisplayName = isSentByMe ? 'أنت' : escapeHtml(m.sender_name || 'طالب');
                div.innerHTML = '<div class="sender" style="font-weight:700; font-size:11px; margin-bottom:3px;">' + senderDisplayName + roleBadge + '</div>' + escapeHtml(m.message);
                container.appendChild(div);
            });

            if (isFirstStudentChatLoad || (newMsgCount > 0 && isAtBottom)) {
                container.scrollTop = container.scrollHeight;
                isFirstStudentChatLoad = false;
            }
        }

        async function sendChatMessage() {
            if (isStudentMuted) {
                alert('⚠️ تم كتمك من قبل الأستاذ في هذه الحصة، لا يمكنك إرسال رسائل');
                return;
            }
            const input = document.getElementById('chatInput');
            const msg = input.value.trim();
            if (!msg) return;
            try {
                const token = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('token');
                const res = await fetch('/api/stream/chat/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ offer_id: ${offer.id}, message: msg, sender_name: typeof userName !== 'undefined' ? userName : '' })
                });
                const data = await res.json();
                if (data.success) {
                    input.value = '';
                    fetchStudentChatMessages();
                } else {
                    alert(data.error || 'فشل إرسال الرسالة');
                }
            } catch(e) { console.error('Send chat error:', e); }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.innerText = text;
            return div.innerHTML;
        }

        function notifyStudentLeave() {
            try {
                const token = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('token');
                const url = '/api/stream/leave/' + ${offer.id} + '?token=' + encodeURIComponent(token);
                if (navigator.sendBeacon) {
                    navigator.sendBeacon(url);
                } else {
                    fetch(url, { method: 'POST', keepalive: true });
                }
            } catch(e){}
        }

        window.addEventListener('beforeunload', notifyStudentLeave);
        window.addEventListener('pagehide', notifyStudentLeave);

        let isLeaving = false;
        async function leaveSession() {
            isLeaving = true;
            notifyStudentLeave();
            if (client) {
                try { client.leave().catch(e => console.warn('Agora client leave:', e)); } catch(e){}
            }
            window.close();
            window.location.href = '/student-dashboard.html';
        }

        document.addEventListener('DOMContentLoaded', () => {
            startStudentTimer();
            updateStudentTimerDisplay();
            initAgora();
            fetchStudentChatMessages();
            setInterval(fetchStudentChatMessages, 1200);
        });
    </script>
</body>
</html>
    `;
}

// ============================================================
// ✅ استيراد المسارات
// ============================================================

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const teacherRoutes = require('./routes/teacher');
const studentRoutes = require('./routes/student');
const offerRoutes = require('./routes/offer');
const publicRoutes = require('./routes/public');
const bookingRoutes = require('./routes/booking');
const streamRoutes = require('./routes/stream');
const postRoutes = require('./routes/post');
const messageRoutes = require('./routes/message');
const supportRoutes = require('./routes/support');
const referralRoutes = require('./routes/referral');
const walletRoutes = require('./routes/wallet');
const notificationRoutes = require('./routes/notification');
const courseRoutes = require('./routes/course');
const groupRoutes = require('./routes/group');
const blogRoutes = require('./routes/blog');
const exerciseRoutes = require('./routes/exercise');

// ============================================================
// ✅ استخدام المسارات - الترتيب مهم جداً!
// ============================================================

// ✅ 1. المسارات العامة (لا تحتاج مصادقة)
app.use('/api', publicRoutes);
app.use('/api/public', publicRoutes);

// ✅ 2. مسارات المصادقة (تسجيل الدخول، تسجيل طالب، تسجيل أستاذ)
app.use('/api', authRoutes);

// ✅ 3. مسارات الإدارة (تحتاج مصادقة إدارية)
app.use('/api/admin', adminRoutes);

// ✅ 4. مسارات الأ��تاذ ��ا��طالب (ت��ت��ج مصادقة)
app.use('/api/teacher', authenticate, teacherRoutes);
app.use('/api/student', authenticate, studentRoutes);

// ✅ 5. باقي المسارات
app.use('/api', offerRoutes);
app.use('/api/course', courseRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/booking', bookingRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api/chat', streamRoutes);
app.use('/api/post', postRoutes);
app.use('/api/exercise', exerciseRoutes);
app.use('/api/exercises', exerciseRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api', blogRoutes);

// ============================================================
// 🤖 ذكاء اصطناعي مجاني بالكامل - ملخصات وشروح مع الصور
// ============================================================
let aiGateway = null;
async function getAiGateway() {
    if (!aiGateway) {
        if (!process.env.AI_GATEWAY_API_KEY) {
            throw new Error('AI_GATEWAY_API_KEY غير مضبوط في بيئة الخادم.');
        }
        const { createGateway } = await import('@ai-sdk/gateway');
        aiGateway = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
    }
    return aiGateway;
}

app.post('/api/ai/summarize', async (req, res) => {
    try {
        const { subject, lesson, education_level, specialty } = req.body;
        if (!subject || !lesson) {
            return res.status(400).json({
                success: false,
                error: 'يرجى اختيار المادة وتحديد الدرس لبدء المراجعة الذكية'
            });
        }

        const levelText = (education_level && education_level !== 'غير محدد') ? education_level : 'الطور الدراسي العام';
        const cleanLesson = lesson.trim();

        let explanation = '';
        try {
            const gateway = await getAiGateway();
            const { generateText } = await import('ai');
            const prompt = `أنت بروفيسور وعالم تربوي وأستاذ أطروحات متميز، خبير في المناهج الرسمية والبرامج التعليمية الجزائرية.
الطالب يدخل المستوى: ${levelText}، الشعبة أو التخصص: ${specialty || 'غير محدد'}، والمادة: ${subject}.
قبل الكتابة استخدم Google Search للعثور على ��صادر موثوقة وحديثة تخص هذا الدرس والمستوى، ثم تحقّق من توافقها. لا تخمّن ولا تنشئ معلومات عامة غير مستندة إلى المصادر. اذكر في نهاية الشرح المصادر التي اعتمدت عليها بروابطها إن توفرت.
المطلوب منك كتابة **شرح فعلي دقيق ومبسّط** لدرس: "${cleanLesson}".

تعليمات صارمة لا تقبل التراجع لضمان فهم الطالب فهماً تاماً وعميقاً ومبسطاً:
1. **مبدأ التبسيط والتفصيل (Simplify & Detail):**
   - اشرح كل مفهوم بأبسط الطرق ثم عمّقه تدريجياً. استخدم تشبيهات من الحياة اليومية لتقريب الفكرة قبل الذهاب للتفاصيل العلمية.
   - ممنوع نهائياً الإيجاز أو السطحية. اشرح نقطة بنقطة، مصطلحاً بمصطلح، وكأنك تلقي محاضرة لطالب يسمع الدرس لأول مرة.
2. **الهيكل الإلزامي المفصل للدرس (أقسام واضحة ومقسّمة):**
   - **### 1️⃣ مقدمة علمية وإشكالية الدرس**: مدخل مبسط، تشبيه أولي، الأهمية المعرفية، ولماذا ندرس هذا الموضوع.
   - **### 2️⃣ المفاهيم الأساسية (بأسلوب مبسط)**: اشرح كل مصطلح أو مفهوم جديد في فقرة مستقلة مع تشبيه يومي، ثم تعريف علمي دقيق.
   - **### 3️⃣ الشرح النظري المفصل (Deep Theory)**: تفصيل دقيق لجميع القواعد والنظريات والقوانين مع جداول مقارنة، مع شرح كل رمز ورمز.
   - **### 4️⃣ أمثلة تطبيقية مشروحة خطوة بخطوة**: مثالان على الأقل، كل مثال يُحلّ بشرح سطري كامل: المعطيات ← المطلوب ← القانون ← التعويض ← النتيجة ← التعليل.
   - **### 5️⃣ تمارين مقترحة مع الحلول النموذجية:**
     - **#### 📝 التمرين التطبيقي الأول (مستوحى من الامتحانات الرسمية)**: نص تمرين واضح.
     - **#### 🔑 الحل النموذجي المفصل خطوة بخطوة**: حل كامل مشروح بالكامل.
     - **#### 📝 التمرين التطبيقي الثاني**: نص تمرين إضافي.
     - **#### 🔑 الحل النموذجي المفصل للتمرين الثاني**: حل كامل ومفصل.
   - **### 6️⃣ خلاصة الدرس (Summary)**: ملخص في 5-7 نقاط مختصرة للمراجعة السريعة.
   - **### 7️⃣ نصائح الأستاذ الخبير للتميز وضمان العلامة الكاملة**.
3. **لغة الإخراج:** باللغة العربية الفصحى الأكاديمية المبسطة وبصيغة Markdown الغنية والمنسقة باحترافية.
4. **المعادلات الرياضية:** استخدم صيغة LaTeX بين رموز $ للمعادلات السطرية و $ للمعادلات المعروضة.`;

            const result = await generateText({
                model: gateway('google/gemini-3.1-pro-preview'),
                system: 'أنت معلم جزائري دقيق. لا تختلق معلومات، واشرح فقط ما تعرفه بثقة وبأسلوب مبسط.',
                prompt
            });
            explanation = result.text || '';
        } catch (aiErr) {
            console.error('❌ فشل البحث أو توليد الشرح الحقيقي:', aiErr.message);
            return res.status(502).json({
                success: false,
                error: 'تعذر البحث عن الدرس أو توليد شرح موثوق حالياً. يرجى المحاولة مرة أخرى.'
            });
        }

        res.json({
            success: true,
            explanation
        });
    } catch (error) {
        console.error('❌ خطأ في تلخيص الدرس:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ المعلم الذكي (AI Tutor) - محادثة تفاعلية مع الطالب/الأستاذ ونظام النقاط
// ============================================================
app.post('/api/ai/chat', authenticate, async (req, res) => {
    try {
        const userId = req.user?.userId;
        const userRole = req.user?.role || req.user?.userType || 'student';
        if (!userId || userId === -1 || userId === '-1') {
            return res.status(401).json({ success: false, error: 'يجب تسجيل الدخول للوصول إلى Zoomy.' });
        }

        let isTeacher = (userRole === 'teacher');
        let student = null;
        let teacher = null;

        if (isTeacher) {
            teacher = await getOne('teachers', 'id', userId);
        } else {
            student = await getOne('students', 'id', userId);
            if (!student) {
                // تجربة البحث في الأساتذة احتياطياً
                teacher = await getOne('teachers', 'id', userId);
                if (teacher) isTeacher = true;
            }
        }

        if (!student && !teacher) {
            return res.status(404).json({ success: false, error: 'المستخدم غير موجود.' });
        }

        // إذا كان أستاذ ولم يتم إضافة عمود النقاط لديه بعد، يمنح نقاط غير محدودة، أما إذا تمت إضافته فيعمل بنظام النقاط اليومية
        let userObj = isTeacher ? teacher : student;
        let userTable = isTeacher ? 'teachers' : 'students';
        let hasCustomTokens = userObj?.ai_tokens !== undefined && userObj?.ai_tokens !== null;
        let currentTokens = hasCustomTokens ? userObj.ai_tokens : (isTeacher ? 999999 : 50);
        
        if (hasCustomTokens || (!isTeacher && student)) {
            const now = new Date();
            const lastResetStr = userObj.last_ai_reset;
            const lastReset = lastResetStr ? new Date(lastResetStr) : null;
            
            const isNewDay = !lastReset || 
                now.getFullYear() !== lastReset.getFullYear() || 
                now.getMonth() !== lastReset.getMonth() || 
                now.getDate() !== lastReset.getDate();
                
            if (isNewDay) {
                currentTokens = 50;
                try {
                    await update(userTable, userId, {
                        ai_tokens: 50,
                        last_ai_reset: now.toISOString()
                    });
                    console.log(`⏳ [Zoomy] تم تجديد النقاط المجانية اليومية (50 نقطة) للمستخدم ${userId}`);
                } catch (dbErr) {
                    console.warn('⚠️ Could not update last_ai_reset or ai_tokens in chat endpoint:', dbErr.message);
                }
            }

            if (currentTokens <= 0) {
                return res.status(403).json({ 
                    success: false, 
                    error: 'لقد نفدت نقاط Zoomy المتاحة لك لهذا اليوم. تجدد النقاط المجانية تلقائياً كل يوم، أو يمكنك شحن نقاط إضافية للمتابعة الآن!',
                    out_of_tokens: true
                });
            }
        }

        const { messages = [], imageBase64, mimeType = 'image/jpeg', education_level = 'غير محدد', model = 'gemini-3.6-flash' } = req.body || {};
        
        // رسم خريطة النماذج لضمان استخدام النماذج الحديثة والمدعومة
        let selectedModel = 'gemini-3.6-flash';
        const requestedModel = String(model || '');
        if (requestedModel === 'gemini-1.5-pro' || requestedModel === 'gemini-3.1-pro-preview') {
            selectedModel = 'gemini-3.1-pro-preview';
        } else if (requestedModel === 'gemini-3.7-flash') {
            selectedModel = 'gemini-3.7-flash';
        } else {
            selectedModel = 'gemini-3.6-flash';
        }

        const cleanMessages = Array.isArray(messages) ? messages.slice(-20).map(message => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: String(message.content || '').slice(0, 12000) }]
        })).filter(message => message.parts[0].text.trim()) : [];
        
        if (!cleanMessages.length && !imageBase64) return res.status(400).json({ success: false, error: 'اكتب سؤالك أو أرفق صورة أولاً.' });
        if (!process.env.GEMINI_API_KEY) return res.status(503).json({ success: false, error: 'محرك الذكاء الاصطناعي غير مضبوط حالياً.' });
        
        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        const prompt = `أنت معلم ذكاء اصطناعي عربي ودود واسمك Zoomy لمنصة ZoomDz التعليمية بالجزائر. ساعد الطالب في أي موضوع بأسلوب ممتع ومشجع، واشرح بالفصحى المبسطة المناسبة لمستواه الدراسي (${education_level}).
عند حل أي مسألة أو تمرين:
1. اذكر المعطيات بوضوح.
2. حدد المنهجية المتبعة.
3. اكتب الحل خطوة بخطوة مع شرح كل خطوة.
4. اكتب القوانين والمعادلات الرياضية أو الفيزيائية بشكل كامل وصحيح باستخدام صيغة LaTeX ووضعها بين علامتي دولار مزدوجة $$ للمعادلات الكبيرة المنفصلة (مثال: $$ROI = \\left( \\frac{0.80}{1.00} \\right) \\times 100\\%$$) أو علامة دولار مفردة $ للمعادلات المدمجة داخل السطر.
5. تحقق من صحة الحل بشكل مختصر في النهاية.

إذا أرسل الطالب صورة، فحلل محتواها بدقة واشرح تفاصيلها تبعا لأسئلته. وإذا لم تكن الصورة تعليمية أو واضحة، فاطلب منه بلطف رفع صورة أوضح لمساعدته.`;

        const last = cleanMessages[cleanMessages.length - 1] || { role: 'user', parts: [{ text: 'حلل الصورة المرفقة وقدم المساعدة.' }] };
        if (imageBase64) {
            const data = String(imageBase64).replace(/^data:[^;]+;base64,/, '');
            last.parts.push({ inlineData: { mimeType, data } });
        }
        
        // محاولة استدعاء النموذج المحدد مع تفعيل التبديل والتبديل التلقائي الاحتياطي في حال الفشل
        const modelPool = ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.1-pro-preview'];
        const order = [selectedModel, ...modelPool.filter(m => m !== selectedModel)];
        
        let response = null;
        let lastError = null;
        let activeModelUsed = selectedModel;
        
        for (const currentModel of order) {
            try {
                console.log(`🤖 [Zoomy] Trying Gemini model: ${currentModel}...`);
                response = await ai.models.generateContent({ 
                    model: currentModel, 
                    contents: [{ role: 'user', parts: [{ text: prompt }] }, ...cleanMessages.slice(0, -1), last] 
                });
                activeModelUsed = currentModel;
                console.log(`✅ [Zoomy] Success with Gemini model: ${currentModel}`);
                break;
            } catch (err) {
                console.warn(`⚠️ [Zoomy] Gemini model ${currentModel} failed:`, err.message);
                lastError = err;
            }
        }
        
        if (!response) {
            throw new Error(`تعذر الاتصال بجميع نماذج الذكاء الاصطناعي المتاحة حالياً. الخطأ الأخير: ${lastError ? lastError.message : 'غير معروف'}`);
        }
        
        const messageText = typeof response.text === 'function'
            ? await response.text()
            : response.text || response.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
            
        if (!messageText) {
            throw new Error('فشل توليد نص الإجابة من نموذج الذكاء الاصطناعي.');
        }

        // تخصم نقطة واحدة فقط للمستخدم بعد نجاح توليد الإجابة (إذا كان لديه نقاط محددة)
        let finalTokens = currentTokens;
        if (currentTokens !== 999999) {
            finalTokens = Math.max(0, currentTokens - 1);
            try {
                await update(userTable, userId, { ai_tokens: finalTokens });
            } catch (e) {}
        }

        return res.json({ 
            success: true, 
            message: messageText,
            ai_tokens: currentTokens === 999999 ? 999999 : finalTokens
        });
    } catch (error) {
        console.error('[v0] AI chat error:', error.message);
        return res.status(502).json({ success: false, error: 'تعذر الاتصال بالمعلم الذكي Zoomy أو انتهت صلاحية الجلسة. حاول مرة أخرى.' });
    }
});



/**
 * @route   POST /api/ai/platform-assistant
 * @desc    المساعد الذكي التفاعلي المخصص لمنصة ZoomDz (الأقسام، كيفية العمل، طرق السحب والشحن، والتنقل السريع)
 * @access  Public / Authenticated
 */
app.post('/api/ai/platform-assistant', async (req, res) => {
    try {
        const { message, messages = [], role = 'user' } = req.body || {};
        const userPrompt = String(message || (messages[messages.length - 1]?.content) || '').trim();
        if (!userPrompt) {
            return res.status(400).json({ success: false, error: 'الرجاء كتابة سؤالك' });
        }

        const systemInstruction = `أنت "مساعد منصة ZoomDz الذكي" الرسمي (المنصة الجزائرية لدروس الدعم والتعليم التفاعلي عن بعد عبر الـ 58 ولاية).
مهمتك الحصرية هي الإجابة عن كل ما يخص منصة ZoomDz وكيفية عملها، وأقسامها، والتنقل السريع إليها، وطرق سحب الأرباح وشحن الرصيد.

القواعد والتعليمات الصارمة:
1. الإجابة حصراً عن منصة ZoomDz والخدمات التعليمية المتوفرة فيها.
2. إذا سألك المستخدم عن أي موضوع عام خارج إطار المنصة (مثل أسئلة عامة أو مواضيع لا علاقة لها بالمنصة)، اعتذر منه بلباقة واشرح أنك مخصص للإجابة عن خدمات ومنصة ZoomDz واستخداماتها وأقسامها وسحب الأرباح وشحن الرصيد.
3. تفاصيل المنصة الأساسية:
   - سحب الأرباح (للأساتذة): يتم عبر بريدي موب (BaridiMob) أو الحساب البريدي الجاري (CCP). الحد الأدنى 500 دج. وقت التحقق والمعالجة 24 ساعة كحد أقصى مع إشعار بالتحويل.
   - شحن الرصيد (للطلاب): متاح عبر بريدي موب، البطاقة الذهبية، CIB، أو رفع وصل التحويل في قسم المعاملات.
   - الحصص والبث المباشر: عبر تقنيات Agora و Jitsi المدمجة، وتدعم الصوت والصورة والسبورة التفاعلية ومشاركة الشاشة.
   - الميزات الجديدة:
     * زر زائد (+) لإرفاق الصور والملفات بمختلف الأنواع (PDF, Word, Excel, ZIP, Images).
     * زر الكاميرا (📷) لالتقاط الصور الحية فوراً من الهاتف أو الحاسوب.
     * أيقونة المساعد الذكي الدائرية القابلة للتحريك لأي مكان على الشاشة.
   - صندوق الهدايا اليومي: فتح صندوق يومي لربح رصيد مجاني يضاف للمحفظة.
   - نظام الإحالة: كسب مكافأة مالية عند دعوة الأصدقاء.
4. عندما تقترح الانتقال إلى قسم معين في المنصة، أضف كود التوجيه في سطر مستقل:
   [[NAV:اسم_القسم:عنوان الزر]]
   مثل:
   [[NAV:earnings:الانتقال إلى قسم المحفظة والأرباح]]
   [[NAV:transactions:الانتقال إلى المعاملات وشحن الرصيد]]
   [[NAV:offers:الانتقال إلى الحصص المباشرة]]
   [[NAV:courses:الانتقال إلى الدورات التعليمية]]
   [[NAV:exercises:الانتقال إلى التمارين والواجبات]]
   [[NAV:groups:الانتقال إلى المجموعات التعليمية]]
   [[NAV:posts:الانتقال إلى منشورات الأساتذة]]
   [[NAV:messages:الانتقال إلى الرسائل المباشرة]]
   [[NAV:referral:الانتقال إلى نظام الإحالة]]
5. تحدث بأسلوب عربي ودود، منسق بالنقاط، مع الرموز التعبيرية المناسبة.`;

        if (process.env.GEMINI_API_KEY) {
            try {
                const { GoogleGenAI } = require('@google/genai');
                const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
                const contents = [
                    { role: 'user', parts: [{ text: userPrompt }] }
                ];
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents,
                    config: {
                        systemInstruction
                    }
                });
                const messageText = (typeof response.text === 'function' ? response.text() : response.text) || '';
                if (messageText) {
                    return res.json({ success: true, message: messageText });
                }
            } catch (aiError) {
                console.warn('⚠️ Fallback AI for platform assistant:', aiError.message);
            }
        }

        // Fallback response generator if API key is not present or failed
        let fallbackMsg = `أهلاً بك في منصة **ZoomDz التعليمية**! 👋
أنا مساعدك الذكي المخصص لخدمات المنصة:
- 💰 **سحب الأرباح:** متاح عبر بريدي موب (BaridiMob) و CCP بحد أدنى 500 دج.
- 💳 **شحن الرصيد:** عبر بريدي موب والبطاقة الذهبية ورفع الوصل.
- 🎥 **الحصص المباشرة:** بث تفاعلي مع سبورة ومشاركة شاشة.
- 📁 **إرفاق الملفات (+):** زر لرفع المستندات والصور، وزر (📷) لالتقاط الصور فوراً.

[[NAV:offers:استعراض الحصص والدروس]]
[[NAV:earnings:الانتقال إلى المحفظة]]`;

        const q = userPrompt.toLowerCase();
        if (q.includes('سحب') || q.includes('ارباح') || q.includes('أرباح') || q.includes('بريدي') || q.includes('ccp')) {
            fallbackMsg = `💰 **دليل سحب الأرباح في منصة ZoomDz:**
1. **طرق السحب المتاحة:**
   - 📱 **بريدي موب (BaridiMob):** تحويل مباشر إلى حسابك عبر رقم RIP.
   - 📮 **الحساب البريدي الجاري (CCP):** عبر رقم الحساب والمفتاح (Clé CCP).
2. **الحد الأدنى للسحب:** 500 دج.
3. **مدة المعالجة:** يتم التحقق والتحويل خلال **24 ساعة** كحد أقصى مع إشعار بحالة السحب.
4. **خطوات تقديم الطلب:** ادخل إلى قسم **المحفظة / الأرباح** ثم اضغط على زر **"طلب سحب الأرباح"** وأدخل بياناتك.

[[NAV:earnings:الانتقال إلى قسم المحفظة والأرباح]]`;
        } else if (q.includes('شحن') || q.includes('رصيد') || q.includes('دفع') || q.includes('تعبئة')) {
            fallbackMsg = `💳 **دليل شحن الرصيد في منصة ZoomDz:**
- يمكنك شحن محفظتك للاشتراك في الحصص والدورات عبر:
  1. 📱 **بريدي موب (BaridiMob)** أو **البطاقة الذهبية / CIB**.
  2. 🧾 **رفع وصل التحويل (Reçu):** قم بالتحويل ثم ارفع صورة الوصل في قسم المعاملات ليتم اعتماد رصيدك فوراً.
- كما يمكنك الحصول على رصيد مجاني يومياً عبر **صندوق الهدايا 🎁** و**نظام الإحالة 🏆**.

[[NAV:transactions:الانتقال إلى قسم المعاملات وشحن الرصيد]]`;
        } else if (q.includes('قسم') || q.includes('أقسام') || q.includes('اقسام') || q.includes('كيف تعمل') || q.includes('شرح')) {
            fallbackMsg = `🧭 **أقسام ودليل استخدام منصة ZoomDz:**
- 🎓 **الحصص والدروس (Offers):** استعراض الحصص المباشرة والدروس الخصوصية المتاحة وحجزها.
- 📚 **الدورات (Courses):** الدورات المسجلة والفيديوهات التعليمية الشاملة.
- 📝 **التمارين والواجبات (Exercises):** بنك التمارين التفاعلية وحلولها.
- 👥 **المجموعات (Groups):** غرف الدردشة الجماعية مع الأساتذة ومشاركة الملفات.
- 📰 **المنشورات (Posts):** نصائح الأساتذة والمذكرات والملخصات.
- 💬 **الرسائل (Messages):** التواصل الفردي المباشر مع إرفاق الملفات (+) والتقاط الصور (📷).
- 🤖 **المعلم الذكي (AI Tutor):** تحليل صور التمارين وحلها خطوة بخطوة.
- 🎁 **صندوق الهدايا (Mystery Box):** فتح صندوق يومي لربح رصيد مجاني.

[[NAV:offers:استعراض الحصص المتاحة]]`;
        } else if (q.includes('ارفاق') || q.includes('إرفاق') || q.includes('ملف') || q.includes('صورة') || q.includes('كاميرا') || q.includes('التقاط')) {
            fallbackMsg = `📁 **ميزة إرفاق الملفات والتقاط الصور الجديدة:**
1. ➕ **زر الإرفاق (+):** تجده بجانب صندوق الكتابة في الرسائل والمجموعات والمعلم الذكي لإرفاق أي صورة (PNG, JPG, WEBP) أو ملف مستندات (PDF, Word, Excel, ZIP).
2. 📷 **زر التقاط الصور (الكاميرا):** يتيح لك فتح كاميرا هاتفك أو حاسوبك فوراً والتقاط صورة لتمرين أو مذكرة وإرسالها بضغطة زر واحدة.
3. 🔍 **معاينة قبل الإرسال:** يمكنك فحص الصورة أو الملف وإلغاء المرفق أو تأكيد إرساله بسهولة.`;
        }

        return res.json({
            success: true,
            fallback: true,
            message: fallbackMsg
        });
    } catch (err) {
        console.error('Platform Assistant Error:', err);
        return res.status(500).json({ success: false, error: 'حدث خطأ أثناء معالجة الطلب' });
    }
});

/**
 * @route   POST /api/ai/solve-image
 * @desc    تحليل صورة تمرين دراسي بالذكاء الاصطناعي والتحقق منها وحلها خطوة بخطوة مع رفض فوري للصور غير الدراسية
 * @access  Public / Students
 */
app.post('/api/ai/chat', async (req, res) => {
    try {
        const { messages = [], imageBase64, mimeType = 'image/jpeg', education_level = 'غير محدد' } = req.body || {};
        const cleanMessages = Array.isArray(messages) ? messages.slice(-20).map(message => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: String(message.content || '').slice(0, 12000) }]
        })).filter(message => message.parts[0].text.trim()) : [];
        if (!cleanMessages.length && !imageBase64) return res.status(400).json({ success: false, error: 'اكتب سؤالك أو أرفق صورة أولاً.' });
        if (!process.env.GEMINI_API_KEY) return res.status(503).json({ success: false, error: 'محرك الذكاء الاصطناعي غير مضبوط حالياً.' });
        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const prompt = `أنت معلم ذكاء اصطناعي عربي ودود لمنصة ZoomDz. ساعد الطالب في أي موضوع، واشرح بالفصحى المبسطة المناسبة لمستواه (${education_level}). لا تخترع معلومات، واطلب توضيحاً عند الحاجة. عند حل مسألة: اذكر الم��طيات ثم المنهجية ثم الحل خطوة بخطوة ثم تحققاً مختصراً. استخدم Markdown وLaTeX بين $$ للمعادلات. إذا أرسل الطالب صورة فحلل محتواها واذكر ما تراه بوضوح، وإذا لم تكن تعليمية فاطلب منه صورة أوضح. اجعل إجابتك عملية ومشجعة دون مبالغة.`;
        const last = cleanMessages[cleanMessages.length - 1] || { role: 'user', parts: [{ text: 'حلل الصورة المرفقة وقدم المساعدة.' }] };
        if (imageBase64) {
            const data = String(imageBase64).replace(/^data:[^;]+;base64,/, '');
            last.parts.push({ inlineData: { mimeType, data } });
        }
        const response = await ai.models.generateContent({ model: 'gemini-3.6-flash', contents: [{ role: 'user', parts: [{ text: prompt }] }, ...cleanMessages.slice(0, -1), last] });
        const messageText = typeof response.text === 'function'
            ? await response.text()
            : response.text || response.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
        return res.json({ success: true, message: messageText || 'لم أستطع توليد إجابة الآن.' });
    } catch (error) {
        console.error('[v0] AI chat error:', error.message);
        return res.status(502).json({ success: false, error: 'تعذر الاتصال بالمعلم الذكي. حاول مرة أخرى.' });
    }
});

app.post('/api/ai/solve-image', async (req, res) => {
    try {
        const { imageBase64, mimeType = 'image/jpeg', education_level, notes } = req.body;

        if (!imageBase64) {
            return res.status(400).json({
                success: false,
                error: 'يرجى تقديم صورة التمرين أولاً'
            });
        }

        // Clean up base64 string
        let cleanBase64 = imageBase64;
        let detectedMime = mimeType;
        if (imageBase64.includes(';base64,')) {
            const parts = imageBase64.split(';base64,');
            detectedMime = parts[0].replace('data:', '') || 'image/jpeg';
            cleanBase64 = parts[1];
        }

        // Fast validation on minimal payload
        if (!cleanBase64 || cleanBase64.length < 200) {
            return res.json({
                success: false,
                noExercise: true,
                message: 'الصور�� غير واضحة أو تالفة. يرجى التقاط أو رفع صورة واضحة لنص تمرين أو مسألة مدرسية.'
            });
        }

        const levelText = (education_level && education_level !== 'غير محدد') ? education_level : 'الطور الدراسي العام';

        if (process.env.GEMINI_API_KEY) {
            try {
                const { GoogleGenAI } = require('@google/genai');
                const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

                const prompt = `أنت مصحح ومحلل أكاديمي فائق الدقة لمنصة ZoomDz التعليمية للطو�� (${levelText}).
مهمتك الصارمة الأولى هي فحص وتصنيف الصورة المرفقة قبل أي شيء:

1. تصنيف محتوى الصورة:
- إذا كانت الصورة عبارة عن: صورة شخصية (سيلفي، وجه إنسان، شخص، مجموعة أشخاص)، أو صورة منظر طبيعي، حيوان، طعام، سيارة، أثاث، خلفية فارغة، صورة عشوائية، أو أي شيء لا يمثل نص مسألة، تمرين دراسي، امتحان، أو واجب أكاديمي:
  يجب فوراً وحتماً تعيين is_exercise = false وكتابة سبب الرفض في rejection_reason (مثال: "الصورة المرفقة صورة شخصية/غير أكاديمية ولا تحتوي على أي نص لتمرين أو مسألة دراسية").

2. إذا كانت الصورة تحتوي فعلاً على تمرين أو مسألة أو واجب دراسي:
  - عيّن is_exercise = true.
  - استخرج نص المسألة أو الأسئلة بوضوح.
  - حدد المادة والموضوع.
  - اكتب حلاً نموذجياً شاملاً ومفصلاً خطوة بخطوة بالمنهجية المعتمدة، مع استخدام $ للمعادلات الرياضية.
  - صغ الحل في solution_markdown.
  ${notes ? `- ملاحظات إضافية من الطالب: ${notes}` : ''}

يجب أن تكون الإجابة حصراً بصيغة JSON وفق الهيكل التالي:
{
  "is_exercise": true | false,
  "rejection_reason": "سبب الرفض باللغة العربية إن لم تكن تمريناً",
  "subject": "اسم المادة إن كانت تمريناً",
  "topic": "الموضوع المستنتج",
  "exercise_text": "نص المسألة المستخرجة",
  "solution_markdown": "الحل الكامل المنسق بصيغة Markdown الغنية فقط إذا كانت is_exercise=true وإلا اتركها فارغة"
}`;

                // Try gemini-3.6-flash first, fallback to gemini-3.1-pro-preview
                let response;
                try {
                    response = await ai.models.generateContent({
                        model: 'gemini-3.6-flash',
                        contents: [
                            {
                                role: 'user',
                                parts: [
                                    {
                                        inlineData: {
                                            mimeType: detectedMime,
                                            data: cleanBase64
                                        }
                                    },
                                    {
                                        text: prompt
                                    }
                                ]
                            }
                        ],
                        config: {
                            responseMimeType: 'application/json'
                        }
                    });
                } catch (modelErr) {
                    console.warn('Fallback to gemini-3.1-pro-preview for vision:', modelErr.message);
                    response = await ai.models.generateContent({
                        model: 'gemini-3.1-pro-preview',
                        contents: [
                            {
                                role: 'user',
                                parts: [
                                    {
                                        inlineData: {
                                            mimeType: detectedMime,
                                            data: cleanBase64
                                        }
                                    },
                                    {
                                        text: prompt
                                    }
                                ]
                            }
                        ],
                        config: {
                            responseMimeType: 'application/json'
                        }
                    });
                }

                const rawText = response.text || '{}';
                let parsedResult;
                try {
                    parsedResult = JSON.parse(rawText);
                } catch (jsonErr) {
                    // In case of markdown-wrapped JSON
                    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        parsedResult = JSON.parse(jsonMatch[0]);
                    } else {
                        parsedResult = { is_exercise: false, rejection_reason: 'تعذر التحقق من محتوى الصورة' };
                    }
                }

                if (!parsedResult.is_exercise) {
                    const message = parsedResult.rejection_reason || 'الصورة المرفقة لا تحتوي على نص مسألة أو تمرين دراسي (مثال: صورة شخصية أو غير أكاديمية). يرجى رفع أو التقاط صورة واضحة لنص تمرين مدرسي.';
                    return res.json({
                        success: false,
                        noExercise: true,
                        message: message
                    });
                }

                let finalMarkdown = parsedResult.solution_markdown || '';
                if (!finalMarkdown && parsedResult.exercise_text) {
                    finalMarkdown = `### 📌 نص المسألة المستخرجة (${parsedResult.subject || 'مادة دراسية'})\n\n${parsedResult.exercise_text}`;
                }

                return res.json({
                    success: true,
                    subject: parsedResult.subject || 'تمرين دراسي',
                    topic: parsedResult.topic || '',
                    solutionMarkdown: finalMarkdown
                });

            } catch (geminiError) {
                console.error('❌ خطأ في فحص وحل صورة التمرين عبر الذكاء الاصطناعي:', geminiError.message);
                return res.status(422).json({
                    success: false,
                    noExercise: true,
                    message: 'تعذر التحقق من وجود تمرين دراسي في الصورة المرفقة. يرجى التأكد من تصوير مسألة أو تمرين مدرسي بإضاءة وزاوية واضحة.'
                });
            }
        }

        // في حال عدم توفر الذكاء الاصطناعي، نطلب من الطالب تقديم صورة صريحة
        return res.status(503).json({
            success: false,
            error: 'خدمة الرؤية الحاسوبية غير متوفرة حالياً، يرجى المحاولة لاحقاً.'
        });

    } catch (error) {
        console.error('❌ خطأ غير متوقع في معالجة صورة التمرين:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'حدث خطأ أثناء معالجة الصورة'
        });
    }
});

/**
 * @route   POST /api/ai/exercise-variation
 * @desc    توليد تمرين تطبيقي جديد بأفكار متنوعة وحل مفصل لدرس معين دون إعادة توليد كامل الدرس
 * @access  Public / Students
 */
app.post('/api/ai/exercise-variation', async (req, res) => {
    try {
        const { subject, lesson, education_level, seed } = req.body;

        if (!subject || !lesson) {
            return res.status(400).json({
                success: false,
                error: 'يرجى تحديد المادة واسم الدرس'
            });
        }

        const levelText = (education_level && education_level !== 'غير محدد') ? education_level : 'الطور الدراسي العام';
        const cleanLesson = lesson.trim();
        const variationSeed = Number(seed) || Math.floor(Math.random() * 1000);

        if (!process.env.GEMINI_API_KEY) {
            return res.status(400).json({ success: false, error: 'GEMINI_API_KEY is not configured' });
        }

        const ai = getAiClient();
        const prompt = `أنت أستاذ ومستشار تربوي خبير في المنهاج الجزائري.
المادة: ${subject}
الدرس: ${cleanLesson}
المستوى: ${levelText}

قم بتوليد **تمرين تطبيقي جديد كلياً ومبتكر** (فكرة مغايرة تماماً برقم ${variationSeed}) خاص حصرياً بدرس "${cleanLesson}"، ومرفقاً بحله النموذجي المفصل خطوة بخطوة.
يجب أن يكون الناتج منسقاً بصيغة Markdown بالهيكل التالي بدقة:
#### 📝 نص التمرين الجديد (فكرة رقم ${variationSeed}):
[نص التمرين الجديد والمبتكر المرتبط تماماً بالدرس]

#### 🔑 الحل المفصل خطوة بخطوة:
[الحل التفصيلي الكامل والدقيق]`;

        let response;
        try {
            response = await ai.models.generateContent({
                model: 'gemini-3.6-flash',
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });
        } catch (modelErr) {
            response = await ai.models.generateContent({
                model: 'gemini-3.1-pro-preview',
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });
        }

        const exerciseMarkdown = (typeof response.text === 'function' ? response.text() : response.text) || '';

        res.json({
            success: true,
            subject,
            lesson: cleanLesson,
            seed: variationSeed,
            exerciseMarkdown
        });

    } catch (error) {
        console.error('❌ خطأ في توليد تمرين بديل عبر الذكاء الاصطناعي:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'حدث خطأ أثناء توليد التمرين البديل'
        });
    }
});

// ============================================================
        });
    } catch (error) {
        console.error('❌ خطأ في جلب بيانات الطالب:', error.message);
        res.status(500).json({ 
            success: false, 
            error: 'حدث خطأ في الخادم' 
        });
    }
});

// ============================================================
// ============================================================
// ✅ مسار جلب الرصيد والأرباح والمدفوعات المستحقة للأستاذ
// ============================================================

app.get('/api/teacher/balance/:teacherId', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacherId = parseInt(req.params.teacherId);
        
        if (teacherId === -1 || req.user.userId === -1 || req.user.userId === '-1') {
            return res.json({ 
                success: true, 
                balance: 0, 
                total_earned: 0, 
                pending_withdraw: 0, 
                total_withdrawn: 0, 
                sessions: [] 
            });
        }

        if (req.user.userId !== teacherId && req.user.userId !== 0 && req.user.email !== 'admin@zoomdz.com') {
            return res.status(403).json({ success: false, error: 'غير مصرح به' });
        }
        
        const { data: teacher, error: balanceError } = await supabase
            .from('teachers')
            .select('balance, total_earned, pending_withdraw, total_withdrawn')
            .eq('id', teacherId)
            .single();
        
        if (balanceError) {
            console.error('❌ خطأ في جلب الرصيد:', balanceError);
            return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
        }

        // جلب جميع دروس هذا الأستاذ
        const { data: offers } = await supabase
            .from('offers')
            .select('id, subject_name, price, offer_date')
            .eq('teacher_id', teacherId);

        const offerIds = (offers || []).map(o => o.id);
        const offersMap = new Map();
        (offers || []).forEach(o => offersMap.set(o.id, o));

        let allSessions = [];
        if (offerIds.length > 0) {
            const { data: sessions, error: sessionsError } = await supabase
                .from('sessions')
                .select(`
                    id,
                    offer_id,
                    student_id,
                    payment_status,
                    payment_amount,
                    teacher_earned,
                    created_at,
                    students:student_id (
                        id,
                        full_name,
                        phone
                    )
                `)
                .in('offer_id', offerIds)
                .in('payment_status', ['paid', 'pending_stream', 'pending', 'completed'])
                .order('created_at', { ascending: false });

            if (sessionsError) {
                console.error('❌ خطأ في جلب جل��ات الأستاذ:', sessionsError);
            } else if (sessions) {
                allSessions = sessions.map(s => {
                    const offer = offersMap.get(s.offer_id);
                    const offerPrice = parseFloat(offer?.price || 0);
                    let earned = (s.teacher_earned !== undefined && s.teacher_earned !== null && Number(s.teacher_earned) > 0)
                        ? Number(s.teacher_earned)
                        : (Number(s.payment_amount || 0) > 0 ? Math.max(0, Number(s.payment_amount) - 50) : Math.max(0, offerPrice - 50));

                    return {
                        id: s.id,
                        offer_id: s.offer_id,
                        student_id: s.student_id,
                        payment_status: s.payment_status,
                        payment_amount: s.payment_amount,
                        teacher_earned: earned,
                        created_at: s.created_at,
                        offers: {
                            subject_name: offer?.subject_name || 'درس خصوصي',
                            price: offerPrice,
                            offer_date: offer?.offer_date
                        },
                        student_name: s.students?.full_name || 'طالب منصة ZoomDz'
                    };
                });
            }
        }

        let calculatedPending = 0;
        allSessions.forEach(s => {
            if (s.payment_status === 'pending_stream' || s.payment_status === 'pending') {
                calculatedPending += parseFloat(s.teacher_earned || 0);
            }
        });

        const currentPendingWithdraw = parseFloat(teacher?.pending_withdraw || 0);
        const finalPending = Math.max(currentPendingWithdraw, calculatedPending);
        
        res.json({
            success: true,
            balance: parseFloat(teacher?.balance || 0),
            total_earned: parseFloat(teacher?.total_earned || 0),
            pending_withdraw: finalPending,
            total_withdrawn: parseFloat(teacher?.total_withdrawn || 0),
            sessions: allSessions
        });
    } catch (error) {
        console.error('❌ خطأ في جلب رصيد الأستاذ والمدفوعات:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ مسار جلب الرصيد للطالب (مباشر)
// ============================================================

app.get('/api/student/balance/:studentId', authenticate, authorize(['student']), async (req, res) => {
    try {
        const studentId = parseInt(req.params.studentId);
        
        if (req.user.userId !== studentId) {
            return res.status(403).json({ success: false, error: 'غير مصرح به' });
        }
        
        const { data: student, error } = await supabase
            .from('students')
            .select('wallet_balance, balance')
            .eq('id', studentId)
            .single();
        
        if (error) {
            console.error('❌ خطأ في جلب رصيد الطالب:', error);
            return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
        }
        
        res.json({
            success: true,
            balance: parseFloat(student?.wallet_balance || student?.balance || 0)
        });
    } catch (error) {
        console.error('❌ خطأ في جلب رصيد الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// ✅ مسار جلب دروس الأستاذ (مباشر)
// ============================================================

app.get('/api/teacher/offers/:teacherId', authenticate, authorize(['teacher']), async (req, res) => {
    try {
        const teacherId = parseInt(req.params.teacherId);
        
        // التأكد من أن المستخدم يطلب بياناته الخاصة
        if (req.user.userId !== teacherId) {
            return res.status(403).json({ success: false, error: 'غير مصرح به' });
        }
        
        const { data: offers, error } = await supabase
            .from('offers')
            .select('*')
            .eq('teacher_id', teacherId)
            .order('offer_date', { ascending: true });
        
        if (error) {
            console.error('❌ خطأ في جلب دروس الأستاذ:', error);
            return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
        }
        
        const syncedOffers = (offers || []).map(offer => {
            const views = getViewCount('offer', offer.id, offer.views_count || offer.views || 0);
            return {
                ...offer,
                views_count: views,
                views: views
            };
        });
        res.json(syncedOffers);
    } catch (error) {
        console.error('❌ خطأ في جلب دروس ا��أستاذ:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// مسار المعلم الذكي (AI Tutor)
// ============================================================
app.get(['/ai-tutor', '/ai-tutor.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'ai-tutor.html'));
});

// ============================================================
        console.log('✅ مسارات المصادقة: /api/student/register و /api/teacher/register');
        console.log('✅ مسارات /me: /api/student/me و /api/teacher/me');
        console.log('='.repeat(60));
        
        // التحقق من إعدادات التخزين
        ensureProfilesBucket().catch(err => {
            console.error('Error during profiles bucket setup:', err.message);
        });
        
        startOfferCron();
        startCleanupCron();
    });
}
