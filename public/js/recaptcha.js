// =============================================
// ZoomDz Security - reCAPTCHA Disabled
// =============================================
window.RECAPTCHA_SITE_KEY = '';

var recaptchaState = {
    login: true,
    student: true,
    teacher: true
};

var recaptchaWidgets = {
    login: 'disabled',
    student: 'disabled',
    teacher: 'disabled'
};

function onLoginCaptchaSuccess(token) {}
function onStudentCaptchaSuccess(token) {}
function onTeacherCaptchaSuccess(token) {}
function onRecaptchaExpired() {}
function renderRecaptchaWidget(type, containerId) {}
function renderAllRecaptchaWidgets() {}
function resetRecaptchaWidget(type) {}
function resetRecaptchaState() {}
function switchTabRecaptcha(tab) {}

function isRecaptchaVerified(type) {
    return true;
}

window.grecaptcha = {
    getResponse: function() { return 'disabled_token'; },
    reset: function() {},
    render: function() { return 'disabled'; }
};

window.onRecaptchaLoaded = function() {};
