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


// Social Media Floating Quick Links (Facebook & Telegram)
(function() {
    function injectSocialLinks() {
        if (document.getElementById('platform-floating-socials')) return;
        
        var style = document.createElement('style');
        style.id = 'platform-socials-style';
        style.textContent = `
            .platform-social-links-wrap {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .platform-social-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 36px;
                height: 36px;
                border-radius: 50%;
                color: #ffffff !important;
                text-decoration: none !important;
                transition: transform 0.2s ease, box-shadow 0.2s ease;
                box-shadow: 0 3px 10px rgba(0,0,0,0.15);
                font-size: 1.05rem;
            }
            .platform-social-btn:hover {
                transform: translateY(-2px) scale(1.05);
                box-shadow: 0 5px 15px rgba(0,0,0,0.25);
            }
            .platform-social-btn.facebook {
                background: linear-gradient(135deg, #1877f2, #0d65d9);
            }
            .platform-social-btn.telegram {
                background: linear-gradient(135deg, #229ed9, #0088cc);
            }
            /* Floating container for fast access */
            #platform-floating-socials {
                position: fixed;
                bottom: 85px;
                right: 18px;
                z-index: 9998;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            @media (max-width: 768px) {
                #platform-floating-socials {
                    bottom: 78px;
                    right: 12px;
                }
                .platform-social-btn {
                    width: 34px;
                    height: 34px;
                    font-size: 0.95rem;
                }
            }
        `;
        document.head.appendChild(style);

        var floatContainer = document.createElement('div');
        floatContainer.id = 'platform-floating-socials';
        floatContainer.innerHTML = `
            <a href="https://www.facebook.com/profile.php?id=61593360985540" target="_blank" rel="noopener noreferrer" class="platform-social-btn facebook" title="صفحتنا على فيسبوك" aria-label="Facebook">
                <i class="fab fa-facebook-f"></i>
            </a>
            <a href="https://t.me/mohhh20055" target="_blank" rel="noopener noreferrer" class="platform-social-btn telegram" title="قناتنا على تلغرام" aria-label="Telegram">
                <i class="fab fa-telegram-plane"></i>
            </a>
        `;
        document.body.appendChild(floatContainer);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectSocialLinks);
    } else {
        injectSocialLinks();
    }
})();


// Global Chat & Group Messages Infinite Scroll and 10-message Pagination Engine
(function() {
    'use strict';
    
    var paginationState = {
        directLimit: 10,
        groupLimit: 10,
        isLoadingMore: false,
        hasMoreDirect: true,
        hasMoreGroup: true,
        oldestDirectTimestamp: null,
        oldestGroupTimestamp: null
    };

    window.PlatformChatPagination = {
        state: paginationState,
        resetDirect: function() {
            paginationState.directLimit = 10;
            paginationState.hasMoreDirect = true;
            paginationState.oldestDirectTimestamp = null;
        },
        resetGroup: function() {
            paginationState.groupLimit = 10;
            paginationState.hasMoreGroup = true;
            paginationState.oldestGroupTimestamp = null;
        },
        getDirectLimit: function() { return paginationState.directLimit; },
        getGroupLimit: function() { return paginationState.groupLimit; },
        loadMoreDirect: function(callback) {
            if (paginationState.isLoadingMore) return;
            paginationState.directLimit += 10;
            if (typeof callback === 'function') callback();
        },
        loadMoreGroup: function(callback) {
            if (paginationState.isLoadingMore) return;
            paginationState.groupLimit += 10;
            if (typeof callback === 'function') callback();
        }
    };

    // Attach scroll listener to chat containers when they appear
    function attachScrollPagination() {
        var directContainer = document.getElementById('chatMessages');
        if (directContainer && !directContainer.dataset.paginationAttached) {
            directContainer.dataset.paginationAttached = 'true';
            directContainer.addEventListener('scroll', function() {
                if (directContainer.scrollTop <= 20) {
                    if (window.loadMoreDirectMessagesHistory && typeof window.loadMoreDirectMessagesHistory === 'function') {
                        window.loadMoreDirectMessagesHistory();
                    } else if (typeof window.loadConversationMessages === 'function' && window.currentChatTeacher) {
                        PlatformChatPagination.loadMoreDirect(function() {
                            var currentH = directContainer.scrollHeight;
                            var curOther = window.currentChatTeacher;
                            window.loadConversationMessages(curOther.id, curOther.type, true);
                        });
                    }
                }
            }, { passive: true });
        }

        var groupContainer = document.getElementById('studentGroupMessages') || document.getElementById('groupMessagesArea') || document.getElementById('groupMessages');
        if (groupContainer && !groupContainer.dataset.paginationAttached) {
            groupContainer.dataset.paginationAttached = 'true';
            groupContainer.addEventListener('scroll', function() {
                if (groupContainer.scrollTop <= 20) {
                    if (window.loadMoreGroupMessagesHistory && typeof window.loadMoreGroupMessagesHistory === 'function') {
                        window.loadMoreGroupMessagesHistory();
                    } else if (window.PlatformChatPagination) {
                        PlatformChatPagination.loadMoreGroup(function() {
                            if (typeof window.fetchStudentGroupMessages === 'function') {
                                window.fetchStudentGroupMessages();
                            } else if (typeof window.loadGroupMessages === 'function') {
                                window.loadGroupMessages();
                            }
                        });
                    }
                }
            }, { passive: true });
        }
    }

    setInterval(attachScrollPagination, 1500);
})();
