/**
 * ZoomDz Platform - Mobile Top Bar Fixed & Stable Controller
 * يضمن بقاء الشريط العلوي ثابتاً تماماً في مكانه تحت شريط الأخبار دون تحرك أو إخفاء عند التمرير
 */
(function() {
    'use strict';

    function initFixedNavbar() {
        document.body.classList.remove('mobile-nav-hidden');
        var pill = document.getElementById('mobileNavbarRevealPill');
        if (pill) pill.remove();
        var sensor = document.getElementById('mobileTopSwipeSensor');
        if (sensor) sensor.remove();
    }

    // تصدير واجهة برمجية آمنة
    window.MobileNavbarSwipe = {
        init: initFixedNavbar,
        hide: function() {},
        show: function() { document.body.classList.remove('mobile-nav-hidden'); },
        toggle: function() {},
        isHidden: function() { return false; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initFixedNavbar);
    } else {
        initFixedNavbar();
    }
})();

