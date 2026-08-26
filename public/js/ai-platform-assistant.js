/**
 * ZoomDz Platform AI Assistant - Floating Draggable Widget
 * مساعد منصة ZoomDz الذكي التفاعلي - أيقونة دائرية قابلة للتحريك ودردشة مخصصة للمنصة
 */

(function () {
    // Prevent duplicate initializations
    if (window.__ZOOMDZ_AI_ASSISTANT_INITIALIZED__) return;
    window.__ZOOMDZ_AI_ASSISTANT_INITIALIZED__ = true;

    // Platform Knowledge Base for Instant Fallback
    const PLATFORM_KB = [
        {
            keywords: ['سحب', 'ارباح', 'أرباح', 'سحب الارباح', 'بريدي موب', 'baridimob', 'ccp', 'بريد الجزائر', 'تحويل', 'فلوس', 'دراهم'],
            response: `💰 **دليل سحب الأرباح في منصة ZoomDz:**
1. **طرق السحب المتاحة:**
   - 📱 **تطبيق بريدي موب (BaridiMob):** تحويل فوري ومباشر إلى حسابك عبر رقم RIP.
   - 📮 **الحساب البريدي الجاري (CCP):** عبر رقم الحساب والمفتاح (Clé CCP).
2. **الحد الأدنى للسحب:** 500 دج فقط.
3. **مدة المعالجة:** تتم مراجعة وإرسال الحوالات خلال **24 ساعة** كحد أقصى مع إشعار فوري بحالة التحويل.
4. **كيفية تقديم طلب السحب:**
   - افتح قسم **المحفظة / الأرباح** من القائمة.
   - اضغط على زر **"طلب سحب الأرباح"**.
   - اختر طريقة السحب وأدخل معلومات حسابك والمبلغ، ثم أكد الطلب.

[[NAV:earnings:الانتقال إلى قسم المحفظة والأرباح]]`
        },
        {
            keywords: ['شحن', 'رصيد', 'دفع', 'تعبئة', 'اشتراك', 'شراء'],
            response: `💳 **دليل شحن الرصيد والدفع في ZoomDz:**
- يمكنك شحن محفظتك للاشتراك في الحصص والدورات عبر:
  1. 📱 **بريدي موب (BaridiMob)** أو **البطاقة الذهبية / CIB**.
  2. 🧾 **رفع وصل التحويل (Reçu):** قم بالتحويل ثم ارفع صورة الوصل في قسم المعاملات ليتم اعتماد رصيدك فوراً.
- كما يمكنك الحصول على رصيد مجاني يومياً عبر **صندوق الهدايا 🎁** و**نظام دعوة الأصدقاء (الإحالة) 🏆**.

[[NAV:transactions:الانتقال إلى قسم المعاملات وشحن الرصيد]]`
        },
        {
            keywords: ['اقسام', 'أقسام', 'اقسام المنصة', 'كيف تعمل', 'شرح المنصة', 'لوحة', 'صفحات'],
            response: `🧭 **أقسام ودليل استخدام منصة ZoomDz:**
- 🎓 **الحصص والدروس (Offers):** استعراض الحصص المباشرة والدروس الخصوصية المتاحة وحجزها.
- 📚 **الدورات (Courses):** الدورات المسجلة والفيديوهات التعليمية الشاملة.
- 📝 **التمارين والواجبات (Exercises):** بنك التمارين التفاعلية وحلولها.
- 👥 **المجموعات (Groups):** غرف الدردشة الجماعية مع الأساتذة ومشاركة الملفات.
- 📰 **المنشورات (Posts):** نصائح الأساتذة والمذكرات والملخصات.
- 💬 **الرسائل (Messages):** التواصل الفردي المباشر مع إرفاق الملفات (+) والتقاط الصور (📷).
- 🤖 **المعلم الذكي (AI Tutor):** تحليل صور التمارين وحلها خطوة بخطوة.
- 🎁 **صندوق الهدايا (Mystery Box):** فتح صندوق يومي لربح رصيد مجاني.

[[NAV:offers:استعراض الحصص المتاحة]]`
        },
        {
            keywords: ['ارفاق', 'إرفاق', 'ملف', 'ملفات', 'صورة', 'صور', 'كاميرا', 'التقاط', 'تصوير', 'كامرة'],
            response: `📁 **ميزة إرفاق الملفات والتقاط الصور الجديدة:**
1. ➕ **زر الإرفاق (+):** تجده بجانب صندوق الكتابة في الرسائل والمجموعات والمعلم الذكي لإرفاق أي صورة (PNG, JPG, WEBP) أو ملف مستندات (PDF, Word, Excel, ZIP).
2. 📷 **زر التقاط الصور (الكاميرا):** يتيح لك فتح كاميرا هاتفك أو حاسوبك فوراً والتقاط صورة لتمرين أو مذكرة وإرسالها بضغطة زر واحدة.
3. 🔍 **معاينة قبل الإرسال:** يمكنك فحص الصورة أو الملف وإلغاء المرفق أو تأكيد إرساله بسهولة.`
        },
        {
            keywords: ['بث', 'مباشر', 'حصة مباشرة', 'كاميرا البث', 'زوم', 'zoom', 'agora', 'jitsi', 'حضور'],
            response: `🎥 **الحصص والبث المباشر في ZoomDz:**
- المنصة تدعم البث المباشر التفاعلي عالي الجودة عبر تقنيات **Agora** و **Jitsi** المدمجة مباشرة داخل المنصة بدون الحاجة لتحميل برامج خارجية.
- يدعم البث: الصوت والصورة، مشاركة الشاشة، السبورة التفاعلية، والدردشة الحية مع الأستاذ وزملائك.`
        },
        {
            keywords: ['هدية', 'هدايا', 'صندوق', 'مجاني', 'احالة', 'إحالة', 'مكافأة', 'ربح'],
            response: `🎁 **صندوق الهدايا اليومي ونظام الإحالة:**
- 🎁 **صندوق الهدايا:** متاح يومياً لجميع الطلاب لفتح الصندوق وربح رصيد مالي يضاف مباشرة إلى محفظتك!
- 🏆 **نظام الإحالة (Referral):** شارك رابط دعوتك الخاص مع أصدقائك، وستحصل على مكافأة مالية في محفظتك عن كل صديق ينضم للمنصة.`
        },
        {
            keywords: ['معلم ذكي', 'ai tutor', 'ذكاء اصطناعي', 'حل تمرين', 'مسألة'],
            response: `🤖 **المعلم الذكي في ZoomDz:**
- ميزة الذكاء الاصطناعي المتطورة المخصصة للمناهج الجزائرية في كافة الأطوار (ابتدائي، متوسط، ثانوي، جامعي).
- يمكنك كتابة أي سؤال أو **التقاط صورة لتمرينك (📷)** ليشرح لك الحل والخطوات المنهجية بالتفصيل.`
        }
    ];

    function getFallbackResponse(query, role) {
        const q = (query || '').toLowerCase().trim();
        
        // Strict platform scope check
        const isPlatformRelated = /zoomdz|منصة|سحب|شحن|رصيد|استاذ|أستاذ|طالب|حصة|حجز|دورة|تمرين|واجب|مجموعة|مجموعات|رسائل|دردشة|بريدي|ccp|ارباح|أرباح|كاميرا|ارفاق|إرفاق|ملف|معلم ذكي|بث|مباشر|تسجيل|تسجيل دخول|حساب|أقسام|اقسام|قسم/i.test(q);
        
        for (const item of PLATFORM_KB) {
            if (item.keywords.some(k => q.includes(k))) {
                return item.response;
            }
        }

        if (!isPlatformRelated && q.length > 3) {
            return `مرحباً بك! 👋 أنا **مساعد ZoomDz الذكي**، ومهمتي مخصصة حصرياً لمساعدتك في:
- 💡 شرح خدمات وأقسام منصة ZoomDz وكيفية التنقل بينها.
- 💳 طرق شحن الرصيد وسحب الأرباح (BaridiMob / CCP).
- 🎥 كيفية بدء وحضور الحصص المباشرة واستخدام السبورة.
- 📁 كيفية إرفاق الملفات والصور (+) والتقاط الصور (📷).
- 🤖 كيفية الاستفادة من المعلم الذكي وصندوق الهدايا اليومي.

يرجى طرح سؤالك حول المنصة وسأكون سعيداً بمساعدتك فوراً! ✨`;
        }

        return `أهلاً بك في منصة **ZoomDz التعليمية**! 🇩🇿
كيف يمكنني مساعدتك اليوم بخصوص المنصة أو الأقسام أو طرق السحب والدفع؟

[[NAV:offers:استعراض الحصص والدروس]]
[[NAV:transactions:فتح المحفظة والمعاملات]]`;
    }

    // Styles Injection
    const css = `
    /* ZoomDz Floating AI Assistant Widget Styles */
    #zoomdz-ai-float-btn {
        position: fixed;
        bottom: 24px;
        left: 24px;
        width: 58px;
        height: 58px;
        border-radius: 50%;
        background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
        color: #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.5rem;
        cursor: grab;
        z-index: 99999;
        box-shadow: 0 8px 25px rgba(37, 99, 235, 0.4), 0 0 0 3px rgba(255, 255, 255, 0.85);
        user-select: none;
        touch-action: none;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
    }

    #zoomdz-ai-float-btn:hover {
        transform: scale(1.08);
        box-shadow: 0 12px 30px rgba(124, 58, 237, 0.5), 0 0 0 4px #ffffff;
    }

    #zoomdz-ai-float-btn:active {
        cursor: grabbing;
        transform: scale(0.95);
    }

    #zoomdz-ai-float-btn .ai-glow-ring {
        position: absolute;
        inset: -4px;
        border-radius: 50%;
        background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc);
        z-index: -1;
        opacity: 0.75;
        animation: aiPulse 2.5s infinite;
    }

    @keyframes aiPulse {
        0%, 100% { transform: scale(1); opacity: 0.6; }
        50% { transform: scale(1.15); opacity: 0.9; filter: blur(2px); }
    }

    #zoomdz-ai-float-btn .ai-tooltip-badge {
        position: absolute;
        right: calc(100% + 12px);
        top: 50%;
        transform: translateY(-50%);
        background: #0f172a;
        color: #f8fafc;
        padding: 5px 12px;
        border-radius: 20px;
        font-size: 0.78rem;
        font-weight: 700;
        white-space: nowrap;
        pointer-events: none;
        box-shadow: 0 4px 14px rgba(0,0,0,0.2);
        opacity: 0.95;
        font-family: 'Cairo', system-ui, sans-serif;
        border: 1px solid rgba(255,255,255,0.1);
        display: flex;
        align-items: center;
        gap: 6px;
    }

    #zoomdz-ai-float-btn .ai-tooltip-badge::after {
        content: '';
        position: absolute;
        left: 100%;
        top: 50%;
        transform: translateY(-50%);
        border-width: 5px;
        border-style: solid;
        border-color: transparent transparent transparent #0f172a;
    }

    /* Modal / Pop-up Chat Window */
    #zoomdz-ai-chat-window {
        position: fixed;
        bottom: 92px;
        left: 24px;
        width: 375px;
        max-width: calc(100vw - 32px);
        height: 540px;
        max-height: calc(100vh - 120px);
        background: #ffffff;
        border-radius: 20px;
        box-shadow: 0 16px 40px rgba(15, 23, 42, 0.22), 0 0 0 1px rgba(0,0,0,0.06);
        display: none;
        flex-direction: column;
        z-index: 999999;
        overflow: hidden;
        font-family: 'Cairo', system-ui, sans-serif;
        direction: rtl;
        animation: aiWindowPop 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @media (max-width: 640px) {
        #zoomdz-ai-chat-window {
            position: fixed !important;
            inset: 10px !important;
            width: auto !important;
            height: auto !important;
            max-width: none !important;
            max-height: none !important;
            border-radius: 16px !important;
            z-index: 9999999 !important;
            box-shadow: 0 12px 36px rgba(15, 23, 42, 0.4) !important;
        }
        #zoomdz-ai-float-btn {
            bottom: 16px !important;
            left: 16px !important;
            z-index: 9999990 !important;
        }
        #zoomdz-ai-float-btn .ai-tooltip-badge {
            display: none !important;
        }
    }

    @keyframes aiWindowPop {
        from { opacity: 0; transform: scale(0.92) translateY(15px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
    }

    .ai-chat-header {
        background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
        color: #ffffff;
        padding: 14px 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
    }

    .ai-chat-header-info {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .ai-avatar-icon {
        width: 36px;
        height: 36px;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.15rem;
    }

    .ai-chat-header h4 {
        margin: 0;
        font-size: 0.96rem;
        font-weight: 800;
        line-height: 1.3;
    }

    .ai-chat-header p {
        margin: 0;
        font-size: 0.72rem;
        color: #bfdbfe;
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .ai-chat-header .status-dot {
        width: 7px;
        height: 7px;
        background: #10b981;
        border-radius: 50%;
        display: inline-block;
    }

    .ai-chat-header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .ai-chat-btn-icon {
        background: rgba(255, 255, 255, 0.15);
        border: none;
        color: white;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.85rem;
        transition: background 0.2s;
    }

    .ai-chat-btn-icon:hover {
        background: rgba(255, 255, 255, 0.3);
    }

    .ai-chat-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        background: #f8fafc;
        display: flex;
        flex-direction: column;
        gap: 12px;
        scrollbar-width: thin;
    }

    .ai-chat-body::-webkit-scrollbar {
        width: 5px;
    }
    .ai-chat-body::-webkit-scrollbar-thumb {
        background: #cbd5e1;
        border-radius: 10px;
    }

    .ai-msg {
        max-width: 88%;
        padding: 10px 14px;
        border-radius: 16px;
        font-size: 0.88rem;
        line-height: 1.55;
        word-wrap: break-word;
    }

    .ai-msg.bot {
        align-self: flex-start;
        background: #ffffff;
        color: #1e293b;
        border: 1px solid #e2e8f0;
        border-bottom-right-radius: 4px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.03);
    }

    .ai-msg.user {
        align-self: flex-end;
        background: linear-gradient(135deg, #2563eb, #1d4ed8);
        color: #ffffff;
        border-bottom-left-radius: 4px;
        box-shadow: 0 4px 12px rgba(37,99,235,0.25);
    }

    .ai-msg-nav-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: #eff6ff;
        color: #2563eb;
        border: 1.5px solid #bfdbfe;
        padding: 6px 12px;
        border-radius: 10px;
        font-size: 0.82rem;
        font-weight: 700;
        cursor: pointer;
        margin-top: 8px;
        transition: all 0.2s;
        text-decoration: none;
    }

    .ai-msg-nav-btn:hover {
        background: #2563eb;
        color: #ffffff;
        border-color: #2563eb;
    }

    .ai-chips-container {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 8px 14px;
        background: #ffffff;
        border-top: 1px solid #f1f5f9;
    }

    .ai-chip {
        background: #f1f5f9;
        border: 1px solid #e2e8f0;
        color: #334155;
        font-size: 0.75rem;
        font-weight: 700;
        padding: 4px 10px;
        border-radius: 20px;
        cursor: pointer;
        transition: all 0.2s;
        white-space: nowrap;
    }

    .ai-chip:hover {
        background: #e0f2fe;
        color: #0369a1;
        border-color: #bae6fd;
    }

    .ai-chat-input-area {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        background: #ffffff;
        border-top: 1px solid #e2e8f0;
    }

    .ai-chat-input {
        flex: 1;
        border: 1.5px solid #cbd5e1;
        border-radius: 24px;
        padding: 8px 14px;
        font-size: 0.88rem;
        font-family: inherit;
        outline: none;
        background: #f8fafc;
        color: #0f172a;
    }

    .ai-chat-input:focus {
        border-color: #3b82f6;
        background: #ffffff;
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
    }

    .ai-send-btn {
        width: 38px;
        height: 38px;
        border-radius: 50%;
        background: #2563eb;
        color: white;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.95rem;
        transition: background 0.2s, transform 0.1s;
        flex-shrink: 0;
    }

    .ai-send-btn:hover {
        background: #1d4ed8;
        transform: scale(1.05);
    }

    .ai-send-btn:disabled {
        background: #94a3b8;
        cursor: not-allowed;
        transform: none;
    }

    .ai-typing-indicator {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 8px 12px;
        background: #ffffff;
        border-radius: 16px;
        align-self: flex-start;
        border: 1px solid #e2e8f0;
    }

    .ai-typing-dot {
        width: 6px;
        height: 6px;
        background: #3b82f6;
        border-radius: 50%;
        animation: aiBlink 1.4s infinite both;
    }
    .ai-typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .ai-typing-dot:nth-child(3) { animation-delay: 0.4s; }

    @keyframes aiBlink {
        0%, 80%, 100% { transform: scale(0); opacity: 0.4; }
        40% { transform: scale(1); opacity: 1; }
    }
    `;

    const styleEl = document.createElement('style');
    styleEl.innerHTML = css;
    document.head.appendChild(styleEl);

    // Create Widget Markup
    const widgetContainer = document.createElement('div');
    widgetContainer.id = 'zoomdz-ai-assistant-root';
    widgetContainer.innerHTML = `
        <div id="zoomdz-ai-float-btn" title="اسأل مساعد ZoomDz الذكي (انقر للفتح، أو اسحب لتغيير المكان)">
            <div class="ai-glow-ring"></div>
            <i class="fas fa-robot"></i>
            <div class="ai-tooltip-badge">
                <span>مساعد المنصة 🤖</span>
            </div>
        </div>

        <div id="zoomdz-ai-chat-window">
            <div class="ai-chat-header">
                <div class="ai-chat-header-info">
                    <div class="ai-avatar-icon">
                        <i class="fas fa-sparkles"></i>
                    </div>
                    <div>
                        <h4>مساعد ZoomDz الذكي</h4>
                        <p><span class="status-dot"></span> مخصص لخدمات وأقسام المنصة والسحب</p>
                    </div>
                </div>
                <div class="ai-chat-header-actions">
                    <button class="ai-chat-btn-icon" id="ai-clear-chat-btn" title="مسح المحادثة"><i class="fas fa-redo-alt"></i></button>
                    <button class="ai-chat-btn-icon" id="ai-close-chat-btn" title="إغلاق"><i class="fas fa-times"></i></button>
                </div>
            </div>

            <div class="ai-chat-body" id="ai-chat-messages">
                <div class="ai-msg bot">
                    👋 <strong>مرحباً بك في منصة ZoomDz!</strong><br>
                    أنا مساعدك الذكي الخاص بالمنصة، جاهز للإجابة عن جميع استفساراتك حول <strong>أقسام المنصة، طرق سحب الأرباح وشحن الرصيد (بريدي موب / CCP)، الحصص المباشرة، وإرفاق الملفات والتقاط الصور</strong>.
                </div>
            </div>

            <div class="ai-chips-container">
                <button class="ai-chip" data-q="كيف أسحب أرباحي؟">💰 سحب الأرباح (BaridiMob/CCP)</button>
                <button class="ai-chip" data-q="كيف أشحن رصيدي في المنصة؟">💳 شحن الرصيد</button>
                <button class="ai-chip" data-q="ما هي أقسام المنصة وكيف أتنقل بينها؟">🧭 دليل الأقسام</button>
                <button class="ai-chip" data-q="كيف أرفق ملفات أو ألتقط صوراً؟">📁 إرفاق الملفات والكاميرا</button>
                <button class="ai-chip" data-q="كيف أبدأ أو أحضر حصة مباشرة؟">🎥 الحصص المباشرة</button>
                <button class="ai-chip" data-q="صندوق الهدايا اليومي ونظام الإحالة">🎁 الهدايا والإحالة</button>
            </div>

            <div class="ai-chat-input-area">
                <input type="text" class="ai-chat-input" id="ai-chat-input-field" placeholder="اسأل عن أي ميزة في المنصة أو طريقة سحب...">
                <button class="ai-send-btn" id="ai-chat-send-btn" title="إرسال"><i class="fas fa-paper-plane"></i></button>
            </div>
        </div>
    `;
    if (document.body) {
        document.body.appendChild(widgetContainer);
    } else {
        window.addEventListener('DOMContentLoaded', () => {
            document.body.appendChild(widgetContainer);
        });
    }

    // Elements
    const floatBtn = document.getElementById('zoomdz-ai-float-btn');
    const chatWindow = document.getElementById('zoomdz-ai-chat-window');
    const closeBtn = document.getElementById('ai-close-chat-btn');
    const clearBtn = document.getElementById('ai-clear-chat-btn');
    const messagesContainer = document.getElementById('ai-chat-messages');
    const inputField = document.getElementById('ai-chat-input-field');
    const sendBtn = document.getElementById('ai-chat-send-btn');

    // Detect user role (student / teacher)
    function getUserRole() {
        if (window.location.pathname.includes('teacher') || document.title.includes('أستاذ')) return 'teacher';
        if (window.location.pathname.includes('student') || document.title.includes('طالب')) return 'student';
        return 'user';
    }

    // Restore saved position
    try {
        const savedPos = localStorage.getItem('zoomdz_ai_widget_pos');
        if (savedPos) {
            const { left, top } = JSON.parse(savedPos);
            const maxL = window.innerWidth - 70;
            const maxT = window.innerHeight - 70;
            if (left >= 10 && left <= maxL && top >= 10 && top <= maxT) {
                floatBtn.style.left = left + 'px';
                floatBtn.style.top = top + 'px';
                floatBtn.style.bottom = 'auto';
            }
        }
    } catch (e) { }

    // Draggable Logic (Mouse + Touch)
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialLeft = 0;
    let initialTop = 0;
    let hasMoved = false;
    let lastTouchEndTime = 0;

    function onPointerDown(e) {
        if (e.target.closest('#ai-close-chat-btn') || e.target.closest('#ai-clear-chat-btn')) return;
        
        // Prevent synthetic mouse event right after touch end
        if (e.type === 'mousedown' && (Date.now() - lastTouchEndTime < 600)) {
            return;
        }

        isDragging = true;
        hasMoved = false;

        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        const rect = floatBtn.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        dragStartX = clientX;
        dragStartY = clientY;

        document.addEventListener('mousemove', onPointerMove);
        document.addEventListener('mouseup', onPointerUp);
        document.addEventListener('touchmove', onPointerMove, { passive: false });
        document.addEventListener('touchend', onPointerUp);
    }

    function onPointerMove(e) {
        if (!isDragging) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        const deltaX = clientX - dragStartX;
        const deltaY = clientY - dragStartY;

        if (Math.abs(deltaX) > 6 || Math.abs(deltaY) > 6) {
            hasMoved = true;
            if (e.cancelable && e.type === 'touchmove') e.preventDefault();

            let newL = initialLeft + deltaX;
            let newT = initialTop + deltaY;

            // Boundaries
            const maxL = window.innerWidth - 65;
            const maxT = window.innerHeight - 65;
            newL = Math.max(10, Math.min(maxL, newL));
            newT = Math.max(10, Math.min(maxT, newT));

            floatBtn.style.left = newL + 'px';
            floatBtn.style.top = newT + 'px';
            floatBtn.style.bottom = 'auto';

            // Sync Chat Window Position if open
            repositionChatWindow(newL, newT);
        }
    }

    function onPointerUp(e) {
        if (!isDragging) return;
        isDragging = false;
        if (e.type === 'touchend') {
            lastTouchEndTime = Date.now();
        }

        document.removeEventListener('mousemove', onPointerMove);
        document.removeEventListener('mouseup', onPointerUp);
        document.removeEventListener('touchmove', onPointerMove);
        document.removeEventListener('touchend', onPointerUp);

        if (hasMoved) {
            const rect = floatBtn.getBoundingClientRect();
            try {
                localStorage.setItem('zoomdz_ai_widget_pos', JSON.stringify({ left: rect.left, top: rect.top }));
            } catch (err) { }
        } else {
            // It was a click/tap!
            toggleChatWindow();
        }
    }

    floatBtn.addEventListener('mousedown', onPointerDown);
    floatBtn.addEventListener('touchstart', onPointerDown, { passive: true });

    function repositionChatWindow(btnLeft, btnTop) {
        if (window.innerWidth <= 640) {
            chatWindow.style.left = '';
            chatWindow.style.right = '';
            chatWindow.style.top = '';
            chatWindow.style.bottom = '';
            return;
        }

        const rect = floatBtn.getBoundingClientRect();
        let targetLeft = rect.left;
        let targetBottom = window.innerHeight - rect.top + 12;

        if (targetLeft + 380 > window.innerWidth) {
            targetLeft = window.innerWidth - 390;
        }
        if (targetLeft < 10) targetLeft = 10;

        chatWindow.style.left = targetLeft + 'px';
        if (rect.top < 450) {
            chatWindow.style.top = (rect.bottom + 12) + 'px';
            chatWindow.style.bottom = 'auto';
        } else {
            chatWindow.style.bottom = (window.innerHeight - rect.top + 12) + 'px';
            chatWindow.style.top = 'auto';
        }
    }

    function toggleChatWindow(forceShow) {
        const isHidden = chatWindow.style.display === 'none' || !chatWindow.style.display;
        const shouldShow = (forceShow !== undefined) ? !!forceShow : isHidden;
        if (shouldShow) {
            const rect = floatBtn.getBoundingClientRect();
            repositionChatWindow(rect.left, rect.top);
            chatWindow.style.display = 'flex';
            setTimeout(() => {
                if (inputField) inputField.focus();
            }, 100);
        } else {
            chatWindow.style.display = 'none';
        }
    }

    window.openAiAssistant = function () { toggleChatWindow(true); };
    window.toggleAiAssistant = function () { toggleChatWindow(); };
    window.openAiWidget = function () { toggleChatWindow(true); };

    closeBtn.addEventListener('click', () => {
        chatWindow.style.display = 'none';
    });

    clearBtn.addEventListener('click', () => {
        messagesContainer.innerHTML = `
            <div class="ai-msg bot">
                👋 <strong>تم مسح المحادثة.</strong><br>
                أنا جاهز للإجابة عن أي سؤال يخص منصة ZoomDz وأقسامها وسحب الأرباح وشحن الرصيد!
            </div>
        `;
    });

    // Handle interactive navigation within the platform
    window.handleAiWidgetNav = function (sectionId) {
        if (typeof window.showSection === 'function') {
            window.showSection(sectionId);
        } else if (typeof window.switchSection === 'function') {
            window.switchSection(sectionId);
        } else {
            const tabBtn = document.querySelector(`[data-section="${sectionId}"]`);
            if (tabBtn) tabBtn.click();
        }
        // On mobile, close widget or notify
        if (window.innerWidth < 768) {
            chatWindow.style.display = 'none';
        }
    };

    function parseResponseMarkup(text) {
        if (!text) return '';
        let formatted = text
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/\n/g, '<br>');

        // Match [[NAV:section_id:Button Label]]
        formatted = formatted.replace(/\[\[NAV:([a-zA-Z0-9_\-]+):(.*?)\]\]/g, function (match, sec, label) {
            return `<br><button class="ai-msg-nav-btn" onclick="handleAiWidgetNav('${sec}')"><i class="fas fa-arrow-left"></i> ${label}</button>`;
        });

        return formatted;
    }

    async function sendUserMessage(text) {
        const userText = (text || inputField.value).trim();
        if (!userText) return;

        inputField.value = '';
        appendMessage(userText, 'user');

        // Typing indicator
        const typingEl = document.createElement('div');
        typingEl.className = 'ai-typing-indicator';
        typingEl.innerHTML = '<div class="ai-typing-dot"></div><div class="ai-typing-dot"></div><div class="ai-typing-dot"></div>';
        messagesContainer.appendChild(typingEl);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;

        sendBtn.disabled = true;

        const role = getUserRole();

        try {
            // Attempt API call to backend assistant endpoint
            const token = localStorage.getItem('token') || '';
            const res = await fetch('/api/ai/platform-assistant', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': token ? `Bearer ${token}` : ''
                },
                body: JSON.stringify({ message: userText, role })
            });

            typingEl.remove();

            if (res.ok) {
                const data = await res.json();
                if (data.success && data.message) {
                    appendMessage(data.message, 'bot');
                } else {
                    const fb = getFallbackResponse(userText, role);
                    appendMessage(fb, 'bot');
                }
            } else {
                const fb = getFallbackResponse(userText, role);
                appendMessage(fb, 'bot');
            }
        } catch (err) {
            typingEl.remove();
            const fb = getFallbackResponse(userText, role);
            appendMessage(fb, 'bot');
        } finally {
            sendBtn.disabled = false;
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    }

    function appendMessage(text, sender = 'bot') {
        const msgDiv = document.createElement('div');
        msgDiv.className = `ai-msg ${sender}`;
        if (sender === 'bot') {
            msgDiv.innerHTML = parseResponseMarkup(text);
        } else {
            msgDiv.textContent = text;
        }
        messagesContainer.appendChild(msgDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    sendBtn.addEventListener('click', () => sendUserMessage());
    inputField.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendUserMessage();
    });

    // Chips clicks
    document.querySelectorAll('.ai-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const q = chip.getAttribute('data-q');
            if (q) sendUserMessage(q);
        });
    });

})();
