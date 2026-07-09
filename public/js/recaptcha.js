// =============================================
// تعيين مفاتيح reCAPTCHA
// =============================================
window.RECAPTCHA_SITE_KEY = '6Lcv8kctAAAAAHcoWBv_e87vrjP7I6IzQJSV6THf';
// المفتاح السري (يستخدم في الخادم فقط - لا تضعه في الكود الأمامي في الإنتاج)
// window.RECAPTCHA_SECRET_KEY = '6Lcv8kctAAAAAKeHhfjm3dA-EqHprnKOIp5rJzKv';

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
    if (typeof window.RECAPTCHA_SITE_KEY === 'undefined' || !window.RECAPTCHA_SITE_KEY) {
        console.warn('⚠️ RECAPTCHA_SITE_KEY غير مضبوط. سيتم عرض رسالة للمسؤول.');
        renderRecaptchaMissing();
        return;
    }
    console.log('✅ تم تحميل reCAPTCHA بنجاح');
    renderAllRecaptchaWidgets();
}

// =============================================
// دالة عرض عنصر reCAPTCHA
// =============================================
function renderRecaptchaWidget(type, containerId) {
    if (typeof grecaptcha === 'undefined') {
        console.warn('⚠️ grecaptcha غير محمل بعد');
        return;
    }
    
    if (!window.RECAPTCHA_SITE_KEY) {
        console.warn('⚠️ RECAPTCHA_SITE_KEY غير موجود');
        return;
    }
    
    var container = document.getElementById(containerId);
    if (!container) {
        console.warn('⚠️ العنصر ' + containerId + ' غير موجود');
        return;
    }

    // إذا كان الـ widget موجوداً بالفعل، نقوم بإعادة تعيينه
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
    } catch (err) {
        console.error('❌ خطأ في عرض reCAPTCHA:', err);
        container.innerHTML = '<div style="color:#ef4444;font-size:0.85rem;padding:10px;background:#fef2f2;border-radius:8px;border:1px solid #fca5a5;">⚠️ تأكد من ضبط RECAPTCHA_SITE_KEY بشكل صحيح</div>';
    }
}

// =============================================
// دالة عرض رسالة عدم وجود مفتاح
// =============================================
function renderRecaptchaMissing() {
    var ids = ['loginRecaptcha', 'studentRecaptcha', 'teacherRecaptcha'];
    ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) {
            el.innerHTML = '<div style="color:#ef4444;font-size:0.85rem;text-align:center;padding:15px;background:#fef2f2;border-radius:8px;border:1px solid #fca5a5;">⚠️ مفتاح reCAPTCHA غير مضبوط.<br>أضف RECAPTCHA_SITE_KEY في الكود</div>';
        }
    });
}

// =============================================
// دالة عرض جميع عناصر reCAPTCHA
// =============================================
function renderAllRecaptchaWidgets() {
    renderRecaptchaWidget('login', 'loginRecaptcha');
    renderRecaptchaWidget('student', 'studentRecaptcha');
    renderRecaptchaWidget('teacher', 'teacherRecaptcha');
}

// =============================================
// دالة إعادة تعيين عنصر reCAPTCHA محدد
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

// =============================================
// دالة إعادة تعيين حالة reCAPTCHA بالكامل
// =============================================
function resetRecaptchaState() {
    recaptchaState.login = false;
    recaptchaState.student = false;
    recaptchaState.teacher = false;
    console.log('🔄 تم إعادة تعيين حالة reCAPTCHA');
    setTimeout(function () {
        renderAllRecaptchaWidgets();
    }, 100);
}

// =============================================
// دالة تبديل علامات التبويب مع reCAPTCHA
// =============================================
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
    }, 50);
}

// =============================================
// دالة للتحقق من حالة reCAPTCHA
// =============================================
function isRecaptchaVerified(type) {
    return recaptchaState[type] === true;
}

// =============================================
// دالة للحصول على حالة reCAPTCHA كنص
// =============================================
function getRecaptchaStatus() {
    return {
        login: recaptchaState.login ? '✅ تم التحقق' : '❌ لم يتم التحقق',
        student: recaptchaState.student ? '✅ تم التحقق' : '❌ لم يتم التحقق',
        teacher: recaptchaState.teacher ? '✅ تم التحقق' : '❌ لم يتم التحقق'
    };
}

// =============================================
// تهيئة reCAPTCHA عند تحميل الصفحة
// =============================================
document.addEventListener('DOMContentLoaded', function() {
    console.log('📄 تم تحميل الصفحة - جاري تهيئة reCAPTCHA');
    console.log('🔑 مفتاح reCAPTCHA المستخدم:', window.RECAPTCHA_SITE_KEY);
    
    // إذا كان grecaptcha محمل بالفعل
    if (typeof grecaptcha !== 'undefined') {
        onRecaptchaLoaded();
    } else {
        console.log('⏳ في انتظار تحميل grecaptcha...');
        // سيتم استدعاء onRecaptchaLoaded بواسطة Google
    }
});

// =============================================
// تصدير الدوال للاستخدام الخارجي (اختياري)
// =============================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        recaptchaState: recaptchaState,
        recaptchaWidgets: recaptchaWidgets,
        onLoginCaptchaSuccess: onLoginCaptchaSuccess,
        onStudentCaptchaSuccess: onStudentCaptchaSuccess,
        onTeacherCaptchaSuccess: onTeacherCaptchaSuccess,
        onRecaptchaExpired: onRecaptchaExpired,
        onRecaptchaLoaded: onRecaptchaLoaded,
        renderRecaptchaWidget: renderRecaptchaWidget,
        renderRecaptchaMissing: renderRecaptchaMissing,
        renderAllRecaptchaWidgets: renderAllRecaptchaWidgets,
        resetRecaptchaWidget: resetRecaptchaWidget,
        resetRecaptchaState: resetRecaptchaState,
        switchTabRecaptcha: switchTabRecaptcha,
        isRecaptchaVerified: isRecaptchaVerified,
        getRecaptchaStatus: getRecaptchaStatus
    };
}
