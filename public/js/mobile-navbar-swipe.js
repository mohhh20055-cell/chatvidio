/**
 * ZoomDz Platform - Mobile Top Bar Swipe Gestures Engine
 * يتيح للمستخدم في شاشات الجوال سحب الشريط العلوي للأعلى لإخفائه وتوفير مساحة إضافية،
 * وسحبه للأسفل أو النقر على مقبض الإظهار لاسترجاعه بسلاسة تامة.
 */
(function() {
    'use strict';

    var isInitialized = false;
    var touchStartY = 0;
    var touchStartX = 0;
    var touchStartTime = 0;
    var lastScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    var isHeaderHidden = false;
    var ticking = false;
    var minSwipeDistance = 35; // الحد الأدنى للمسافة لاعتبارها سحبة
    var maxHorizontalDrift = 50; // لمنع التأثير على التمرير الأفقي للأزرار

    // CSS المخصص لتأثيرات السحب والاختفاء والمقبض
    function injectStyles() {
        if (document.getElementById('mobile-swipe-navbar-styles')) return;

        var style = document.createElement('style');
        style.id = 'mobile-swipe-navbar-styles';
        style.textContent = `
            /* أنماط السحب والإخفاء للشريط العلوي على الجوال */
            .navbar, 
            header.navbar, 
            nav.navbar, 
            .top-bar-collapsible,
            .news-ticker-container,
            .header-container {
                transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.28s ease !important;
                will-change: transform;
            }

            @media (max-width: 820px) {
                /* حالة إخفاء الشريط العلوي */
                body.mobile-nav-hidden .navbar,
                body.mobile-nav-hidden header.navbar,
                body.mobile-nav-hidden nav.navbar,
                body.mobile-nav-hidden .top-bar-collapsible,
                body.mobile-nav-hidden .news-ticker-container,
                body.mobile-nav-hidden .header-container {
                    transform: translateY(-102%) !important;
                    pointer-events: none !important;
                }

                /* مقبض سحب وإظهار الشريط العلوي عندما يكون مخفياً */
                #mobileNavbarRevealPill {
                    position: fixed;
                    top: 6px;
                    left: 50%;
                    transform: translateX(-50%) translateY(-35px);
                    width: 58px;
                    height: 20px;
                    background: rgba(15, 23, 42, 0.78);
                    backdrop-filter: blur(10px);
                    -webkit-backdrop-filter: blur(10px);
                    border: 1px solid rgba(255, 255, 255, 0.22);
                    border-radius: 20px;
                    z-index: 100000;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
                    opacity: 0;
                    pointer-events: none;
                    transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease, background-color 0.2s;
                    touch-action: pan-y;
                    user-select: none;
                }

                #mobileNavbarRevealPill:active {
                    background: rgba(37, 99, 235, 0.9);
                    transform: translateX(-50%) scale(1.08);
                }

                #mobileNavbarRevealPill .pill-icon {
                    width: 22px;
                    height: 4px;
                    background: rgba(255, 255, 255, 0.85);
                    border-radius: 4px;
                    transition: transform 0.25s ease;
                }

                body.mobile-nav-hidden #mobileNavbarRevealPill {
                    transform: translateX(-50%) translateY(0);
                    opacity: 1;
                    pointer-events: auto;
                }

                /* منطقة استشعار السحب بالأعلى عند إخفاء الشريط */
                #mobileTopSwipeSensor {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    height: 35px;
                    z-index: 99999;
                    display: none;
                    pointer-events: auto;
                    touch-action: pan-y;
                }

                body.mobile-nav-hidden #mobileTopSwipeSensor {
                    display: block;
                }
            }
        `;
        document.head.appendChild(style);
    }

    // إنشاء مقبض الإظهار ومنطقة الاستشعار
    function createPullElements() {
        if (!document.getElementById('mobileNavbarRevealPill')) {
            var pill = document.createElement('div');
            pill.id = 'mobileNavbarRevealPill';
            pill.title = 'إظهار الشريط العلوي (اسحب للأسفل أو انقر)';
            pill.setAttribute('aria-label', 'إظهار الشريط العلوي');
            pill.innerHTML = '<div class="pill-icon"></div>';

            // نقر على المقبض لإظهار الشريط
            pill.addEventListener('click', function(e) {
                e.stopPropagation();
                showNavbar();
            });

            document.body.appendChild(pill);
        }

        if (!document.getElementById('mobileTopSwipeSensor')) {
            var sensor = document.createElement('div');
            sensor.id = 'mobileTopSwipeSensor';
            document.body.appendChild(sensor);
        }
    }

    // إخفاء الشريط العلوي
    function hideNavbar() {
        if (window.innerWidth > 820) return;
        
        // التحقق إذا كان هناك قائمة منسدلة أو نافذة منبثقة مفتوحة
        var activeModal = document.querySelector('.modal.show, .modal.active, .swal2-container, .dropdown-menu.show, .notif-dropdown.show, .chat-modal.active');
        if (activeModal) return;

        isHeaderHidden = true;
        document.body.classList.add('mobile-nav-hidden');
    }

    // إظهار الشريط العلوي
    function showNavbar() {
        isHeaderHidden = false;
        document.body.classList.remove('mobile-nav-hidden');
    }

    // تبديل حالة الشريط
    function toggleNavbar() {
        if (isHeaderHidden) {
            showNavbar();
        } else {
            hideNavbar();
        }
    }

    function initSwipeListeners() {
        // الاستماع لحركات اللمس على مستوى الصفحة والشريط
        window.addEventListener('touchstart', function(e) {
            if (window.innerWidth > 820) return;
            if (!e.touches || e.touches.length !== 1) return;

            touchStartY = e.touches[0].clientY;
            touchStartX = e.touches[0].clientX;
            touchStartTime = Date.now();
        }, { passive: true });

        window.addEventListener('touchmove', function(e) {
            if (window.innerWidth > 820) return;
            if (!e.touches || e.touches.length !== 1) return;

            var currentY = e.touches[0].clientY;
            var currentX = e.touches[0].clientX;
            var deltaY = currentY - touchStartY;
            var deltaX = currentX - touchStartX;

            // إذا كانت الحركة أفقية في الأساس (مثل تمرير التبويبات)، نتجاهل السحب
            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > maxHorizontalDrift) {
                return;
            }

            // سحب مباشر للأعلى على الشريط أو الصفحة
            if (deltaY < -minSwipeDistance) {
                hideNavbar();
            } 
            // سحب مباشر للأسفل لإظهار الشريط
            else if (deltaY > minSwipeDistance) {
                showNavbar();
            }
        }, { passive: true });

        // الاستماع لأحداث التمرير (Scroll) التلقائية
        window.addEventListener('scroll', function() {
            if (window.innerWidth > 820) {
                if (isHeaderHidden) showNavbar();
                return;
            }

            if (!ticking) {
                window.requestAnimationFrame(function() {
                    var currentScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
                    var scrollDiff = currentScrollY - lastScrollY;

                    // إذا كان التمرير في أعلى الصفحة تماماً، نظهر الشريط
                    if (currentScrollY <= 15) {
                        showNavbar();
                    } 
                    // إذا كان التمرير سريعاً للأسفل، نخفي الشريط
                    else if (scrollDiff > 14 && currentScrollY > 70) {
                        hideNavbar();
                    } 
                    // إذا كان التمرير للأعلى، نظهر الشريط
                    else if (scrollDiff < -14) {
                        showNavbar();
                    }

                    lastScrollY = currentScrollY;
                    ticking = false;
                });
                ticking = true;
            }
        }, { passive: true });

        // الاستماع للمس المباشر على مقبض الإظهار أو منطقة الاستشعار
        var sensor = document.getElementById('mobileTopSwipeSensor');
        var pill = document.getElementById('mobileNavbarRevealPill');

        var attachPullGesture = function(el) {
            if (!el) return;
            var pullStartY = 0;

            el.addEventListener('touchstart', function(e) {
                if (e.touches && e.touches.length === 1) {
                    pullStartY = e.touches[0].clientY;
                }
            }, { passive: true });

            el.addEventListener('touchmove', function(e) {
                if (e.touches && e.touches.length === 1) {
                    var pullCurrentY = e.touches[0].clientY;
                    if (pullCurrentY - pullStartY > 15) {
                        showNavbar();
                    }
                }
            }, { passive: true });
        };

        attachPullGesture(sensor);
        attachPullGesture(pill);
    }

    function init() {
        if (isInitialized) return;
        injectStyles();
        createPullElements();
        initSwipeListeners();
        isInitialized = true;
    }

    // تصدير واجهة برمجية عامة
    window.MobileNavbarSwipe = {
        init: init,
        hide: hideNavbar,
        show: showNavbar,
        toggle: toggleNavbar,
        isHidden: function() { return isHeaderHidden; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
