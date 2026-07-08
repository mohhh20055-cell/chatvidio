// ============================================================
// مسارات البث المباشر
// ============================================================

const express = require('express');
const router = express.Router();
const { body, validationResult, param } = require('express-validator');

// استيراد الدوال المساعدة من الملف الرئيسي
const server = require('../server');

// استخراج الدوال من server
const { 
    authenticate, 
    authorize, 
    getOne, 
    insert, 
    update, 
    supabase,
    sanitizeInput,
    renderErrorPage,
    verifyToken
} = server;

// ============================================================
// مسار حفظ رابط البث من الأستاذ - ✅ معدل لإضافة الطلاب تلقائياً
// ============================================================
router.post('/stream/save-link', [
    authenticate,
    authorize(['teacher']),
    body('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('stream_url').notEmpty().withMessage('رابط البث مطلوب'),
    body('platform').isIn(['google-meet', 'microsoft-teams', 'other']).withMessage('منصة غير صالحة')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, stream_url, platform } = req.body;

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }
        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        // ✅ تحديث العرض مع رابط البث
        await supabase
            .from('offers')
            .update({
                stream_url: stream_url,
                stream_platform: platform,
                status: 'live',
                stream_started_at: new Date().toISOString()
            })
            .eq('id', offer_id);

        // ✅ جلب جميع الطلاب الذين لديهم حجز مدفوع
        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        let addedCount = 0;

        // ✅ إضافة جميع الطلاب إلى active_stream تلقائياً
        if (sessions && sessions.length > 0) {
            for (const session of sessions) {
                const { data: existing } = await supabase
                    .from('active_stream')
                    .select('*')
                    .eq('offer_id', offer_id)
                    .eq('student_id', session.student_id)
                    .maybeSingle();

                if (!existing) {
                    await insert('active_stream', {
                        offer_id: parseInt(offer_id),
                        student_id: session.student_id,
                        teacher_id: req.user.userId,
                        joined_at: new Date().toISOString(),
                        added_at: new Date().toISOString(),
                        added_by_teacher: true,
                        last_ping: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    });
                    addedCount++;
                }
            }

            // ✅ إرسال إشعارات للطلاب
            const notifications = sessions.map(s => ({
                user_id: s.student_id,
                user_type: 'student',
                title: '🔴 البث المباشر بدأ',
                message: `الحصة "${offer.subject_name}" قد بدأت الآن. اضغط على "انضم الآن" للدخول.`,
                offer_id: offer_id,
                stream_url: stream_url,
                is_read: false,
                created_at: new Date().toISOString()
            }));

            await supabase
                .from('notifications')
                .insert(notifications);
        }

        // ✅ حذف جميع الطلاب من waiting_room
        await supabase
            .from('waiting_room')
            .delete()
            .eq('offer_id', offer_id);

        res.json({
            success: true,
            message: `تم بدء البث المباشر بنجاح، وتم إضافة ${addedCount} طالب إلى البث`,
            stream_url: stream_url,
            platform: platform,
            students_count: sessions?.length || 0,
            added_count: addedCount
        });
    } catch (error) {
        console.error('❌ خطأ في حفظ رابط البث:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// صفحة بدء البث للأستاذ
// ============================================================
router.get('/teacher-start-stream/:offer_id/:teacher_id', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token) return res.redirect('/teacher-dashboard.html');
        
        const decoded = verifyToken(token);
        if (!decoded || decoded.role !== 'teacher') {
            return res.redirect('/teacher-dashboard.html');
        }

        const { offer_id, teacher_id } = req.params;
        if (decoded.userId !== parseInt(teacher_id)) {
            return res.redirect('/teacher-dashboard.html');
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer || offer.teacher_id !== parseInt(teacher_id)) {
            return res.redirect('/teacher-dashboard.html');
        }

        const { count: studentsCount } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        res.send(`
            <!DOCTYPE html>
            <html dir="rtl" lang="ar">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>بدء البث المباشر</title>
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { font-family: 'Cairo', Arial, sans-serif; background: #0a0a1a; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
                    .container { max-width: 700px; width: 90%; background: #1a1a2e; border-radius: 24px; padding: 40px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
                    h1 { color: #0f5cbf; text-align: center; margin-bottom: 10px; font-size: 2rem; }
                    .subtitle { text-align: center; color: #94a3b8; margin-bottom: 30px; }
                    .info-box { background: #0f3460; border-radius: 12px; padding: 15px 20px; margin-bottom: 25px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
                    .info-box span { color: #94a3b8; }
                    .info-box strong { color: white; }
                    .platforms { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 25px 0; }
                    .platform-card { background: #16213e; border: 2px solid transparent; border-radius: 16px; padding: 25px; text-align: center; cursor: pointer; transition: all 0.3s; }
                    .platform-card:hover { border-color: #0f5cbf; transform: translateY(-3px); }
                    .platform-card.selected { border-color: #10b981; background: #0f3460; }
                    .platform-card .icon { font-size: 3rem; display: block; margin-bottom: 10px; }
                    .platform-card .name { font-size: 1.1rem; font-weight: 700; }
                    .platform-card .desc { font-size: 0.8rem; color: #94a3b8; margin-top: 5px; }
                    .platform-card .badge-free { background: #10b981; color: white; padding: 2px 12px; border-radius: 20px; font-size: 0.7rem; display: inline-block; margin-top: 8px; }
                    .input-group { margin: 20px 0; }
                    .input-group label { display: block; margin-bottom: 8px; color: #94a3b8; font-weight: 600; }
                    .input-group input { width: 100%; padding: 14px 18px; border-radius: 12px; border: 1px solid #333; background: #0a0a1a; color: white; font-size: 1rem; transition: border 0.3s; }
                    .input-group input:focus { outline: none; border-color: #0f5cbf; }
                    .input-group .hint { font-size: 0.8rem; color: #64748b; margin-top: 5px; }
                    .btn-start { width: 100%; padding: 16px; background: linear-gradient(135deg, #0f5cbf, #0a4a9a); color: white; border: none; border-radius: 12px; font-size: 1.2rem; font-weight: 700; cursor: pointer; transition: all 0.3s; margin-top: 20px; }
                    .btn-start:hover { transform: scale(1.02); box-shadow: 0 8px 25px rgba(15, 92, 191, 0.4); }
                    .btn-start:disabled { opacity: 0.5; cursor: not-allowed; }
                    .btn-back { background: transparent; color: #94a3b8; border: 1px solid #333; padding: 12px 24px; border-radius: 12px; cursor: pointer; transition: all 0.3s; margin-top: 10px; width: 100%; }
                    .btn-back:hover { background: #1a1a2e; }
                    .tip { background: #0f3460; border-radius: 12px; padding: 15px 20px; margin: 15px 0; border-right: 4px solid #f59e0b; }
                    .tip h4 { color: #f59e0b; margin-bottom: 5px; }
                    .tip p { color: #94a3b8; font-size: 0.9rem; line-height: 1.6; }
                    .waiting-list { margin-top: 20px; border-top: 1px solid #333; padding-top: 20px; }
                    .waiting-list h3 { color: #94a3b8; margin-bottom: 10px; }
                    .waiting-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #16213e; border-radius: 8px; margin-bottom: 5px; }
                    .waiting-item .name { color: white; }
                    .waiting-item .status-badge { font-size: 0.7rem; padding: 2px 10px; border-radius: 20px; }
                    .status-badge.waiting { background: #f59e0b; color: #1a1a2e; }
                    .status-badge.active { background: #10b981; color: white; }
                    .add-btn { background: #0f5cbf; color: white; border: none; padding: 4px 12px; border-radius: 20px; cursor: pointer; font-size: 0.7rem; }
                    .add-btn:hover { background: #0a4a9a; }
                    .add-all-btn { background: #10b981; color: white; border: none; padding: 10px 20px; border-radius: 12px; cursor: pointer; font-weight: 600; width: 100%; margin-top: 10px; }
                    .add-all-btn:hover { background: #059669; }
                    .btn-success { background: #10b981 !important; }
                    .btn-success:hover { background: #059669 !important; box-shadow: 0 8px 25px rgba(16, 185, 129, 0.4) !important; }
                    @media(max-width:600px) {
                        .container { padding: 20px; }
                        .platforms { grid-template-columns: 1fr; }
                        .info-box { flex-direction: column; }
                    }
                </style>
            </head>
            <body>
            <div class="container">
                <h1>🎥 بدء البث المباشر</h1>
                <p class="subtitle">اختر المنصة التي تريد البث من خلالها (مجاني 100%)</p>

                <div class="info-box">
                    <div><span>📚 المادة:</span> <strong>${sanitizeInput(offer.subject_name)}</strong></div>
                    <div><span>👨‍🏫 الأستاذ:</span> <strong>${sanitizeInput(decoded.name)}</strong></div>
                    <div><span>👨‍🎓 الطلاب المسجلين:</span> <strong>${studentsCount || 0}</strong></div>
                </div>

                <div class="tip">
                    <h4>💡 نصيحة</h4>
                    <p>• استخدم <strong>Google Meet</strong> للحصول على رابط سريع ومجاني<br>
                    • كلتا المنصتين <strong>مجانيتان</strong> ولا تحتاجان إلى دفع أي شيء<br>
                    • يمكنك إنشاء الرابط مباشرة من هنا دون مغادرة المنصة</p>
                </div>

                <div class="platforms">
                    <div class="platform-card selected" data-platform="google-meet" onclick="selectPlatform('google-meet')">
                        <span class="icon">🔵</span>
                        <div class="name">Google Meet</div>
                        <div class="desc">مجاني • 100 مشارك • سهل الاستخدام</div>
                        <span class="badge-free">✅ مجاني</span>
                    </div>
                    <div class="platform-card" data-platform="microsoft-teams" onclick="selectPlatform('microsoft-teams')">
                        <span class="icon">💜</span>
                        <div class="name">Microsoft Teams</div>
                        <div class="desc">مجاني • 100 مشارك • ميزات متقدمة</div>
                        <span class="badge-free">✅ مجاني</span>
                    </div>
                </div>

                <div class="input-group">
                    <label id="urlLabel">🔗 رابط البث من Google Meet</label>
                    <input type="url" id="streamUrl" placeholder="مثال: https://meet.google.com/xxx-xxxx-xxx" dir="ltr">
                    <div class="hint" id="urlHint">انسخ رابط الاجتماع من Google Meet وألصقه هنا، أو اضغط "إنشاء رابط جديد"</div>
                </div>

                <button class="btn-start" onclick="openMeetAndStart()">🆕 إنشاء رابط جديد وبدء البث</button>
                <button class="btn-start" id="startBtn" onclick="startStream()" style="margin-top:10px;">📋 استخدام رابط موجود وبدء البث</button>
                <button class="btn-back" onclick="window.location.href='/teacher-dashboard.html'">← العودة للوحة التحكم</button>

                <div class="waiting-list" id="waitingList">
                    <h3>📋 قائمة الانتظار</h3>
                    <div id="studentsList">جاري التحميل...</div>
                    <button class="add-all-btn btn-success" onclick="addAllStudents()" id="addAllBtn">➕ إضافة جميع الطلاب إلى البث</button>
                </div>
            </div>

            <script>
                let selectedPlatform = 'google-meet';
                const authToken = '${token}';
                const offerId = ${parseInt(offer_id)};
                const teacherId = ${parseInt(teacher_id)};
                let csrfToken = '';

                async function getCsrfToken() {
                    try {
                        const response = await fetch('/api/get-csrf-token', {
                            method: 'GET',
                            headers: {
                                'Authorization': 'Bearer ' + authToken
                            },
                            credentials: 'include'
                        });
                        const data = await response.json();
                        csrfToken = data.csrfToken;
                        return csrfToken;
                    } catch (error) {
                        console.error('خطأ في جلب CSRF Token:', error);
                        return null;
                    }
                }

                getCsrfToken();

                function selectPlatform(platform) {
                    selectedPlatform = platform;
                    document.querySelectorAll('.platform-card').forEach(el => {
                        el.classList.toggle('selected', el.dataset.platform === platform);
                    });
                    
                    const label = document.getElementById('urlLabel');
                    const hint = document.getElementById('urlHint');
                    
                    if (platform === 'google-meet') {
                        label.textContent = '🔗 رابط البث من Google Meet';
                        hint.textContent = 'انسخ رابط الاجتماع من Google Meet وألصقه هنا';
                        document.getElementById('streamUrl').placeholder = 'https://meet.google.com/xxx-xxxx-xxx';
                    } else {
                        label.textContent = '🔗 رابط البث من Microsoft Teams';
                        hint.textContent = 'انسخ رابط الاجتماع من Microsoft Teams وألصقه هنا';
                        document.getElementById('streamUrl').placeholder = 'https://teams.microsoft.com/l/meetup-join/...';
                    }
                }

                function openMeetAndStart() {
                    const meetWindow = window.open('https://meet.google.com/new', '_blank');
                    
                    setTimeout(() => {
                        const url = prompt('📌 الصق رابط Google Meet هنا:', 'https://meet.google.com/');
                        if (url && url.includes('meet.google.com')) {
                            document.getElementById('streamUrl').value = url;
                            startStream();
                        } else if (url) {
                            alert('❌ الرابط غير صحيح. يجب أن يحتوي على meet.google.com');
                        }
                    }, 2000);
                }

                async function startStream() {
                    const url = document.getElementById('streamUrl').value.trim();
                    if (!url) {
                        alert('❌ الرجاء إدخال رابط البث، أو اضغط "إنشاء رابط جديد"');
                        return;
                    }

                    if (!url.startsWith('http://') && !url.startsWith('https://')) {
                        alert('❌ الرابط غير صحيح. يجب أن يبدأ بـ http:// أو https://');
                        return;
                    }

                    if (selectedPlatform === 'google-meet' && !url.includes('meet.google.com')) {
                        alert('❌ الرابط غير صحيح. يجب أن يحتوي على meet.google.com');
                        return;
                    }

                    if (selectedPlatform === 'microsoft-teams' && !url.includes('teams.microsoft.com')) {
                        alert('❌ الرابط غير صحيح. يجب أن يحتوي على teams.microsoft.com');
                        return;
                    }

                    const btn = document.getElementById('startBtn');
                    btn.disabled = true;
                    btn.textContent = '⏳ جاري بدء البث...';

                    try {
                        const response = await fetch('/api/stream/save-link', {
                            method: 'POST',
                            headers: {
                                'Authorization': 'Bearer ' + authToken,
                                'Content-Type': 'application/json',
                                'X-CSRF-Token': csrfToken
                            },
                            body: JSON.stringify({
                                offer_id: offerId,
                                stream_url: url,
                                platform: selectedPlatform
                            })
                        });

                        const data = await response.json();

                        if (data.success) {
                            const result = await fetch('/api/stream/add-students/' + offerId, {
                                method: 'POST',
                                headers: {
                                    'Authorization': 'Bearer ' + authToken,
                                    'Content-Type': 'application/json',
                                    'X-CSRF-Token': csrfToken
                                },
                                body: JSON.stringify({
                                    offer_id: offerId,
                                    teacher_id: teacherId
                                })
                            });

                            const resultData = await result.json();
                            
                            alert('✅ تم بدء البث المباشر بنجاح!\\n📌 رابط البث: ' + url + '\\n' +
                                  (resultData.students_count ? '👨‍🎓 تم إشعار ' + resultData.students_count + ' طالب' : ''));
                            
                            window.location.href = '/teacher-dashboard.html';
                        } else {
                            alert('❌ ' + (data.error || 'حدث خطأ في بدء البث'));
                            btn.disabled = false;
                            btn.textContent = '📋 استخدام رابط موجود وبدء البث';
                        }
                    } catch (error) {
                        console.error('خطأ:', error);
                        alert('❌ حدث خطأ في الاتصال بالخادم');
                        btn.disabled = false;
                        btn.textContent = '📋 استخدام رابط موجود وبدء البث';
                    }
                }

                async function loadWaitingList() {
                    try {
                        const response = await fetch('/api/stream/waiting-list/' + offerId + '/' + teacherId, {
                            headers: { 
                                'Authorization': 'Bearer ' + authToken,
                                'X-CSRF-Token': csrfToken
                            }
                        });
                        const students = await response.json();
                        const container = document.getElementById('studentsList');
                        
                        if (students.length === 0) {
                            container.innerHTML = '<p style="color:#64748b;">لا يوجد طلاب في قائمة الانتظار</p>';
                            document.getElementById('addAllBtn').style.display = 'none';
                            return;
                        }

                        let html = '';
                        students.forEach(s => {
                            const statusClass = s.is_active ? 'active' : 'waiting';
                            const statusText = s.is_active ? '✅ في البث' : '⏳ في الانتظار';
                            html += \`
                                <div class="waiting-item">
                                    <span class="name">\${s.full_name || 'طالب'}</span>
                                    <span class="status-badge \${statusClass}">\${statusText}</span>
                                    \${!s.is_active ? \`<button class="add-btn" onclick="addStudent(\${s.student_id})">إضافة</button>\` : ''}
                                </div>
                            \`;
                        });
                        container.innerHTML = html;
                        document.getElementById('addAllBtn').style.display = 'block';
                    } catch (error) {
                        console.error('خطأ في جلب قائمة الانتظار:', error);
                        document.getElementById('studentsList').innerHTML = '<p style="color:#ef4444;">حدث خطأ في جلب القائمة</p>';
                    }
                }

                async function addStudent(studentId) {
                    try {
                        const response = await fetch('/api/stream/add-student/' + offerId, {
                            method: 'POST',
                            headers: {
                                'Authorization': 'Bearer ' + authToken,
                                'Content-Type': 'application/json',
                                'X-CSRF-Token': csrfToken
                            },
                            body: JSON.stringify({
                                offer_id: offerId,
                                student_id: studentId,
                                teacher_id: teacherId
                            })
                        });
                        const data = await response.json();
                        if (data.success) {
                            alert('✅ تم إضافة الطالب إلى البث');
                            loadWaitingList();
                        } else {
                            alert('❌ ' + (data.error || 'حدث خطأ'));
                        }
                    } catch (error) {
                        console.error('خطأ:', error);
                        alert('❌ حدث خطأ في الاتصال بالخادم');
                    }
                }

                async function addAllStudents() {
                    if (!confirm('⚠️ هل تريد إضافة جميع الطلاب في قائمة الانتظار إلى البث المباشر؟')) return;

                    const btn = document.getElementById('addAllBtn');
                    btn.disabled = true;
                    btn.textContent = '⏳ جاري الإضافة...';

                    try {
                        const response = await fetch('/api/stream/add-all-students/' + offerId, {
                            method: 'POST',
                            headers: {
                                'Authorization': 'Bearer ' + authToken,
                                'Content-Type': 'application/json',
                                'X-CSRF-Token': csrfToken
                            },
                            body: JSON.stringify({
                                offer_id: offerId,
                                teacher_id: teacherId
                            })
                        });
                        const data = await response.json();
                        if (data.success) {
                            alert('✅ تم إضافة ' + data.students_count + ' طالب إلى البث');
                            loadWaitingList();
                        } else {
                            alert('❌ ' + (data.error || 'حدث خطأ'));
                        }
                    } catch (error) {
                        console.error('خطأ:', error);
                        alert('❌ حدث خطأ في الاتصال بالخادم');
                    }
                    btn.disabled = false;
                    btn.textContent = '➕ إضافة جميع الطلاب إلى البث';
                }

                loadWaitingList();
                setInterval(loadWaitingList, 10000);

                selectPlatform('google-meet');
            </script>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.redirect('/teacher-dashboard.html');
    }
});

// ============================================================
// صفحة دخول الطالب إلى البث
// ============================================================
router.get('/join-stream/:offer_id/:student_id', async (req, res) => {
    try {
        let token = req.headers.authorization?.substring(7);
        if (!token && req.query.token) {
            token = req.query.token;
        }
        
        if (!token) {
            console.log('❌ لا يوجد توكن في طلب دخول الطالب إلى البث');
            return res.status(401).send(renderErrorPage('غير مصرح', 'يرجى تسجيل الدخول أولاً'));
        }
        
        const decoded = verifyToken(token);
        if (!decoded) {
            console.log('❌ توكن غير صالح في طلب دخول الطالب');
            return res.status(401).send(renderErrorPage('انتهت الصلاحية', 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مرة أخرى'));
        }
        
        const { offer_id, student_id } = req.params;
        
        if (decoded.userId !== parseInt(student_id) || decoded.role !== 'student') {
            console.log('❌ صلاحيات غير كافية لدخول البث');
            return res.status(403).send(renderErrorPage('غير مصرح', 'غير مصرح لك بالدخول إلى هذا البث'));
        }

        const session = await getOne('sessions', 'offer_id', offer_id);
        if (!session || session.student_id !== parseInt(student_id) || session.payment_status !== 'paid') {
            console.log('❌ الطالب ليس لديه حجز مدفوع في هذه الحصة');
            return res.status(403).send(renderErrorPage('غير مصرح', 'يجب حجز الحصة أولاً للدخول إلى البث'));
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.redirect('/student-dashboard.html');
        }

        if (offer.status !== 'live') {
            return res.redirect('/student-dashboard.html');
        }

        const { data: active } = await supabase
            .from('active_stream')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .maybeSingle();

        if (!active) {
            console.log(`🔄 إضافة الطالب ${student_id} إلى active_stream من join-stream`);
            await insert('active_stream', {
                offer_id: parseInt(offer_id),
                student_id: parseInt(student_id),
                teacher_id: offer.teacher_id,
                joined_at: new Date().toISOString(),
                added_at: new Date().toISOString(),
                added_by_teacher: false,
                last_ping: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="ar">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>حصة مباشرة</title>
                <style>
                    *{margin:0;padding:0;box-sizing:border-box}
                    body{font-family:Cairo,sans-serif;background:#0a0a1a;overflow:hidden}
                    .header{background:linear-gradient(135deg,#0f3460,#1a1a2e);color:white;padding:12px 24px;display:flex;justify-content:space-between;align-items:center;position:fixed;top:0;left:0;right:0;z-index:100}
                    .btn{background:#ef4444;color:white;border:none;padding:8px 20px;border-radius:30px;cursor:pointer;transition:all 0.3s}
                    .btn:hover{background:#dc2626;transform:scale(1.05)}
                    .badge{background:#10b981;padding:5px 15px;border-radius:30px;font-size:0.8rem}
                    .video-container{position:fixed;top:60px;left:0;right:0;bottom:0;background:#0a0a1a;display:flex;align-items:center;justify-content:center;flex-direction:column}
                    .video-container iframe{width:100%;height:100%;border:none}
                    .info-bar{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);color:white;padding:8px 20px;border-radius:30px;font-size:0.8rem;z-index:100;backdrop-filter:blur(10px);}
                    .waiting-message{text-align:center;color:#94a3b8;padding:40px;font-size:1.2rem}
                    .waiting-message .spinner{display:inline-block;width:40px;height:40px;border:4px solid #0f3460;border-top:4px solid #0f5cbf;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:20px}
                    @keyframes spin{to{transform:rotate(360deg)}}
                </style>
            </head>
            <body>
            <div class="header">
                <div><span class="badge">🎓 طالب</span></div>
                <div>
                    <span style="font-weight:700; font-size:0.9rem; margin-left:16px;">${sanitizeInput(offer.subject_name)}</span>
                    <button class="btn" onclick="leaveStream()">مغادرة</button>
                </div>
            </div>
            <div class="video-container" id="videoContainer">
                ${offer.stream_url ? `
                    <iframe 
                        src="${offer.stream_url}"
                        allow="camera; microphone; autoplay; display-capture; fullscreen"
                        allowfullscreen>
                    </iframe>
                ` : `
                    <div class="waiting-message">
                        <div class="spinner"></div>
                        <p>⏳ جاري تحميل البث المباشر...</p>
                        <p style="font-size:0.8rem;color:#64748b;margin-top:10px;">سيبدأ البث قريباً</p>
                    </div>
                `}
            </div>
            <div class="info-bar">🟢 البث المباشر جاري</div>

            <script>
                const AUTH_TOKEN = '${token}';
                const offerId = ${parseInt(offer_id)};
                const studentId = ${parseInt(student_id)};
                
                async function fetchWithToken(url, options = {}) {
                    const response = await fetch(url, {
                        ...options,
                        headers: {
                            'Authorization': 'Bearer ' + AUTH_TOKEN,
                            'Content-Type': 'application/json',
                            ...options.headers
                        }
                    });
                    if (response.status === 401) {
                        alert('⏳ انتهت صلاحية الجلسة، جاري إعادة التوجيه...');
                        window.location.href = '/student-dashboard.html';
                        return null;
                    }
                    return response;
                }

                function leaveStream() {
                    window.location.href = '/student-dashboard.html';
                }

                setInterval(async () => {
                    try {
                        const res = await fetchWithToken('/api/stream/status/' + offerId);
                        if (res && res.ok) {
                            const data = await res.json();
                            if (data.status !== 'live') {
                                alert('⏹️ انتهى البث المباشر');
                                leaveStream();
                            }
                        }
                    } catch(e) {
                        console.error('خطأ في التحقق من حالة البث:', e);
                    }
                }, 30000);

                const container = document.getElementById('videoContainer');
                const iframe = container.querySelector('iframe');
                if (iframe) {
                    setInterval(() => {
                        iframe.src = iframe.src;
                    }, 300000);
                }

                console.log('✅ تم تهيئة صفحة البث للطالب');
            </script>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('❌ خطأ في دخول الطالب إلى البث:', error.message);
        res.redirect('/student-dashboard.html');
    }
});

// ============================================================
// مسار قائمة انتظار الطلاب
// ============================================================
router.get('/stream/waiting-list/:offer_id/:teacher_id', [
    authenticate,
    authorize(['teacher']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    param('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, teacher_id } = req.params;

        if (req.user.userId !== parseInt(teacher_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const { data } = await supabase
            .from('waiting_room')
            .select('*, students:student_id (id, full_name, email, profile_url)')
            .eq('offer_id', offer_id);

        const { data: activeStudents } = await supabase
            .from('active_stream')
            .select('student_id')
            .eq('offer_id', offer_id);

        const activeStudentIds = new Set(activeStudents?.map(s => s.student_id) || []);

        const formatted = (data || []).map(w => ({
            ...w,
            full_name: w.students?.full_name,
            email: w.students?.email,
            profile_url: w.students?.profile_url,
            is_active: activeStudentIds.has(w.student_id)
        }));

        res.json(formatted);
    } catch (error) {
        console.error('❌ خطأ في جلب قائمة الانتظار:', error.message);
        res.status(500).json([]);
    }
});

// ============================================================
// مسار إضافة طالب واحد من قائمة الانتظار
// ============================================================
router.post('/stream/add-student/:offer_id', [
    authenticate,
    authorize(['teacher']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('student_id').isInt().withMessage('معرف الطالب غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, student_id, teacher_id } = req.body;

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer || offer.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح' });
        }

        const session = await getOne('sessions', 'offer_id', offer_id);
        if (!session || session.student_id !== student_id || session.payment_status !== 'paid') {
            return res.status(403).json({ success: false, error: 'الطالب ليس لديه حجز مدفوع في هذه الحصة' });
        }

        await insert('active_stream', {
            offer_id: parseInt(offer_id),
            student_id: parseInt(student_id),
            teacher_id: teacher_id,
            joined_at: new Date().toISOString(),
            added_at: new Date().toISOString(),
            added_by_teacher: true,
            last_ping: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });

        await supabase
            .from('waiting_room')
            .delete()
            .eq('offer_id', offer_id)
            .eq('student_id', student_id);

        await insert('notifications', {
            user_id: student_id,
            user_type: 'student',
            title: '✅ تمت إضافتك إلى البث المباشر',
            message: `تمت إضافتك إلى البث المباشر للحصة "${offer.subject_name}". انضم الآن عبر زر البث المباشر.`,
            offer_id: offer_id,
            is_read: false,
            created_at: new Date().toISOString()
        });

        res.json({ success: true, message: 'تم إضافة الطالب إلى البث' });
    } catch (error) {
        console.error('❌ خطأ في إضافة الطالب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// مسار إضافة جميع الطلاب من قائمة الانتظار
// ============================================================
router.post('/stream/add-all-students/:offer_id', [
    authenticate,
    authorize(['teacher']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, teacher_id } = req.body;

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer || offer.teacher_id !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح' });
        }

        const { data: waitingStudents } = await supabase
            .from('waiting_room')
            .select('student_id')
            .eq('offer_id', offer_id);

        if (!waitingStudents || waitingStudents.length === 0) {
            return res.json({ success: true, students_count: 0, message: 'لا يوجد طلاب في قائمة الانتظار' });
        }

        let addedCount = 0;
        const addedStudents = [];

        for (const student of waitingStudents) {
            const session = await getOne('sessions', 'offer_id', offer_id);
            if (session && session.student_id === student.student_id && session.payment_status === 'paid') {
                
                const { data: existing } = await supabase
                    .from('active_stream')
                    .select('*')
                    .eq('offer_id', offer_id)
                    .eq('student_id', student.student_id)
                    .maybeSingle();

                if (existing) {
                    await supabase
                        .from('waiting_room')
                        .delete()
                        .eq('offer_id', offer_id)
                        .eq('student_id', student.student_id);
                    continue;
                }

                await insert('active_stream', {
                    offer_id: parseInt(offer_id),
                    student_id: student.student_id,
                    teacher_id: teacher_id,
                    joined_at: new Date().toISOString(),
                    added_at: new Date().toISOString(),
                    added_by_teacher: true,
                    last_ping: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });

                await supabase
                    .from('waiting_room')
                    .delete()
                    .eq('offer_id', offer_id)
                    .eq('student_id', student.student_id);

                await insert('notifications', {
                    user_id: student.student_id,
                    user_type: 'student',
                    title: '✅ تمت إضافتك إلى البث المباشر',
                    message: `تمت إضافتك إلى البث المباشر للحصة "${offer.subject_name}". انضم الآن عبر زر البث المباشر.`,
                    offer_id: offer_id,
                    is_read: false,
                    created_at: new Date().toISOString()
                });

                addedCount++;
                addedStudents.push(student.student_id);
            } else {
                await supabase
                    .from('waiting_room')
                    .delete()
                    .eq('offer_id', offer_id)
                    .eq('student_id', student.student_id);

                await insert('notifications', {
                    user_id: student.student_id,
                    user_type: 'student',
                    title: '❌ لم تتمكن من الانضمام إلى البث',
                    message: `لم تتمكن من الانضمام إلى البث المباشر للحصة "${offer.subject_name}" لأنك لم تقم بحجز الحصة.`,
                    offer_id: offer_id,
                    is_read: false,
                    created_at: new Date().toISOString()
                });
            }
        }

        res.json({ 
            success: true, 
            students_count: addedCount,
            students: addedStudents,
            message: `تم إضافة ${addedCount} طالب إلى البث`
        });
    } catch (error) {
        console.error('❌ خطأ في إضافة جميع الطلاب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// مسار إضافة الطلاب إلى البث (API قديم)
// ============================================================
router.post('/stream/add-students/:offer_id', [
    authenticate,
    authorize(['teacher']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, teacher_id } = req.body;

        if (req.user.userId !== teacher_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', offer_id);

        if (!offer || offer.teacher_id != teacher_id) {
            return res.status(403).json({ success: false });
        }

        await update('offers', offer_id, { status: 'live' });

        const { data: waitingStudents } = await supabase
            .from('waiting_room')
            .select('student_id')
            .eq('offer_id', offer_id);

        const addedStudents = [];

        for (const student of waitingStudents || []) {
            const session = await getOne('sessions', 'offer_id', offer_id);
            if (session && session.student_id === student.student_id && session.payment_status === 'paid') {
                
                const { data: existing } = await supabase
                    .from('active_stream')
                    .select('*')
                    .eq('offer_id', offer_id)
                    .eq('student_id', student.student_id)
                    .maybeSingle();

                if (existing) {
                    await supabase
                        .from('waiting_room')
                        .delete()
                        .eq('offer_id', offer_id)
                        .eq('student_id', student.student_id);
                    continue;
                }

                await insert('active_stream', { 
                    offer_id: parseInt(offer_id), 
                    student_id: student.student_id,
                    teacher_id: teacher_id,
                    joined_at: new Date().toISOString(),
                    added_at: new Date().toISOString(),
                    added_by_teacher: true,
                    last_ping: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });

                await insert('notifications', {
                    user_id: student.student_id,
                    user_type: 'student',
                    title: '🔴 البث المباشر بدأ',
                    message: `الحصة "${offer.subject_name}" قد بدأت الآن. انضم إلى البث المباشر.`,
                    offer_id: offer_id,
                    stream_url: offer.stream_url,
                    is_read: false,
                    created_at: new Date().toISOString()
                });

                addedStudents.push(student.student_id);

                await supabase
                    .from('waiting_room')
                    .delete()
                    .eq('offer_id', offer_id)
                    .eq('student_id', student.student_id);
            } else {
                await supabase
                    .from('waiting_room')
                    .delete()
                    .eq('offer_id', offer_id)
                    .eq('student_id', student.student_id);
            }
        }

        res.json({ success: true, students_count: addedStudents.length, students: addedStudents });
    } catch (error) {
        console.error('❌ خطأ في إضافة الطلاب:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// مسار إضافة طالب إلى البث مباشرة (من الإشعار)
// ============================================================
router.post('/stream/add-student-to-stream/:offer_id', [
    authenticate,
    authorize(['student']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('offer_id').isInt().withMessage('معرف العرض مطلوب'),
    body('student_id').isInt().withMessage('معرف الطالب مطلوب')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, student_id } = req.body;

        if (req.user.userId !== student_id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.status !== 'live') {
            return res.status(400).json({ success: false, error: 'البث غير مباشر' });
        }

        const session = await getOne('sessions', 'offer_id', offer_id);
        if (!session || session.student_id !== student_id || session.payment_status !== 'paid') {
            return res.status(403).json({ success: false, error: 'ليس لديك حجز في هذه الحصة' });
        }

        const { data: existing } = await supabase
            .from('active_stream')
            .select('*')
            .eq('offer_id', offer_id)
            .eq('student_id', student_id)
            .maybeSingle();

        if (existing) {
            return res.json({ success: true, message: 'الطالب مضاف بالفعل إلى البث' });
        }

        await insert('active_stream', {
            offer_id: parseInt(offer_id),
            student_id: parseInt(student_id),
            teacher_id: offer.teacher_id,
            joined_at: new Date().toISOString(),
            added_at: new Date().toISOString(),
            added_by_teacher: false,
            last_ping: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });

        res.json({ success: true, message: 'تمت إضافة الطالب إلى البث' });
    } catch (error) {
        console.error('❌ خطأ في إضافة الطالب إلى البث:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// مسار التحقق من حالة البث للطالب
// ============================================================
router.get('/student/stream-status/:offer_id/:student_id', [
    authenticate,
    authorize(['student']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    param('student_id').isInt().withMessage('معرف الطالب غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, student_id } = req.params;

        if (req.user.userId !== parseInt(student_id)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const session = await getOne('sessions', 'offer_id', offer_id);
        if (!session || session.student_id !== parseInt(student_id) || session.payment_status !== 'paid') {
            return res.json({ 
                can_join: false, 
                error: 'لا يوجد حجز مدفوع',
                status: 'no_booking'
            });
        }

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.json({ 
                can_join: false, 
                status: 'not_found',
                error: 'العرض غير موجود'
            });
        }

        if (offer.status === 'live') {
            const { data: active } = await supabase
                .from('active_stream')
                .select('*')
                .eq('offer_id', offer_id)
                .eq('student_id', student_id)
                .maybeSingle();

            if (!active) {
                console.log(`🔄 إضافة الطالب ${student_id} إلى active_stream تلقائياً`);
                await insert('active_stream', {
                    offer_id: parseInt(offer_id),
                    student_id: parseInt(student_id),
                    teacher_id: offer.teacher_id,
                    joined_at: new Date().toISOString(),
                    added_at: new Date().toISOString(),
                    added_by_teacher: false,
                    last_ping: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });
            }

            await supabase
                .from('notifications')
                .update({ is_read: true })
                .eq('offer_id', offer_id)
                .eq('user_id', student_id);

            return res.json({ 
                can_join: true, 
                stream_url: offer.stream_url, 
                status: 'live',
                offer_id: offer_id
            });
        } else if (offer.status === 'teacher_ready') {
            const { data: existingWaiting } = await supabase
                .from('waiting_room')
                .select('*')
                .eq('offer_id', offer_id)
                .eq('student_id', student_id)
                .maybeSingle();

            if (!existingWaiting) {
                await insert('waiting_room', { 
                    offer_id: offer_id, 
                    student_id: student_id 
                });
            }
            return res.json({ 
                can_join: false, 
                is_waiting: true, 
                status: 'waiting' 
            });
        } else if (offer.status === 'upcoming') {
            return res.json({ 
                can_join: false, 
                is_upcoming: true, 
                status: 'upcoming', 
                offer_date: offer.offer_date 
            });
        } else if (offer.status === 'completed') {
            return res.json({ 
                can_join: false, 
                status: 'completed',
                error: 'انتهى البث المباشر'
            });
        }

        return res.json({ 
            can_join: false, 
            status: 'unknown' 
        });
    } catch (error) {
        console.error('❌ خطأ في حالة البث للطالب:', error.message);
        res.status(500).json({ can_join: false, status: 'error' });
    }
});

// ============================================================
// مسار حالة البث (عام)
// ============================================================
router.get('/stream/status/:offer_id', async (req, res) => {
    try {
        const offer = await getOne('offers', 'id', req.params.offer_id);
        res.json({ 
            status: offer?.status || 'not_found', 
            stream_url: offer?.stream_url || null,
            platform: offer?.stream_platform || null
        });
    } catch (error) {
        res.status(500).json({ status: 'not_found' });
    }
});

// ============================================================
// مسار إنهاء البث
// ============================================================
router.post('/stream/end/:offer_id', [
    authenticate,
    authorize(['teacher']),
    param('offer_id').isInt().withMessage('معرف العرض غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const offer_id = parseInt(req.params.offer_id);

        const offer = await getOne('offers', 'id', offer_id);
        if (!offer) {
            return res.status(404).json({ success: false, error: 'العرض غير موجود' });
        }

        if (offer.teacher_id !== req.user.userId) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بإنهاء هذا البث' });
        }

        await update('offers', offer_id, { 
            status: 'completed',
            ended_at: new Date().toISOString()
        });

        await supabase
            .from('active_stream')
            .delete()
            .eq('offer_id', offer_id);

        await supabase
            .from('waiting_room')
            .delete()
            .eq('offer_id', offer_id);

        const { data: sessions } = await supabase
            .from('sessions')
            .select('student_id')
            .eq('offer_id', offer_id)
            .eq('payment_status', 'paid');

        if (sessions && sessions.length > 0) {
            const notifications = sessions.map(s => ({
                user_id: s.student_id,
                user_type: 'student',
                title: '⏹️ انتهى البث المباشر',
                message: `انتهى البث المباشر للحصة "${offer.subject_name}". شكراً لمشاركتك!`,
                offer_id: offer_id,
                is_read: false,
                created_at: new Date().toISOString()
            }));

            await supabase
                .from('notifications')
                .insert(notifications);
        }

        res.json({ 
            success: true, 
            message: 'تم إنهاء البث المباشر بنجاح' 
        });
    } catch (error) {
        console.error('❌ خطأ في إنهاء البث:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

// ============================================================
// مسار Ping للحفاظ على الاتصال
// ============================================================
router.post('/ping', [
    authenticate,
    body('offer_id').isInt().withMessage('معرف العرض غير صالح'),
    body('teacher_id').isInt().withMessage('معرف الأستاذ غير صالح')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { offer_id, teacher_id } = req.body;
        
        await supabase
            .from('active_stream')
            .update({ 
                last_ping: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('offer_id', offer_id)
            .eq('teacher_id', teacher_id);
        
        const offer = await getOne('offers', 'id', offer_id);
        
        res.json({ 
            success: true, 
            status: offer?.status || 'unknown',
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('❌ خطأ في ping:', error.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;
