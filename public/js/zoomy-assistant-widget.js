/**
 * ZoomDz Platform - Zoomy AI Assistant Drag & Drop To Trash Bin & Conversation Reset
 * إدارة سحب معلم الذكاء الاصطناعي إلى سلة المهملات وتصفير المحادثة وإخفاء الزر العائم
 */
(function() {
    'use strict';

    function initZoomyWidget() {
        if (document.getElementById('zoomyFloatingAssistantContainer')) return;
        if (window.location.pathname.includes('ai-tutor') || window.location.href.includes('ai-tutor')) return; // Don't show floating widget on the dedicated AI Tutor page itself

        const isHidden = localStorage.getItem('zoomdz_ai_assistant_hidden') === 'true';

        const container = document.createElement('div');
        container.id = 'zoomyFloatingAssistantContainer';
        container.innerHTML = `
            <style>
                #zoomyFloatingWidget {
                    position: fixed;
                    bottom: 28px;
                    left: 28px;
                    z-index: 999990;
                    display: ${isHidden ? 'none' : 'flex'};
                    align-items: center;
                    gap: 10px;
                    background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
                    color: #ffffff;
                    padding: 10px 18px 10px 12px;
                    border-radius: 50px;
                    box-shadow: 0 8px 25px rgba(37, 99, 235, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.2);
                    cursor: grab;
                    user-select: none;
                    touch-action: none;
                    transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.3s ease;
                    animation: zoomyFloatPulse 3s ease-in-out infinite;
                }
                #zoomyFloatingWidget:hover {
                    transform: translateY(-3px) scale(1.03);
                    box-shadow: 0 12px 30px rgba(37, 99, 235, 0.6);
                }
                #zoomyFloatingWidget:active {
                    cursor: grabbing;
                    transform: scale(0.98);
                }
                .zoomy-avatar-box {
                    width: 38px;
                    height: 38px;
                    background: #ffffff;
                    color: #2563eb;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 1.25rem;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                    flex-shrink: 0;
                }
                .zoomy-text-box {
                    display: flex;
                    flex-direction: column;
                    line-height: 1.2;
                }
                .zoomy-text-title {
                    font-weight: 800;
                    font-size: 0.88rem;
                    font-family: 'Cairo', sans-serif;
                }
                .zoomy-text-sub {
                    font-size: 0.72rem;
                    opacity: 0.9;
                    font-family: 'Cairo', sans-serif;
                }

                @keyframes zoomyFloatPulse {
                    0%, 100% { box-shadow: 0 8px 25px rgba(37, 99, 235, 0.45); }
                    50% { box-shadow: 0 12px 35px rgba(37, 99, 235, 0.65); }
                }

                /* سلة المهملات في المنتصف بالأسفل */
                #aiTrashBinZone {
                    position: fixed;
                    bottom: 20px;
                    left: 50%;
                    transform: translateX(-50%) translateY(140px);
                    z-index: 999995;
                    background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
                    color: #ffffff;
                    padding: 14px 28px;
                    border-radius: 40px;
                    border: 2px dashed #64748b;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    font-weight: 700;
                    font-size: 0.9rem;
                    font-family: 'Cairo', sans-serif;
                    opacity: 0;
                    pointer-events: none;
                    transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s ease, border-color 0.2s ease, background 0.2s ease;
                }

                #aiTrashBinZone.active {
                    transform: translateX(-50%) translateY(0);
                    opacity: 1;
                    pointer-events: auto;
                }

                #aiTrashBinZone.hover-over {
                    background: linear-gradient(135deg, #991b1b 0%, #dc2626 100%);
                    border-color: #f87171;
                    transform: translateX(-50%) translateY(-5px) scale(1.1);
                    box-shadow: 0 15px 45px rgba(220, 38, 38, 0.6);
                }

                #aiTrashBinZone i {
                    font-size: 1.4rem;
                    color: #ef4444;
                    transition: transform 0.2s ease, color 0.2s ease;
                }

                #aiTrashBinZone.hover-over i {
                    color: #ffffff;
                    transform: scale(1.2) rotate(-10deg);
                }

                .zoomy-trash-quick-btn {
                    background: rgba(255, 255, 255, 0.2);
                    color: #ffffff;
                    border: none;
                    width: 28px;
                    height: 28px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.8rem;
                    cursor: pointer;
                    margin-right: 4px;
                    transition: background 0.2s ease, transform 0.2s ease;
                    flex-shrink: 0;
                }
                .zoomy-trash-quick-btn:hover {
                    background: #ef4444;
                    color: #ffffff;
                    transform: scale(1.15);
                }

                .zoomy-sucking-into-trash {
                    transform: scale(0) rotate(720deg) !important;
                    opacity: 0 !important;
                    transition: all 0.4s cubic-bezier(0.6, -0.28, 0.735, 0.045) !important;
                }
            </style>

            <div id="zoomyFloatingWidget" style="display: ${isHidden ? 'none' : 'flex'};" title="انقر للتحدث أو اسحب لسلة المهملات لإخفاء الزر وتصفير المحادثة">
                <div class="zoomy-avatar-box">
                    <i class="fas fa-robot"></i>
                </div>
                <div class="zoomy-text-box">
                    <span class="zoomy-text-title">Zoomy AI 🤖</span>
                    <span class="zoomy-text-sub">انقر للتحدث • سحب للمهملات</span>
                </div>
                <button class="zoomy-trash-quick-btn" onclick="event.stopPropagation(); window.sendZoomyToTrash();" title="إخفاء الزر وحذف المحادثة في سلة المهملات 🗑️">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </div>

            <div id="aiTrashBinZone">
                <i class="fas fa-trash-alt" id="trashBinIcon"></i>
                <span>إفلات المساعد هنا لإخفاء الزر وحذف المحادثة 🗑️</span>
            </div>
        `;
        document.body.appendChild(container);

        setupDragAndDrop();
    }

    function setupDragAndDrop() {
        const widget = document.getElementById('zoomyFloatingWidget');
        const trashZone = document.getElementById('aiTrashBinZone');
        if (!widget || !trashZone) return;

        let isDragging = false;
        let startX = 0, startY = 0;
        let hasMoved = false;

        function onDragStart(clientX, clientY) {
            isDragging = true;
            hasMoved = false;
            startX = clientX;
            startY = clientY;

            widget.style.transition = 'none';
            trashZone.classList.add('active');
        }

        function onDragMove(clientX, clientY) {
            if (!isDragging) return;

            const deltaX = clientX - startX;
            const deltaY = clientY - startY;

            if (Math.abs(deltaX) > 6 || Math.abs(deltaY) > 6) {
                hasMoved = true;
            }

            const currentLeft = (widget._initialRectLeft || widget.getBoundingClientRect().left) + deltaX;
            const currentTop = (widget._initialRectTop || widget.getBoundingClientRect().top) + deltaY;

            widget.style.position = 'fixed';
            widget.style.left = currentLeft + 'px';
            widget.style.top = currentTop + 'px';
            widget.style.bottom = 'auto';

            const trashRect = trashZone.getBoundingClientRect();
            const widgetRect = widget.getBoundingClientRect();

            const isOver = !(widgetRect.right < trashRect.left || 
                             widgetRect.left > trashRect.right || 
                             widgetRect.bottom < trashRect.top || 
                             widgetRect.top > trashRect.bottom);

            if (isOver) {
                trashZone.classList.add('hover-over');
            } else {
                trashZone.classList.remove('hover-over');
            }
        }

        function onDragEnd() {
            if (!isDragging) return;
            isDragging = false;

            const isOverTrash = trashZone.classList.contains('hover-over');

            if (isOverTrash) {
                window.sendZoomyToTrash();
            } else {
                trashZone.classList.remove('active', 'hover-over');
                widget.style.transition = 'all 0.3s ease';
                widget.style.left = '28px';
                widget.style.top = 'auto';
                widget.style.bottom = '28px';

                if (!hasMoved) {
                    const token = localStorage.getItem('token');
                    if (!token || token === 'guest_token') {
                        alert('🔒 عذراً، لا يمكنك استخدام الذكاء الاصطناعي Zoomy إلا بعد إنشاء حساب أو تسجيل الدخول.');
                        window.location.href = '/?login=true';
                        return;
                    }
                    if (typeof window.toggleAiAssistant === 'function') {
                        window.toggleAiAssistant();
                    } else if (!window.location.pathname.includes('ai-tutor')) {
                        window.location.href = '/ai-tutor';
                    }
                }
            }

            delete widget._initialRectLeft;
            delete widget._initialRectTop;
        }

        widget.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const rect = widget.getBoundingClientRect();
            widget._initialRectLeft = rect.left;
            widget._initialRectTop = rect.top;
            onDragStart(e.clientX, e.clientY);

            function handleMouseMove(e) {
                onDragMove(e.clientX, e.clientY);
            }

            function handleMouseUp() {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
                onDragEnd();
            }

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });

        widget.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            const touch = e.touches[0];
            const rect = widget.getBoundingClientRect();
            widget._initialRectLeft = rect.left;
            widget._initialRectTop = rect.top;
            onDragStart(touch.clientX, touch.clientY);
        }, { passive: true });

        widget.addEventListener('touchmove', (e) => {
            if (!isDragging || e.touches.length !== 1) return;
            const touch = e.touches[0];
            onDragMove(touch.clientX, touch.clientY);
        }, { passive: true });

        widget.addEventListener('touchend', () => {
            onDragEnd();
        });
    }

    window.sendZoomyToTrash = function() {
        const widget = document.getElementById('zoomyFloatingWidget');
        const trashZone = document.getElementById('aiTrashBinZone');

        // Clear AI Chat Messages
        const msgs = document.getElementById('ai-assistant-messages');
        if (msgs) {
            msgs.innerHTML = `
                <div class="ai-msg bot">
                    👋 <strong>تم حذف وسكب جميع محادثات وسجل معلم الذكاء الاصطناعي بنجاح 🗑️</strong><br>
                    أنا جاهز للإجابة عن أي سؤال يخص منصة ZoomDz وأقسامها وسحب الأرباح وشحن الرصيد!
                </div>
            `;
        }

        // Save preference in localStorage so it stays hidden
        try {
            localStorage.setItem('zoomdz_ai_assistant_hidden', 'true');
        } catch(e) {}

        if (widget && trashZone) {
            trashZone.classList.add('active', 'hover-over');
            widget.classList.add('zoomy-sucking-into-trash');

            setTimeout(() => {
                widget.style.display = 'none'; // Completely HIDE
                widget.classList.remove('zoomy-sucking-into-trash');
                trashZone.classList.remove('active', 'hover-over');

                const msg = '🗑️ تم إخفاء الزر العائم وتصفير المحادثة بنجاح! يمكنك الوصول للمعلم الذكي دائماً من التبويبات.';
                if (typeof showToast === 'function') {
                    showToast(msg, 'success');
                }
            }, 400);
        } else {
            const msg = '🗑️ تم تصفير المحادثة وإخفاء الزر العائم بنجاح!';
            if (typeof showToast === 'function') {
                showToast(msg, 'success');
            }
        }
    };

    window.restoreZoomyWidget = function() {
        try {
            localStorage.removeItem('zoomdz_ai_assistant_hidden');
        } catch(e) {}
        const widget = document.getElementById('zoomyFloatingWidget');
        if (widget) {
            widget.style.display = 'flex';
            widget.style.left = '28px';
            widget.style.top = 'auto';
            widget.style.bottom = '28px';
        }
    };

    window.toggleAiAssistantSetting = function() {
        window.sendZoomyToTrash();
    };

    window.checkAiAssistantState = function() {
        const widget = document.getElementById('zoomyFloatingWidget');
        if (!widget) return;
        const isHidden = localStorage.getItem('zoomdz_ai_assistant_hidden') === 'true';
        widget.style.display = isHidden ? 'none' : 'flex';
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initZoomyWidget);
    } else {
        initZoomyWidget();
    }
})();
