const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// إعداد رفع الملفات
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 5 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ============= قاعدة بيانات دائمة (حفظ على القرص) =============
// استخدام ملف محدد للتخزين الدائم
const DB_PATH = path.join(__dirname, 'platform.db');
const db = new sqlite3.Database(DB_PATH);

// دالة لتهيئة قاعدة البيانات
function initDatabase() {
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
      experience TEXT,
      profile_image TEXT,
      diploma_image TEXT,
      id_image TEXT,
      status TEXT DEFAULT 'pending',
      rejection_reason TEXT,
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

    // جدول العروض
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
      room_password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(teacher_id) REFERENCES teachers(id)
    )`);

    // جدول الحصص
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER,
      student_id INTEGER,
      payment_status TEXT DEFAULT 'pending',
      payment_amount INTEGER DEFAULT 0,
      joined_at DATETIME,
      left_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(offer_id) REFERENCES offers(id),
      FOREIGN KEY(student_id) REFERENCES students(id)
    )`);

    // جدول غرفة الانتظار
    db.run(`CREATE TABLE IF NOT EXISTS waiting_room (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER,
      student_id INTEGER,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(offer_id) REFERENCES offers(id),
      FOREIGN KEY(student_id) REFERENCES students(id)
    )`);

    // جدول البث المباشر
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

    // إنشاء admin افتراضي إذا لم يكن موجوداً
    db.get("SELECT * FROM teachers WHERE email = 'admin@platform.com'", [], (err, row) => {
      if (!row && !err) {
        const hashedPassword = bcrypt.hashSync('admin123', 10);
        db.run("INSERT INTO teachers (full_name, email, password, phone, status) VALUES (?, ?, ?, ?, 'approved')", 
          ['مدير المنصة', 'admin@platform.com', hashedPassword, '00000000']);
      }
    });
  });
}

// تهيئة قاعدة البيانات عند بدء التشغيل
initDatabase();

// ============= API Routes =============

// تسجيل أستاذ جديد
app.post('/api/teacher/register', upload.fields([
  { name: 'profile_image', maxCount: 1 },
  { name: 'diploma_image', maxCount: 1 },
  { name: 'id_image', maxCount: 1 }
]), async (req, res) => {
  const { full_name, email, password, phone, specialization, bio, experience } = req.body;
  
  if (!full_name || !email || !password || !phone || !specialization || !bio || !experience) {
    return res.json({ success: false, error: 'يرجى ملء جميع الحقول المطلوبة' });
  }
  
  if (!req.files['profile_image'] || !req.files['diploma_image'] || !req.files['id_image']) {
    return res.json({ success: false, error: 'يرجى رفع الصورة الشخصية، صورة الدبلوم، وصورة بطاقة الهوية' });
  }
  
  const hashedPassword = bcrypt.hashSync(password, 10);
  const profile_image = req.files['profile_image'][0].filename;
  const diploma_image = req.files['diploma_image'][0].filename;
  const id_image = req.files['id_image'][0].filename;
  
  db.run(`INSERT INTO teachers (full_name, email, password, phone, specialization, bio, experience, profile_image, diploma_image, id_image, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [full_name, email, hashedPassword, phone, specialization, bio, experience, profile_image, diploma_image, id_image],
    function(err) {
      if (err && err.message.includes('UNIQUE')) return res.json({ success: false, error: 'البريد الإلكتروني مستخدم مسبقاً' });
      if (err) return res.json({ success: false, error: 'حدث خطأ: ' + err.message });
      res.json({ success: true, message: 'تم إرسال طلبك، سيتم مراجعته من قبل الإدارة' });
    });
});

// تسجيل طالب
app.post('/api/student/register', async (req, res) => {
  const { full_name, email, password, phone } = req.body;
  if (!full_name || !email || !password || !phone) {
    return res.json({ success: false, error: 'يرجى ملء جميع الحقول' });
  }
  const hashedPassword = bcrypt.hashSync(password, 10);
  
  db.run(`INSERT INTO students (full_name, email, password, phone, balance)
          VALUES (?, ?, ?, ?, 0)`,
    [full_name, email, hashedPassword, phone],
    function(err) {
      if (err && err.message.includes('UNIQUE')) return res.json({ success: false, error: 'البريد الإلكتروني مستخدم' });
      if (err) return res.json({ success: false, error: 'حدث خطأ: ' + err.message });
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

// ADMIN Routes
app.get('/api/admin/pending-teachers', (req, res) => {
  db.all("SELECT id, full_name, email, phone, specialization, bio, experience, profile_image, diploma_image, id_image, created_at FROM teachers WHERE status = 'pending'", [], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/admin/approved-teachers', (req, res) => {
  db.all("SELECT id, full_name, email, phone, specialization, bio, experience, profile_image, created_at FROM teachers WHERE status = 'approved'", [], (err, rows) => {
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
  const { reason } = req.body;
  db.run("UPDATE teachers SET status = 'rejected', rejection_reason = ? WHERE id = ?", [reason, req.params.id], function(err) {
    res.json({ success: true });
  });
});

// ============= العروض العامة =============

app.get('/api/public/teachers', (req, res) => {
  db.all(`SELECT id, full_name, email, phone, specialization, bio, experience, profile_image, created_at 
          FROM teachers 
          WHERE status = 'approved' 
          ORDER BY created_at DESC`, [], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/public/offers', (req, res) => {
  db.all(`SELECT o.*, t.full_name as teacher_name, t.specialization, t.profile_image 
          FROM offers o 
          JOIN teachers t ON o.teacher_id = t.id 
          WHERE o.status = 'upcoming' AND o.offer_date > datetime('now') AND t.status = 'approved'
          ORDER BY o.offer_date ASC`, [], (err, rows) => {
    res.json(rows || []);
  });
});

// ============= نظام العروض =============

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

app.get('/api/offers', (req, res) => {
  db.all(`SELECT o.*, t.full_name as teacher_name, t.specialization, t.profile_image 
          FROM offers o 
          JOIN teachers t ON o.teacher_id = t.id 
          WHERE o.status = 'upcoming' AND o.offer_date > datetime('now') AND t.status = 'approved'
          ORDER BY o.offer_date ASC`, [], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/live-offers', (req, res) => {
  db.all(`SELECT o.*, t.full_name as teacher_name, t.specialization, t.profile_image 
          FROM offers o 
          JOIN teachers t ON o.teacher_id = t.id 
          WHERE o.status = 'live' AND t.status = 'approved'
          ORDER BY o.offer_date DESC`, [], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/teacher/offers/:teacher_id', (req, res) => {
  db.all(`SELECT * FROM offers WHERE teacher_id = ? ORDER BY offer_date DESC`, [req.params.teacher_id], (err, rows) => {
    res.json(rows || []);
  });
});

app.delete('/api/offer/delete/:offer_id', (req, res) => {
  const { offer_id } = req.params;
  const { teacher_id } = req.body;
  
  db.get(`SELECT * FROM offers WHERE id = ? AND teacher_id = ?`, [offer_id, teacher_id], (err, offer) => {
    if (!offer) return res.json({ success: false, error: 'غير مصرح لك بحذف هذا العرض' });
    
    db.run(`DELETE FROM sessions WHERE offer_id = ?`, [offer_id]);
    db.run(`DELETE FROM waiting_room WHERE offer_id = ?`, [offer_id]);
    db.run(`DELETE FROM active_stream WHERE offer_id = ?`, [offer_id]);
    db.run(`DELETE FROM offers WHERE id = ?`, [offer_id], function(err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, message: 'تم حذف العرض بنجاح' });
    });
  });
});

// ============= نظام الحجز والدفع =============

app.post('/api/booking/create', (req, res) => {
  const { offer_id, student_id } = req.body;
  
  db.get(`SELECT * FROM sessions WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, existing) => {
    if (existing) return res.json({ success: false, error: 'أنت مسجل بالفعل في هذه الحصة' });
    
    db.get(`SELECT price, is_free FROM offers WHERE id = ?`, [offer_id], (err, offer) => {
      if (!offer) return res.json({ success: false, error: 'العرض غير موجود' });
      
      const payment_status = offer.is_free === 1 ? 'paid' : 'pending';
      
      db.run(`INSERT INTO sessions (offer_id, student_id, payment_status, payment_amount) VALUES (?, ?, ?, ?)`,
        [offer_id, student_id, payment_status, offer.price],
        function(err) {
          if (err) return res.json({ success: false, error: err.message });
          
          if (offer.is_free === 1) {
            db.run(`INSERT INTO waiting_room (offer_id, student_id) VALUES (?, ?)`, [offer_id, student_id]);
          }
          
          res.json({ success: true, session_id: this.lastID, is_free: offer.is_free === 1 });
        });
    });
  });
});

app.post('/api/create-chargily-payment', (req, res) => {
  const { session_id, amount, student_name, student_email } = req.body;
  
  db.run(`INSERT INTO payments (session_id, amount, status) VALUES (?, ?, 'pending')`,
    [session_id, amount],
    function(err) {
      if (err) return res.json({ success: false, error: err.message });
      
      const payment_url = `https://sandbox.chargily.dz/pay/${this.lastID}`;
      res.json({ success: true, payment_url: payment_url, payment_id: this.lastID });
    });
});

app.post('/api/payment/confirm/:payment_id', (req, res) => {
  db.get("SELECT session_id FROM payments WHERE id = ?", [req.params.payment_id], (err, payment) => {
    if (payment) {
      db.run("UPDATE payments SET status = 'completed' WHERE id = ?", [req.params.payment_id]);
      db.run("UPDATE sessions SET payment_status = 'paid' WHERE id = ?", [payment.session_id]);
      
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

// ============= نظام البث المباشر (الأستاذ يدخل أولاً ثم يضيف الطلاب) =============

// الأستاذ يدخل البث أولاً (بدون طلاب)
app.post('/api/stream/enter-teacher/:offer_id', (req, res) => {
  const { offer_id, teacher_id } = req.body;
  
  db.get(`SELECT * FROM offers WHERE id = ? AND teacher_id = ?`, [offer_id, teacher_id], (err, offer) => {
    if (!offer) return res.json({ success: false, error: 'غير مصرح لك' });
    
    // تغيير حالة العرض إلى "teacher_ready" (الأستاذ جاهز ولكن البث لم يبدأ للطلاب بعد)
    db.run(`UPDATE offers SET status = 'teacher_ready' WHERE id = ?`, [offer_id]);
    
    res.json({ success: true, room_name: offer.room_name });
  });
});

// إضافة الطلاب المنتظرين إلى البث (بعد أن يكون الأستاذ جاهزاً)
app.post('/api/stream/add-students/:offer_id', (req, res) => {
  const { offer_id, teacher_id } = req.body;
  
  db.get(`SELECT * FROM offers WHERE id = ? AND teacher_id = ?`, [offer_id, teacher_id], (err, offer) => {
    if (!offer) return res.json({ success: false, error: 'غير مصرح لك' });
    
    // تغيير حالة العرض إلى live (البث بدأ للطلاب)
    db.run(`UPDATE offers SET status = 'live' WHERE id = ?`, [offer_id]);
    
    // نقل جميع الطلاب من غرفة الانتظار إلى البث المباشر
    db.all(`SELECT student_id FROM waiting_room WHERE offer_id = ?`, [offer_id], (err, students) => {
      const studentIds = students || [];
      
      studentIds.forEach(s => {
        db.run(`INSERT INTO active_stream (offer_id, student_id) VALUES (?, ?)`, [offer_id, s.student_id]);
        db.run(`DELETE FROM waiting_room WHERE offer_id = ? AND student_id = ?`, [offer_id, s.student_id]);
      });
      
      res.json({ 
        success: true, 
        room_name: offer.room_name,
        students_count: studentIds.length 
      });
    });
  });
});

// إنهاء البث
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

// التحقق من حالة العرض
app.get('/api/stream/status/:offer_id', (req, res) => {
  db.get(`SELECT status, room_name FROM offers WHERE id = ?`, [req.params.offer_id], (err, offer) => {
    if (!offer) return res.json({ status: 'not_found' });
    res.json({ status: offer.status, room_name: offer.room_name });
  });
});

// التحقق من حالة الطالب
app.get('/api/student/stream-status/:offer_id/:student_id', (req, res) => {
  const { offer_id, student_id } = req.params;
  
  db.get(`SELECT status, room_name FROM offers WHERE id = ?`, [offer_id], (err, offer) => {
    if (!offer) return res.json({ can_join: false, error: 'العرض غير موجود' });
    
    if (offer.status === 'live') {
      db.get(`SELECT * FROM active_stream WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, active) => {
        if (active) {
          return res.json({ can_join: true, is_waiting: false, room_name: offer.room_name, stream_started: true });
        } else {
          db.get(`SELECT payment_status FROM sessions WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, session) => {
            if (session && session.payment_status === 'paid') {
              db.run(`INSERT INTO active_stream (offer_id, student_id) VALUES (?, ?)`, [offer_id, student_id]);
              return res.json({ can_join: true, is_waiting: false, room_name: offer.room_name, stream_started: true });
            }
            return res.json({ can_join: false, is_waiting: false, error: 'غير مسجل أو لم يتم الدفع' });
          });
        }
      });
    } 
    else if (offer.status === 'upcoming' || offer.status === 'teacher_ready') {
      db.get(`SELECT s.*, o.is_free, o.price 
              FROM sessions s 
              JOIN offers o ON s.offer_id = o.id 
              WHERE s.offer_id = ? AND s.student_id = ?`, [offer_id, student_id], (err, session) => {
        if (!session) return res.json({ can_join: false, error: 'غير مسجل في هذه الحصة' });
        
        if (session.is_free === 1 || session.payment_status === 'paid') {
          db.get(`SELECT * FROM waiting_room WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, waiting) => {
            if (!waiting) {
              db.run(`INSERT INTO waiting_room (offer_id, student_id) VALUES (?, ?)`, [offer_id, student_id]);
            }
            let message = offer.status === 'teacher_ready' ? 'الأستاذ جاهز، سيبدأ البث قريباً' : 'بانتظار بدء البث';
            return res.json({ can_join: false, is_waiting: true, message: message, stream_started: false, teacher_ready: offer.status === 'teacher_ready' });
          });
        } else {
          return res.json({ can_join: false, is_waiting: false, error: 'يرجى إتمام الدفع أولاً', payment_required: true });
        }
      });
    }
    else {
      return res.json({ can_join: false, error: 'انتهت الحصة' });
    }
  });
});

// ============= صفحات البث =============

// صفحة البث للأستاذ (مع صلاحيات المضيف الكاملة)
function generateTeacherStreamPage(roomName, teacherId, offerId) {
  return `
<!DOCTYPE html>
<html lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>بث مباشر - الأستاذ | منصة التعليم الجزائرية</title>
    <script src="https://meet.jit.si/external_api.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Cairo', sans-serif; background: #0a0a1a; }
        .stream-header { background: linear-gradient(135deg, #0f3460, #16213e); color: white; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; position: fixed; top: 0; left: 0; right: 0; z-index: 100; }
        .leave-btn, .end-stream-btn, .add-students-btn { background: #ef4444; color: white; border: none; padding: 8px 24px; border-radius: 30px; cursor: pointer; margin-left: 10px; }
        .add-students-btn { background: #10b981; }
        .teacher-badge { background: #10b981; padding: 5px 15px; border-radius: 30px; font-size: 14px; }
        #jitsi-container { position: fixed; top: 60px; left: 0; right: 0; bottom: 0; }
        .waiting-info { background: #f59e0b; color: white; padding: 8px 16px; border-radius: 30px; font-size: 14px; margin-right: 15px; }
    </style>
</head>
<body>
    <div class="stream-header">
        <div><i class="fas fa-chalkboard-user"></i> <span class="teacher-badge"><i class="fas fa-crown"></i> أنت المضيف</span></div>
        <div>
            <span id="waitingCount" class="waiting-info">⏳ جاري تحميل عدد المنتظرين...</span>
            <button id="addStudentsBtn" class="add-students-btn" onclick="addStudentsToStream()" style="display:none"><i class="fas fa-users"></i> إضافة الطلاب المنتظرين</button>
            <button class="end-stream-btn" onclick="endStream()"><i class="fas fa-stop"></i> إنهاء البث</button>
            <button class="leave-btn" onclick="leaveStream()"><i class="fas fa-sign-out-alt"></i> مغادرة</button>
        </div>
    </div>
    <div id="jitsi-container"></div>
    <script>
        let studentsAdded = false;
        
        const domain = 'meet.jit.si';
        const options = {
            roomName: '${roomName}',
            width: '100%',
            height: window.innerHeight - 60,
            parentNode: document.querySelector('#jitsi-container'),
            userInfo: { displayName: '👨‍🏫 الأستاذ (المضيف)' },
            configOverwrite: {
                startWithVideoMuted: false,
                startWithAudioMuted: false,
                enableWelcomePage: false,
                prejoinPageEnabled: false,
                disableDeepLinking: true,
            },
            interfaceConfigOverwrite: {
                SHOW_JITSI_WATERMARK: false,
                SHOW_WATERMARK_FOR_GUESTS: false,
                TOOLBAR_BUTTONS: ['microphone', 'camera', 'closedcaptions', 'desktop', 'fullscreen', 'hangup', 'chat', 'raisehand', 'settings', 'tileview', 'security', 'mute-everyone', 'mute-video-everyone'],
                HIDE_INVITE_MORE_HEADER: true,
            }
        };
        
        const api = new JitsiMeetExternalAPI(domain, options);
        
        // جلب عدد الطلاب المنتظرين
        async function loadWaitingCount() {
            try {
                const res = await fetch('/api/stream/waiting-list/${offerId}/${teacherId}');
                const students = await res.json();
                const count = students?.length || 0;
                document.getElementById('waitingCount').innerHTML = \`⏳ ${count} طالب في الانتظار\`;
                if (count > 0 && !studentsAdded) {
                    document.getElementById('addStudentsBtn').style.display = 'inline-block';
                } else {
                    document.getElementById('addStudentsBtn').style.display = 'none';
                }
            } catch(e) { console.log(e); }
        }
        
        // إضافة الطلاب إلى البث
        async function addStudentsToStream() {
            if (confirm('هل أنت متأكد من إضافة جميع الطلاب المنتظرين إلى البث؟')) {
                const res = await fetch('/api/stream/add-students/${offerId}', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ offer_id: ${offerId}, teacher_id: ${teacherId} })
                });
                const data = await res.json();
                if (data.success) {
                    studentsAdded = true;
                    document.getElementById('addStudentsBtn').style.display = 'none';
                    document.getElementById('waitingCount').innerHTML = \`✅ تم إضافة ${data.students_count} طالب\`;
                    alert(\`✅ تم إضافة \${data.students_count} طالب إلى البث!\`);
                } else {
                    alert('خطأ: ' + data.error);
                }
            }
        }
        
        function leaveStream() { 
            try { api.dispose(); } catch(e) {} 
            window.location.href = '/teacher-dashboard.html'; 
        }
        
        async function endStream() {
            if (confirm('إنهاء البث المباشر؟')) {
                await fetch('/api/stream/end/${offerId}', { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ offer_id: ${offerId}, teacher_id: ${teacherId} }) 
                });
                try { api.dispose(); } catch(e) {}
                window.location.href = '/teacher-dashboard.html';
            }
        }
        
        // تحميل عدد المنتظرين كل 3 ثوانٍ
        loadWaitingCount();
        setInterval(loadWaitingCount, 3000);
        
        document.head.appendChild(Object.assign(document.createElement('link'), { 
            rel: 'stylesheet', 
            href: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css' 
        }));
    </script>
</body>
</html>
  `;
}

// صفحة البث للطالب (بدون صلاحيات - مشاهد فقط)
function generateStudentStreamPage(roomName, studentId) {
  return `
<!DOCTYPE html>
<html lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>حصة مباشرة - طالب | منصة التعليم الجزائرية</title>
    <script src="https://meet.jit.si/external_api.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Cairo', sans-serif; background: #0a0a1a; }
        .stream-header { background: linear-gradient(135deg, #0f3460, #16213e); color: white; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; position: fixed; top: 0; left: 0; right: 0; z-index: 100; }
        .leave-btn { background: #ef4444; color: white; border: none; padding: 8px 24px; border-radius: 30px; cursor: pointer; margin-left: 10px; }
        .student-badge { background: #f59e0b; padding: 5px 15px; border-radius: 30px; font-size: 14px; }
        #jitsi-container { position: fixed; top: 60px; left: 0; right: 0; bottom: 0; }
    </style>
</head>
<body>
    <div class="stream-header">
        <div><i class="fas fa-user-graduate"></i> <span class="student-badge"><i class="fas fa-eye"></i> أنت طالب - صلاحية مشاهدة فقط</span></div>
        <div><button class="leave-btn" onclick="leaveStream()"><i class="fas fa-sign-out-alt"></i> مغادرة الحصة</button></div>
    </div>
    <div id="jitsi-container"></div>
    <script>
        const domain = 'meet.jit.si';
        const options = {
            roomName: '${roomName}',
            width: '100%',
            height: window.innerHeight - 60,
            parentNode: document.querySelector('#jitsi-container'),
            userInfo: { displayName: '👨‍🎓 طالب' },
            configOverwrite: {
                startWithVideoMuted: true,
                startWithAudioMuted: true,
                enableWelcomePage: false,
                prejoinPageEnabled: false,
                disableDeepLinking: true,
            },
            interfaceConfigOverwrite: {
                SHOW_JITSI_WATERMARK: false,
                SHOW_WATERMARK_FOR_GUESTS: false,
                TOOLBAR_BUTTONS: ['microphone', 'camera', 'closedcaptions', 'fullscreen', 'hangup', 'chat', 'raisehand', 'settings', 'tileview'],
                HIDE_INVITE_MORE_HEADER: true,
            }
        };
        const api = new JitsiMeetExternalAPI(domain, options);
        function leaveStream() { try { api.dispose(); } catch(e) {} window.location.href = '/student-dashboard.html'; }
        document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css' }));
    </script>
</body>
</html>
  `;
}

// مسارات البث
app.get('/api/teacher-stream/:offer_id/:teacher_id', (req, res) => {
  const { offer_id, teacher_id } = req.params;
  
  db.get(`SELECT room_name FROM offers WHERE id = ? AND teacher_id = ?`, [offer_id, teacher_id], (err, offer) => {
    if (!offer) return res.redirect('/teacher-dashboard.html');
    res.send(generateTeacherStreamPage(offer.room_name, teacher_id, offer_id));
  });
});

app.get('/api/join-stream/:offer_id/:student_id', (req, res) => {
  const { offer_id, student_id } = req.params;
  
  db.get(`SELECT room_name, status FROM offers WHERE id = ?`, [offer_id], (err, offer) => {
    if (!offer || offer.status !== 'live') return res.redirect('/student-dashboard.html?error=stream_not_started');
    
    db.get(`SELECT * FROM active_stream WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, active) => {
      if (active) {
        res.send(generateStudentStreamPage(offer.room_name, student_id));
      } else {
        res.redirect('/student-dashboard.html?error=not_authorized');
      }
    });
  });
});

// الأستاذ يدخل البث (يدخل أولاً بدون طلاب)
app.get('/api/enter-teacher-stream/:offer_id/:teacher_id', (req, res) => {
  const { offer_id, teacher_id } = req.params;
  
  db.get(`SELECT room_name FROM offers WHERE id = ? AND teacher_id = ?`, [offer_id, teacher_id], async (err, offer) => {
    if (!offer) return res.redirect('/teacher-dashboard.html');
    
    // تسجيل دخول الأستاذ إلى البث
    await fetch(`http://localhost:${PORT}/api/stream/enter-teacher/${offer_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offer_id: parseInt(offer_id), teacher_id: parseInt(teacher_id) })
    });
    
    res.send(generateTeacherStreamPage(offer.room_name, teacher_id, offer_id));
  });
});

// جلب الحجوزات
app.get('/api/student/bookings/:student_id', (req, res) => {
  db.all(`SELECT s.*, o.subject_name, o.offer_date, o.duration, o.price, o.is_free, o.status as offer_status, o.room_name, t.full_name as teacher_name, t.profile_image
          FROM sessions s
          JOIN offers o ON s.offer_id = o.id
          JOIN teachers t ON o.teacher_id = t.id
          WHERE s.student_id = ?
          ORDER BY o.offer_date DESC`, [req.params.student_id], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/stream/waiting-list/:offer_id/:teacher_id', (req, res) => {
  db.all(`SELECT w.*, s.full_name, s.email FROM waiting_room w JOIN students s ON w.student_id = s.id WHERE w.offer_id = ?`, [req.params.offer_id], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/stream/active-list/:offer_id/:teacher_id', (req, res) => {
  db.all(`SELECT a.*, s.full_name, s.email FROM active_stream a JOIN students s ON a.student_id = s.id WHERE a.offer_id = ?`, [req.params.offer_id], (err, rows) => {
    res.json(rows || []);
  });
});

app.listen(PORT, () => {
  console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
  console.log(`📁 مجلد رفع الملفات: ./uploads`);
  console.log(`📁 قاعدة البيانات: ${DB_PATH}`);
});
