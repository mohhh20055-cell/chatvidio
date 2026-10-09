/**
 * ZoomDz Platform - Universal Anti Rapid-Click & Sequential Action Protection
 * نظام ذكي لمنع تكرار الإجراءات المتزامنة وتسلسل الطلبات بدون ظهور رسائل خطأ
 */
(function() {
    'use strict';

    // 1. حماية نقرات واجهة المستخدم (Buttons, Links, Submit Elements)
    document.addEventListener('click', function(e) {
        const target = e.target;
        if (!target) return;

        const clickable = target.closest('button, input[type="submit"], input[type="button"], [role="button"], .btn, .action-btn, [onclick], .save-btn, .submit-btn, .tab-btn, .message-action-btn');
        if (!clickable) return;

        // إذا كان العنصر مشغولاً بالفعل بمعالجة طلب
        if (clickable.getAttribute('data-busy') === 'true') {
            e.preventDefault();
            e.stopImmediatePropagation();
            return false;
        }

        const now = Date.now();
        const lastClick = clickable._lastClickTimestamp || 0;

        // منع النقر المتكرر السريع على نفس الزر إذا مرت أقل من 600ms
        if (now - lastClick < 600) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return false;
        }

        clickable._lastClickTimestamp = now;

        // تعطيل مؤقت لمؤشر الفأرة (Pointer Events) لتفادي النقرات المزدوجة المتتالية
        if (!clickable.disabled && !clickable.classList.contains('no-throttle')) {
            const originalPointerEvents = clickable.style.pointerEvents;
            clickable.style.pointerEvents = 'none';
            clickable.setAttribute('data-busy', 'true');
            setTimeout(function() {
                clickable.style.pointerEvents = originalPointerEvents || '';
                clickable.removeAttribute('data-busy');
            }, 600);
        }
    }, true); // Capture phase لضمان التدخل قبل أي معالج حدث آخر

    // 2. طابور تسلسل الإجراءات العالمية (Global Sequential Action Queue)
    // لضمان عدم تنفيذ أي إجراء إضافي إلا بعد اكتمال الإجراء الجاري، ومنع رسائل "حدث خطأ"
    if (window.fetch) {
        const originalFetch = window.fetch;
        let globalMutationChain = Promise.resolve();
        const recentlyCompleted = new Map();

        window.fetch = async function(url, options) {
            options = options || {};
            const method = (options.method || 'GET').toUpperCase();

            // فحص طلبات التعديل والإرسال (Mutations)
            if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
                const urlStr = typeof url === 'string' ? url : (url.url || '');
                const bodyStr = typeof options.body === 'string' ? options.body : '';
                const requestKey = `${method}:${urlStr}:${bodyStr.slice(0, 150)}`;
                const isDeleteAction = method === 'DELETE' || urlStr.includes('/delete');

                // فحص إذا كان تم إكمال نفس طلب الحذف حديثاً (خلال آخر 4 ثوانٍ)
                const now = Date.now();
                if (isDeleteAction && recentlyCompleted.has(requestKey) && (now - recentlyCompleted.get(requestKey) < 4000)) {
                    console.log('🛡️ [Anti-Rapid-Click] تم تنفيذ الحذف مسبقاً، إرجاع نجاح فوري لمنع الخطأ:', urlStr);
                    return new Response(JSON.stringify({
                        success: true,
                        message: 'تمت معالجة الطلب بنجاح مسبقاً'
                    }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                // تسلسل الطلب: ننتظر انتهاء أي طلب تعديل سابق أولاً
                const previousPromise = globalMutationChain;
                let resolveChain;
                globalMutationChain = new Promise(r => { resolveChain = r; });

                try {
                    await previousPromise;
                } catch (e) {
                    // حتى لو فشل الطلب السابق لا نوقف السلسلة
                }

                // فحص مرة أخرى إذا كان الطلب حُذف أثناء انتظار الطابور
                if (isDeleteAction && recentlyCompleted.has(requestKey) && (Date.now() - recentlyCompleted.get(requestKey) < 4000)) {
                    resolveChain();
                    return new Response(JSON.stringify({
                        success: true,
                        message: 'تمت معالجة الطلب بنجاح مسبقاً'
                    }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                try {
                    const response = await originalFetch.apply(this, [url, options]);

                    // إذا كان طلب حذف والرد 404 أو تم حذفه مسبقاً، نحوله لـ 200 نجاح لتفادي رسالة خطأ
                    if (isDeleteAction && (response.status === 404 || response.status === 400 || response.status === 403)) {
                        try {
                            const cloned = response.clone();
                            const json = await cloned.json();
                            if (json.error && (json.error.includes('مسبقاً') || json.error.includes('غير موجود') || json.error.includes('غير مصرح'))) {
                                recentlyCompleted.set(requestKey, Date.now());
                                return new Response(JSON.stringify({
                                    success: true,
                                    message: 'تمت معالجة الطلب مسبقاً'
                                }), {
                                    status: 200,
                                    headers: { 'Content-Type': 'application/json' }
                                });
                            }
                        } catch (err) {}
                    }

                    if (response.ok) {
                        recentlyCompleted.set(requestKey, Date.now());
                    }

                    return response;
                } catch (err) {
                    if (err && (err.name === 'TypeError' || err.message === 'Failed to fetch')) {
                        console.warn('📡 [Network] تعذر الاتصال بالخادم مؤقتاً.');
                    }
                    throw err;
                } finally {
                    resolveChain();
                }
            }

            return await originalFetch.apply(this, arguments);
        };
    }
})();
