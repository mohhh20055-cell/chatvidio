/**
 * ZoomDz Platform Branding & Dynamic Image Sync Engine
 * Ensures custom logos, icons, and site images update instantly across web, dashboards, and app
 */
(function() {
    'use strict';

    function setSafeImage(el, url) {
        if (!el || !url) return;
        el.dataset.proxied = '';
        el.setAttribute('data-original-url', url);
        el.setAttribute('referrerpolicy', 'no-referrer');
        
        // Auto-fallback handler for web & mobile app
        el.onerror = function() {
            var orig = el.getAttribute('data-original-url') || el.src;
            if (!el.dataset.proxied && orig && (orig.startsWith('http://') || orig.startsWith('https://'))) {
                el.dataset.proxied = 'true';
                el.setAttribute('referrerpolicy', 'no-referrer');
                var proxyUrl = '/api/proxy-image?url=' + encodeURIComponent(orig) + '&site_asset=' + Date.now();
                el.src = proxyUrl;
                return;
            }
            // If proxy fails or local image missing, fallback safely
            el.onerror = null;
            if (el.id === 'heroMainImage') {
                el.src = '/images/student_hero.jpg';
            } else if (el.id === 'landingCard1Img') {
                el.src = '/images/student_lab.jpg';
            } else if (el.id === 'landingCard2Img') {
                el.src = '/images/ChatGPT Image Aug 20, 2026, 10_43_09 AM.png';
            } else if (el.classList.contains('site-app-logo') || el.classList.contains('navbar-app-logo') || el.classList.contains('brand-logo-img')) {
                el.style.display = 'none';
                if (el.nextElementSibling && el.nextElementSibling.classList.contains('fallback-icon')) {
                    el.nextElementSibling.style.display = 'inline-block';
                }
            } else {
                el.src = '/images/photo_5778184297368981379_x.jpg';
            }
        };

        // Prevent WebView/browser caches from serving an older admin upload.
        var separator = url.indexOf('?') >= 0 ? '&' : '?';
        el.src = url + separator + 'site_asset=' + Date.now();
    }

    function applyBranding(images) {
        if (!images || typeof images !== 'object') return;
        var logoUrl = images.app_logo || images.site_logo;

        if (logoUrl) {
            // Update all brand & app logo image tags
            document.querySelectorAll('.site-app-logo, .brand-logo-img, .navbar-app-logo, .app-brand-logo, #navbarAppLogoImg, #mobileDrawerLogoImg, #studentNavAppLogo, #teacherNavAppLogo, #appPageLogoImg').forEach(function(img) {
                if (img.tagName === 'IMG') {
                    setSafeImage(img, logoUrl);
                    img.style.display = 'block';
                    if (img.nextElementSibling && img.nextElementSibling.classList.contains('fallback-icon')) {
                        img.nextElementSibling.style.display = 'none';
                    }
                }
            });

            // Update preloader logo if present
            var preloaderLogo = document.getElementById('preloaderAppLogoImg');
            if (preloaderLogo) {
                setSafeImage(preloaderLogo, logoUrl);
                preloaderLogo.style.display = 'block';
                var defIcon = document.getElementById('preloaderDefaultIcon');
                if (defIcon) defIcon.style.display = 'none';
            }

            // Update dynamic favicons and icons
            try {
                var icons = document.querySelectorAll('link[rel="shortcut icon"], link[rel="icon"], link[rel="apple-touch-icon"]');
                icons.forEach(function(el) {
                    el.href = logoUrl;
                });
            } catch(e) {}
        }

        // Hero and landing cards
        if (images.hero_image) {
            setSafeImage(document.getElementById('heroMainImage'), images.hero_image);
        }
        if (images.landing_card1_image) {
            setSafeImage(document.getElementById('landingCard1Img'), images.landing_card1_image);
        }
        if (images.landing_card2_image) {
            setSafeImage(document.getElementById('landingCard2Img'), images.landing_card2_image);
        }

        // Login character avatars
        if (images.login_student_img) {
            document.querySelectorAll('.char-img-student').forEach(function(el) {
                setSafeImage(el, images.login_student_img);
            });
        }
        if (images.login_teacher_img) {
            document.querySelectorAll('.char-img-teacher').forEach(function(el) {
                setSafeImage(el, images.login_teacher_img);
            });
        }
        if (images.login_admin_img) {
            document.querySelectorAll('.char-img-admin').forEach(function(el) {
                setSafeImage(el, images.login_admin_img);
            });
        }
    }

    // Fast initial apply from local cache
    try {
        var cached = localStorage.getItem('zoomdz_site_images');
        if (cached) {
            applyBranding(JSON.parse(cached));
        }
    } catch(e) {}

    // Live sync from server API
    async function syncBranding() {
        try {
            var res = await fetch('/api/settings/site_images?_t=' + Date.now());
            if (!res.ok) return;
            var data = await res.json();
            if (data) {
                applyBranding(data);
                try {
                    localStorage.setItem('zoomdz_site_images', JSON.stringify(data));
                } catch(e) {}
            }
        } catch(e) {}
    }

    window.ZoomDzBranding = {
        apply: applyBranding,
        sync: syncBranding
    };

    // Auto-inject mobile navbar swipe behavior
    try {
        if (!document.getElementById('mobile-navbar-swipe-script') && !window.MobileNavbarSwipe) {
            var swipeScript = document.createElement('script');
            swipeScript.id = 'mobile-navbar-swipe-script';
            swipeScript.src = '/js/mobile-navbar-swipe.js';
            swipeScript.async = true;
            document.head.appendChild(swipeScript);
        }
    } catch(e) {}

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', syncBranding);
    } else {
        syncBranding();
    }
})();


// الشبكة - حالة الاتصال بالانترنت
window.addEventListener('online', function() {
    if (typeof showToast === 'function') {
        showToast('✅ تم الاتصال بالإنترنت', 'success');
        setTimeout(() => window.location.reload(), 1500);
    } else {
        const msg = document.createElement('div');
        msg.innerHTML = '✅ تم الاتصال بالإنترنت';
        msg.style.cssText = 'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#10b981; color:white; padding:12px 24px; border-radius:8px; font-weight:bold; z-index:999999; box-shadow:0 4px 12px rgba(0,0,0,0.2); font-family:Cairo,sans-serif;';
        document.body.appendChild(msg);
        setTimeout(() => window.location.reload(), 1500);
    }
});

window.addEventListener('offline', function() {
    if (typeof showToast === 'function') {
        showToast('❌ فقد الاتصال بالإنترنت', 'error');
    } else {
        const msg = document.createElement('div');
        msg.id = 'offline-toast-msg';
        msg.innerHTML = '❌ فقد الاتصال بالإنترنت';
        msg.style.cssText = 'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#ef4444; color:white; padding:12px 24px; border-radius:8px; font-weight:bold; z-index:999999; box-shadow:0 4px 12px rgba(0,0,0,0.2); font-family:Cairo,sans-serif;';
        document.body.appendChild(msg);
        setTimeout(() => {
            if (document.getElementById('offline-toast-msg')) {
                document.getElementById('offline-toast-msg').remove();
            }
        }, 3000);
    }
});
