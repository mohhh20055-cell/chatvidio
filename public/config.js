window.RECAPTCHA_SITE_KEY = "";
window.API_BASE_URL = "";

// Universal Anti Rapid-Click Protection
if (!window._antiRapidClickLoaded) {
    window._antiRapidClickLoaded = true;
    document.addEventListener('click', function(e) {
        const target = e.target;
        if (!target) return;
        const clickable = target.closest('button, input[type="submit"], input[type="button"], [role="button"], .btn, .action-btn, [onclick], .save-btn, .submit-btn, .tab-btn');
        if (!clickable) return;
        const now = Date.now();
        const lastClick = clickable._lastClickTimestamp || 0;
        if (now - lastClick < 1000) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return false;
        }
        clickable._lastClickTimestamp = now;
        if (!clickable.disabled && !clickable.classList.contains('no-throttle')) {
            const orig = clickable.style.pointerEvents;
            clickable.style.pointerEvents = 'none';
            setTimeout(function() { clickable.style.pointerEvents = orig || 'auto'; }, 800);
        }
    }, true);
}
