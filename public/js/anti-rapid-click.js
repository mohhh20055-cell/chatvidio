/**
 * ZoomDz Platform - Universal Anti Rapid-Click / Double Submit Protection
 * حماية متكاملة ضد ثغرة النقر المتكرر على الأزرار في نفس الثانية
 */
(function() {
    'use strict';

    // 1. حماية نقرات واجهة المستخدم (Buttons, Links, Submit Elements)
    document.addEventListener('click', function(e) {
        const target = e.target;
        if (!target) return;

        const clickable = target.closest('button, input[type="submit"], input[type="button"], [role="button"], .btn, .action-btn, [onclick], .save-btn, .submit-btn, .tab-btn');
        if (!clickable) return;

        const now = Date.now();
        const lastClick = clickable._lastClickTimestamp || 0;

        // منع النقر على نفس الزر إذا مرت أقل من 1000ms (ثانية واحدة)
        if (now - lastClick < 1000) {
            e.preventDefault();
            e.stopImmediatePropagation();
            console.warn('🛡️ [Anti-Rapid-Click] تم منع النقر المتكرر السريع على نفس الزر.');
            return false;
        }

        clickable._lastClickTimestamp = now;

        // تعطيل مؤقت لمؤشر الفأرة (Pointer Events) لتفادي النقرات المزدوجة المتتالية
        if (!clickable.disabled && !clickable.classList.contains('no-throttle')) {
            const originalPointerEvents = clickable.style.pointerEvents;
            clickable.style.pointerEvents = 'none';
            setTimeout(function() {
                clickable.style.pointerEvents = originalPointerEvents || 'auto';
            }, 800);
        }
    }, true); // Capture phase لضمان التدخل قبل أي معالج حدث آخر

    // 2. حماية طلبات الشبكة fetch من التكرار السريع
    if (window.fetch) {
        const activeRequests = new Map();
        const originalFetch = window.fetch;

        window.fetch = async function(url, options) {
            options = options || {};
            const method = (options.method || 'GET').toUpperCase();

            // فحص طلبات التعديل والإرسال
            if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
                const urlStr = typeof url === 'string' ? url : (url.url || '');
                const bodyStr = typeof options.body === 'string' ? options.body : '';
                const requestKey = `${method}:${urlStr}:${bodyStr.slice(0, 150)}`;

                const now = Date.now();
                const lastReq = activeRequests.get(requestKey) || 0;

                if (now - lastReq < 1000) {
                    console.warn('🛡️ [Anti-Rapid-Click] تم منع تكرار إرسال الطلب في نفس الثانية:', urlStr);
                    return new Response(JSON.stringify({
                        success: false,
                        error: '⚠️ يرجى الانتظار لحظة، طلبك قيد المعالجة لمنع تكرار العملية.'
                    }), {
                        status: 429,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                activeRequests.set(requestKey, now);
                setTimeout(function() {
                    activeRequests.delete(requestKey);
                }, 1200);
            }

            return originalFetch.apply(this, arguments);
        };
    }
})();
