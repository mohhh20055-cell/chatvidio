// =============================================
// تعيين مفتاح reCAPTCHA مباشرة
// =============================================
// تم تعيين المفتاح يدوياً - لا حاجة لقراءة من .env
window.RECAPTCHA_SITE_KEY = '6Lcv8kctAAAAAHcoWBv_e87vrjP7I6IzQJSV6THf';

console.log('🔑 تم تعيين مفتاح reCAPTCHA من public/js/recaptcha.js');
console.log('🔑 المفتاح:', window.RECAPTCHA_SITE_KEY);

// =============================================
// حالة reCAPTCHA
// =============================================
var recaptchaState = {
    login: false,
    student: false,
    teacher: false
};

// =============================================
// معرفات عناصر reCAPTCHA
// =============================================
var recaptchaWidgets = {
    login: null,
    student: null,
    teacher: null
};

// =============================================
// دوال نجاح التحقق من reCAPTCHA
// =============================================
function onLoginCaptchaSuccess() {
    recaptchaState.login = true;
    var el = document.getElementById('loginRecaptchaError');
    if (el) el.classList.remove('show');
    console.log('✅ تم التحقق من reCAPTCHA لتسجيل الدخول');
}

function onStudentCaptchaSuccess() {
    recaptchaState.student = true;
    var el = document.getElementById('studentRecaptchaError');
    if (el) el.classList.remove('show');
    console.log('✅ تم التحقق من reCAPTCHA لتسجيل الطالب');
}

function onTeacherCaptchaSuccess() {
    recaptchaState.teacher = true;
    var el = document.getElementById('teacherRecaptchaError');
    if (el) el.classList.remove('show');
    console.log('✅ تم التحقق من reCAPTCHA لتسجيل المعلم');
}

// =============================================
// دالة انتهاء صلاحية reCAPTCHA
// =============================================
function onRecaptchaExpired() {
    recaptchaState.login = false;
    recaptchaState.student = false;
    recaptchaState.teacher = false;
    console.warn('⚠️ انتهت صلاحية reCAPTCHA');
}

// =============================================
// دالة تحميل reCAPTCHA
// =============================================
function onRecaptchaLoaded() {
    console.log('✅ onRecaptchaLoaded تم استدعاؤها');
    console.log('🔑 قيمة RECAPTCHA_SITE_KEY:', window.RECAPTCHA_SITE_KEY);
    
    if (!window.RECAPTCHA_SITE_KEY) {
        console.warn('⚠️ RECAPTCHA_SITE_KEY غير مضبوط. جاري تعيينه يدوياً...');
        window.RECAPTCHA_SITE_KEY = '6Lcv8kctAAAAAHcoWBv_e87vrjP7I6IzQJSV6THf';
        console.log('✅ تم تعيين المفتاح يدوياً:', window.RECAPTCHA_SITE_KEY);
    }
    
    renderAllRecaptchaWidgets();
}

// =============================================
// دالة عرض عنصر reCAPTCHA
// =============================================
function renderRecaptchaWidget(type, containerId) {
    console.log('🔄 محاولة عرض reCAPTCHA لنوع:', type);
    
    if (typeof grecaptcha === 'undefined') {
        console.warn('⚠️ grecaptcha غير محمل بعد');
        setTimeout(function() {
            renderRecaptchaWidget(type, containerId);
        }, 500);
        return;
    }
    
    if (!window.RECAPTCHA_SITE_KEY) {
        console.error('❌ RECAPTCHA_SITE_KEY غير موجود! جاري تعيينه...');
        window.RECAPTCHA_SITE_KEY = '6Lcv8kctAAAAAHcoWBv_e87vrjP7I6IzQJSV6THf';
    }
    
    var container = document.getElementById(containerId);
    if (!container) {
        console.warn('⚠️ العنصر ' + containerId + ' غير موجود');
        return;
    }

    if (recaptchaWidgets[type] !== null) {
        try {
            grecaptcha.reset(recaptchaWidgets[type]);
            console.log('🔄 تم إعادة تعيين reCAPTCHA لنوع: ' + type);
        } catch (e) {
            console.error('❌ خطأ في إعادة تعيين reCAPTCHA:', e);
        }
        return;
    }

    try {
        var widgetId = grecaptcha.render(container, {
            'sitekey': window.RECAPTCHA_SITE_KEY,
            'callback': function () {
                if (type === 'login') onLoginCaptchaSuccess();
                else if (type === 'student') onStudentCaptchaSuccess();
                else if (type === 'teacher') onTeacherCaptchaSuccess();
            },
            'expired-callback': onRecaptchaExpired,
            'theme': 'light',
            'size': 'normal'
        });
        recaptchaWidgets[type] = widgetId;
        console.log('✅ تم عرض reCAPTCHA لنوع: ' + type + ' (ID: ' + widgetId + ')');
        console.log('🔑 المفتاح المستخدم:', window.RECAPTCHA_SITE_KEY);
    } catch (err) {
        console.error('❌ خطأ في عرض reCAPTCHA:', err);
        container.innerHTML = '<div style="color:#ef4444;font-size:0.85rem;padding:10px;background:#fef2f2;border-radius:8px;border:1px solid #fca5a5;">⚠️ خطأ في عرض reCAPTCHA: ' + err.message + '</div>';
    }
}

// =============================================
// دالة عرض جميع عناصر reCAPTCHA
// =============================================
function renderAllRecaptchaWidgets() {
    console.log('🔄 جاري عرض جميع عناصر reCAPTCHA');
    renderRecaptchaWidget('login', 'loginRecaptcha');
    renderRecaptchaWidget('student', 'studentRecaptcha');
    renderRecaptchaWidget('teacher', 'teacherRecaptcha');
}

// =============================================
// دوال إعادة تعيين reCAPTCHA
// =============================================
function resetRecaptchaWidget(type) {
    recaptchaState[type] = false;
    if (recaptchaWidgets[type] !== null && typeof grecaptcha !== 'undefined') {
        try {
            grecaptcha.reset(recaptchaWidgets[type]);
            console.log('🔄 تم إعادة تعيين reCAPTCHA لنوع: ' + type);
        } catch (e) {
            console.error('❌ خطأ في إعادة تعيين reCAPTCHA:', e);
        }
    }
}

function resetRecaptchaState() {
    recaptchaState.login = false;
    recaptchaState.student = false;
    recaptchaState.teacher = false;
    console.log('🔄 تم إعادة تعيين حالة reCAPTCHA');
    setTimeout(function () {
        renderAllRecaptchaWidgets();
    }, 100);
}

function switchTabRecaptcha(tab) {
    console.log('🔄 التبديل إلى علامة التبويب: ' + tab);
    setTimeout(function () {
        if (tab === 'login') {
            renderRecaptchaWidget('login', 'loginRecaptcha');
        } else if (tab === 'student-register') {
            renderRecaptchaWidget('student', 'studentRecaptcha');
        } else if (tab === 'teacher-register') {
            renderRecaptchaWidget('teacher', 'teacherRecaptcha');
        }
    }, 100);
}

function isRecaptchaVerified(type) {
    return recaptchaState[type] === true;
}

// =============================================
// تهيئة إضافية
// =============================================
console.log('✅ تم تحميل recaptcha.js من public/js/');
console.log('🔑 المفتاح النهائي:', window.RECAPTCHA_SITE_KEY);
console.log('🔑 طول المفتاح:', window.RECAPTCHA_SITE_KEY ? window.RECAPTCHA_SITE_KEY.length : 0);

// التأكد من أن المفتاح موجود في window
if (!window.RECAPTCHA_SITE_KEY) {
    window.RECAPTCHA_SITE_KEY = '6Lcv8kctAAAAAHcoWBv_e87vrjP7I6IzQJSV6THf';
    console.log('🔄 تم إعادة تعيين المفتاح في نهاية الملف');
}
