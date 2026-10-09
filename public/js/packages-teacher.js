/**
 * نظام الباقات التعليمية - لوحة تحكم الأستاذ (ZoomDz Teacher Packages)
 */

let teacherPackages = [];
let editingPackageId = null;
let currentPackageFormSubjects = [];

// ============================================================
// 1. جلب باقات الأستاذ
// ============================================================
async function loadTeacherPackages() {
    const listContainer = document.getElementById('teacherPackagesList');
    if (!listContainer) return;

    listContainer.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:40px; color:#64748b;"><i class="fas fa-spinner fa-spin fa-2x"></i><p style="margin-top:10px;">جاري تحميل الباقات التعليمية...</p></div>';

    try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/packages/my-packages', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || 'فشل جلب الباقات');
        }

        teacherPackages = data.packages || [];
        renderTeacherPackages();
    } catch (err) {
        console.error('Error loading teacher packages:', err);
        listContainer.innerHTML = `
            <div style="grid-column: 1/-1; text-align:center; padding:30px; background:#fff1f2; border:1px solid #fecdd3; border-radius:12px; color:#be123c;">
                <i class="fas fa-exclamation-triangle fa-2x"></i>
                <p style="margin-top:8px; font-weight:700;">${!navigator.onLine ? 'فقد الاتصال بالإنترنت' : 'تعذر تحميل الباقات التعليمية'}</p>
                <button onclick="loadTeacherPackages()" style="margin-top:10px; background:#e11d48; color:white; border:none; padding:6px 16px; border-radius:8px; cursor:pointer;">إعادة المحاولة</button>
            </div>
        `;
    }
}

// ============================================================
// 2. عرض بطاقات الباقات
// ============================================================
function renderTeacherPackages() {
    const listContainer = document.getElementById('teacherPackagesList');
    if (!listContainer) return;

    if (!teacherPackages || teacherPackages.length === 0) {
        listContainer.innerHTML = `
            <div style="grid-column: 1/-1; text-align:center; padding:50px 20px; background:#f8fafc; border:2px dashed #cbd5e1; border-radius:16px;">
                <div style="width:70px; height:70px; line-height:70px; border-radius:50%; background:#e0f2fe; color:#0284c7; font-size:28px; margin:0 auto 16px;">
                    <i class="fas fa-boxes-stacked"></i>
                </div>
                <h3 style="font-size:1.15rem; color:#1e293b; margin-bottom:8px; font-weight:700;">لا توجد لديك باقات تعليمية حتى الآن</h3>
                <p style="color:#64748b; font-size:0.9rem; max-width:450px; margin:0 auto 20px;">
                    أنشئ باقتك التعليمية المتكاملة الآن، واجمع موادك ودوراتك ومحاورك وملخصاتك وفيديوهات Bunny.net لتمكين الطلاب من الاشتراك فصلياً أو سنوياً.
                </p>
                <button onclick="showCreatePackageModal()" class="btn-primary" style="padding:10px 24px; font-size:0.95rem; border-radius:10px;">
                    <i class="fas fa-plus"></i> إنشاء أول باقة تعليمية
                </button>
            </div>
        `;
        return;
    }

    listContainer.innerHTML = teacherPackages.map(pkg => {
        const thumb = pkg.thumbnail_url || 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=600&q=80';
        const subjectsCount = pkg.total_subjects || (pkg.subjects_data ? pkg.subjects_data.length : 0);
        const lessonsCount = pkg.total_lessons || 0;
        const subsCount = pkg.subscribers_count || 0;

        return `
            <div class="package-card" style="background:#fff; border-radius:16px; border:1px solid #e2e8f0; overflow:hidden; box-shadow:0 4px 12px rgba(0,0,0,0.04); display:flex; flex-direction:column; transition:transform 0.2s, box-shadow 0.2s;">
                <div style="position:relative; height:160px; overflow:hidden;">
                    <img src="${thumb}" alt="${pkg.title}" style="width:100%; height:100%; object-fit:cover;" onerror="this.src='https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=600&q=80'">
                    <div style="position:absolute; top:10px; right:10px; background:rgba(15,23,42,0.85); backdrop-filter:blur(4px); color:white; padding:4px 10px; border-radius:8px; font-size:0.78rem; font-weight:700;">
                        🎓 ${pkg.education_level || 'عام'}
                    </div>
                    <div style="position:absolute; top:10px; left:10px; background:${pkg.status === 'active' ? '#10b981' : '#f59e0b'}; color:white; padding:3px 8px; border-radius:6px; font-size:0.72rem; font-weight:700;">
                        ${pkg.status === 'active' ? 'نشطة ومتاحة' : 'مسودة'}
                    </div>
                </div>

                <div style="padding:16px; flex:1; display:flex; flex-direction:column;">
                    <h3 style="font-size:1.05rem; font-weight:800; color:#0f172a; margin-bottom:8px; line-height:1.4;">${pkg.title}</h3>
                    <p style="font-size:0.82rem; color:#64748b; line-height:1.5; margin-bottom:14px; flex:1; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
                        ${pkg.description || 'باقة تعليمية شاملة تحتوي على دروس ومحاور ومرفقات وسلاسل تمارين ودورات مكثفة.'}
                    </p>

                    <!-- إحصائيات الباقة -->
                    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; background:#f8fafc; padding:10px; border-radius:10px; margin-bottom:14px; text-align:center;">
                        <div>
                            <div style="font-size:0.72rem; color:#64748b;">المواد</div>
                            <div style="font-size:0.95rem; font-weight:800; color:#1e40af;">${subjectsCount} 📚</div>
                        </div>
                        <div>
                            <div style="font-size:0.72rem; color:#64748b;">الدروس</div>
                            <div style="font-size:0.95rem; font-weight:800; color:#0284c7;">${lessonsCount} 🎬</div>
                        </div>
                        <div>
                            <div style="font-size:0.72rem; color:#64748b;">المشتركون</div>
                            <div style="font-size:0.95rem; font-weight:800; color:#10b981;">${subsCount} 👨‍🎓</div>
                        </div>
                    </div>

                    <!-- الأسعار -->
                    <div style="display:flex; justify-content:space-between; align-items:center; background:#eff6ff; padding:8px 12px; border-radius:8px; margin-bottom:14px; font-size:0.82rem;">
                        <div>
                            <span style="color:#475569;">فصلي:</span>
                            <span style="font-weight:800; color:#1e40af;">${pkg.has_term ? (pkg.term_price + ' دج') : 'غير متاح'}</span>
                        </div>
                        <div style="border-right:1px solid #cbd5e1; height:18px;"></div>
                        <div>
                            <span style="color:#475569;">سنوي:</span>
                            <span style="font-weight:800; color:#16a34a;">${pkg.has_annual ? (pkg.annual_price + ' دج') : 'غير متاح'}</span>
                        </div>
                    </div>

                    <!-- أزرار الإجراءات -->
                    <div style="display:flex; gap:8px;">
                        <button onclick="copyPackageLink(${pkg.id})" style="background:#f0fdf4; color:#15803d; border:none; padding:8px 12px; border-radius:8px; font-size:0.82rem; font-weight:700; cursor:pointer;" title="نسخ رابط الباقة">
                            <i class="fas fa-link"></i>
                        </button>
                        <button onclick="openPackageDetailsModal(${pkg.id})" style="background:#f1f5f9; color:#1e293b; border:1px solid #cbd5e1; padding:8px 12px; border-radius:8px; font-size:0.82rem; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:4px;" title="معاينة الباقة">
                            <i class="fas fa-eye" style="color:#2563eb;"></i> معاينة
                        </button>
                        <button onclick="viewPackageSubscribers(${pkg.id})" style="flex:1; background:#f1f5f9; color:#334155; border:1px solid #cbd5e1; padding:8px; border-radius:8px; font-size:0.82rem; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:5px;">
                            <i class="fas fa-users" style="color:#0284c7;"></i> المشتركون
                        </button>
                        <button onclick="editPackage(${pkg.id})" style="background:#e0f2fe; color:#0369a1; border:none; padding:8px 12px; border-radius:8px; font-size:0.82rem; font-weight:700; cursor:pointer;" title="تعديل">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button onclick="deletePackagePrompt(${pkg.id})" style="background:#fee2e2; color:#b91c1c; border:none; padding:8px 12px; border-radius:8px; font-size:0.82rem; font-weight:700; cursor:pointer;" title="حذف">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// ============================================================
// 3. فتح نافذة إنشاء/تعديل الباقة
// ============================================================
function showCreatePackageModal(pkg = null) {
    editingPackageId = pkg ? pkg.id : null;
    currentPackageFormSubjects = pkg && pkg.subjects_data ? JSON.parse(JSON.stringify(pkg.subjects_data)) : [];

    // إذا كانت باقة جديدة نضع مادة افتراضية مع محور ودرس أول لتسهيل البدء
    if (!pkg && currentPackageFormSubjects.length === 0) {
        currentPackageFormSubjects = [{
            subject_name: 'مادة الفيزياء',
            teacher_name: (window.userData && window.userData.full_name) || '',
            modules: [{
                title: 'المحور الأول: الميكانيك وتطور جملة ميكانيكية',
                description: 'دراسة حركة الأقسام وقوانين نيوتن وحركة الكواكب والأقمار',
                lessons: [{
                    title: 'الدرس 01: مقاربة تاريخية وقوانين نيوتن في الميكانيك',
                    video_url: '',
                    summary_pdf_url: '',
                    exercise_pdf_url: '',
                    solution_video_url: ''
                }]
            }],
            intensive_courses: {
                term_review: {
                    title: 'دورة مراجعة الفصل (فيديوهات شاملة + مواضيع مقترحة PDF)',
                    videos: [],
                    pdfs: []
                },
                final_review: {
                    title: 'دورة المراجعة النهائية (حل بكالوريات سابقة بالفيديو + ملخص شامل ومصطلحات)',
                    videos: [],
                    pdfs: []
                }
            }
        }];
    }

    const modalHtml = `
        <div id="packageBuilderModal" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(15,23,42,0.7); backdrop-filter:blur(6px); z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px;">
            <div style="background:#fff; width:100%; max-width:920px; max-height:92vh; border-radius:20px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.25); display:flex; flex-direction:column; overflow:hidden; font-family:'Cairo', sans-serif; direction:rtl; text-align:right;">
                
                <!-- الرأس -->
                <div style="padding:18px 24px; background:linear-gradient(135deg, #1e40af, #3b82f6); color:white; display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:38px; height:38px; border-radius:10px; background:rgba(255,255,255,0.2); display:flex; align-items:center; justify-content:center; font-size:18px;">
                            <i class="fas fa-boxes-stacked"></i>
                        </div>
                        <div>
                            <h3 style="font-size:1.15rem; font-weight:800; margin:0;">${pkg ? 'تعديل الباقة التعليمية' : '📦 إنشاء باقة تعليمية جديدة'}</h3>
                            <p style="font-size:0.78rem; opacity:0.9; margin:0;">أضف المواد والمحاور والدروس (حتى 50 درساً للمادة) مع روابط Bunny.net والملخصات والدورات المكثفة</p>
                        </div>
                    </div>
                    <button onclick="closePackageBuilderModal()" style="background:rgba(255,255,255,0.2); border:none; color:white; width:34px; height:34px; border-radius:50%; cursor:pointer; font-size:16px; display:flex; align-items:center; justify-content:center;">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <!-- جسم النموذج (قابل للتمرير) -->
                <div style="padding:22px 26px; overflow-y:auto; flex:1; background:#f8fafc;">
                    
                    <!-- بطاقة الإعدادات العامة -->
                    <div style="background:white; border-radius:14px; padding:18px; border:1px solid #e2e8f0; margin-bottom:20px;">
                        <h4 style="font-size:0.95rem; font-weight:800; color:#1e293b; margin-bottom:14px; display:flex; align-items:center; gap:8px;">
                            <i class="fas fa-info-circle" style="color:#2563eb;"></i> المعلومات الأساسية والمستوى المستهدف
                        </h4>

                        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:16px;">
                            <div>
                                <label style="display:block; font-size:0.85rem; font-weight:700; color:#334155; margin-bottom:6px;">🎓 المستوى المستهدف: *</label>
                                <select id="pkg_level" style="width:100%; padding:10px 14px; border-radius:10px; border:1.5px solid #cbd5e1; font-size:0.9rem; font-family:inherit; background:#fff;">
                                    <option value="رابعة متوسط BEM">رابعة متوسط BEM</option>
                                    <option value="بكالوريا علوم تجريبية">بكالوريا علوم تجريبية</option>
                                    <option value="بكالوريا رياضيات">بكالوريا رياضيات</option>
                                    <option value="بكالوريا تقني رياضي">بكالوريا تقني رياضي</option>
                                    <option value="بكالوريا تسيير واقتصاد">بكالوريا تسيير واقتصاد</option>
                                    <option value="بكالوريا آداب وفلسفة">بكالوريا آداب وفلسفة</option>
                                    <option value="بكالوريا لغات أجنبية">بكالوريا لغات أجنبية</option>
                                    <option value="أولى ثانوي علمي">أولى ثانوي علمي</option>
                                    <option value="أولى ثانو�� أدبي">أولى ثانوي أدبي</option>
                                    <option value="ثانية ثانوي علوم">ثانية ثانوي علوم</option>
                                    <option value="ثانية ثانوي تقني">ثانية ثانوي تقني</option>
                                    <option value="عام - جميع المستويات">عام - جميع المستويات</option>
                                </select>
                            </div>

                            <div>
                                <label style="display:block; font-size:0.85rem; font-weight:700; color:#334155; margin-bottom:6px;">📌 عنوان الباقة: *</label>
                                <input type="text" id="pkg_title" placeholder="مثال: باقة الامتياز الشاملة لبكالوريا علوم تجريبية" value="${pkg ? (pkg.title || '') : ''}" style="width:100%; padding:10px 14px; border-radius:10px; border:1.5px solid #cbd5e1; font-size:0.9rem; font-family:inherit;">
                            </div>
                        </div>

                        <div style="margin-top:14px;">
                            <label style="display:block; font-size:0.85rem; font-weight:700; color:#334155; margin-bottom:6px;">📝 وصف ومميزات الباقة:</label>
                            <textarea id="pkg_description" rows="2" placeholder="اكتب نبذة عن الباقة وما تتضمنه من شروح وتدريبات ومتابعة..." style="width:100%; padding:10px 14px; border-radius:10px; border:1.5px solid #cbd5e1; font-size:0.9rem; font-family:inherit; resize:vertical;">${pkg ? (pkg.description || '') : ''}</textarea>
                        </div>

                        <!-- الأسعار والاشتراك -->
                        <div style="margin-top:16px; padding:14px; background:#f0f9ff; border:1px solid #bae6fd; border-radius:12px;">
                            <div style="margin-bottom:12px; background:#f3e8ff; border:1px solid #d8b4fe; border-radius:10px; padding:10px 14px;">
                                <label style="display:flex; align-items:center; gap:8px; font-weight:800; font-size:0.88rem; color:#6b21a8; cursor:pointer;">
                                    <input type="checkbox" id="pkg_is_free" ${pkg && pkg.is_free ? 'checked' : ''} style="width:18px; height:18px;">
                                    🎁 جعل هذه الباقة مجانية بالكامل لجميع الطلاب (0 دج)
                                </label>
                            </div>

                            <h5 style="font-size:0.9rem; font-weight:800; color:#0369a1; margin-bottom:12px; display:flex; align-items:center; gap:6px;">
                                <i class="fas fa-coins"></i> 💰 نوع الاشتراك والسعر (DA دج)
                            </h5>
                            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:14px;">
                                <div style="background:white; padding:12px; border-radius:10px; border:1px solid #e2e8f0;">
                                    <label style="display:flex; align-items:center; gap:8px; font-weight:700; font-size:0.88rem; color:#1e40af; margin-bottom:8px; cursor:pointer;">
                                        <input type="checkbox" id="pkg_has_term" ${(!pkg || pkg.has_term) ? 'checked' : ''} style="width:18px; height:18px;">
                                        اشتراك فصلي (4 أشهر)
                                    </label>
                                    <div style="display:flex; align-items:center; gap:6px;">
                                        <input type="number" id="pkg_term_price" placeholder="مثال: 3500" value="${pkg ? (pkg.term_price || '') : '3500'}" style="flex:1; padding:8px 10px; border-radius:8px; border:1.5px solid #cbd5e1; font-size:0.9rem; font-weight:700;">
                                        <span style="font-size:0.85rem; font-weight:700; color:#475569;">دج</span>
                                    </div>
                                </div>

                                <div style="background:white; padding:12px; border-radius:10px; border:1px solid #e2e8f0;">
                                    <label style="display:flex; align-items:center; gap:8px; font-weight:700; font-size:0.88rem; color:#16a34a; margin-bottom:8px; cursor:pointer;">
                                        <input type="checkbox" id="pkg_has_annual" ${(!pkg || pkg.has_annual) ? 'checked' : ''} style="width:18px; height:18px;">
                                        اشتراك سنوي (سنة كاملة)
                                    </label>
                                    <div style="display:flex; align-items:center; gap:6px;">
                                        <input type="number" id="pkg_annual_price" placeholder="مثال: 8500" value="${pkg ? (pkg.annual_price || '') : '8500'}" style="flex:1; padding:8px 10px; border-radius:8px; border:1.5px solid #cbd5e1; font-size:0.9rem; font-weight:700;">
                                        <span style="font-size:0.85rem; font-weight:700; color:#475569;">دج</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- صورة الغلاف -->
                        <div style="margin-top:14px;">
                            <label style="display:block; font-size:0.85rem; font-weight:700; color:#334155; margin-bottom:6px;">🖼️ صورة غلاف الباقة (رابط أو رفع ملف):</label>
                            <div style="display:flex; gap:10px; align-items:center;">
                                <input type="text" id="pkg_thumbnail_url" placeholder="https://..." value="${pkg ? (pkg.thumbnail_url || '') : ''}" style="flex:1; padding:8px 12px; border-radius:8px; border:1.5px solid #cbd5e1; font-size:0.85rem;">
                                <label style="background:#e2e8f0; color:#334155; padding:8px 14px; border-radius:8px; font-size:0.82rem; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:6px;">
                                    <i class="fas fa-upload"></i> رفع صورة
                                    <input type="file" accept="image/*" style="display:none;" onchange="handlePackageImageUpload(this, 'pkg_thumbnail_url')">
                                </label>
                            </div>
                        </div>
                    </div>

                    <!-- قسم المواد والدورات المدرجة (الشجرة التعليمية المتكاملة) -->
                    <div style="margin-bottom:16px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
                            <div>
                                <h4 style="font-size:1.05rem; font-weight:900; color:#0f172a; margin:0; display:flex; align-items:center; gap:8px;">
                                    <i class="fas fa-book-open" style="color:#2563eb;"></i> 📚 المواد والدورات المدرجة في الباقة
                                </h4>
                                <p style="font-size:0.8rem; color:#64748b; margin:2px 0 0 0;">(تسمح بـ 50 فيديو + مرفقاتها وسلاسل التمارين لكل مادة)</p>
                            </div>
                            <button type="button" onclick="addNewSubjectToForm()" style="background:#2563eb; color:white; border:none; padding:8px 16px; border-radius:10px; font-size:0.85rem; font-weight:800; cursor:pointer; display:flex; align-items:center; gap:6px; box-shadow:0 2px 6px rgba(37,99,235,0.3);">
                                <i class="fas fa-plus"></i> إضافة مادة جديدة للباقة
                            </button>
                        </div>

                        <!-- حاوية المواد -->
                        <div id="packageSubjectsContainer"></div>
                    </div>

                </div>

                <!-- التذييل والأزرار -->
                <div style="padding:16px 24px; background:white; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center;">
                    <button type="button" onclick="closePackageBuilderModal()" style="background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; padding:10px 20px; border-radius:10px; font-size:0.9rem; font-weight:700; cursor:pointer;">
                        إلغاء
                    </button>
                    <button type="button" onclick="submitPackageForm()" id="savePackageSubmitBtn" style="background:#16a34a; color:white; border:none; padding:10px 26px; border-radius:10px; font-size:0.95rem; font-weight:800; cursor:pointer; display:flex; align-items:center; gap:8px; box-shadow:0 4px 12px rgba(22,163,74,0.3);">
                        <i class="fas fa-check"></i> ${pkg ? 'حفظ التعديلات' : 'نشر وتفعيل الباقة'}
                    </button>
                </div>
            </div>
        </div>
    `;

    // إزالة النافذة السابقة إن وجدت
    const old = document.getElementById('packageBuilderModal');
    if (old) old.remove();

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    if (pkg && pkg.education_level) {
        const select = document.getElementById('pkg_level');
        if (select) select.value = pkg.education_level;
    }

    renderSubjectsFormList();
}

function closePackageBuilderModal() {
    const modal = document.getElementById('packageBuilderModal');
    if (modal) modal.remove();
}

// ============================================================
// 4. بناء وعرض واجهة المواد والمحاور والدروس داخل النموذج
// ============================================================
function renderSubjectsFormList() {
    const container = document.getElementById('packageSubjectsContainer');
    if (!container) return;

    if (!currentPackageFormSubjects || currentPackageFormSubjects.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:30px; background:white; border:1px dashed #cbd5e1; border-radius:12px; color:#64748b;">
                <p style="margin-bottom:10px; font-weight:700;">لا توجد أي مواد مضافة في هذه الباقة بعد</p>
                <button type="button" onclick="addNewSubjectToForm()" style="background:#2563eb; color:white; border:none; padding:8px 18px; border-radius:8px; font-size:0.85rem; font-weight:700; cursor:pointer;">
                    + إضافة المادة الأولى
                </button>
            </div>
        `;
        return;
    }

    container.innerHTML = currentPackageFormSubjects.map((subject, sIdx) => {
        const modules = subject.modules || [];
        const intensive = subject.intensive_courses || {};

        return `
            <div style="background:white; border:1.5px solid #cbd5e1; border-radius:14px; padding:18px; margin-bottom:16px; box-shadow:0 2px 8px rgba(0,0,0,0.03);">
                
                <!-- رأس المادة -->
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1.5px solid #f1f5f9; padding-bottom:12px; margin-bottom:14px;">
                    <div style="display:flex; align-items:center; gap:8px; flex:1;">
                        <span style="background:#dbeafe; color:#1e40af; font-size:0.82rem; font-weight:800; padding:3px 10px; border-radius:6px;">
                            🎬 المادة (${sIdx + 1})
                        </span>
                        <input type="text" placeholder="اسم المادة (مثال: مادة الفيزياء)" value="${subject.subject_name || ''}" onchange="updateSubjectField(${sIdx}, 'subject_name', this.value)" style="font-weight:800; font-size:0.95rem; color:#0f172a; padding:6px 10px; border:1px solid #cbd5e1; border-radius:8px; width:220px;">
                        
                        <div style="display:flex; align-items:center; gap:6px; margin-right:12px;">
                            <span style="font-size:0.8rem; color:#475569;">👨‍🏫 الأستاذ المحاضر:</span>
                            <input type="text" placeholder="اسم الأستاذ" value="${subject.teacher_name || ''}" onchange="updateSubjectField(${sIdx}, 'teacher_name', this.value)" style="padding:5px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.85rem; width:160px;">
                        </div>
                    </div>

                    <button type="button" onclick="removeSubjectFromForm(${sIdx})" style="background:#fee2e2; color:#dc2626; border:none; padding:6px 12px; border-radius:8px; font-size:0.78rem; font-weight:700; cursor:pointer;" title="حذف المادة">
                        <i class="fas fa-trash"></i> حذف المادة
                    </button>
                </div>

                <!-- قائمة المحاور داخل المادة -->
                <div style="padding-right:10px; border-right:3px solid #3b82f6; margin-bottom:16px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                        <span style="font-size:0.88rem; font-weight:800; color:#1e293b;"><i class="fas fa-folder-open" style="color:#f59e0b;"></i> محاور ودروس المادة:</span>
                        <button type="button" onclick="addNewModuleToSubject(${sIdx})" style="background:#f1f5f9; color:#0284c7; border:1px solid #bae6fd; padding:4px 10px; border-radius:6px; font-size:0.78rem; font-weight:700; cursor:pointer;">
                            + إضافة محور جديد
                        </button>
                    </div>

                    ${modules.map((module, mIdx) => {
                        const lessons = module.lessons || [];

                        return `
                            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-bottom:12px;">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                                    <div style="display:flex; align-items:center; gap:8px; flex:1;">
                                        <span style="font-size:0.8rem; font-weight:700; color:#d97706;">📂 المحور (${mIdx + 1}):</span>
                                        <input type="text" placeholder="عنوان المحور (مثال: المحور الأول: الميكانيك)" value="${module.title || ''}" onchange="updateModuleField(${sIdx}, ${mIdx}, 'title', this.value)" style="flex:1; padding:5px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.85rem; font-weight:700;">
                                    </div>
                                    <button type="button" onclick="removeModuleFromSubject(${sIdx}, ${mIdx})" style="color:#ef4444; background:none; border:none; cursor:pointer; font-size:0.8rem; margin-right:8px;" title="حذف المحور">
                                        <i class="fas fa-times"></i>
                                    </button>
                                </div>

                                <!-- الدروس داخل المحور -->
                                <div style="margin-top:10px; padding-right:12px; border-right:2px dashed #cbd5e1;">
                                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                                        <span style="font-size:0.8rem; font-weight:700; color:#475569;">📄 الدروس والمرفقات (${lessons.length}/50):</span>
                                        <button type="button" onclick="addNewLessonToModule(${sIdx}, ${mIdx})" style="background:#e0f2fe; color:#0369a1; border:none; padding:3px 8px; border-radius:5px; font-size:0.75rem; font-weight:700; cursor:pointer;">
                                            + إضافة درس ومرفقاته
                                        </button>
                                    </div>

                                    ${lessons.map((lesson, lIdx) => `
                                        <div style="background:white; border:1px solid #e2e8f0; border-radius:8px; padding:10px; margin-bottom:8px; font-size:0.82rem;">
                                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                                                <div style="display:flex; align-items:center; gap:6px; flex:1;">
                                                    <span style="font-weight:700; color:#2563eb;">📄 الدرس (${lIdx + 1}):</span>
                                                    <input type="text" placeholder="اسم الدرس (مثال: قوانين نيوتن وتطبيقاتها)" value="${lesson.title || ''}" onchange="updateLessonField(${sIdx}, ${mIdx}, ${lIdx}, 'title', this.value)" style="flex:1; padding:4px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.82rem;">
                                                </div>
                                                <button type="button" onclick="removeLessonFromModule(${sIdx}, ${mIdx}, ${lIdx})" style="color:#ef4444; background:none; border:none; cursor:pointer; font-size:0.8rem; margin-right:6px;" title="حذف الدرس">
                                                    <i class="fas fa-trash-alt"></i>
                                                </button>
                                            </div>

                                            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:8px; margin-top:8px;">
                                                <!-- فيديو الشرح (Bunny.net) -->
                                                <div>
                                                    <label style="display:block; font-size:0.72rem; color:#475569; margin-bottom:2px;">🔗 فيديو الشرح (رابط Bunny.net المشفر / مباشر):</label>
                                                    <input type="text" placeholder="https://iframe.mediadelivery.net/... أو رابط الفيديو" value="${lesson.video_url || ''}" onchange="updateLessonField(${sIdx}, ${mIdx}, ${lIdx}, 'video_url', this.value)" style="width:100%; padding:4px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.78rem;">
                                                </div>

                                                <!-- ملخص الدرس PDF -->
                                                <div>
                                                    <label style="display:block; font-size:0.72rem; color:#475569; margin-bottom:2px;">📥 ملخص الدرس (PDF ومصطلحات):</label>
                                                    <div style="display:flex; gap:4px;">
                                                        <input type="text" id="sum_pdf_${sIdx}_${mIdx}_${lIdx}" placeholder="رابط PDF أو ارفع ملفاً" value="${lesson.summary_pdf_url || ''}" onchange="updateLessonField(${sIdx}, ${mIdx}, ${lIdx}, 'summary_pdf_url', this.value)" style="flex:1; padding:4px 6px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.75rem;">
                                                        <label style="background:#f1f5f9; color:#334155; padding:4px 8px; border-radius:6px; font-size:0.72rem; cursor:pointer; border:1px solid #cbd5e1; white-space:nowrap;">
                                                            رفع PDF
                                                            <input type="file" accept=".pdf" style="display:none;" onchange="handlePackageAttachmentUpload(this, ${sIdx}, ${mIdx}, ${lIdx}, 'summary_pdf_url', 'sum_pdf_${sIdx}_${mIdx}_${lIdx}')">
                                                        </label>
                                                    </div>
                                                </div>

                                                <!-- السلسلة التطبيقية PDF -->
                                                <div>
                                                    <label style="display:block; font-size:0.72rem; color:#475569; margin-bottom:2px;">📝 السلسلة التطبيقية (ملف تمارين PDF):</label>
                                                    <div style="display:flex; gap:4px;">
                                                        <input type="text" id="ex_pdf_${sIdx}_${mIdx}_${lIdx}" placeholder="رابط PDF السلسلة" value="${lesson.exercise_pdf_url || ''}" onchange="updateLessonField(${sIdx}, ${mIdx}, ${lIdx}, 'exercise_pdf_url', this.value)" style="flex:1; padding:4px 6px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.75rem;">
                                                        <label style="background:#f1f5f9; color:#334155; padding:4px 8px; border-radius:6px; font-size:0.72rem; cursor:pointer; border:1px solid #cbd5e1; white-space:nowrap;">
                                                            رفع PDF
                                                            <input type="file" accept=".pdf" style="display:none;" onchange="handlePackageAttachmentUpload(this, ${sIdx}, ${mIdx}, ${lIdx}, 'exercise_pdf_url', 'ex_pdf_${sIdx}_${mIdx}_${lIdx}')">
                                                        </label>
                                                    </div>
                                                </div>

                                                <!-- فيديو حل التمرين -->
                                                <div>
                                                    <label style="display:block; font-size:0.72rem; color:#475569; margin-bottom:2px;">🎥 فيديو حل التمرين:</label>
                                                    <input type="text" placeholder="رابط فيديو الحل" value="${lesson.solution_video_url || ''}" onchange="updateLessonField(${sIdx}, ${mIdx}, ${lIdx}, 'solution_video_url', this.value)" style="width:100%; padding:4px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.78rem;">
                                                </div>
                                            </div>
                                        </div>
                                    `).join('')}
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>

                <!-- قسم الدورات المكثفة للمادة -->
                <div style="background:#fefce8; border:1px solid #fef08a; border-radius:10px; padding:14px;">
                    <h5 style="font-size:0.88rem; font-weight:800; color:#854d0e; margin-bottom:10px; display:flex; align-items:center; gap:6px;">
                        <i class="fas fa-bullseye" style="color:#eab308;"></i> 🎯 قسم الدورات المكثفة للمادة:
                    </h5>

                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">
                        <!-- دورة مراجعة الفصل -->
                        <div style="background:white; padding:10px; border-radius:8px; border:1px solid #fef08a;">
                            <div style="font-size:0.8rem; font-weight:800; color:#a16207; margin-bottom:6px;">
                                🏆 دورة مراجعة الفصل (أول/ثاني):
                            </div>
                            <input type="text" placeholder="عنوان الدورة (مثال: المراجعة الشاملة للفصل الأول)" value="${intensive.term_review?.title || 'دورة مراجعة الفصل'}" onchange="updateIntensiveField(${sIdx}, 'term_review', 'title', this.value)" style="width:100%; padding:4px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.78rem; margin-bottom:6px;">
                            <textarea placeholder="روابط فيديوهات المراجعة الشاملة ومواضيع PDF المقترحة (رابط بكل سطر)" rows="2" onchange="updateIntensiveLinks(${sIdx}, 'term_review', this.value)" style="width:100%; padding:4px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.75rem;">${(intensive.term_review?.videos || []).join('\n')}</textarea>
                        </div>

                        <!-- دورة المراجعة النهائية -->
                        <div style="background:white; padding:10px; border-radius:8px; border:1px solid #fef08a;">
                            <div style="font-size:0.8rem; font-weight:800; color:#15803d; margin-bottom:6px;">
                                🚀 دورة المراجعة النهائية والبكالوريا:
                            </div>
                            <input type="text" placeholder="عنوان الدورة (مثال: حل بكالوريات سابقة وملخص شامل)" value="${intensive.final_review?.title || 'دورة المراجعة النهائية'}" onchange="updateIntensiveField(${sIdx}, 'final_review', 'title', this.value)" style="width:100%; padding:4px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.78rem; margin-bottom:6px;">
                            <textarea placeholder="روابط حل البكالوريات السابقة وملخص المصطلحات (رابط بكل سطر)" rows="2" onchange="updateIntensiveLinks(${sIdx}, 'final_review', this.value)" style="width:100%; padding:4px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.75rem;">${(intensive.final_review?.videos || []).join('\n')}</textarea>
                        </div>
                    </div>
                </div>

            </div>
        `;
    }).join('');
}

// ============================================================
// 5. دوال التعديل والتحديث للشجرة
// ============================================================
function addNewSubjectToForm() {
    currentPackageFormSubjects.push({
        subject_name: 'مادة جديدة',
        teacher_name: (window.userData && window.userData.full_name) || '',
        modules: [{
            title: 'المحور الأول',
            description: '',
            lessons: [{
                title: 'الدرس 01',
                video_url: '',
                summary_pdf_url: '',
                exercise_pdf_url: '',
                solution_video_url: ''
            }]
        }],
        intensive_courses: {
            term_review: { title: 'دورة مراجعة الفصل', videos: [], pdfs: [] },
            final_review: { title: 'دورة المراجعة النهائية', videos: [], pdfs: [] }
        }
    });
    renderSubjectsFormList();
}

function removeSubjectFromForm(sIdx) {
    if (confirm('هل أنت متأكد من حذف هذه المادة وجميع محاورها ودروسها من الباقة؟')) {
        currentPackageFormSubjects.splice(sIdx, 1);
        renderSubjectsFormList();
    }
}

function updateSubjectField(sIdx, field, val) {
    if (currentPackageFormSubjects[sIdx]) {
        currentPackageFormSubjects[sIdx][field] = val;
    }
}

function addNewModuleToSubject(sIdx) {
    if (currentPackageFormSubjects[sIdx]) {
        if (!currentPackageFormSubjects[sIdx].modules) currentPackageFormSubjects[sIdx].modules = [];
        const mCount = currentPackageFormSubjects[sIdx].modules.length + 1;
        currentPackageFormSubjects[sIdx].modules.push({
            title: `المحور (${mCount})`,
            description: '',
            lessons: [{
                title: 'الدرس 01',
                video_url: '',
                summary_pdf_url: '',
                exercise_pdf_url: '',
                solution_video_url: ''
            }]
        });
        renderSubjectsFormList();
    }
}

function removeModuleFromSubject(sIdx, mIdx) {
    if (currentPackageFormSubjects[sIdx]?.modules) {
        currentPackageFormSubjects[sIdx].modules.splice(mIdx, 1);
        renderSubjectsFormList();
    }
}

function updateModuleField(sIdx, mIdx, field, val) {
    if (currentPackageFormSubjects[sIdx]?.modules?.[mIdx]) {
        currentPackageFormSubjects[sIdx].modules[mIdx][field] = val;
    }
}

function addNewLessonToModule(sIdx, mIdx) {
    const mod = currentPackageFormSubjects[sIdx]?.modules?.[mIdx];
    if (mod) {
        if (!mod.lessons) mod.lessons = [];
        if (mod.lessons.length >= 50) {
            alert('الحد الأقصى هو 50 درساً لكل مادة');
            return;
        }
        const lCount = mod.lessons.length + 1;
        mod.lessons.push({
            title: `الدرس (${lCount})`,
            video_url: '',
            summary_pdf_url: '',
            exercise_pdf_url: '',
            solution_video_url: ''
        });
        renderSubjectsFormList();
    }
}

function removeLessonFromModule(sIdx, mIdx, lIdx) {
    if (currentPackageFormSubjects[sIdx]?.modules?.[mIdx]?.lessons) {
        currentPackageFormSubjects[sIdx].modules[mIdx].lessons.splice(lIdx, 1);
        renderSubjectsFormList();
    }
}

function updateLessonField(sIdx, mIdx, lIdx, field, val) {
    const l = currentPackageFormSubjects[sIdx]?.modules?.[mIdx]?.lessons?.[lIdx];
    if (l) {
        l[field] = val;
    }
}

function updateIntensiveField(sIdx, courseType, field, val) {
    const subj = currentPackageFormSubjects[sIdx];
    if (subj) {
        if (!subj.intensive_courses) subj.intensive_courses = {};
        if (!subj.intensive_courses[courseType]) subj.intensive_courses[courseType] = {};
        subj.intensive_courses[courseType][field] = val;
    }
}

function updateIntensiveLinks(sIdx, courseType, textVal) {
    const subj = currentPackageFormSubjects[sIdx];
    if (subj) {
        if (!subj.intensive_courses) subj.intensive_courses = {};
        if (!subj.intensive_courses[courseType]) subj.intensive_courses[courseType] = {};
        const links = textVal.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        subj.intensive_courses[courseType].videos = links;
    }
}

// ============================================================
// 6. رفع المرفقات وملفات PDF والصور
// ============================================================
async function handlePackageAttachmentUpload(fileInput, sIdx, mIdx, lIdx, field, inputId) {
    if (!fileInput.files || !fileInput.files[0]) return;
    const file = fileInput.files[0];

    const targetInput = document.getElementById(inputId);
    if (targetInput) targetInput.value = 'جاري رفع الملف...';

    const formData = new FormData();
    formData.append('file', file);
    formData.append('folder', 'package_pdfs');

    try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/packages/upload-attachment', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const data = await res.json();

        if (data.success && data.url) {
            updateLessonField(sIdx, mIdx, lIdx, field, data.url);
            if (targetInput) targetInput.value = data.url;
            if (window.showToast) showToast('✅ تم رفع ملف الـ PDF بنجاح!', 'success');
        } else {
            throw new Error(data.error || 'فشل رفع الملف');
        }
    } catch (e) {
        console.error('Error uploading PDF:', e);
        if (targetInput) targetInput.value = '';
        alert('❌ فشل رفع الملف: ' + e.message);
    }
}

async function handlePackageImageUpload(fileInput, targetInputId) {
    if (!fileInput.files || !fileInput.files[0]) return;
    const file = fileInput.files[0];

    const targetInput = document.getElementById(targetInputId);
    if (targetInput) targetInput.value = 'جاري رفع الصورة...';

    const formData = new FormData();
    formData.append('file', file);
    formData.append('folder', 'thumbnails');

    try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/packages/upload-attachment', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const data = await res.json();

        if (data.success && data.url) {
            if (targetInput) targetInput.value = data.url;
            if (window.showToast) showToast('✅ تم رفع صورة الغلاف بنجاح!', 'success');
        } else {
            throw new Error(data.error || 'فشل رفع الصورة');
        }
    } catch (e) {
        console.error('Error uploading image:', e);
        if (targetInput) targetInput.value = '';
        alert('❌ فشل رفع الصورة: ' + e.message);
    }
}

// ============================================================
// 7. حفظ وإرسال نموذج الباقة
// ============================================================
async function submitPackageForm() {
    const title = document.getElementById('pkg_title')?.value?.trim();
    const education_level = document.getElementById('pkg_level')?.value;
    const description = document.getElementById('pkg_description')?.value?.trim();
    const has_term = document.getElementById('pkg_has_term')?.checked;
    const has_annual = document.getElementById('pkg_has_annual')?.checked;
    const is_free = document.getElementById('pkg_is_free')?.checked || false;
    const term_price = parseFloat(document.getElementById('pkg_term_price')?.value || 0);
    const annual_price = parseFloat(document.getElementById('pkg_annual_price')?.value || 0);
    const thumbnail_url = document.getElementById('pkg_thumbnail_url')?.value?.trim();

    if (!title) {
        alert('يرجى إدخال عنوان الباقة التعليمية');
        return;
    }
    if (!education_level) {
        alert('يرجى اختيار المستوى المستهدف');
        return;
    }
    if (!is_free && !has_term && !has_annual) {
        alert('يرجى تفعيل اشتراك فصلي أو سنوي وتحديد سعره، أو تحديد الباقة كمجانية');
        return;
    }

    const payload = {
        title,
        education_level,
        description,
        has_term,
        has_annual,
        is_free,
        term_price: is_free ? 0 : term_price,
        annual_price: is_free ? 0 : annual_price,
        thumbnail_url,
        subjects: currentPackageFormSubjects
    };

    const submitBtn = document.getElementById('savePackageSubmitBtn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الحفظ...';
    }

    try {
        const token = localStorage.getItem('token');
        const url = editingPackageId ? `/api/packages/update/${editingPackageId}` : '/api/packages/create';
        const method = editingPackageId ? 'PUT' : 'POST';

        const res = await fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!data.success) {
            throw new Error(data.error || 'حدث خطأ أثناء حفظ الباقة');
        }

        if (window.showToast) {
            showToast(editingPackageId ? '✅ تم تحديث الباقة بنجاح!' : '🎉 تم إنشاء ونشر الباقة التعليمية بنجاح!', 'success');
        } else {
            alert('✅ تم حفظ الباقة بنجاح!');
        }

        closePackageBuilderModal();
        loadTeacherPackages();
    } catch (err) {
        console.error('Error submitting package:', err);
        alert('❌ ' + err.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fas fa-check"></i> حفظ ونشر';
        }
    }
}

// ============================================================
// 8. تعديل وحذف الباقة وعرض المشتركين
// ============================================================
function editPackage(pkgId) {
    const pkg = teacherPackages.find(p => p.id === pkgId);
    if (pkg) {
        showCreatePackageModal(pkg);
    }
}

async function deletePackagePrompt(pkgId) {
    if (!confirm('هل أنت متأكد من رغبتك في حذف هذه الباقة التعليمية نهائياً؟')) {
        return;
    }

    try {
        const token = localStorage.getItem('token');
        const res = await fetch(`/api/packages/delete/${pkgId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        if (data.success) {
            if (window.showToast) showToast('✅ تم حذف الباقة بنجاح', 'success');
            loadTeacherPackages();
        } else {
            alert('❌ ' + (data.error || 'تعذر حذف الباقة'));
        }
    } catch (e) {
        console.error('Error deleting package:', e);
        alert('❌ حدث خطأ أثناء الحذف');
    }
}

async function viewPackageSubscribers(pkgId) {
    try {
        const token = localStorage.getItem('token');
        const res = await fetch(`/api/packages/subscribers/${pkgId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || 'فشل جلب المشتركين');
        }

        const subs = data.subscribers || [];
        const modalHtml = `
            <div id="packageSubsModal" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(15,23,42,0.7); backdrop-filter:blur(4px); z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px;">
                <div style="background:white; width:100%; max-width:650px; max-height:85vh; border-radius:18px; overflow:hidden; display:flex; flex-direction:column; font-family:'Cairo', sans-serif; direction:rtl; text-align:right;">
                    <div style="padding:16px 20px; background:#1e40af; color:white; display:flex; justify-content:space-between; align-items:center;">
                        <h4 style="margin:0; font-size:1.05rem; font-weight:800;">👥 الطلاب المشتركون في "${data.package_title}" (${subs.length})</h4>
                        <button onclick="document.getElementById('packageSubsModal').remove()" style="background:none; border:none; color:white; font-size:18px; cursor:pointer;"><i class="fas fa-times"></i></button>
                    </div>
                    <div style="padding:20px; overflow-y:auto; flex:1;">
                        ${subs.length === 0 ? '<p style="text-align:center; color:#64748b; padding:30px;">لا يوجد مشتركون في هذه الباقة حتى الآن.</p>' : `
                            <table style="width:100%; border-collapse:collapse; font-size:0.85rem;">
                                <thead>
                                    <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0; color:#475569; text-align:right;">
                                        <th style="padding:10px;">الطالب</th>
                                        <th style="padding:10px;">نوع الاشتراك</th>
                                        <th style="padding:10px;">المبلغ</th>
                                        <th style="padding:10px;">تاريخ الانتهاء</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${subs.map(s => `
                                        <tr style="border-bottom:1px solid #f1f5f9;">
                                            <td style="padding:10px; font-weight:700; color:#1e293b;">${s.students?.full_name || 'طالب'}</td>
                                            <td style="padding:10px;"><span style="background:${s.subscription_type === 'annual' ? '#dcfce7' : '#dbeafe'}; color:${s.subscription_type === 'annual' ? '#166534' : '#1e40af'}; padding:3px 8px; border-radius:6px; font-size:0.75rem; font-weight:700;">${s.subscription_type === 'annual' ? 'سنوي' : 'فصلي'}</span></td>
                                            <td style="padding:10px; font-weight:700;">${s.price_paid} دج</td>
                                            <td style="padding:10px; color:#64748b;">${new Date(s.end_date).toLocaleDateString('ar-DZ')}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        `}
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
    } catch (e) {
        alert('❌ ' + e.message);
    }
}

// ============================================================
// 10. نسخ الرابط
// ============================================================
// ============================================================
// 10. نسخ الرابط وتبويب باقات الأساتذة الآخرين
// ============================================================
let currentTeacherTab = 'my';
let otherTeachersPackages = [];

async function switchTeacherPackageTab(tab) {
    currentTeacherTab = tab;
    
    const myBtn = document.getElementById('myPackagesTabBtn');
    const otherBtn = document.getElementById('allTeachersPackagesTabBtn');
    
    if (myBtn && otherBtn) {
        if (tab === 'my') {
            myBtn.style.background = '#2563eb';
            myBtn.style.color = '#ffffff';
            otherBtn.style.background = '#f1f5f9';
            otherBtn.style.color = '#475569';
        } else {
            otherBtn.style.background = '#2563eb';
            otherBtn.style.color = '#ffffff';
            myBtn.style.background = '#f1f5f9';
            myBtn.style.color = '#475569';
        }
    }

    if (tab === 'my') {
        loadTeacherPackages();
    } else {
        loadOtherTeachersPackages();
    }
}

async function loadOtherTeachersPackages() {
    const listContainer = document.getElementById('teacherPackagesList');
    if (!listContainer) return;

    listContainer.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:40px; color:#64748b;"><i class="fas fa-spinner fa-spin fa-2x"></i><p style="margin-top:10px;">جاري تحميل باقات الأساتذة الآخرين...</p></div>';

    try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/packages/teachers-packages', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || 'فشل جلب باقات الأساتذة');
        }

        otherTeachersPackages = data.packages || [];
        renderOtherTeachersPackages();
    } catch (err) {
        console.error('Error loading other teachers packages:', err);
        listContainer.innerHTML = `
            <div style="grid-column: 1/-1; text-align:center; padding:30px; background:#fff1f2; border:1px solid #fecdd3; border-radius:12px; color:#be123c;">
                <i class="fas fa-exclamation-triangle fa-2x"></i>
                <p style="margin-top:8px; font-weight:700;">تعذر تحميل باقات الأساتذة الآخرين</p>
                <button onclick="loadOtherTeachersPackages()" style="margin-top:10px; background:#e11d48; color:white; border:none; padding:6px 16px; border-radius:8px; cursor:pointer;">إعادة المحاولة</button>
            </div>
        `;
    }
}

function renderOtherTeachersPackages() {
    const listContainer = document.getElementById('teacherPackagesList');
    if (!listContainer) return;

    if (!otherTeachersPackages || otherTeachersPackages.length === 0) {
        listContainer.innerHTML = `
            <div style="grid-column: 1/-1; text-align:center; padding:50px 20px; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:16px;">
                <i class="fas fa-chalkboard-teacher fa-3x" style="color:#94a3b8; margin-bottom:12px;"></i>
                <h3 style="font-size:1.1rem; color:#1e293b; font-weight:700;">لا توجد باقات منشورة لأساتذة آخرين حالياً</h3>
            </div>
        `;
        return;
    }

    listContainer.innerHTML = otherTeachersPackages.map(pkg => {
        const thumb = pkg.thumbnail_url || 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=600&q=80';
        const subjectsCount = pkg.total_subjects || (pkg.subjects_data ? pkg.subjects_data.length : 0);
        const lessonsCount = pkg.total_lessons || 0;
        const salesCount = Number(pkg.sales_count) || 0;
        const avgRating = Number(pkg.average_rating) || 5.0;
        const ratingsCount = Number(pkg.ratings_count) || 0;
        const isFree = pkg.is_free || (pkg.term_price === 0 && pkg.annual_price === 0);

        return `
            <div class="package-card" style="background:#fff; border-radius:18px; border:1px solid #e2e8f0; overflow:hidden; box-shadow:0 6px 18px rgba(0,0,0,0.05); display:flex; flex-direction:column; transition:transform 0.2s, box-shadow 0.2s; position:relative;">
                
                ${pkg.is_own ? `
                    <div style="position:absolute; top:12px; left:12px; z-index:10; background:#2563eb; color:white; padding:4px 12px; border-radius:30px; font-size:0.75rem; font-weight:800;">
                        <i class="fas fa-user-check"></i> باقتك
                    </div>
                ` : isFree ? `
                    <div style="position:absolute; top:12px; left:12px; z-index:10; background:#8b5cf6; color:white; padding:4px 12px; border-radius:30px; font-size:0.75rem; font-weight:800;">
                        <i class="fas fa-gift"></i> مجانية
                    </div>
                ` : ''}

                <!-- الغلاف -->
                <div style="position:relative; height:160px; overflow:hidden;">
                    <img src="${thumb}" alt="${pkg.title}" style="width:100%; height:100%; object-fit:cover;" onerror="this.src='https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=600&q=80'">
                    <div style="position:absolute; top:12px; right:12px; background:rgba(15,23,42,0.85); backdrop-filter:blur(4px); color:white; padding:4px 12px; border-radius:8px; font-size:0.78rem; font-weight:800;">
                        🎓 ${pkg.education_level}
                    </div>
                </div>

                <!-- المحتوى -->
                <div style="padding:16px; flex:1; display:flex; flex-direction:column;">
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                        <img src="${pkg.teacher_profile_image}" style="width:32px; height:32px; border-radius:50%; object-fit:cover; border:1px solid #2563eb;">
                        <div>
                            <div style="font-size:0.85rem; font-weight:800; color:#0f172a;">${pkg.teacher_name}</div>
                            <div style="font-size:0.72rem; color:#64748b;">${pkg.teacher_specialization}</div>
                        </div>
                    </div>

                    <h3 style="font-size:1.05rem; font-weight:900; color:#0f172a; margin-bottom:8px; line-height:1.4;">${pkg.title}</h3>
                    <p style="font-size:0.82rem; color:#64748b; line-height:1.5; margin-bottom:12px; flex:1; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
                        ${pkg.description || 'باقة تعليمية شاملة تحتوي على دروس ومحاور ومرفقات وسلاسل تمارين ودورات مكثفة.'}
                    </p>

                    <!-- التقييم والمبيعات -->
                    <div style="display:flex; justify-content:space-between; align-items:center; background:#f1f5f9; padding:8px 12px; border-radius:10px; margin-bottom:12px; font-size:0.82rem;">
                        <div style="color:#d97706; font-weight:800; display:flex; align-items:center; gap:4px;">
                            <i class="fas fa-star" style="color:#f59e0b;"></i>
                            <span>${avgRating.toFixed(1)}</span>
                            <span style="color:#64748b; font-size:0.75rem;">(${ratingsCount})</span>
                        </div>
                        <div style="color:#2563eb; font-weight:800; display:flex; align-items:center; gap:4px;">
                            <i class="fas fa-shopping-cart"></i>
                            <span>${salesCount} مبيعات</span>
                        </div>
                    </div>

                    <!-- الأسعار -->
                    <div style="display:flex; justify-content:space-between; align-items:center; background:#eff6ff; padding:8px 12px; border-radius:8px; margin-bottom:14px; font-size:0.82rem;">
                        ${isFree ? `
                            <div style="width:100%; text-align:center; color:#7c3aed; font-weight:900;">🎁 باقة مجانية للطلاب</div>
                        ` : `
                            <div>
                                <span style="color:#475569;">فصلي:</span>
                                <span style="font-weight:800; color:#1e40af;">${pkg.has_term ? (pkg.term_price + ' دج') : 'غير متاح'}</span>
                            </div>
                            <div style="border-right:1px solid #cbd5e1; height:18px;"></div>
                            <div>
                                <span style="color:#475569;">سنوي:</span>
                                <span style="font-weight:800; color:#16a34a;">${pkg.has_annual ? (pkg.annual_price + ' دج') : 'غير متاح'}</span>
                            </div>
                        `}
                    </div>

                    <!-- الأزرار -->
                    <div style="display:flex; gap:8px;">
                        <button onclick="copyPackageLink(${pkg.id})" style="background:#f0fdf4; color:#15803d; border:none; padding:8px 12px; border-radius:8px; font-size:0.82rem; font-weight:700; cursor:pointer;" title="نسخ الرابط">
                            <i class="fas fa-link"></i>
                        </button>
                        <button onclick="openPackageDetailsModal(${pkg.id})" style="flex:1; background:#f1f5f9; color:#1e293b; border:1px solid #cbd5e1; padding:8px; border-radius:8px; font-size:0.82rem; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">
                            <i class="fas fa-eye" style="color:#2563eb;"></i> معاينة الباقة
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

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

// ============================================================
// 4. نافذة معاينة الباقة التعليمية
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
        let subjects = pkg.subjects || pkg.subjects_data || [];
        if (typeof subjects === 'string') {
            try { subjects = JSON.parse(subjects); } catch (e) { subjects = []; }
        }
        if (!Array.isArray(subjects)) subjects = [];

        const salesCount = Number(pkg.sales_count) || 0;
        const avgRating = Number(pkg.average_rating) || 5.0;

        const modalHtml = `
            <div id="packageDetailsModal" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(15,23,42,0.8); backdrop-filter:blur(6px); z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px;">
                <div style="background:white; width:100%; max-width:900px; max-height:92vh; border-radius:20px; overflow:hidden; display:flex; flex-direction:column; font-family:'Cairo', sans-serif; direction:rtl; text-align:right; box-shadow:0 25px 50px -12px rgba(0,0,0,0.35);">
                    
                    <!-- الرأس -->
                    <div style="padding:18px 24px; background:linear-gradient(135deg, #0f172a, #1e293b); color:white; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <span style="background:#2563eb; color:white; padding:3px 10px; border-radius:20px; font-size:0.75rem; font-weight:800;">
                                🎓 ${pkg.education_level || 'عام'}
                            </span>
                            <h3 style="font-size:1.2rem; font-weight:900; margin:6px 0 0 0;">${pkg.title}</h3>
                        </div>
                        <button onclick="document.getElementById('packageDetailsModal').remove()" style="background:rgba(255,255,255,0.15); border:none; color:white; width:34px; height:34px; border-radius:50%; cursor:pointer; font-size:16px; display:flex; align-items:center; justify-content:center;">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>

                    <!-- إحصائيات سريعة والمعاينة -->
                    <div style="background:#f8fafc; border-bottom:1px solid #e2e8f0; padding:12px 24px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; font-size:0.85rem;">
                        <div style="display:flex; align-items:center; gap:16px;">
                            <span style="color:#2563eb; font-weight:800;"><i class="fas fa-shopping-cart"></i> المبيعات: ${salesCount}</span>
                            <span style="color:#d97706; font-weight:800;"><i class="fas fa-star" style="color:#f59e0b;"></i> التقييم: ${avgRating.toFixed(1)}</span>
                            <span style="color:#059669; font-weight:800;"><i class="fas fa-book"></i> المواد: ${subjects.length}</span>
                        </div>
                        <div style="color:#475569; font-weight:700;">
                            الأستاذ المحاضر: <strong style="color:#0f172a;">${pkg.teacher_name || 'أستاذ معتمد'}</strong>
                        </div>
                    </div>

                    <!-- محتوى المواد والمحاور والدروس -->
                    <div style="padding:22px; overflow-y:auto; flex:1; background:#ffffff;">
                        <h4 style="font-size:1rem; font-weight:900; color:#0f172a; margin-bottom:16px;">
                            📚 المواد والوحدات والدروس المدرجة في الباقة:
                        </h4>

                        ${subjects.map((subj, sIdx) => {
                            let modules = subj.modules || [];
                            if (typeof modules === 'string') {
                                try { modules = JSON.parse(modules); } catch(e) { modules = []; }
                            }
                            if (!Array.isArray(modules)) modules = [];

                            return `
                                <div style="background:#f8fafc; border:1.5px solid #e2e8f0; border-radius:14px; padding:16px; margin-bottom:16px;">
                                    
                                    <!-- المادة -->
                                    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #cbd5e1; padding-bottom:10px; margin-bottom:12px;">
                                        <div style="display:flex; align-items:center; gap:10px;">
                                            <div style="width:34px; height:34px; border-radius:8px; background:#eff6ff; color:#2563eb; display:flex; align-items:center; justify-content:center; font-size:15px;">
                                                <i class="fas fa-graduation-cap"></i>
                                            </div>
                                            <h5 style="font-size:0.98rem; font-weight:900; color:#0f172a; margin:0;">${subj.subject_name || `المادة ${sIdx + 1}`}</h5>
                                        </div>
                                        <span style="background:#e0f2fe; color:#0369a1; padding:3px 10px; border-radius:6px; font-size:0.75rem; font-weight:700;">
                                            ${modules.length} محاور
                                        </span>
                                    </div>

                                    <!-- المحاور -->
                                    <div style="padding-right:10px; border-right:3px solid #2563eb;">
                                        ${modules.map((mod, mIdx) => {
                                            let lessons = mod.lessons || [];
                                            if (typeof lessons === 'string') {
                                                try { lessons = JSON.parse(lessons); } catch(e) { lessons = []; }
                                            }
                                            if (!Array.isArray(lessons)) lessons = [];

                                            return `
                                                <div style="background:white; border:1px solid #cbd5e1; border-radius:10px; padding:12px; margin-bottom:10px;">
                                                    <div style="font-size:0.88rem; font-weight:800; color:#0369a1; margin-bottom:6px;">
                                                        📂 ${mod.title || `المحور ${mIdx + 1}`}
                                                    </div>
                                                    ${mod.description ? `<p style="font-size:0.78rem; color:#64748b; margin-bottom:8px;">${mod.description}</p>` : ''}

                                                    <!-- قائمة الدروس -->
                                                    <div style="display:flex; flex-direction:column; gap:6px;">
                                                        ${lessons.map((lesson, lIdx) => `
                                                            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:8px 12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
                                                                <div style="font-size:0.82rem; font-weight:700; color:#1e293b;">
                                                                    <span style="color:#2563eb;">${lIdx + 1}.</span> ${lesson.title}
                                                                </div>
                                                                <div style="display:flex; align-items:center; gap:6px;">
                                                                    ${(lesson.video_url || lesson.has_video) ? `<span style="background:#eff6ff; color:#1e40af; padding:2px 8px; border-radius:4px; font-size:0.72rem; font-weight:700;"><i class="fas fa-play-circle"></i> فيديو</span>` : ''}
                                                                    ${(lesson.summary_pdf_url || lesson.has_summary) ? `<span style="background:#fef2f2; color:#991b1b; padding:2px 8px; border-radius:4px; font-size:0.72rem; font-weight:700;"><i class="fas fa-file-pdf"></i> ملخص</span>` : ''}
                                                                    ${(lesson.exercise_pdf_url || lesson.has_exercise) ? `<span style="background:#f0fdf4; color:#166534; padding:2px 8px; border-radius:4px; font-size:0.72rem; font-weight:700;"><i class="fas fa-file-lines"></i> تمارين</span>` : ''}
                                                                    ${(lesson.solution_video_url || lesson.has_solution) ? `<span style="background:#fdf4ff; color:#86198f; padding:2px 8px; border-radius:4px; font-size:0.72rem; font-weight:700;"><i class="fas fa-check-circle"></i> حل</span>` : ''}
                                                                </div>
                                                            </div>
                                                        `).join('')}
                                                    </div>
                                                </div>
                                            `;
                                        }).join('')}
                                    </div>

                                </div>
                            `;
                        }).join('')}
                    </div>

                    <!-- التذييل -->
                    <div style="padding:14px 24px; background:#f8fafc; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center;">
                        <button onclick="document.getElementById('packageDetailsModal').remove()" style="background:#0f172a; color:white; border:none; padding:8px 20px; border-radius:8px; font-weight:800; cursor:pointer;">
                            إغلاق المعاينة
                        </button>
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

// تصدير للدوال العالمية
window.loadTeacherPackages = loadTeacherPackages;
window.switchTeacherPackageTab = switchTeacherPackageTab;
window.loadOtherTeachersPackages = loadOtherTeachersPackages;
window.openPackageDetailsModal = openPackageDetailsModal;
window.showCreatePackageModal = showCreatePackageModal;
window.closePackageBuilderModal = closePackageBuilderModal;
window.renderSubjectsFormList = renderSubjectsFormList;
window.addNewSubjectToForm = addNewSubjectToForm;
window.removeSubjectFromForm = removeSubjectFromForm;
window.updateSubjectField = updateSubjectField;
window.addNewModuleToSubject = addNewModuleToSubject;
window.removeModuleFromSubject = removeModuleFromSubject;
window.updateModuleField = updateModuleField;
window.addNewLessonToModule = addNewLessonToModule;
window.removeLessonFromModule = removeLessonFromModule;
window.updateLessonField = updateLessonField;
window.updateIntensiveField = updateIntensiveField;
window.updateIntensiveLinks = updateIntensiveLinks;
window.handlePackageAttachmentUpload = handlePackageAttachmentUpload;
window.handlePackageImageUpload = handlePackageImageUpload;
window.submitPackageForm = submitPackageForm;
window.editPackage = editPackage;
window.deletePackagePrompt = deletePackagePrompt;
window.viewPackageSubscribers = viewPackageSubscribers;
window.copyPackageLink = copyPackageLink;
