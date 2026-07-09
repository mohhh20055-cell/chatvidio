// ============================================================
// دوال إرسال البريد الإلكتروني
// ============================================================

const { Resend } = require('resend');
const { sanitizeInput } = require('./helpers');

const resendApiKey = process.env.RESEND_API_KEY;

// ✅ التحقق من وجود مفتاح Resend
if (!resendApiKey) {
    console.warn('⚠️ تحذير: متغير RESEND_API_KEY غير موجود. لن يتم إرسال البريد الإلكتروني.');
    console.warn('⚠️ يمكنك الحصول على مفتاح مجاني من https://resend.com');
}

const resend = resendApiKey ? new Resend(resendApiKey) : null;

/**
 * إرسال بريد التحقق (للاستخدام العام)
 */
async function sendVerificationEmail(toEmail, toName, verificationUrl) {
    try {
        // ✅ التحقق من وجود المفتاح
        if (!resend) {
            console.warn('⚠️ لا يمكن إرسال البريد: RESEND_API_KEY غير موجود');
            return false;
        }

        const sanitizedEmail = sanitizeInput(toEmail);
        const sanitizedName = sanitizeInput(toName);
        const sanitizedUrl = sanitizeInput(verificationUrl);

        console.log('📧 محاولة إرسال بريد تأكيد إلى:', sanitizedEmail);

        const { data, error } = await resend.emails.send({
            from: 'ZoomDz <onboarding@resend.dev>',
            to: [sanitizedEmail],
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
                            <p style="font-size: 0.9rem; color: #64748b;">إذا لم يعمل الزر، يمكنك نسخ الرابط التالي ولصقه في المتصفح:</p>
                            <div class="code-box">${sanitizedUrl}</div>
                            <p style="font-size: 0.85rem; color: #94a3b8;">⏳ هذا الرابط صالح لمدة 24 ساعة</p>
                        </div>
                        <div class="footer">
                            <p>© 2024 ZoomDz - منصة التعليم الجزائرية</p>
                            <p style="font-size: 0.75rem;">هذا بريد آلي، يرجى عدم الرد عليه</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        });

        if (error) {
            console.error('❌ خطأ في إرسال البريد:', error);
            return false;
        }

        console.log('✅ تم إرسال بريد التأكيد بنجاح إلى:', sanitizedEmail);
        return true;
    } catch (error) {
        console.error('❌ خطأ في إرسال البريد:', error.message);
        return false;
    }
}

/**
 * إرسال بريد إعادة تعيين كلمة المرور
 */
async function sendResetEmail(toEmail, toName, resetUrl) {
    try {
        if (!resend) {
            console.warn('⚠️ لا يمكن إرسال البريد: RESEND_API_KEY غير موجود');
            return false;
        }

        const sanitizedEmail = sanitizeInput(toEmail);
        const sanitizedName = sanitizeInput(toName);
        const sanitizedUrl = sanitizeInput(resetUrl);

        console.log('📧 محاولة إرسال بريد إعادة تعيين إلى:', sanitizedEmail);

        const { data, error } = await resend.emails.send({
            from: 'ZoomDz <onboarding@resend.dev>',
            to: [sanitizedEmail],
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
                            <p style="font-size: 0.9rem; color: #64748b;">إذا لم يعمل الزر، يمكنك نسخ الرابط التالي ولصقه في المتصفح:</p>
                            <div class="code-box">${sanitizedUrl}</div>
                            <p style="font-size: 0.85rem; color: #94a3b8;">⏳ هذا الرابط صالح لمدة ساعة واحدة</p>
                            <p style="font-size: 0.85rem; color: #94a3b8;">🔒 إذا لم تطلب إعادة تعيين كلمة المرور، يرجى تجاهل هذا البريد</p>
                        </div>
                        <div class="footer">
                            <p>© 2024 ZoomDz - منصة التعليم الجزائرية</p>
                            <p style="font-size: 0.75rem;">هذا بريد آلي، يرجى عدم الرد عليه</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        });

        if (error) {
            console.error('❌ خطأ في إرسال بريد إعادة التعيين:', error);
            return false;
        }

        console.log('✅ تم إرسال بريد إعادة التعيين بنجاح إلى:', sanitizedEmail);
        return true;
    } catch (error) {
        console.error('❌ خطأ في إرسال بريد إعادة التعيين:', error.message);
        return false;
    }
}

/**
 * ✅ إرسال بريد قبول الأستاذ (عند الموافقة من الإدارة)
 */
async function sendTeacherApprovalEmail(toEmail, toName) {
    try {
        if (!resend) {
            console.warn('⚠️ لا يمكن إرسال البريد: RESEND_API_KEY غير موجود');
            return false;
        }

        const sanitizedEmail = sanitizeInput(toEmail);
        const sanitizedName = sanitizeInput(toName);

        console.log('📧 محاولة إرسال بريد قبول الأستاذ إلى:', sanitizedEmail);

        const platformUrl = process.env.PLATFORM_URL || 'https://chatvidio.onrender.com';

        const { data, error } = await resend.emails.send({
            from: 'ZoomDz <onboarding@resend.dev>',
            to: [sanitizedEmail],
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
                                <li>📚 إنشاء عروض دروسك</li>
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
                            <p>© 2024 ZoomDz - منصة التعليم الجزائرية</p>
                            <p style="font-size: 0.75rem;">هذا بريد آلي، يرجى عدم الرد عليه</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        });

        if (error) {
            console.error('❌ خطأ في إرسال بريد قبول الأستاذ:', error);
            return false;
        }

        console.log('✅ تم إرسال بريد قبول الأستاذ بنجاح إلى:', sanitizedEmail);
        return true;
    } catch (error) {
        console.error('❌ خطأ في إرسال بريد قبول الأستاذ:', error.message);
        return false;
    }
}

/**
 * ✅ إرسال بريد رفض الأستاذ
 */
async function sendTeacherRejectionEmail(toEmail, toName, reason) {
    try {
        if (!resend) {
            console.warn('⚠️ لا يمكن إرسال البريد: RESEND_API_KEY غير موجود');
            return false;
        }

        const sanitizedEmail = sanitizeInput(toEmail);
        const sanitizedName = sanitizeInput(toName);
        const sanitizedReason = sanitizeInput(reason || 'لم يتم تحديد سبب');

        console.log('📧 محاولة إرسال بريد رفض الأستاذ إلى:', sanitizedEmail);

        const { data, error } = await resend.emails.send({
            from: 'ZoomDz <onboarding@resend.dev>',
            to: [sanitizedEmail],
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
                            <p>© 2024 ZoomDz - منصة التعليم الجزائرية</p>
                            <p style="font-size: 0.75rem;">هذا بريد آلي، يرجى عدم الرد عليه</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        });

        if (error) {
            console.error('❌ خطأ في إرسال بريد رفض الأستاذ:', error);
            return false;
        }

        console.log('✅ تم إرسال بريد رفض الأستاذ بنجاح إلى:', sanitizedEmail);
        return true;
    } catch (error) {
        console.error('❌ خطأ في إرسال بريد رفض الأستاذ:', error.message);
        return false;
    }
}

module.exports = {
    sendVerificationEmail,
    sendResetEmail,
    sendTeacherApprovalEmail,
    sendTeacherRejectionEmail
};
