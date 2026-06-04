const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// قاعدة بيانات SQLite
const db = new sqlite3.Database('./platform.db');

// إنشاء الجداول
db.serialize(() => {
  // جدول الأساتذة
  db.run(`CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    phone TEXT,
    specialization TEXT,
    bio TEXT,
    hourly_rate INTEGER DEFAULT 1000,
    profile_image TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // جدول الطلاب
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    phone TEXT,
    balance INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // جدول الحصص مع room_password
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER,
    student_id INTEGER,
    room_name TEXT UNIQUE,
    room_password TEXT,
    session_date DATETIME,
    duration INTEGER DEFAULT 60,
    price INTEGER,
    status TEXT DEFAULT 'scheduled',
    payment_status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(teacher_id) REFERENCES teachers(id),
    FOREIGN KEY(student_id) REFERENCES students(id)
  )`);

  // جدول المدفوعات
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    amount INTEGER,
    chargily_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  )`);

  // إنشاء admin افتراضي
  db.get("SELECT * FROM teachers WHERE email = 'admin@platform.com'", [], (err, row) => {
    if (!row) {
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      db.run("INSERT INTO teachers (full_name, email, password, status) VALUES (?, ?, ?, 'approved')", 
        ['مدير المنصة', 'admin@platform.com', hashedPassword]);
    }
  });
});

// ============= API Routes =============

// تسجيل أستاذ جديد
app.post('/api/teacher/register', async (req, res) => {
  const { full_name, email, password, phone, specialization, bio, hourly_rate } = req.body;
  const hashedPassword = bcrypt.hashSync(password, 10);
  
  db.run(`INSERT INTO teachers (full_name, email, password, phone, specialization, bio, hourly_rate, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [full_name, email, hashedPassword, phone, specialization, bio, hourly_rate],
    function(err) {
      if (err && err.message.includes('UNIQUE')) return res.json({ success: false, error: 'البريد الإلكتروني مستخدم مسبقاً' });
      if (err) return res.json({ success: false, error: 'حدث خطأ' });
      res.json({ success: true, message: 'تم إرسال طلبك، سيتم مراجعته من قبل الإدارة' });
    });
});

// تسجيل طالب
app.post('/api/student/register', async (req, res) => {
  const { full_name, email, password, phone } = req.body;
  const hashedPassword = bcrypt.hashSync(password, 10);
  
  db.run(`INSERT INTO students (full_name, email, password, phone, balance)
          VALUES (?, ?, ?, ?, 0)`,
    [full_name, email, hashedPassword, phone],
    function(err) {
      if (err && err.message.includes('UNIQUE')) return res.json({ success: false, error: 'البريد الإلكتروني مستخدم' });
      if (err) return res.json({ success: false, error: 'حدث خطأ' });
      res.json({ success: true, message: 'تم التسجيل بنجاح' });
    });
});

// تسجيل الدخول
app.post('/api/login', (req, res) => {
  const { email, password, role } = req.body;
  const table = role === 'teacher' ? 'teachers' : 'students';
  
  db.get(`SELECT * FROM ${table} WHERE email = ?`, [email], async (err, user) => {
    if (err || !user) return res.json({ success: false, error: 'البريد الإلكتروني غير موجود' });
    
    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) return res.json({ success: false, error: 'كلمة المرور خاطئة' });
    
    if (role === 'teacher' && user.status !== 'approved' && user.email !== 'admin@platform.com') {
      return res.json({ success: false, error: 'حسابك قيد المراجعة من قبل الإدارة' });
    }
    
    const token = jwt.sign({ id: user.id, email: user.email, role, name: user.full_name }, 'secret_key', { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, name: user.full_name, email: user.email, role, status: user.status } });
  });
});

// ADMIN: عرض الأساتذة المنتظرين
app.get('/api/admin/pending-teachers', (req, res) => {
  db.all("SELECT id, full_name, email, phone, specialization, bio, hourly_rate, created_at FROM teachers WHERE status = 'pending'", [], (err, rows) => {
    res.json(rows || []);
  });
});

// ADMIN: عرض جميع الأساتذة المقبولين
app.get('/api/admin/approved-teachers', (req, res) => {
  db.all("SELECT id, full_name, email, phone, specialization, bio, hourly_rate, created_at FROM teachers WHERE status = 'approved'", [], (err, rows) => {
    res.json(rows || []);
  });
});

// ADMIN: قبول أستاذ
app.post('/api/admin/approve-teacher/:id', (req, res) => {
  db.run("UPDATE teachers SET status = 'approved' WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

// ADMIN: رفض أستاذ
app.post('/api/admin/reject-teacher/:id', (req, res) => {
  db.run("DELETE FROM teachers WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.json({ success: false });
    res.json({ success: true });
  });
});

// عرض قائمة الأساتذة المقبولين للطلاب
app.get('/api/teachers', (req, res) => {
  db.all("SELECT id, full_name, specialization, bio, hourly_rate FROM teachers WHERE status = 'approved'", [], (err, rows) => {
    res.json(rows || []);
  });
});

// الحصول على تفاصيل أستاذ
app.get('/api/teacher/:id', (req, res) => {
  db.get("SELECT id, full_name, specialization, bio, hourly_rate, phone FROM teachers WHERE id = ? AND status = 'approved'", [req.params.id], (err, row) => {
    if (!row) return res.json({ error: 'الأستاذ غير موجود' });
    res.json(row);
  });
});

// ============= نظام إدارة الغرف والصوت/الفيديو =============

// إنشاء غرفة جديدة للحصة (مع صلاحيات)
app.post('/api/session/create-room', (req, res) => {
  const { teacher_id, student_id, session_date, price } = req.body;
  
  // إنشاء معرف غرفة فريد وآمن
  const room_id = `class_${Date.now()}_${Math.random().toString(36).substr(2, 10)}`;
  const room_password = Math.random().toString(36).substr(2, 8);
  
  db.run(`INSERT INTO sessions (teacher_id, student_id, room_name, room_password, session_date, price, status, payment_status)
          VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 'pending')`,
    [teacher_id, student_id, room_id, room_password, session_date, price],
    function(err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ 
        success: true, 
        session_id: this.lastID, 
        room_id: room_id,
        room_password: room_password,
        jitsi_url: `https://meet.jit.si/${room_id}`
      });
    });
});

// التحقق من صلاحية الدخول إلى الغرفة
app.post('/api/verify-room-access', (req, res) => {
  const { session_id, user_id, user_role } = req.body;
  
  db.get(`SELECT s.*, t.full_name as teacher_name, st.full_name as student_name 
          FROM sessions s
          LEFT JOIN teachers t ON s.teacher_id = t.id
          LEFT JOIN students st ON s.student_id = st.id
          WHERE s.id = ?`, [session_id], (err, session) => {
    
    if (!session) {
      return res.json({ allowed: false, error: 'الحصة غير موجودة' });
    }
    
    let isAuthorized = false;
    
    if (user_role === 'teacher' && session.teacher_id == user_id) {
      isAuthorized = true;
    } 
    else if (user_role === 'student' && session.student_id == user_id) {
      if (session.payment_status === 'paid') {
        isAuthorized = true;
      } else {
        return res.json({ allowed: false, error: 'يرجى إتمام الدفع أولاً', payment_required: true, session_id: session.id });
      }
    }
    else {
      return res.json({ allowed: false, error: 'غير مصرح لك بدخول هذه الحصة' });
    }
    
    const accessToken = jwt.sign(
      { session_id: session.id, user_id: user_id, role: user_role, room: session.room_name },
      'room_secret_key',
      { expiresIn: '2h' }
    );
    
    res.json({
      allowed: true,
      room_name: session.room_name,
      access_token: accessToken,
      jitsi_url: `https://meet.jit.si/${session.room_name}`,
      is_teacher: user_role === 'teacher'
    });
  });
});

// إنشاء رابط دخول مباشر للحصة (مع توثيق)
app.get('/api/join-session/:session_id/:user_id/:role', (req, res) => {
  const { session_id, user_id, role } = req.params;
  
  db.get(`SELECT s.*, t.full_name as teacher_name, st.full_name as student_name 
          FROM sessions s
          LEFT JOIN teachers t ON s.teacher_id = t.id
          LEFT JOIN students st ON s.student_id = st.id
          WHERE s.id = ?`, [session_id], (err, session) => {
    
    if (!session) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="ar">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>خطأ</title>
        <style>body{text-align:center;padding:50px;font-family:'Cairo',sans-serif;background:#f0f2f5;} .card{background:white;border-radius:20px;padding:40px;max-width:500px;margin:auto;box-shadow:0 10px 30px rgba(0,0,0,0.1);} h1{color:#ef4444;} a{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px;}</style>
        </head>
        <body><div class="card"><h1>❌ الحصة غير موجودة</h1><a href="/">العودة للرئيسية</a></div></body></html>
      `);
    }
    
    let isAuthorized = false;
    let displayName = '';
    
    if (role === 'teacher' && session.teacher_id == user_id) {
      isAuthorized = true;
      displayName = session.teacher_name || `أستاذ`;
    }
    if (role === 'student' && session.student_id == user_id && session.payment_status === 'paid') {
      isAuthorized = true;
      displayName = session.student_name || `طالب`;
    }
    
    if (!isAuthorized) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="ar">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>غير مصرح</title>
        <style>body{text-align:center;padding:50px;font-family:'Cairo',sans-serif;background:#f0f2f5;} .card{background:white;border-radius:20px;padding:40px;max-width:500px;margin:auto;box-shadow:0 10px 30px rgba(0,0,0,0.1);} h1{color:#ef4444;} a{background:#0f5cbf;color:white;padding:12px 30px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px;}</style>
        </head>
        <body><div class="card"><h1>⛔ غير مصرح لك بدخول هذه الحصة</h1>
        ${role === 'student' && session.student_id == user_id && session.payment_status !== 'paid' ? 
          '<p>💰 يرجى إتمام الدفع أولاً للانضمام إلى الحصة</p><a href="/student-dashboard.html">الذهاب للوحة الطالب</a>' : 
          '<a href="/">العودة للرئيسية</a>'}
        </div></body></html>
      `);
    }
    
    // عرض صفحة الفيديو المباشر مع Jitsi Meet
    res.send(`
      <!DOCTYPE html>
      <html lang="ar">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
        <title>الحصة المباشرة - منصة التعليم الجزائرية</title>
        <script src="https://meet.jit.si/external_api.js"></script>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Cairo', 'Segoe UI', sans-serif; background: #1a1a2e; }
          .video-header { background: linear-gradient(135deg, #0f3460, #16213e); color: white; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; position: fixed; top: 0; left: 0; right: 0; z-index: 100; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
          .session-info { display: flex; align-items: center; gap: 15px; flex-wrap: wrap; }
          .session-info i { font-size: 24px; color: #0f5cbf; }
          .session-info span { font-size: 14px; color: #b9d0f0; }
          .leave-btn { background: #ef4444; color: white; border: none; padding: 8px 24px; border-radius: 30px; cursor: pointer; font-size: 14px; font-weight: 600; transition: 0.3s; font-family: 'Cairo', sans-serif; }
          .leave-btn:hover { background: #dc2626; transform: scale(1.02); }
          #jitsi-container { position: fixed; top: 60px; left: 0; right: 0; bottom: 0; }
          @media (max-width: 768px) {
            .video-header { padding: 8px 16px; }
            .session-info span { font-size: 10px; }
            .leave-btn { padding: 6px 16px; font-size: 12px; }
            #jitsi-container { top: 55px; }
          }
        </style>
      </head>
      <body>
        <div class="video-header">
          <div class="session-info">
            <i class="fas fa-chalkboard-user"></i>
            <span>🎓 الحصة التعليمية المباشرة</span>
            <span>👤 ${displayName}</span>
            <span>🔑 ${session.room_name}</span>
          </div>
          <button class="leave-btn" onclick="leaveSession()"><i class="fas fa-sign-out-alt"></i> مغادرة الحصة</button>
        </div>
        <div id="jitsi-container"></div>
        <script>
          const domain = 'meet.jit.si';
          const options = {
            roomName: '${session.room_name}',
            width: '100%',
            height: window.innerHeight - 60,
            parentNode: document.querySelector('#jitsi-container'),
            userInfo: {
              displayName: '${displayName}',
            },
            configOverwrite: {
              startWithVideoMuted: false,
              startWithAudioMuted: false,
              enableWelcomePage: false,
              prejoinPageEnabled: false,
              disableDeepLinking: true,
              toolbarButtons: ['microphone', 'camera', 'closedcaptions', 'desktop', 'fullscreen', 'hangup', 'chat', 'raisehand', 'settings', 'tileview', 'security']
            },
            interfaceConfigOverwrite: {
              SHOW_JITSI_WATERMARK: false,
              SHOW_WATERMARK_FOR_GUESTS: false,
              TOOLBAR_BUTTONS: ['microphone', 'camera', 'closedcaptions', 'desktop', 'fullscreen', 'hangup', 'chat', 'raisehand', 'settings', 'tileview'],
              LANG_DETECTION: true,
            }
          };
          const api = new JitsiMeetExternalAPI(domain, options);
          
          function leaveSession() {
            try { api.dispose(); } catch(e) {}
            window.location.href = '/${role === 'teacher' ? 'teacher-dashboard.html' : 'student-dashboard.html'}';
          }
          
          window.addEventListener('beforeunload', () => {
            try { api.dispose(); } catch(e) {}
          });
          
          // إضافة أيقونات Font Awesome
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css';
          document.head.appendChild(link);
        </script>
      </body>
      </html>
    `);
  });
});

// الحصول على حصص الطالب
app.get('/api/student/sessions/:student_id', (req, res) => {
  db.all(`SELECT s.*, t.full_name as teacher_name, t.specialization 
          FROM sessions s 
          JOIN teachers t ON s.teacher_id = t.id 
          WHERE s.student_id = ? 
          ORDER BY s.session_date DESC`, 
    [req.params.student_id], (err, rows) => {
    res.json(rows || []);
  });
});

// الحصول على حصص الأستاذ
app.get('/api/teacher/sessions/:teacher_id', (req, res) => {
  db.all(`SELECT s.*, st.full_name as student_name 
          FROM sessions s 
          JOIN students st ON s.student_id = st.id 
          WHERE s.teacher_id = ? 
          ORDER BY s.session_date DESC`, 
    [req.params.teacher_id], (err, rows) => {
    res.json(rows || []);
  });
});

// ============= Chargily Payment API =============
app.post('/api/create-chargily-payment', (req, res) => {
  const { session_id, amount, student_name, student_email, student_phone } = req.body;
  
  db.run(`INSERT INTO payments (session_id, amount, status) VALUES (?, ?, 'pending')`,
    [session_id, amount],
    function(err) {
      if (err) return res.json({ success: false, error: err.message });
      
      const payment_url = `https://sandbox.chargily.dz/pay/${this.lastID}`;
      res.json({
        success: true,
        payment_url: payment_url,
        payment_id: this.lastID,
        instructions: "ادفع عبر شارجيلي باستخدام بطاقة EDAHABIA أو CCP"
      });
    });
});

// تأكيد الدفع
app.post('/api/payment/confirm/:payment_id', (req, res) => {
  db.get("SELECT session_id FROM payments WHERE id = ?", [req.params.payment_id], (err, payment) => {
    if (payment) {
      db.run("UPDATE payments SET status = 'completed' WHERE id = ?", [req.params.payment_id]);
      db.run("UPDATE sessions SET payment_status = 'paid' WHERE id = ?", [payment.session_id]);
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  });
});

// Webhook من شارجيلي
app.post('/api/chargily-webhook', (req, res) => {
  const { payment_id, status, chargily_transaction_id } = req.body;
  
  if (status === 'paid') {
    db.run(`UPDATE payments SET status = 'completed', chargily_id = ? WHERE id = ?`, 
      [chargily_transaction_id, payment_id], (err) => {
        db.get("SELECT session_id FROM payments WHERE id = ?", [payment_id], (err, payment) => {
          if (payment) {
            db.run("UPDATE sessions SET payment_status = 'paid' WHERE id = ?", [payment.session_id]);
          }
        });
      });
  }
  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
});
