const logger = require('./logger');
const axios = require('axios');
// ============================================================
// دوال إرسال البريد الإلكتروني (تدعم Brevo أساسياً و Resend كبديل لتوفير الباقة)
// ============================================================

const { Resend } = require('resend');
const { sanitizeInput } = require('./helpers');

// خريطة لتخزين وقت آخر إرسال بريد لكل عنوان بريد إلكتروني (لتطبيق فترة سماح 15 دقيقة)
const emailCooldownMap = new Map();
const COOLDOWN_DURATION_MS = 15 * 60 * 1000; // 15 دقيقة

function checkEmailCooldown(email) {
    if (!email) return false;
    const now = Date.now();
    const lastSent = emailCooldownMap.get(email.toLowerCase());
    if (lastSent && (now - lastSent < COOLDOWN_DURATION_MS)) {
        const remainingMinutes = Math.ceil((COOLDOWN_DURATION_MS - (now - lastSent)) / 60000);
        console.warn(`⚠️ تم تخطي إرسال البريد إلى ${email} مؤقتاً لتجنب استهلاك الباقة. يرجى الانتظار ${remainingMinutes} دقائق.`);
        return true; // في فترة الحظر (Cooldown)
    }
    return false;
}

function recordEmailSend(email) {
    if (!email) return;
    emailCooldownMap.set(email.toLowerCase(), Date.now());
}

const brevoApiKey = process.env.BREVO_API_KEY;
const resendApiKey = process.env.RESEND_API_KEY;

if (!brevoApiKey && !resendApiKey) {
    logger.warn('⚠️ تحذير: لم يتم العثور على BREVO_API_KEY أو RESEND_API_KEY. يرجى ضبط المفاتيح في متغيرات البيئة.');
}
const platformUrl = process.env.PLATFORM_URL || 'https://zoomdz.com';

const senderDomain = process.env.RESEND_SENDER_DOMAIN || 'zoomdz.com';
const senderName = process.env.RESEND_SENDER_NAME || 'ZoomDz';
const senderEmail = process.env.RESEND_SENDER_EMAIL || `no-reply@zoomdz.com`;
const fromAddress = `${senderName} <${senderEmail}>`;

const resend = resendApiKey ? new Resend(resendApiKey) : null;

/**
 * نظام تناوبي لإرسال البريد الإلكتروني (مرة Brevo ومرة Resend)
 * مع التبديل التلقائي للمزود الآخر عند الفشل.
 */
let emailCounter = 0;

async function sendViaBrevo({ targetEmail, subject, html, text, finalSenderName, finalSenderEmail }) {
    const activeBrevoApiKey = process.env.BREVO_API_KEY;
    if (!activeBrevoApiKey) {
        logger.warn('⚠️ [Brevo] لم يتم ضبط المتغير BREVO_API_KEY في البيئة.');
        return { success: false, reason: 'BREVO_API_KEY غير مضبوط في البيئة' };
    }

    const senderEmailToUse = process.env.BREVO_SENDER_EMAIL || finalSenderEmail || senderEmail;
    const senderNameToUse = process.env.BREVO_SENDER_NAME || finalSenderName || senderName;

    try {
        const brevoPayload = {
            sender: { name: senderNameToUse, email: senderEmailToUse },
            to: [{ email: targetEmail }],
            subject: subject,
            htmlContent: html || text
        };
        if (text) brevoPayload.textContent = text;

        const response = await axios.post('https://api.brevo.com/v3/smtp/email', brevoPayload, {
            headers: {
                'accept': 'application/json',
                'api-key': activeBrevoApiKey,
                'content-type': 'application/json'
            },
            timeout: 8000
        });

        if (response.status >= 200 && response.status < 300) {
            console.log(`✅ [Brevo] تم إرسال البريد بنجاح إلى: ${targetEmail}`);
            return { success: true, provider: 'brevo', data: response.data };
        }
        return { success: false, reason: `كود الاستجابة: ${response.status}` };
    } catch (error) {
        const responseData = error.response?.data;
        const errDetail = responseData?.message || responseData?.code || error.message;
        if (typeof errDetail === 'string' && (errDetail.includes('unrecognised IP address') || errDetail.includes('authorised_ips'))) {
            logger.warn(`⚠️ [Brevo IP Restriction] تم رفض الطلب بسبب تفعيل حظر IP في Brevo. حل المشكلة: يرجى إلغاء تفعيل Authorized IPs أو حظر IP من إعدادات الحساب في Brevo (https://app.brevo.com/security/authorised_ips).`);
        } else {
            logger.warn(`⚠️ [Brevo] تعذر الإرسال: ${errDetail} | التفاصيل: ${JSON.stringify(responseData || {})}`);
        }
        return { success: false, reason: typeof errDetail === 'object' ? JSON.stringify(errDetail) : errDetail };
    }
}

async function sendViaResend({ targetEmail, subject, html, text, finalSenderName, finalSenderEmail, to }) {
    const activeResendApiKey = process.env.RESEND_API_KEY;
    if (!activeResendApiKey) {
        logger.warn('⚠️ [Resend] لم يتم ضبط المتغير RESEND_API_KEY في البيئة.');
        return { success: false, reason: 'RESEND_API_KEY غير مضبوط' };
    }

    const activeResend = new Resend(activeResendApiKey);

    try {
        const resendPayload = {
            from: `${finalSenderName} <${finalSenderEmail}>`,
            to: Array.isArray(to) ? to : [targetEmail],
            subject: subject,
            html: html || text
        };
        if (text) resendPayload.text = text;

        const { data, error } = await activeResend.emails.send(resendPayload);

        if (error) {
            logger.error('❌ [Resend] خطأ في الإرسال:', error);
            return { success: false, reason: error.message || JSON.stringify(error) };
        }

        console.log(`✅ [Resend] تم إرسال البريد بنجاح إلى: ${targetEmail}`);
        return { success: true, provider: 'resend', data };
    } catch (error) {
        logger.error('❌ [Resend] استثناء أثناء الإرسال:', error.message);
        return { success: false, reason: error.message };
    }
}

async function sendEmail({ to, subject, html, text, fromName, fromEmail }) {
    const targetEmail = Array.isArray(to) ? to[0] : to;
    const finalSenderName = fromName || senderName;
    const finalSenderEmail = fromEmail || senderEmail;

    // التناوب بالتساوي (Round-Robin): مرة من Brevo ومرة من Resend
    emailCounter++;
    const preferBrevo = emailCounter % 2 !== 0;

    const primaryFn = preferBrevo ? sendViaBrevo : sendViaResend;
    const fallbackFn = preferBrevo ? sendViaResend : sendViaBrevo;
    const primaryName = preferBrevo ? 'Brevo' : 'Resend';
    const fallbackName = preferBrevo ? 'Resend' : 'Brevo';

    console.log(`📧 [Email Strategy] محاولة الإرسال رقم (${emailCounter}) عبر [${primaryName}]...`);

    const params = { targetEmail, subject, html, text, finalSenderName, finalSenderEmail, to };
    let result = await primaryFn(params);

    if (result.success) {
        return result;
    }

    console.warn(`⚠️ فشل/تعذر الإرسال عبر [${primaryName}] (${result.reason}). جاري التبديل الاحتياطي إلى [${fallbackName}]...`);
    result = await fallbackFn(params);

    if (result.success) {
        return result;
    }

    logger.warn('⚠️ لم يتم إرسال البريد: فشل الإرسال عبر كلا المزودين (Brevo & Resend)');
    return { success: false, error: 'Both email providers failed' };
}

/**
 * إرسال بريد التحقق (للاستخدام العام)
 */
async function sendVerificationEmail(toEmail, toName, verificationUrl) {
    try {
        const sanitizedEmail = sanitizeInput(toEmail);
        const sanitizedName = sanitizeInput(toName);
        const sanitizedUrl = sanitizeInput(verificationUrl);

        console.log('📧 محاولة إرسال بريد تأكيد إلى:', sanitizedEmail);

        const emailResult = await sendEmail({
            to: sanitizedEmail,
            subject: '✅ تأكيد حسابك - ZoomDz',
            html: `
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>تأكيد الحساب</title>
                    <style>
                        body { font-family: 'Cairo', Arial, sans-serif; background: #f0f4ff; padding: 40px; }
                        .container { max-width: 550px; margin: 0 auto; background: white; border-radius: 20px; padding: 40px; box-shadow: 0 10px 40px rgba(0,0,0,0.08); }
                        .header { text-align: center; }
                        .header h1 { color: #0f5cbf; font-size: 2rem; margin: 10px 0; }
                        .content { color: #1a2332; line-height: 1.8; font-size: 1.05rem; }
                        .btn { display: inline-block; background: #0f5cbf; color: white; padding: 14px 40px; border-radius: 50px; text-decoration: none; font-weight: 700; margin: 20px 0; }
                        .btn:hover { background: #0b4a9c; }
                        .footer { text-align: center; color: #94a3b8; font-size: 0.8rem; margin-top: 30px; border-top: 1px solid #edf2f7; padding-top: 20px; }
                        .code-box { background: #f1f5f9; padding: 12px; border-radius: 8px; text-align: center; font-size: 0.85rem; color: #64748b; word-break: break-all; margin: 10px 0; }
                        .emoji { font-size: 3rem; margin-bottom: 10px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <div class="emoji">🎓</div>
                            <h1>ZoomDz</h1>
                            <p style="color: #64748b; font-size: 0.9rem;">منصة التعليم الجزائرية</p>
                        </div>
                        <div class="content">
                            <h2>مرحباً ${sanitizedName} 👋</h2>
                            <p>شكراً لتسجيلك في منصة <strong>ZoomDz</strong>!</p>
                            <p>لتفعيل حسابك، يرجى النقر على الزر أدناه:</p>
                            <div style="text-align: center;">
                                <a href="${sanitizedUrl}" class="btn">✅ تأكيد الحساب</a>
                            </div>
                            <p>أو تفضل بزيارة منصتنا: <a href="${platformUrl}">${platformUrl}</a></p>
                            <p style="font-size: 0.9rem; color: #64748b;">إذا لم يعمل الزر، يمكنك نسخ الرابط التالي ولصقه في المتصفح:</p>
                            <div class="code-box">${sanitizedUrl}</div>
                            <p style="font-size: 0.85rem; color: #94a3b8;">⏳ هذا الرابط صالح لمدة 24 ساعة</p>
                        </div>
                        <div class="footer">
                            <p>© 2026 ZoomDz - منصة التعليم الجزائرية</p>
                            <p style="font-size: 0.75rem;">هذا بريد آلي، يرجى عدم الرد عليه</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        });

        if (!emailResult.success) {
            logger.error('❌ خطأ في إرسال البريد:', emailResult.error);
            return false;
        }

        console.log('✅ تم إرسال بريد التأكيد بنجاح إلى:', sanitizedEmail);
        return true;
    } catch (error) {
        logger.error('❌ خطأ في إرسال البريد:', error.message);
        return false;
    }
}

/**
 * إرسال بريد إعادة تعيين كلمة المرور
 */
async function sendResetEmail(toEmail, toName, resetUrl) {
    try {
        const sanitizedEmail = sanitizeInput(toEmail);
        const sanitizedName = sanitizeInput(toName);
        const sanitizedUrl = sanitizeInput(resetUrl);

        console.log('📧 محاولة إرسال بريد إعادة تعيين إلى:', sanitizedEmail);

        const emailResult = await sendEmail({
            to: sanitizedEmail,
            subject: '🔑 إعادة تعيين كلمة المرور - ZoomDz',
            html: `
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>إعادة تعيين كلمة المرور</title>
                    <style>
                        body { font-family: 'Cairo', Arial, sans-serif; background: #f0f4ff; padding: 40px; }
                        .container { max-width: 550px; margin: 0 auto; background: white; border-radius: 20px; padding: 40px; box-shadow: 0 10px 40px rgba(0,0,0,0.08); }
                        .header { text-align: center; }
                        .header h1 { color: #0f5cbf; font-size: 2rem; margin: 10px 0; }
                        .content { color: #1a2332; line-height: 1.8; font-size: 1.05rem; }
                        .btn { display: inline-block; background: #f59e0b; color: white; padding: 14px 40px; border-radius: 50px; text-decoration: none; font-weight: 700; margin: 20px 0; }
                        .btn:hover { background: #d97706; }
                        .footer { text-align: center; color: #94a3b8; font-size: 0.8rem; margin-top: 30px; border-top: 1px solid #edf2f7; padding-top: 20px; }
                        .code-box { background: #f1f5f9; padding: 12px; border-radius: 8px; text-align: center; font-size: 0.85rem; color: #64748b; word-break: break-all; margin: 10px 0; }
                        .emoji { font-size: 3rem; margin-bottom: 10px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <div class="emoji">🔐</div>
                            <h1>ZoomDz</h1>
                            <p style="color: #64748b; font-size: 0.9rem;">منصة التعليم الجزائرية</p>
                        </div>
                        <div class="content">
                            <h2>مرحباً ${sanitizedName} 👋</h2>
                            <p>لقد تلقينا طلباً لإعادة تعيين كلمة المرور لحسابك في <strong>ZoomDz</strong>.</p>
                            <p>لإعادة تعيين كلمة المرور، يرجى النقر على الزر أدناه:</p>
                            <div style="text-align: center;">
                                <a href="${sanitizedUrl}" class="btn">🔑 إعادة تعيين كلمة المرور</a>
                            </div>
                            <p>أو تفضل بزيارة منصتنا: <a href="${platformUrl}">${platformUrl}</a></p>
                            <p style="font-size: 0.9rem; color: #64748b;">إذا لم يعمل الزر، يمكنك نسخ الرابط التالي ولصقه في المتصفح:</p>
                            <div class="code-box">${sanitizedUrl}</div>
                            <p style="font-size: 0.85rem; color: #94a3b8;">⏳ هذا الرابط صالح لمدة ساعة واحدة</p>
                            <p style="font-size: 0.85rem; color: #94a3b8;">🔒 إذا لم تطلب إعادة تعيين كلمة المرور، يرجى تجاهل هذا البريد</p>
                        </div>
                        <div class="footer">
                            <p>© 2026 ZoomDz - منصة التعليم الجزائرية</p>
                            <p style="font-size: 0.75rem;">هذا بريد آلي، يرجى عدم الرد عليه</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        });

        if (!emailResult.success) {
            logger.error('❌ خطأ في إرسال بريد إعادة التعيين:', emailResult.error);
            return false;
        }

        console.log('✅ تم إرسال بريد إعادة التعيين بنجاح إلى:', sanitizedEmail);
        return true;
    } catch (error) {
        logger.error('❌ خطأ في إرسال بريد إعادة التعيين:', error.message);
        return false;
    }
}

/**
 * ✅ إرسال بريد قبول الأستاذ (عند الموافقة من الإدارة)
 */
async function sendTeacherApprovalEmail(toEmail, toName) {
    try {
        const sanitizedEmail = sanitizeInput(toEmail);
        const sanitizedName = sanitizeInput(toName);

        console.log('📧 محاولة إرسال بريد قبول الأستاذ إلى:', sanitizedEmail);

        const emailResult = await sendEmail({
            to: sanitizedEmail,
            subject: '🎉 تم قبول حسابك - ZoomDz',
            html: `
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>تم قبول حسابك</title>
                    <style>
                        body { font-family: 'Cairo', Arial, sans-serif; background: #f0f4ff; padding: 40px; }
                        .container { max-width: 550px; margin: 0 auto; background: white; border-radius: 20px; padding: 40px; box-shadow: 0 10px 40px rgba(0,0,0,0.08); }
                        .header { text-align: center; }
                        .header h1 { color: #0f5cbf; font-size: 2rem; margin: 10px 0; }
                        .content { color: #1a2332; line-height: 1.8; font-size: 1.05rem; }
                        .btn { display: inline-block; background: #10b981; color: white; padding: 14px 40px; border-radius: 50px; text-decoration: none; font-weight: 700; margin: 20px 0; }
                        .btn:hover { background: #059669; }
                        .footer { text-align: center; color: #94a3b8; font-size: 0.8rem; margin-top: 30px; border-top: 1px solid #edf2f7; padding-top: 20px; }
                        .emoji { font-size: 3rem; margin-bottom: 10px; }
                        .success-box { background: #dcfce7; border-radius: 12px; padding: 20px; border-right: 4px solid #10b981; margin: 15px 0; }
                        .success-box p { color: #166534; margin: 0; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <div class="emoji">🎉</div>
                            <h1>ZoomDz</h1>
                            <p style="color: #64748b; font-size: 0.9rem;">منصة التعليم الجزائرية</p>
                        </div>
                        <div class="content">
                            <h2>أهلاً بك أستاذنا ${sanitizedName} 👨‍🏫</h2>
                            <div class="success-box">
                                <p style="font-size: 1.1rem; font-weight: 700;">✅ تم قبول حسابك بنجاح!</p>
                            </div>
                            <p>يسعدنا إعلامك بأن طلب التسجيل الخاص بك قد تم <strong>قبوله</strong> من قبل الإدارة.</p>
                            <p>يمكنك الآن تسجيل الدخول إلى حسابك والبدء في:</p>
                            <ul style="text-align: right; padding-right: 20px; color: #1a2332;">
                                <li>📚 إنشاء دروس دروسك</li>
                                <li>🎥 إجراء بث مباشر للدروس</li>
                                <li>💰 إدارة أرباحك وطلبات السحب</li>
                                <li>📊 متابعة طلابك وإحصائياتك</li>
                            </ul>
                            <div style="text-align: center;">
                                <a href="${platformUrl}" class="btn">🚀 الذهاب إلى المنصة</a>
                            </div>
                            <p style="font-size: 0.9rem; color: #64748b;">يمكنك تسجيل الدخول باستخدام بريدك الإلكتروني وكلمة المرور التي سجلت بها.</p>
                        </div>
                        <div class="footer">
                            <p>© 2026 ZoomDz - منصة التعليم الجزائرية</p>
                            <p style="font-size: 0.75rem;">هذا بريد آلي، يرجى عدم الرد عليه</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        });

        if (!emailResult.success) {
            logger.error('❌ خطأ في إرسال بريد قبول الأستاذ:', emailResult.error);
            return false;
        }

        console.log('✅ تم إرسال بريد قبول الأستاذ بنجاح إلى:', sanitizedEmail);
        return true;
    } catch (error) {
        logger.error('❌ خطأ في إرسال بريد قبول الأستاذ:', error.message);
        return false;
    }
}

/**
 * ✅ إرسال بريد رفض الأستاذ
 */
async function sendTeacherRejectionEmail(toEmail, toName, reason) {
    try {
        const sanitizedEmail = sanitizeInput(toEmail);
        const sanitizedName = sanitizeInput(toName);
        const sanitizedReason = sanitizeInput(reason || 'لم يتم تحديد سبب');

        console.log('📧 محاولة إرسال بريد رفض الأستاذ إلى:', sanitizedEmail);

        const emailResult = await sendEmail({
            to: sanitizedEmail,
            subject: '❌ تحديث بشأن طلب التسجيل - ZoomDz',
            html: `
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>طلب التسجيل</title>
                    <style>
                        body { font-family: 'Cairo', Arial, sans-serif; background: #f0f4ff; padding: 40px; }
                        .container { max-width: 550px; margin: 0 auto; background: white; border-radius: 20px; padding: 40px; box-shadow: 0 10px 40px rgba(0,0,0,0.08); }
                        .header { text-align: center; }
                        .header h1 { color: #0f5cbf; font-size: 2rem; margin: 10px 0; }
                        .content { color: #1a2332; line-height: 1.8; font-size: 1.05rem; }
                        .footer { text-align: center; color: #94a3b8; font-size: 0.8rem; margin-top: 30px; border-top: 1px solid #edf2f7; padding-top: 20px; }
                        .emoji { font-size: 3rem; margin-bottom: 10px; }
                        .error-box { background: #fef2f2; border-radius: 12px; padding: 20px; border-right: 4px solid #ef4444; margin: 15px 0; }
                        .error-box p { color: #991b1b; margin: 0; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <div class="emoji">📋</div>
                            <h1>ZoomDz</h1>
                            <p style="color: #64748b; font-size: 0.9rem;">منصة التعليم الجزائرية</p>
                        </div>
                        <div class="content">
                            <h2>مرحباً ${sanitizedName} 👋</h2>
                            <div class="error-box">
                                <p style="font-size: 1.1rem; font-weight: 700;">❌ تم رفض طلب التسجيل</p>
                            </div>
                            <p>نأسف لإعلامك بأن طلب التسجيل الخاص بك كأستاذ في منصة <strong>ZoomDz</strong> لم يتم قبوله.</p>
                            <p><strong>سبب الرفض:</strong></p>
                            <div style="background: #f1f5f9; padding: 12px 16px; border-radius: 8px; margin: 10px 0; color: #1a2332;">
                                ${sanitizedReason}
                            </div>
                            <p style="font-size: 0.9rem; color: #64748b;">يمكنك التقدم بطلب جديد في أي وقت مع استيفاء الشروط المطلوبة.</p>
                            <p style="font-size: 0.9rem; color: #64748b;">للمزيد من المعلومات، يرجى التواصل مع فريق الدعم.</p>
                        </div>
                        <div class="footer">
                            <p>© 2026 ZoomDz - منصة التعليم الجزائرية</p>
                            <p style="font-size: 0.75rem;">هذا بريد آلي، يرجى عدم الرد عليه</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        });

        if (!emailResult.success) {
            logger.error('❌ خطأ في إرسال بريد رفض الأستاذ:', emailResult.error);
            return false;
        }

        console.log('✅ تم إرسال بريد رفض الأستاذ بنجاح إلى:', sanitizedEmail);
        return true;
    } catch (error) {
        logger.error('❌ خطأ في إرسال بريد رفض الأستاذ:', error.message);
        return false;
    }
}

/**
 * ✅ إرسال كود التحقق لسحب الأرباح (OTP)
 */
async function sendWithdrawalOtpEmail(toEmail, toName, otpCode, amount) {
    try {
        const sanitizedEmail = sanitizeInput(toEmail);
        const sanitizedName = sanitizeInput(toName);

        console.log(`📧 [Withdrawal OTP] Sending OTP code (${otpCode}) to:`, sanitizedEmail);

        const emailResult = await sendEmail({
            to: sanitizedEmail,
            subject: '🔐 رمز التحقق لتأكيد عملية السحب - ZoomDz',
            html: `
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>رمز التحقق لعملية السحب</title>
                    <style>
                        body { font-family: 'Cairo', Arial, sans-serif; background: #f0f4ff; padding: 30px; }
                        .container { max-width: 520px; margin: 0 auto; background: white; border-radius: 20px; padding: 35px; box-shadow: 0 10px 40px rgba(0,0,0,0.08); }
                        .header { text-align: center; }
                        .header h1 { color: #0f5cbf; font-size: 1.8rem; margin: 8px 0; }
                        .content { color: #1a2332; line-height: 1.8; font-size: 1rem; }
                        .otp-card { background: #f8fafc; border: 2px dashed #0f5cbf; border-radius: 16px; padding: 20px; text-align: center; margin: 20px 0; }
                        .otp-code { font-size: 2.5rem; font-weight: 800; letter-spacing: 12px; color: #0f5cbf; font-family: monospace; margin: 10px 0; text-indent: 12px; }
                        .footer { text-align: center; color: #94a3b8; font-size: 0.8rem; margin-top: 30px; border-top: 1px solid #edf2f7; padding-top: 20px; }
                        .emoji { font-size: 2.8rem; margin-bottom: 8px; }
                        .info-box { background: #e0f2fe; border-radius: 10px; padding: 12px 16px; color: #0369a1; font-weight: 700; margin-bottom: 15px; text-align: center; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <div class="emoji">🔐</div>
                            <h1>ZoomDz</h1>
                            <p style="color: #64748b; font-size: 0.88rem;">منصة التعليم الجزائرية</p>
                        </div>
                        <div class="content">
                            <h2>مرحباً أستاذ ${sanitizedName} 👋</h2>
                            <p>تلقينا طلباً لتأكيد عملية سحب أرباح من حسابك.</p>
                            
                            <div class="info-box">
                                💰 المبلغ المطلوب سحبه: <strong>${amount} دج</strong>
                            </div>

                            <p>يرجى استخدام رمز التحقق التالي والمكون من 6 أرقام لإتمام عملية السحب:</p>

                            <div class="otp-card">
                                <div style="font-size: 0.85rem; color: #64748b; font-weight: 700;">رمز التحقق (OTP)</div>
                                <div class="otp-code">${otpCode}</div>
                                <div style="font-size: 0.8rem; color: #ef4444; font-weight: 700;">⏱️ هذا الرمز صالح لمدة 10 دقائق فقط</div>
                            </div>
                            
                            <p>يمكنك العودة للمنصة في أي وقت عبر: <a href="${platformUrl}">${platformUrl}</a></p>

                            <p style="font-size: 0.85rem; color: #64748b; margin-top: 15px;">
                                🔒 إذا لم تطلب سحب الأرباح، يرجى تجاهل هذا البريد وتغيير كلمة مرور حسابك فوراً لحماية أرباحك.
                            </p>
                        </div>
                        <div class="footer">
                            <p>© 2026 ZoomDz - منصة التعليم الجزائرية</p>
                            <p style="font-size: 0.75rem;">هذا بريد آلي أمني حمايةً لأرباحك، يرجى عدم الرد عليه</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        });

        if (!emailResult.success) {
            logger.error('❌ Error sending withdrawal OTP email:', emailResult.error);
            return false;
        }

        console.log('✅ Withdrawal OTP email sent successfully to:', sanitizedEmail);
        return true;
    } catch (error) {
        logger.error('❌ Error sending withdrawal OTP email:', error.message);
        return false;
    }
}

module.exports = {
    sendEmail,
    sendVerificationEmail,
    sendResetEmail,
    sendTeacherApprovalEmail,
    sendTeacherRejectionEmail,
    sendWithdrawalOtpEmail
};

