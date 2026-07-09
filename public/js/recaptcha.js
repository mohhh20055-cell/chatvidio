var recaptchaState = {
    login: false,
    student: false,
    teacher: false
};

var recaptchaWidgets = {
    login: null,
    student: null,
    teacher: null
};

function onLoginCaptchaSuccess() {
    recaptchaState.login = true;
    var el = document.getElementById('loginRecaptchaError');
    if (el) el.classList.remove('show');
}

function onStudentCaptchaSuccess() {
    recaptchaState.student = true;
    var el = document.getElementById('studentRecaptchaError');
    if (el) el.classList.remove('show');
}

function onTeacherCaptchaSuccess() {
    recaptchaState.teacher = true;
    var el = document.getElementById('teacherRecaptchaError');
    if (el) el.classList.remove('show');
}

function onRecaptchaExpired() {
    recaptchaState.login = false;
    recaptchaState.student = false;
    recaptchaState.teacher = false;
}

function onRecaptchaLoaded() {
    if (typeof window.RECAPTCHA_SITE_KEY === 'undefined' || !window.RECAPTCHA_SITE_KEY) {
        console.warn('⚠️ RECAPTCHA_SITE_KEY غير مضبوط. سيتم عرض رسالة للمسؤول.');
        renderRecaptchaMissing();
        return;
    }
    renderAllRecaptchaWidgets();
}

function renderRecaptchaWidget(type, containerId) {
    if (typeof grecaptcha === 'undefined' || !window.RECAPTCHA_SITE_KEY) return;
    var container = document.getElementById(containerId);
    if (!container) return;

    if (recaptchaWidgets[type] !== null) {
        try {
            grecaptcha.reset(recaptchaWidgets[type]);
        } catch (e) {}
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
    } catch (err) {
        console.error('❌ خطأ في عرض reCAPTCHA:', err);
        container.innerHTML = '<div style="color:#ef4444;font-size:0.85rem;">⚠️ تأكد من ضبط RECAPTCHA_SITE_KEY</div>';
    }
}

function renderRecaptchaMissing() {
    var ids = ['loginRecaptcha', 'studentRecaptcha', 'teacherRecaptcha'];
    ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.innerHTML = '<div style="color:#ef4444;font-size:0.85rem;text-align:center;">⚠️ مفتاح reCAPTCHA غير مضبوط.<br>أضف RECAPTCHA_SITE_KEY في ملف .env</div>';
    });
}

function renderAllRecaptchaWidgets() {
    renderRecaptchaWidget('login', 'loginRecaptcha');
    renderRecaptchaWidget('student', 'studentRecaptcha');
    renderRecaptchaWidget('teacher', 'teacherRecaptcha');
}

function resetRecaptchaWidget(type) {
    recaptchaState[type] = false;
    if (recaptchaWidgets[type] !== null && typeof grecaptcha !== 'undefined') {
        try {
            grecaptcha.reset(recaptchaWidgets[type]);
        } catch (e) {}
    }
}

function resetRecaptchaState() {
    recaptchaState.login = false;
    recaptchaState.student = false;
    recaptchaState.teacher = false;
    setTimeout(function () {
        renderAllRecaptchaWidgets();
    }, 100);
}

function switchTabRecaptcha(tab) {
    setTimeout(function () {
        if (tab === 'login') renderRecaptchaWidget('login', 'loginRecaptcha');
        else if (tab === 'student-register') renderRecaptchaWidget('student', 'studentRecaptcha');
        else if (tab === 'teacher-register') renderRecaptchaWidget('teacher', 'teacherRecaptcha');
    }, 50);
}
