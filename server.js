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

  // جدول العروض (المنشورات) التي ينشرها الأستاذ
  db.run(`CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER,
    subject_name TEXT NOT NULL,
    duration INTEGER DEFAULT 60,
    offer_date DATETIME NOT NULL,
    price INTEGER DEFAULT 0,
    is_free BOOLEAN DEFAULT 0,
    status TEXT DEFAULT 'upcoming',
    room_name TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(teacher_id) REFERENCES teachers(id)
  )`);

  // جدول الحصص (الطلاب المسجلين في العروض)
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER,
    student_id INTEGER,
    payment_status TEXT DEFAULT 'pending',
    joined_at DATETIME,
    left_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(offer_id) REFERENCES offers(id),
    FOREIGN KEY(student_id) REFERENCES students(id)
  )`);

  // جدول الطلاب في غرفة الانتظار (قبل بدء البث)
  db.run(`CREATE TABLE IF NOT EXISTS waiting_room (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER,
    student_id INTEGER,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(offer_id) REFERENCES offers(id),
    FOREIGN KEY(student_id) REFERENCES students(id)
  )`);

  // جدول الطلاب في البث المباشر (أثناء الحصة)
  db.run(`CREATE TABLE IF NOT EXISTS active_stream (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER,
    student_id INTEGER,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(offer_id) REFERENCES offers(id),
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
  const { full_name, email, password, phone, specialization, bio } = req.body;
  const hashedPassword = bcrypt.hashSync(password, 10);
  
  db.run(`INSERT INTO teachers (full_name, email, password, phone, specialization, bio, status)
          VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [full_name, email, hashedPassword, phone, specialization, bio],
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
  db.all("SELECT id, full_name, email, phone, specialization, bio, created_at FROM teachers WHERE status = 'pending'", [], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/admin/approved-teachers', (req, res) => {
  db.all("SELECT id, full_name, email, phone, specialization, bio, created_at FROM teachers WHERE status = 'approved'", [], (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/admin/approve-teacher/:id', (req, res) => {
  db.run("UPDATE teachers SET status = 'approved' WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.json({ success: false });
    res.json({ success: true });
  });
});

app.post('/api/admin/reject-teacher/:id', (req, res) => {
  db.run("DELETE FROM teachers WHERE id = ?", [req.params.id], function(err) {
    res.json({ success: true });
  });
});

// ============= نظام العروض (منشورات الأساتذة) =============

// إنشاء عرض جديد (منشور) من قبل الأستاذ
app.post('/api/offer/create', (req, res) => {
  const { teacher_id, subject_name, duration, offer_date, price, is_free } = req.body;
  const room_name = `stream_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
  
  db.run(`INSERT INTO offers (teacher_id, subject_name, duration, offer_date, price, is_free, room_name, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'upcoming')`,
    [teacher_id, subject_name, duration, offer_date, price, is_free ? 1 : 0, room_name],
    function(err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, offer_id: this.lastID, room_name });
    });
});

// جلب جميع العروض المتاحة (للطلاب)
app.get('/api/offers', (req, res) => {
  db.all(`SELECT o.*, t.full_name as teacher_name, t.specialization 
          FROM offers o 
          JOIN teachers t ON o.teacher_id = t.id 
          WHERE o.status = 'upcoming' AND o.offer_date > datetime('now')
          ORDER BY o.offer_date ASC`, [], (err, rows) => {
    res.json(rows || []);
  });
});

// جلب عروض أستاذ معين
app.get('/api/teacher/offers/:teacher_id', (req, res) => {
  db.all(`SELECT * FROM offers WHERE teacher_id = ? ORDER BY offer_date DESC`, [req.params.teacher_id], (err, rows) => {
    res.json(rows || []);
  });
});

// ============= نظام الحجز والدفع والانتظار =============

// حجز عرض (تسجيل طالب في عرض)
app.post('/api/booking/create', (req, res) => {
  const { offer_id, student_id } = req.body;
  
  // التحقق إذا كان الطالب مسجل مسبقاً
  db.get(`SELECT * FROM sessions WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, existing) => {
    if (existing) return res.json({ success: false, error: 'أنت مسجل بالفعل في هذه الحصة' });
    
    db.run(`INSERT INTO sessions (offer_id, student_id, payment_status) VALUES (?, ?, 'pending')`,
      [offer_id, student_id],
      function(err) {
        if (err) return res.json({ success: false, error: err.message });
        res.json({ success: true, session_id: this.lastID });
      });
  });
});

// إنشاء طلب دفع عبر شارجيلي
app.post('/api/create-chargily-payment', (req, res) => {
  const { session_id, amount, student_name, student_email } = req.body;
  
  db.run(`INSERT INTO payments (session_id, amount, status) VALUES (?, ?, 'pending')`,
    [session_id, amount],
    function(err) {
      if (err) return res.json({ success: false, error: err.message });
      
      // محاكاة رابط الدفع (في الإنتاج يتم ربطه بشارجيلي الحقيقي)
      const payment_url = `https://sandbox.chargily.dz/pay/${this.lastID}`;
      res.json({ success: true, payment_url: payment_url, payment_id: this.lastID });
    });
});

// تأكيد الدفع
app.post('/api/payment/confirm/:payment_id', (req, res) => {
  db.get("SELECT session_id FROM payments WHERE id = ?", [req.params.payment_id], (err, payment) => {
    if (payment) {
      db.run("UPDATE payments SET status = 'completed' WHERE id = ?", [req.params.payment_id]);
      db.run("UPDATE sessions SET payment_status = 'paid' WHERE id = ?", [payment.session_id]);
      
      // بعد الدفع، إضافة الطالب إلى غرفة الانتظار
      db.get("SELECT offer_id FROM sessions WHERE id = ?", [payment.session_id], (err, session) => {
        if (session) {
          db.get("SELECT student_id FROM sessions WHERE id = ?", [payment.session_id], (err, sess) => {
            if (sess) {
              db.run(`INSERT INTO waiting_room (offer_id, student_id) VALUES (?, ?)`, [session.offer_id, sess.student_id]);
            }
          });
        }
      });
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  });
});

// ============= نظام البث المباشر وغرفة الانتظار =============

// بدء البث المباشر (الأستاذ يبدأ الحصة)
app.post('/api/stream/start/:offer_id', (req, res) => {
  const { offer_id, teacher_id } = req.body;
  
  // التحقق من ملكية الأستاذ للعرض
  db.get(`SELECT * FROM offers WHERE id = ? AND teacher_id = ?`, [offer_id, teacher_id], (err, offer) => {
    if (!offer) return res.json({ success: false, error: 'غير مصرح لك' });
    
    // تحديث حالة العرض إلى live
    db.run(`UPDATE offers SET status = 'live' WHERE id = ?`, [offer_id]);
    
    // نقل جميع الطلاب من غرفة الانتظار إلى البث المباشر
    db.all(`SELECT student_id FROM waiting_room WHERE offer_id = ?`, [offer_id], (err, students) => {
      students.forEach(s => {
        db.run(`INSERT INTO active_stream (offer_id, student_id) VALUES (?, ?)`, [offer_id, s.student_id]);
        db.run(`DELETE FROM waiting_room WHERE offer_id = ? AND student_id = ?`, [offer_id, s.student_id]);
      });
    });
    
    res.json({ success: true, room_name: offer.room_name });
  });
});

// إنهاء البث المباشر
app.post('/api/stream/end/:offer_id', (req, res) => {
  const { offer_id, teacher_id } = req.body;
  
  db.get(`SELECT * FROM offers WHERE id = ? AND teacher_id = ?`, [offer_id, teacher_id], (err, offer) => {
    if (!offer) return res.json({ success: false });
    
    db.run(`UPDATE offers SET status = 'completed' WHERE id = ?`, [offer_id]);
    db.run(`DELETE FROM active_stream WHERE offer_id = ?`, [offer_id]);
    db.run(`DELETE FROM waiting_room WHERE offer_id = ?`, [offer_id]);
    
    res.json({ success: true });
  });
});

// التحقق من حالة العرض (هل بدأ البث؟)
app.get('/api/stream/status/:offer_id', (req, res) => {
  db.get(`SELECT status, room_name FROM offers WHERE id = ?`, [req.params.offer_id], (err, offer) => {
    if (!offer) return res.json({ status: 'not_found' });
    res.json({ status: offer.status, room_name: offer.room_name });
  });
});

// التحقق مما إذا كان الطالب في البث المباشر أم في الانتظار
app.get('/api/student/stream-status/:offer_id/:student_id', (req, res) => {
  const { offer_id, student_id } = req.params;
  
  // التحقق من حالة العرض أولاً
  db.get(`SELECT status FROM offers WHERE id = ?`, [offer_id], (err, offer) => {
    if (!offer) return res.json({ can_join: false, error: 'العرض غير موجود' });
    
    if (offer.status === 'live') {
      // التحقق مما إذا كان الطالب في البث المباشر
      db.get(`SELECT * FROM active_stream WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, active) => {
        if (active) {
          return res.json({ can_join: true, is_waiting: false, room_name: offer.room_name });
        } else {
          return res.json({ can_join: false, is_waiting: false, error: 'لم يتم الدفع أو غير مسجل' });
        }
      });
    } 
    else if (offer.status === 'upcoming') {
      // التحقق مما إذا كان الطالب مسجل ومدفوع
      db.get(`SELECT s.*, o.is_free, o.price 
              FROM sessions s 
              JOIN offers o ON s.offer_id = o.id 
              WHERE s.offer_id = ? AND s.student_id = ?`, [offer_id, student_id], (err, session) => {
        if (!session) return res.json({ can_join: false, error: 'غير مسجل في هذه الحصة' });
        
        if (session.is_free === 1 || session.payment_status === 'paid') {
          // التحقق مما إذا كان في غرفة الانتظار
          db.get(`SELECT * FROM waiting_room WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, waiting) => {
            if (!waiting) {
              // إضافته إلى غرفة الانتظار
              db.run(`INSERT INTO waiting_room (offer_id, student_id) VALUES (?, ?)`, [offer_id, student_id]);
            }
            return res.json({ can_join: false, is_waiting: true, message: 'بانتظار بدء البث من قبل الأستاذ' });
          });
        } else {
          return res.json({ can_join: false, is_waiting: false, error: 'يرجى إتمام الدفع أولاً', payment_required: true, session_id: session.id });
        }
      });
    }
    else {
      return res.json({ can_join: false, error: 'انتهت الحصة' });
    }
  });
});

// الحصول على قائمة الطلاب المنتظرين (للأستاذ)
app.get('/api/stream/waiting-list/:offer_id/:teacher_id', (req, res) => {
  const { offer_id, teacher_id } = req.params;
  
  db.get(`SELECT teacher_id FROM offers WHERE id = ?`, [offer_id], (err, offer) => {
    if (!offer || offer.teacher_id != teacher_id) return res.json({ error: 'غير مصرح' });
    
    db.all(`SELECT w.*, s.full_name, s.email 
            FROM waiting_room w 
            JOIN students s ON w.student_id = s.id 
            WHERE w.offer_id = ?`, [offer_id], (err, students) => {
      res.json(students || []);
    });
  });
});

// الحصول على قائمة الطلاب في البث (للأستاذ)
app.get('/api/stream/active-list/:offer_id/:teacher_id', (req, res) => {
  const { offer_id, teacher_id } = req.params;
  
  db.get(`SELECT teacher_id FROM offers WHERE id = ?`, [offer_id], (err, offer) => {
    if (!offer || offer.teacher_id != teacher_id) return res.json({ error: 'غير مصرح' });
    
    db.all(`SELECT a.*, s.full_name, s.email 
            FROM active_stream a 
            JOIN students s ON a.student_id = s.id 
            WHERE a.offer_id = ?`, [offer_id], (err, students) => {
      res.json(students || []);
    });
  });
});

// دخول الطالب إلى الغرفة (بعد التحقق)
app.get('/api/join-stream/:offer_id/:student_id', (req, res) => {
  const { offer_id, student_id } = req.params;
  
  db.get(`SELECT status, room_name FROM offers WHERE id = ?`, [offer_id], (err, offer) => {
    if (!offer) return res.redirect('/student-dashboard.html?error=offer_not_found');
    
    if (offer.status === 'live') {
      db.get(`SELECT * FROM active_stream WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, active) => {
        if (active) {
          // صفحة البث المباشر مع Jitsi
          res.send(generateStreamPage(offer.room_name, student_id, 'student'));
        } else {
          res.redirect('/student-dashboard.html?error=not_authorized');
        }
      });
    } else {
      res.redirect('/student-dashboard.html?error=stream_not_started');
    }
  });
});

// صفحة البث المباشر للأستاذ
app.get('/api/teacher-stream/:offer_id/:teacher_id', (req, res) => {
  const { offer_id, teacher_id } = req.params;
  
  db.get(`SELECT room_name FROM offers WHERE id = ? AND teacher_id = ?`, [offer_id, teacher_id], (err, offer) => {
    if (!offer) return res.redirect('/teacher-dashboard.html?error=unauthorized');
    res.send(generateStreamPage(offer.room_name, teacher_id, 'teacher', offer_id));
  });
});

// دوال مساعدة
function generateStreamPage(roomName, userId, role, offerId = null) {
  return `
<!DOCTYPE html>
<html lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${role === 'teacher' ? 'بث مباشر - أستاذ' : 'حصة مباشرة - طالب'} | منصة التعليم</title>
    <script src="https://meet.jit.si/external_api.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Cairo', sans-serif; background: #0a0a1a; }
        .stream-header { background: linear-gradient(135deg, #0f3460, #16213e); color: white; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; position: fixed; top: 0; left: 0; right: 0; z-index: 100; }
        .stream-info { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
        .stream-info i { font-size: 24px; color: #0f5cbf; }
        .stream-info span { font-size: 14px; color: #b9d0f0; }
        .leave-btn, .end-stream-btn { background: #ef4444; color: white; border: none; padding: 8px 24px; border-radius: 30px; cursor: pointer; font-size: 14px; font-weight: 600; font-family: 'Cairo', sans-serif; margin-left: 10px; }
        .end-stream-btn { background: #dc2626; }
        .leave-btn:hover, .end-stream-btn:hover { opacity: 0.9; transform: scale(1.02); }
        #jitsi-container { position: fixed; top: 60px; left: 0; right: 0; bottom: 0; }
        @media (max-width: 768px) {
            .stream-header { padding: 8px 16px; }
            .stream-info span { font-size: 10px; }
            #jitsi-container { top: 55px; }
        }
    </style>
</head>
<body>
    <div class="stream-header">
        <div class="stream-info">
            <i class="fas fa-chalkboard-user"></i>
            <span>🎓 ${role === 'teacher' ? 'بث مباشر - أنت تنشر المعرفة' : 'حصة تعليمية مباشرة'}</span>
            <span>🔑 ${roomName}</span>
        </div>
        <div>
            ${role === 'teacher' ? `<button class="end-stream-btn" onclick="endStream()"><i class="fas fa-stop"></i> إنهاء البث</button>` : ''}
            <button class="leave-btn" onclick="leaveStream()"><i class="fas fa-sign-out-alt"></i> مغادرة</button>
        </div>
    </div>
    <div id="jitsi-container"></div>
    <script>
        const domain = 'meet.jit.si';
        const options = {
            roomName: '${roomName}',
            width: '100%',
            height: window.innerHeight - 60,
            parentNode: document.querySelector('#jitsi-container'),
            userInfo: { displayName: '${role === 'teacher' ? 'أستاذ' : 'طالب'}' },
            configOverwrite: {
                startWithVideoMuted: false,
                startWithAudioMuted: false,
                enableWelcomePage: false,
                prejoinPageEnabled: false,
                toolbarButtons: ['microphone', 'camera', 'desktop', 'fullscreen', 'hangup', 'chat', 'raisehand', 'settings']
            }
        };
        const api = new JitsiMeetExternalAPI(domain, options);
        
        function leaveStream() {
            try { api.dispose(); } catch(e) {}
            window.location.href = '/${role === 'teacher' ? 'teacher-dashboard.html' : 'student-dashboard.html'}';
        }
        
        ${role === 'teacher' ? `
        async function endStream() {
            if (confirm('هل أنت متأكد من إنهاء البث المباشر؟')) {
                await fetch('/api/stream/end/${offerId}', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ offer_id: ${offerId}, teacher_id: ${userId} })
                });
                try { api.dispose(); } catch(e) {}
                window.location.href = '/teacher-dashboard.html';
            }
        }
        ` : ''}
        
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css';
        document.head.appendChild(link);
    </script>
</body>
</html>
  `;
}

// الحصول على حجوزات الطالب
app.get('/api/student/bookings/:student_id', (req, res) => {
  db.all(`SELECT s.*, o.subject_name, o.offer_date, o.duration, o.price, o.is_free, o.status as offer_status, o.room_name, t.full_name as teacher_name
          FROM sessions s
          JOIN offers o ON s.offer_id = o.id
          JOIN teachers t ON o.teacher_id = t.id
          WHERE s.student_id = ?
          ORDER BY o.offer_date DESC`, [req.params.student_id], (err, rows) => {
    res.json(rows || []);
  });
});

app.listen(PORT, () => {
  console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
});
