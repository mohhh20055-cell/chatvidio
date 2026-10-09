/**
 * نظام الباقات التعليمية - لوحة تحكم الطالب (ZoomDz Student Packages)
 */

let allStudentPackages = [];
let studentMySubscriptions = [];
let currentPackageFilter = 'all'; // 'all' or specific level
let currentPackageTab = 'all'; // 'all' (جميع الباقات) or 'my_subs' (باقاتي المشترك فيها)
let currentStudentPackagePage = 1;
let hasMoreStudentPackages = false;

// ============================================================
// 1. جلب الباقات والاشتراكات للطالب (بتواتر ودفعات لتسريع الجلب)
// ============================================================
async function loadStudentPackages(isLoadMore = false) {
    const listContainer = document.getElementById('studentPackagesList');
    if (!listContainer) return;

    if (!isLoadMore) {
        currentStudentPackagePage = 1;
        allStudentPackages = [];
        listContainer.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:40px; color:#64748b;"><i class="fas fa-spinner fa-spin fa-2x"></i><p style="margin-top:10px;">جاري تحميل الباقات التعليمية...</p></div>';
    }

    try {
        const token = localStorage.getItem('token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

        // جلب الباقات العامة بتواتر
        const resPackages = await fetch(`/api/packages/public?page=${currentStudentPackagePage}&limit=20`);
        const dataPackages = await resPackages.json();
        const newPkgs = dataPackages.packages || [];

        if (isLoadMore) {
            allStudentPackages = [...allStudentPackages, ...newPkgs];
        } else {
            allStudentPackages = newPkgs;
        }

        hasMoreStudentPackages = !!dataPackages.has_more;

        // جلب اشتراكات الطالب إن كان مسجلاً
        if (token && (!studentMySubscriptions || studentMySubscriptions.length === 0)) {
            try {
                const resSubs = await fetch('/api/packages/student/my-subscriptions', { headers });
                const dataSubs = await resSubs.json();
                studentMySubscriptions = dataSubs.subscriptions || [];
            } catch (subErr) {
                console.warn('Could not fetch student subscriptions:', subErr);
                studentMySubscriptions = studentMySubscriptions || [];
            }
        }

        renderStudentPackages();
    } catch (err) {
        console.error('Error loading student packages:', err);
        if (!isLoadMore || allStudentPackages.length === 0) {
            listContainer.innerHTML = `
                <div style="grid-column: 1/-1; text-align:center; padding:30px; background:#fff1f2; border:1px solid #fecdd3; border-radius:12px; color:#be123c;">
                    <i class="fas fa-exclamation-triangle fa-2x"></i>
                    <p style="margin-top:8px; font-weight:700;">${!navigator.onLine ? 'فقد الاتصال بالإنترنت' : 'تعذر تحميل الباقات التعليمية'}</p>
                    <button onclick="loadStudentPackages()" style="margin-top:10px; background:#e11d48; color:white; border:none; padding:6px 16px; border-radius:8px; cursor:pointer;">إعادة المحاولة</button>
                </div>
            `;
        }
    }
}

async function loadNextStudentPackagePage() {
    currentStudentPackagePage++;
    await loadStudentPackages(true);
}

// ============================================================
// 2. تصفية وعرض بطاقات الباقات
// ============================================================
function setStudentPackageTab(tab) {
    currentPackageTab = tab;
    document.querySelectorAll('.pkg-tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    renderStudentPackages();
}

function setStudentPackageLevelFilter(level) {
    currentPackageFilter = level;
    renderStudentPackages();
}

function renderStudentPackages() {
    const listContainer = document.getElementById('studentPackagesList');
    if (!listContainer) return;

    let filtered = [...allStudentPackages];

    // فلترة التبويب (باقاتي المشترك فيها vs الكل)
    if (currentPackageTab === 'my_subs') {
        const subscribedIds = studentMySubscriptions.filter(s => s.is_active).map(s => s.package_id);
        filtered = filtered.filter(p => subscribedIds.includes(p.id));
    }

    // فلترة المستوى
    if (currentPackageFilter !== 'all') {
        filtered = filtered.filter(p => {
            const lvl = (p.education_level || p.stage || p.level || '').toLowerCase().trim();
            const target = currentPackageFilter.toLowerCase().trim();
            return lvl.includes(target) || target.includes(lvl);
        });
    }

    if (filtered.length === 0) {
        listContainer.innerHTML = `
            <div style="grid-column: 1/-1; text-align:center; padding:50px 20px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:16px;">
                <i class="fas fa-box-open fa-3x" style="color:#94a3b8; margin-bottom:12px;"></i>
                <h3 style="font-size:1.1rem; color:#1e293b; font-weight:700; margin-bottom:6px;">
                    ${currentPackageTab === 'my_subs' ? 'لم تشترك في أي باقة تعليمية بعد' : 'لا توجد باقات متوفرة لهذا المستوى حالياً'}
                </h3>
                <p style="color:#64748b; font-size:0.88rem;">
                    ${currentPackageTab === 'my_subs' ? 'تصفح الباقات المتاحة واشترك للاستفادة من الفيديوهات والملخصات والتمارين المحلولة.' : 'اختر مستوى آخر أو تصفح جميع الباقات.'}
                </p>
                ${currentPackageTab === 'my_subs' ? `
                    <button onclick="setStudentPackageTab('all')" class="btn-primary" style="margin-top:14px; padding:8px 20px; border-radius:8px;">
                        تصفح جميع الباقات المتاحة
                    </button>
                ` : ''}
            </div>
        `;
        return;
    }

    listContainer.innerHTML = filtered.map(pkg => {
        const sub = studentMySubscriptions.find(s => s.package_id === pkg.id && s.is_active);
        const isSubscribed = !!sub;

        const thumb = pkg.thumbnail_url || 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=600&q=80';
        const subjectsCount = pkg.total_subjects || (pkg.subjects_preview ? pkg.subjects_preview.length : 0);
        const lessonsCount = pkg.total_lessons || 0;
        const salesCount = Number(pkg.sales_count) || 0;
        const avgRating = Number(pkg.average_rating) || 5.0;
        const ratingsCount = Number(pkg.ratings_count) || 0;
        const isFree = pkg.is_free || (pkg.term_price === 0 && pkg.annual_price === 0);

        return `
            <div class="package-card" style="background:#fff; border-radius:18px; border:1.5px solid ${isSubscribed ? '#10b981' : '#e2e8f0'}; overflow:hidden; box-shadow:0 6px 18px rgba(0,0,0,0.05); display:flex; flex-direction:column; transition:transform 0.2s, box-shadow 0.2s; position:relative;">
                
                ${isSubscribed ? `
                    <div style="position:absolute; top:12px; left:12px; z-index:10; background:#10b981; color:white; padding:4px 12px; border-radius:30px; font-size:0.75rem; font-weight:800; display:flex; align-items:center; gap:5px; box-shadow:0 4px 10px rgba(16,185,129,0.4);">
                        <i class="fas fa-check-circle"></i> أنت مشترك (متبقي ${sub.days_remaining} يوم)
                    </div>
                ` : isFree ? `
                    <div style="position:absolute; top:12px; left:12px; z-index:10; background:#8b5cf6; color:white; padding:4px 12px; border-radius:30px; font-size:0.75rem; font-weight:800; display:flex; align-items:center; gap:5px; box-shadow:0 4px 10px rgba(139,92,246,0.4);">
                        <i class="fas fa-gift"></i> باقة مجانية 100%
                    </div>
                ` : ''}

                <!-- الغلاف -->
                <div style="position:relative; height:180px; overflow:hidden;">
                    <img src="${thumb}" alt="${pkg.title}" style="width:100%; height:100%; object-fit:cover;" onerror="this.src='https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=600&q=80'">
                    <div style="position:absolute; top:12px; right:12px; background:rgba(15,23,42,0.85); backdrop-filter:blur(4px); color:white; padding:4px 12px; border-radius:8px; font-size:0.8rem; font-weight:800;">
                        🎓 ${pkg.education_level}
                    </div>
                </div>

                <!-- المحتوى -->
                <div style="padding:18px; flex:1; display:flex; flex-direction:column;">
                    <h3 style="font-size:1.1rem; font-weight:900; color:#0f172a; margin-bottom:8px; line-height:1.4;">${pkg.title}</h3>
                    <p style="font-size:0.84rem; color:#64748b; line-height:1.5; margin-bottom:12px; flex:1; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
                        ${pkg.description || 'باقة تعليمية متكاملة تشمل فيديوهات الشرح المشفرة وملخصات PDF وسلاسل التمارين المحلولة ودورات المراجعة المكثفة والنهائية.'}
                    </p>

                    <!-- التقييم والمبيعات -->
                    <div onclick="openPackageReviewsModal(${pkg.id}, '${escapeHtml(pkg.title).replace(/'/g, "\\'")}')" style="display:flex; justify-content:space-between; align-items:center; background:#f1f5f9; padding:8px 12px; border-radius:10px; margin-bottom:12px; font-size:0.82rem; cursor:pointer;" title="انقر لعرض جميع تقييمات ومراجعات الباقة">
                        <div style="color:#d97706; font-weight:800; display:flex; align-items:center; gap:4px;">
                            <i class="fas fa-star" style="color:#f59e0b;"></i>
                            <span>${avgRating.toFixed(1)}</span>
                            <span style="color:#64748b; font-weight:600; font-size:0.75rem;">(${ratingsCount} تقييم)</span>
                            <i class="fas fa-chevron-left" style="font-size:0.6rem; opacity:0.7;"></i>
                        </div>
                        <div style="color:#2563eb; font-weight:800; display:flex; align-items:center; gap:4px;">
                            <i class="fas fa-shopping-cart"></i>
                            <span>${salesCount} مبيعات</span>
                        </div>
                    </div>

                    <!-- مميزات الباقة -->
                    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:12px; margin-bottom:14px; font-size:0.8rem;">
                        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                            <span style="color:#475569;"><i class="fas fa-book-bookmark" style="color:#2563eb;"></i> المواد المشمولة:</span>
                            <span style="font-weight:800; color:#0f172a;">${subjectsCount} مواد أساسية</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                            <span style="color:#475569;"><i class="fas fa-video" style="color:#0284c7;"></i> شروحات فيديو وحلول:</span>
                            <span style="font-weight:800; color:#0f172a;">حتى 50 درساً لكل مادة</span>
                        </div>
                        <div style="display:flex; justify-content:space-between;">
                            <span style="color:#475569;"><i class="fas fa-file-pdf" style="color:#ef4444;"></i> ملخصات وسلاسل تمارين:</span>
                            <span style="font-weight:800; color:#16a34a;">PDF + حلول فيديو شاملة</span>
                        </div>
                    </div>

                    <!-- خيارات الأسعار -->
                    <div style="background:linear-gradient(135deg, #eff6ff, #f0fdf4); border:1px solid #bfdbfe; border-radius:10px; padding:10px 14px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center;">
                        ${isFree ? `
                            <div style="width:100%; text-align:center; color:#7c3aed; font-weight:900; font-size:1.05rem;">
                                🎁 باقة مجانية لجميع الطلاب
                            </div>
                        ` : `
                            <div>
                                <div style="font-size:0.72rem; color:#64748b; font-weight:700;">اشتراك فصلي (4 أشهر)</div>
                                <div style="font-size:1.05rem; font-weight:900; color:#1e40af;">
                                    ${pkg.has_term ? (pkg.term_price + ' <span style="font-size:0.8rem;">دج</span>') : '<span style="font-size:0.8rem; color:#94a3b8;">غير متاح</span>'}
                                </div>
                            </div>
                            <div style="height:24px; border-right:1.5px solid #cbd5e1;"></div>
                            <div style="text-align:left;">
                                <div style="font-size:0.72rem; color:#64748b; font-weight:700;">اشتراك سنوي (كامل)</div>
                                <div style="font-size:1.05rem; font-weight:900; color:#16a34a;">
                                    ${pkg.has_annual ? (pkg.annual_price + ' <span style="font-size:0.8rem;">دج</span>') : '<span style="font-size:0.8rem; color:#94a3b8;">غير متاح</span>'}
                                </div>
                            </div>
                        `}
                    </div>

                    <!-- أزرار الإجراءات -->
                    <div style="display:flex; gap:10px;">
                        <button onclick="copyPackageLink(${pkg.id})" style="background:#f0fdf4; color:#15803d; border:none; padding:10px; border-radius:10px; font-size:0.88rem; font-weight:800; cursor:pointer;" title="نسخ الرابط">
                            <i class="fas fa-link"></i>
                        </button>
                        <button onclick="openPackageDetailsModal(${pkg.id})" style="flex:1; background:#f1f5f9; color:#1e293b; border:1px solid #cbd5e1; padding:10px; border-radius:10px; font-size:0.88rem; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">
                            <i class="fas fa-list-check" style="color:#2563eb;"></i> التفاصيل
                        </button>

                        ${isSubscribed ? `
                            <button onclick="openPackageDetailsModal(${pkg.id})" style="flex:1; background:#10b981; color:white; border:none; padding:10px; border-radius:10px; font-size:0.88rem; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">
                                <i class="fas fa-play"></i> دخول الباقة
                            </button>
                            <button onclick="openRatePackageModal(${pkg.id})" style="background:#fef3c7; color:#d97706; border:none; padding:10px; border-radius:10px; font-size:0.88rem; font-weight:800; cursor:pointer;" title="تقييم الباقة">
                                <i class="fas fa-star"></i>
                            </button>
                        ` : `
                            <button onclick="openSubscribePackageModal(${pkg.id})" style="flex:1; background:${isFree ? 'linear-gradient(135deg, #7c3aed, #9333ea)' : 'linear-gradient(135deg, #1e40af, #2563eb)'}; color:white; border:none; padding:10px; border-radius:10px; font-size:0.88rem; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px; box-shadow:0 4px 12px rgba(37,99,235,0.3);">
                                <i class="fas ${isFree ? 'fa-gift' : 'fa-wallet'}"></i> ${isFree ? 'تفعيل مجاني' : 'اشتراك بالرصيد'}
                            </button>
                        `}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    if (hasMoreStudentPackages && currentPackageTab === 'all') {
        listContainer.innerHTML += `
            <div style="grid-column: 1/-1; text-align:center; padding:20px 0;">
                <button onclick="loadNextStudentPackagePage()" style="background:linear-gradient(135deg, #1e40af, #2563eb); color:white; border:none; padding:10px 24px; border-radius:30px; font-weight:800; font-size:0.92rem; cursor:pointer; box-shadow:0 4px 12px rgba(37,99,235,0.3);">
                    <i class="fas fa-layer-group"></i> عرض المزيد من الباقات 📦
                </button>
            </div>
        `;
    }
}

// ============================================================
// 3. عرض نافذة تفاصيل الباقة والمحتوى المحمي
// ============================================================
async function openPackageDetailsModal(packageId) {
    try {
        const token = localStorage.getItem('token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

        const res = await fetch(`/api/packages/${packageId}`, { headers });
        const data = await res.json();

        if (!data.success || !data.package) {
            throw new Error(data.error || 'فشل جلب تفاصيل الباقة');
        }

        const pkg = data.package;
        const isSubscribed = pkg.is_subscribed;
        const subjects = pkg.subjects || [];

        const modalHtml = `
            <div id="packageDetailsModal" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(15,23,42,0.75); backdrop-filter:blur(6px); z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px;">
                <div style="background:white; width:100%; max-width:920px; max-height:92vh; border-radius:20px; overflow:hidden; display:flex; flex-direction:column; font-family:'Cairo', sans-serif; direction:rtl; text-align:right; box-shadow:0 25px 50px -12px rgba(0,0,0,0.35);">
                    
                    <!-- الرأس -->
                    <div style="padding:18px 24px; background:linear-gradient(135deg, #1e3a8a, #2563eb); color:white; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <span style="background:rgba(255,255,255,0.2); padding:3px 10px; border-radius:20px; font-size:0.75rem; font-weight:800;">
                                🎓 ${pkg.education_level}
                            </span>
                            <h3 style="font-size:1.2rem; font-weight:900; margin:6px 0 0 0;">${pkg.title}</h3>
                        </div>
                        <button onclick="document.getElementById('packageDetailsModal').remove()" style="background:rgba(255,255,255,0.2); border:none; color:white; width:34px; height:34px; border-radius:50%; cursor:pointer; font-size:16px; display:flex; align-items:center; justify-content:center;">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>

                    <!-- تنبيه الاشتراك -->
                    ${!isSubscribed ? `
                        <div style="background:#fef3c7; border-bottom:1px solid #fde68a; padding:12px 24px; display:flex; justify-content:space-between; align-items:center; font-size:0.85rem;">
                            <div style="color:#92400e; font-weight:700;">
                                <i class="fas fa-lock"></i> أنت تستعرض الفهرس العام. اشترك لفتح روابط فيديوهات الشروع المشفرة والملخصات وسلاسل التمارين.
                            </div>
                            <button onclick="document.getElementById('packageDetailsModal').remove(); openSubscribePackageModal(${pkg.id});" style="background:#d97706; color:white; border:none; padding:6px 14px; border-radius:8px; font-weight:800; cursor:pointer;">
                                اشترك الآن
                            </button>
                        </div>
                    ` : `
                        <div style="background:#dcfce7; border-bottom:1px solid #bbf7d0; padding:10px 24px; color:#166534; font-size:0.85rem; font-weight:800; display:flex; align-items:center; gap:8px;">
                            <i class="fas fa-unlock-keyhole"></i> اشتراكك مفعل! جميع الفيديوهات وملخصات PDF وسلاسل التمارين متاحة لك بالكامل.
                        </div>
                    `}

                    <!-- محتوى المواد والمحاور والدروس -->
                    <div style="padding:22px 26px; overflow-y:auto; flex:1; background:#f8fafc;">
                        <h4 style="font-size:1rem; font-weight:900; color:#1e293b; margin-bottom:16px;">
                            📚 المواد والوحدات والدروس المدرجة في الباقة (${subjects.length} مواد):
                        </h4>

                        ${subjects.map((subj, sIdx) => {
                            const modules = subj.modules || [];
                            const intensive = subj.intensive_courses || {};

                            return `
                                <div style="background:white; border:1.5px solid #e2e8f0; border-radius:14px; padding:18px; margin-bottom:18px; box-shadow:0 2px 6px rgba(0,0,0,0.02);">
                                    
                                    <!-- رأس المادة -->
                                    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1.5px solid #f1f5f9; padding-bottom:12px; margin-bottom:14px;">
                                        <div style="display:flex; align-items:center; gap:10px;">
                                            <div style="width:36px; height:36px; border-radius:10px; background:#eff6ff; color:#2563eb; display:flex; align-items:center; justify-content:center; font-size:16px;">
                                                <i class="fas fa-graduation-cap"></i>
                                            </div>
                                            <div>
                                                <h5 style="font-size:1rem; font-weight:900; color:#0f172a; margin:0;">${subj.subject_name || 'مادة تعليمية'}</h5>
                                                <p style="font-size:0.78rem; color:#64748b; margin:2px 0 0 0;">الأستاذ المحاضر: ${subj.teacher_name || pkg.teacher_name || 'أستاذ معتمد'}</p>
                                            </div>
                                        </div>
                                        <span style="background:#f1f5f9; color:#475569; padding:4px 10px; border-radius:6px; font-size:0.75rem; font-weight:700;">
                                            ${modules.length} محاور
                                        </span>
                                    </div>

                                    <!-- المحاور -->
                                    <div style="padding-right:12px; border-right:3px solid #3b82f6;">
                                        ${modules.map((mod, mIdx) => {
                                            const lessons = mod.lessons || [];

                                            return `
                                                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:14px; margin-bottom:12px;">
                                                    <div style="font-size:0.9rem; font-weight:800; color:#0369a1; margin-bottom:6px;">
                                                        📂 ${mod.title || `المحور ${mIdx + 1}`}
                                                    </div>
                                                    ${mod.description ? `<p style="font-size:0.78rem; color:#64748b; margin-bottom:10px;">${mod.description}</p>` : ''}

                                                    <!-- قائمة الدروس -->
                                                    <div style="display:flex; flex-direction:column; gap:8px;">
                                                        ${lessons.map((lesson, lIdx) => `
                                                            <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                                                                <div style="font-size:0.85rem; font-weight:700; color:#1e293b; display:flex; align-items:center; gap:8px;">
                                                                    <span style="color:#2563eb;">${lIdx + 1}.</span>
                                                                    <span>${lesson.title}</span>
                                                                </div>

                                                                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                                                                    <!-- زر فيديو الشرح -->
                                                                    ${(isSubscribed && lesson.video_url) ? `
                                                                        <button onclick="playPackageLessonVideo('${encodeURIComponent(lesson.video_url)}', '${encodeURIComponent(lesson.title)}')" style="background:#eff6ff; color:#1e40af; border:1px solid #bfdbfe; padding:4px 10px; border-radius:6px; font-size:0.75rem; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:4px;">
                                                                            <i class="fas fa-play-circle"></i> فيديو الشرح
                                                                        </button>
                                                                    ` : (lesson.has_video || lesson.video_url ? `
                                                                        <span style="background:#f1f5f9; color:#94a3b8; padding:4px 8px; border-radius:6px; font-size:0.72rem; display:flex; align-items:center; gap:4px;">
                                                                            <i class="fas fa-lock"></i> فيديو الشرح
                                                                        </span>
                                                                    ` : '')}

                                                                    <!-- ملخص الدرس PDF -->
                                                                    ${(isSubscribed && lesson.summary_pdf_url) ? `
                                                                        <a href="${lesson.summary_pdf_url}" target="_blank" rel="noopener" style="background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; padding:4px 10px; border-radius:6px; font-size:0.75rem; font-weight:700; text-decoration:none; display:flex; align-items:center; gap:4px;">
                                                                            <i class="fas fa-file-pdf"></i> ملخص PDF
                                                                        </a>
                                                                    ` : (lesson.has_summary || lesson.summary_pdf_url ? `
                                                                        <span style="background:#f1f5f9; color:#94a3b8; padding:4px 8px; border-radius:6px; font-size:0.72rem; display:flex; align-items:center; gap:4px;">
                                                                            <i class="fas fa-lock"></i> ملخص PDF
                                                                        </span>
                                                                    ` : '')}

                                                                    <!-- السلسلة التطبيقية PDF -->
                                                                    ${(isSubscribed && lesson.exercise_pdf_url) ? `
                                                                        <a href="${lesson.exercise_pdf_url}" target="_blank" rel="noopener" style="background:#f0fdf4; color:#15803d; border:1px solid #bbf7d0; padding:4px 10px; border-radius:6px; font-size:0.75rem; font-weight:700; text-decoration:none; display:flex; align-items:center; gap:4px;">
                                                                            <i class="fas fa-file-lines"></i> تمارين PDF
                                                                        </a>
                                                                    ` : (lesson.has_exercise || lesson.exercise_pdf_url ? `
                                                                        <span style="background:#f1f5f9; color:#94a3b8; padding:4px 8px; border-radius:6px; font-size:0.72rem; display:flex; align-items:center; gap:4px;">
                                                                            <i class="fas fa-lock"></i> تمارين PDF
                                                                        </span>
                                                                    ` : '')}

                                                                    <!-- فيديو حل التمرين -->
                                                                    ${(isSubscribed && lesson.solution_video_url) ? `
                                                                        <button onclick="playPackageLessonVideo('${encodeURIComponent(lesson.solution_video_url)}', '${encodeURIComponent('حل تمرين: ' + lesson.title)}')" style="background:#fdf4ff; color:#86198f; border:1px solid #f5d0fe; padding:4px 10px; border-radius:6px; font-size:0.75rem; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:4px;">
                                                                            <i class="fas fa-circle-check"></i> حل التمرين
                                                                        </button>
                                                                    ` : (lesson.has_solution || lesson.solution_video_url ? `
                                                                        <span style="background:#f1f5f9; color:#94a3b8; padding:4px 8px; border-radius:6px; font-size:0.72rem; display:flex; align-items:center; gap:4px;">
                                                                            <i class="fas fa-lock"></i> حل التمرين
                                                                        </span>
                                                                    ` : '')}
                                                                </div>
                                                            </div>
                                                        `).join('')}
                                                    </div>
                                                </div>
                                            `;
                                        }).join('')}
                                    </div>

                                    <!-- قسم الدورات المكثفة -->
                                    ${(intensive.term_review || intensive.final_review) ? `
                                        <div style="background:#fefce8; border:1px solid #fef08a; border-radius:10px; padding:12px; margin-top:12px;">
                                            <div style="font-size:0.85rem; font-weight:800; color:#854d0e; margin-bottom:8px;">
                                                🎯 الدورات والمراجعات المكثفة للمادة:
                                            </div>
                                            
                                            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:10px;">
                                                ${intensive.term_review ? `
                                                    <div style="background:white; padding:10px; border-radius:8px; border:1px solid #fef08a;">
                                                        <div style="font-size:0.8rem; font-weight:800; color:#a16207; margin-bottom:4px;">
                                                            🏆 ${intensive.term_review.title || 'دورة مراجعة الفصل'}
                                                        </div>
                                                        ${isSubscribed && Array.isArray(intensive.term_review.videos) ? `
                                                            <div style="display:flex; flex-direction:column; gap:4px; margin-top:6px;">
                                                                ${intensive.term_review.videos.map((v, i) => `
                                                                    <a href="${v}" target="_blank" rel="noopener" style="font-size:0.75rem; color:#2563eb; text-decoration:none; display:flex; align-items:center; gap:4px;">
                                                                        <i class="fas fa-play"></i> فيديو مراجعة (${i+1})
                                                                    </a>
                                                                `).join('')}
                                                            </div>
                                                        ` : `
                                                            <span style="font-size:0.75rem; color:#94a3b8;"><i class="fas fa-lock"></i> فيديوهات المراجعة الشاملة ومواضيع مقترحة PDF</span>
                                                        `}
                                                    </div>
                                                ` : ''}

                                                ${intensive.final_review ? `
                                                    <div style="background:white; padding:10px; border-radius:8px; border:1px solid #fef08a;">
                                                        <div style="font-size:0.8rem; font-weight:800; color:#15803d; margin-bottom:4px;">
                                                            🚀 ${intensive.final_review.title || 'دورة المراجعة النهائية'}
                                                        </div>
                                                        ${isSubscribed && Array.isArray(intensive.final_review.videos) ? `
                                                            <div style="display:flex; flex-direction:column; gap:4px; margin-top:6px;">
                                                                ${intensive.final_review.videos.map((v, i) => `
                                                                    <a href="${v}" target="_blank" rel="noopener" style="font-size:0.75rem; color:#16a34a; text-decoration:none; display:flex; align-items:center; gap:4px;">
                                                                        <i class="fas fa-play"></i> حل بكالوريا (${i+1})
                                                                    </a>
                                                                `).join('')}
                                                            </div>
                                                        ` : `
                                                            <span style="font-size:0.75rem; color:#94a3b8;"><i class="fas fa-lock"></i> حل بكالوري��ت سابقة بالفيديو + ملخص شامل</span>
                                                        `}
                                                    </div>
                                                ` : ''}
                                            </div>
                                        </div>
                                    ` : ''}

                                </div>
                            `;
                        }).join('')}
                    </div>

                    <!-- التذييل -->
                    <div style="padding:16px 24px; background:white; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center;">
                        <button onclick="document.getElementById('packageDetailsModal').remove()" style="background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; padding:8px 18px; border-radius:8px; font-weight:700; cursor:pointer;">
                            إغلاق
                        </button>
                        ${!isSubscribed ? `
                            <button onclick="document.getElementById('packageDetailsModal').remove(); openSubscribePackageModal(${pkg.id});" style="background:linear-gradient(135deg, #1e40af, #2563eb); color:white; border:none; padding:10px 24px; border-radius:10px; font-weight:800; cursor:pointer; display:flex; align-items:center; gap:6px;">
                                <i class="fas fa-wallet"></i> اشترك بالرصيد الآن
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;

        const old = document.getElementById('packageDetailsModal');
        if (old) old.remove();

        document.body.insertAdjacentHTML('beforeend', modalHtml);
    } catch (e) {
        alert('❌ ' + e.message);
    }
}

// ============================================================
// 4. نافذة الاشتراك وخصم الرصيد
// ============================================================
async function openSubscribePackageModal(packageId) {
    const pkg = allStudentPackages.find(p => p.id === packageId);
    if (!pkg) return;

    // جلب رصيد الطالب الحالي
    let studentBalance = (window.userData && window.userData.wallet_balance) || 0;

    const modalHtml = `
        <div id="packageSubscribeModal" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(15,23,42,0.7); backdrop-filter:blur(5px); z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px;">
            <div style="background:white; width:100%; max-width:520px; border-radius:20px; overflow:hidden; font-family:'Cairo', sans-serif; direction:rtl; text-align:right; box-shadow:0 20px 40px rgba(0,0,0,0.25);">
                
                <div style="padding:18px 22px; background:linear-gradient(135deg, #1e40af, #3b82f6); color:white; display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <i class="fas fa-wallet fa-lg"></i>
                        <h4 style="margin:0; font-size:1.1rem; font-weight:800;">الاشتراك في الباقة التعليمية</h4>
                    </div>
                    <button onclick="document.getElementById('packageSubscribeModal').remove()" style="background:none; border:none; color:white; font-size:18px; cursor:pointer;"><i class="fas fa-times"></i></button>
                </div>

                <div style="padding:22px;">
                    <h5 style="font-size:1.05rem; font-weight:900; color:#0f172a; margin-bottom:6px;">${pkg.title}</h5>
                    <p style="font-size:0.82rem; color:#64748b; margin-bottom:16px;">المستوى: ${pkg.education_level}</p>

                    <!-- رصيد المحفظة الحالي -->
                    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:12px 16px; margin-bottom:18px; display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-size:0.88rem; color:#475569; font-weight:700;">💳 رصيد محفظتك الحالي:</span>
                        <span style="font-size:1.1rem; font-weight:900; color:#1e40af;" id="subModalCurrentBalance">${studentBalance} دج</span>
                    </div>

                    <!-- اختيار نوع الاشتراك -->
                    <div style="margin-bottom:18px;">
                        <label style="display:block; font-size:0.88rem; font-weight:800; color:#334155; margin-bottom:10px;">اختر خطة الاشتراك:</label>
                        
                        <div style="display:flex; flex-direction:column; gap:10px;">
                            ${pkg.has_term ? `
                                <label style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border:2px solid #cbd5e1; border-radius:12px; cursor:pointer; transition:all 0.2s;" class="sub-option-label" onclick="selectSubOption('term', ${pkg.term_price})">
                                    <div style="display:flex; align-items:center; gap:10px;">
                                        <input type="radio" name="sub_plan" value="term" checked style="width:18px; height:18px;">
                                        <div>
                                            <div style="font-weight:800; color:#0f172a; font-size:0.92rem;">اشتراك فصلي (4 أشهر)</div>
                                            <div style="font-size:0.75rem; color:#64748b;">وصول كامل لجميع دروس ومواد الفصل</div>
                                        </div>
                                    </div>
                                    <div style="font-size:1.1rem; font-weight:900; color:#1e40af;">${pkg.term_price} دج</div>
                                </label>
                            ` : ''}

                            ${pkg.has_annual ? `
                                <label style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border:2px solid #cbd5e1; border-radius:12px; cursor:pointer; transition:all 0.2s;" class="sub-option-label" onclick="selectSubOption('annual', ${pkg.annual_price})">
                                    <div style="display:flex; align-items:center; gap:10px;">
                                        <input type="radio" name="sub_plan" value="annual" ${!pkg.has_term ? 'checked' : ''} style="width:18px; height:18px;">
                                        <div>
                                            <div style="font-weight:800; color:#0f172a; font-size:0.92rem;">اشتراك سنوي (سنة كاملة) 👑</div>
                                            <div style="font-size:0.75rem; color:#16a34a; font-weight:700;">أفضل قيمة + الدورات والمراجعات النهائية</div>
                                        </div>
                                    </div>
                                    <div style="font-size:1.1rem; font-weight:900; color:#16a34a;">${pkg.annual_price} دج</div>
                                </label>
                            ` : ''}
                        </div>
                    </div>

                    <!-- ملخص الخصم -->
                    <div id="subSummaryBox" style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:12px 16px; margin-bottom:20px; font-size:0.85rem;">
                        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                            <span style="color:#475569;">المبلغ المطلوب خصمه:</span>
                            <span style="font-weight:800; color:#0f172a;" id="subRequiredAmount">${pkg.has_term ? pkg.term_price : pkg.annual_price} دج</span>
                        </div>
                    </div>

                    <!-- زر التأكيد -->
                    <button onclick="confirmPackageSubscription(${pkg.id})" id="confirmSubBtn" style="width:100%; background:#16a34a; color:white; border:none; padding:12px; border-radius:12px; font-size:0.95rem; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; box-shadow:0 4px 12px rgba(22,163,74,0.3);">
                        <i class="fas fa-check-circle"></i> تأكيد الاشتراك وتفعيل الباقة فوراً
                    </button>
                </div>
            </div>
        </div>
    `;

    const old = document.getElementById('packageSubscribeModal');
    if (old) old.remove();

    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function selectSubOption(plan, price) {
    const req = document.getElementById('subRequiredAmount');
    if (req) req.innerText = price + ' دج';
}

// ============================================================
// 5. تأكيد الاشتراك وإرسال الطلب للخادم
// ============================================================
async function confirmPackageSubscription(packageId) {
    const planInput = document.querySelector('input[name="sub_plan"]:checked');
    const subscription_type = planInput ? planInput.value : 'term';

    const btn = document.getElementById('confirmSubBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري التحقق وتفعيل الاشتراك...';
    }

    try {
        const token = localStorage.getItem('token');
        if (!token) {
            alert('يرجى تسجيل الدخول كطالب أولاً للاشتراك في الباقة');
            return;
        }

        const res = await fetch('/api/packages/subscribe', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ package_id: packageId, subscription_type })
        });

        const data = await res.json();

        if (!data.success) {
            if (data.missing_amount) {
                if (confirm(`⚠️ رصيدك غير كافٍ. تحتاج إلى شحن ${data.missing_amount} دج إضافية.\nهل تود الانتقال إلى صفحة شحن المحفظة الآن؟`)) {
                    document.getElementById('packageSubscribeModal')?.remove();
                    if (window.showSection) window.showSection('transactions');
                }
                return;
            }
            throw new Error(data.error || 'فشلت عملية الاشتراك');
        }

        // تحديث الرصيد محلياً
        if (data.new_balance !== undefined && window.userData) {
            window.userData.wallet_balance = data.new_balance;
            const balEl = document.getElementById('studentWalletBalance');
            if (balEl) balEl.innerText = data.new_balance + ' دج';
        }

        if (window.showToast) {
            showToast(data.message || '🎉 تم تفعيل اشتراكك في الباقة بنجاح!', 'success');
        } else {
            alert(data.message || '🎉 تم تفعيل اشتراكك في الباقة بنجاح!');
        }

        document.getElementById('packageSubscribeModal')?.remove();
        loadStudentPackages();
    } catch (err) {
        console.error('Error subscribing to package:', err);
        alert('❌ ' + err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-check-circle"></i> تأكيد الاشتراك وتفعيل الباقة فوراً';
        }
    }
}

// ============================================================
// 6. مشغل الفيديو المدمج لباقات Bunny.net
// ============================================================
function playPackageLessonVideo(encodedUrl, encodedTitle) {
    const videoUrl = decodeURIComponent(encodedUrl);
    const title = decodeURIComponent(encodedTitle);

    let playerContent = '';

    // إذا كان الرابط iframe أو Bunny.net embed
    if (videoUrl.includes('iframe') || videoUrl.includes('mediadelivery.net') || videoUrl.includes('bunny.net') || videoUrl.includes('youtube') || videoUrl.includes('vimeo')) {
        const src = videoUrl.startsWith('http') ? videoUrl : `https://${videoUrl}`;
        playerContent = `
            <iframe src="${src}" allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;" allowfullscreen="true" style="width:100%; height:100%; border:none; border-radius:12px;"></iframe>
        `;
    } else {
        playerContent = `
            <video controls autoplay style="width:100%; height:100%; border-radius:12px; background:#000;">
                <source src="${videoUrl}" type="video/mp4">
                متصفحك لا يدعم تشغيل الفيديو المباشر.
            </video>
        `;
    }

    const modalHtml = `
        <div id="packageVideoModal" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.9); z-index:10000; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:16px;">
            <div style="width:100%; max-width:960px; display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; color:white; font-family:'Cairo', sans-serif;">
                <h4 style="margin:0; font-size:1.1rem; font-weight:800;"><i class="fas fa-play-circle" style="color:#38bdf8;"></i> ${title}</h4>
                <button onclick="document.getElementById('packageVideoModal').remove()" style="background:rgba(255,255,255,0.2); border:none; color:white; width:36px; height:36px; border-radius:50%; cursor:pointer; font-size:18px;"><i class="fas fa-times"></i></button>
            </div>
            <div style="width:100%; max-width:960px; height:65vh; max-height:540px; background:#000; border-radius:14px; overflow:hidden; box-shadow:0 20px 40px rgba(0,0,0,0.5);">
                ${playerContent}
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// ============================================================
// 7. نافذة تقييم الباقة (تقييم لمرة واحدة)
// ============================================================
let currentRatingSelected = 5;

async function openRatePackageModal(packageId, packageTitle) {
    currentRatingSelected = 5;
    
    if (!packageTitle) {
        const p = allStudentPackages.find(x => x.id === packageId);
        packageTitle = p ? p.title : 'الباقة التعليمية';
    }
    
    // فحص ما إذا كان الطالب قد قيم سابقاً
    try {
        const token = localStorage.getItem('token');
        const res = await fetch(`/api/packages/${packageId}/my-rating`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        if (data.has_rated && data.rating) {
            alert(`لقد قمت بتقييم هذه الباقة سابقاً بـ ${data.rating.rating} نجوم ⭐`);
            return;
        }
    } catch (e) {}

    const modalHtml = `
        <div id="ratePackageModal" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(15,23,42,0.75); backdrop-filter:blur(6px); z-index:10001; display:flex; align-items:center; justify-content:center; padding:16px;">
            <div style="background:white; width:100%; max-width:480px; border-radius:20px; padding:24px; font-family:'Cairo', sans-serif; direction:rtl; text-align:center; box-shadow:0 25px 50px -12px rgba(0,0,0,0.35);">
                <div style="width:60px; height:60px; border-radius:50%; background:#fef3c7; color:#d97706; display:flex; align-items:center; justify-content:center; font-size:28px; margin:0 auto 16px;">
                    <i class="fas fa-star"></i>
                </div>
                
                <h3 style="font-size:1.2rem; font-weight:900; color:#0f172a; margin-bottom:6px;">تقييم الباقة التعليمية</h3>
                <p style="font-size:0.88rem; color:#64748b; margin-bottom:20px; line-height:1.5;">${packageTitle}</p>

                <p style="font-size:0.85rem; font-weight:800; color:#334155; margin-bottom:10px;">اختر تقييمك (من 1 إلى 5 نجوم):</p>
                <div id="ratingStarsRow" style="display:flex; justify-content:center; gap:10px; margin-bottom:20px; font-size:32px; color:#f59e0b; cursor:pointer;">
                    <i class="fas fa-star" onclick="setStarRating(1)"></i>
                    <i class="fas fa-star" onclick="setStarRating(2)"></i>
                    <i class="fas fa-star" onclick="setStarRating(3)"></i>
                    <i class="fas fa-star" onclick="setStarRating(4)"></i>
                    <i class="fas fa-star" onclick="setStarRating(5)"></i>
                </div>

                <div style="margin-bottom:20px; text-align:right;">
                    <label style="font-size:0.82rem; font-weight:700; color:#475569; display:block; margin-bottom:6px;">رأيك أو ملاحظتك (اختياري):</label>
                    <textarea id="ratePackageReview" rows="3" placeholder="اكتب انطباعك عن الباقة وجودة المواد والدروس..." style="width:100%; padding:10px; border:1px solid #cbd5e1; border-radius:10px; font-family:'Cairo', sans-serif; font-size:0.88rem; outline:none; resize:none;"></textarea>
                </div>

                <div style="display:flex; gap:10px;">
                    <button onclick="document.getElementById('ratePackageModal').remove()" style="flex:1; background:#f1f5f9; color:#475569; border:none; padding:12px; border-radius:10px; font-weight:800; cursor:pointer;">إلغاء</button>
                    <button onclick="submitPackageRating(${packageId})" style="flex:1; background:linear-gradient(135deg, #d97706, #f59e0b); color:white; border:none; padding:12px; border-radius:10px; font-weight:800; cursor:pointer; box-shadow:0 4px 12px rgba(245,158,11,0.3);">إرسال التقييم</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    setStarRating(5);
}

function setStarRating(num) {
    currentRatingSelected = num;
    const container = document.getElementById('ratingStarsRow');
    if (!container) return;
    const stars = container.querySelectorAll('i');
    stars.forEach((s, idx) => {
        if (idx < num) {
            s.className = 'fas fa-star';
            s.style.color = '#f59e0b';
        } else {
            s.className = 'far fa-star';
            s.style.color = '#cbd5e1';
        }
    });
}

async function submitPackageRating(packageId) {
    const review = document.getElementById('ratePackageReview')?.value || '';
    const token = localStorage.getItem('token');

    try {
        const res = await fetch(`/api/packages/rate/${packageId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ rating: currentRatingSelected, review })
        });

        const data = await res.json();
        if (!data.success) {
            throw new Error(data.error || 'فشل إرسال التقييم');
        }

        if (window.showToast) {
            showToast('🌟 تم تسجيل تقييمك بنجاح، شكراً لمشاركتك!', 'success');
        } else {
            alert('🌟 تم تسجيل تقييمك بنجاح، شكراً لمشاركتك!');
        }

        document.getElementById('ratePackageModal')?.remove();
        loadStudentPackages();
    } catch (err) {
        alert('❌ ' + err.message);
    }
}



// تصدير للدوال العالمية
window.loadStudentPackages = loadStudentPackages;
window.setStudentPackageTab = setStudentPackageTab;
window.setStudentPackageLevelFilter = setStudentPackageLevelFilter;
window.openPackageDetailsModal = openPackageDetailsModal;
window.openSubscribePackageModal = openSubscribePackageModal;
window.selectSubOption = selectSubOption;
window.confirmPackageSubscription = confirmPackageSubscription;
window.playPackageLessonVideo = playPackageLessonVideo;

function copyPackageLink(packageId) {
    const url = window.location.origin + '/student-dashboard.html?package=' + packageId;
    navigator.clipboard.writeText(url).then(() => {
        if (typeof showToast === 'function') {
            showToast('✅ تم نسخ رابط الباقة بنجاح', 'success');
        } else {
            alert('تم نسخ الرابط: ' + url);
        }
    }).catch(err => {
        console.error('Failed to copy: ', err);
    });
}
window.copyPackageLink = copyPackageLink;

async function openPackageReviewsModal(packageId, packageTitle) {
    const modalId = 'packageReviewsModal';
    const existing = document.getElementById(modalId);
    if (existing) existing.remove();

    if (!packageTitle) {
        const p = allStudentPackages ? allStudentPackages.find(x => x.id === packageId) : null;
        packageTitle = p ? p.title : 'الباقة التعليمية';
    }

    const modalHtml = `
        <div id="${modalId}" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(15,23,42,0.75); backdrop-filter:blur(6px); z-index:10001; display:flex; align-items:center; justify-content:center; padding:16px;">
            <div style="background:white; width:100%; max-width:560px; max-height:85vh; border-radius:20px; padding:24px; font-family:'Cairo', sans-serif; direction:rtl; text-align:right; box-shadow:0 25px 50px -12px rgba(0,0,0,0.35); display:flex; flex-direction:column;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #f1f5f9; padding-bottom:12px; margin-bottom:16px;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:40px; height:40px; border-radius:50%; background:#fef3c7; color:#d97706; display:flex; align-items:center; justify-content:center; font-size:18px;">
                            <i class="fas fa-star"></i>
                        </div>
                        <div>
                            <h3 style="font-size:1.05rem; font-weight:900; color:#0f172a; margin:0;">تقييمات ومراجعات الباقة</h3>
                            <p style="font-size:0.8rem; color:#64748b; margin:0;">${escapeHtml(packageTitle)}</p>
                        </div>
                    </div>
                    <button onclick="document.getElementById('${modalId}').remove()" style="background:none; border:none; font-size:20px; color:#64748b; cursor:pointer;"><i class="fas fa-times"></i></button>
                </div>

                <div id="packageReviewsListContent" style="flex:1; overflow-y:auto; padding-right:4px;">
                    <div style="text-align:center; padding:30px; color:#6b7280;"><i class="fas fa-spinner fa-spin fa-2x"></i><p style="margin-top:10px;">جاري تحميل المراجعات...</p></div>
                </div>

                <div style="border-top:1px solid #f1f5f9; padding-top:16px; margin-top:16px; text-align:center;">
                    <button onclick="document.getElementById('${modalId}').remove()" style="background:#f1f5f9; color:#475569; border:none; padding:10px 24px; border-radius:10px; font-weight:800; cursor:pointer;">إغلاق</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    try {
        const res = await fetch(`/api/packages/${packageId}/reviews`);
        const data = await res.json();
        const listContainer = document.getElementById('packageReviewsListContent');
        if (!data.success || !data.reviews || data.reviews.length === 0) {
            listContainer.innerHTML = '<div style="text-align:center; padding:40px; color:#64748b;"><i class="fas fa-comment-slash fa-2x" style="opacity:0.5; margin-bottom:10px;"></i><p>لا توجد مراجعات أو تقييمات لهذه الباقة حتى الآن.</p></div>';
            return;
        }

        let html = '<div style="display:flex; flex-direction:column; gap:12px;">';
        for (const r of data.reviews) {
            const dateStr = new Date(r.created_at).toLocaleDateString('ar-DZ', { year: 'numeric', month: 'short', day: 'numeric' });
            let starsHtml = '';
            for (let i = 1; i <= 5; i++) {
                starsHtml += `<i class="fas fa-star" style="color:${i <= r.rating ? '#f59e0b' : '#cbd5e1'}; font-size:12px;"></i>`;
            }
            html += `
                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:14px;">
                    <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:8px;">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <img src="${escapeHtml(r.student_image)}" alt="${escapeHtml(r.student_name)}" style="width:36px; height:36px; border-radius:50%; object-fit:cover;" onerror="this.src='https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'">
                            <div>
                                <h4 style="font-size:0.9rem; font-weight:800; color:#1e293b; margin:0;">${escapeHtml(r.student_name)}</h4>
                                <span style="font-size:0.72rem; color:#64748b;">${dateStr}</span>
                            </div>
                        </div>
                        <div style="display:flex; gap:2px;">
                            ${starsHtml}
                        </div>
                    </div>
                    ${r.review ? `<p style="font-size:0.85rem; color:#334155; margin:0; line-height:1.5; background:white; padding:10px; border-radius:8px; border:1px solid #f1f5f9;">${escapeHtml(r.review)}</p>` : ''}
                </div>
            `;
        }
        html += '</div>';
        listContainer.innerHTML = html;
    } catch (e) {
        console.error('Error fetching package reviews:', e);
        document.getElementById('packageReviewsListContent').innerHTML = '<div style="text-align:center; padding:30px; color:#ef4444;">حدث خطأ في تحميل المراجعات</div>';
    }
}
window.openPackageReviewsModal = openPackageReviewsModal;
