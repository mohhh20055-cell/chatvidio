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

  // جدول الحصص
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER,
    student_id INTEGER,
    room_name TEXT UNIQUE,
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

// إنشاء حصة جديدة
app.post('/api/create-session', (req, res) => {
  const { teacher_id, student_id, session_date, duration, price } = req.body;
  const room_name = `class_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
  
  db.run(`INSERT INTO sessions (teacher_id, student_id, room_name, session_date, duration, price, status, payment_status)
          VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 'pending')`,
    [teacher_id, student_id, room_name, session_date, duration, price],
    function(err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, session_id: this.lastID, room_name });
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

// رابط الانضمام للحصة
app.get('/api/session/:id/join', (req, res) => {
  db.get("SELECT room_name, teacher_id, student_id, payment_status FROM sessions WHERE id = ?", [req.params.id], (err, session) => {
    if (!session) return res.json({ error: 'الحصة غير موجودة' });
    if (session.payment_status !== 'paid') return res.json({ error: 'يرجى إتمام الدفع أولاً' });
    res.json({ room_url: `https://meet.jit.si/${session.room_name}` });
  });
});

// ============= Chargily Payment API (محاكاة) =============
app.post('/api/create-chargily-payment', (req, res) => {
  const { session_id, amount, student_name, student_email, student_phone } = req.body;
  
  db.run(`INSERT INTO payments (session_id, amount, status) VALUES (?, ?, 'pending')`,
    [session_id, amount],
    function(err) {
      if (err) return res.json({ success: false, error: err.message });
      
      // رابط تجريبي لشارجيلي - استبدله برابط حقيقي عند التفعيل
      const payment_url = `https://sandbox.chargily.dz/pay/${this.lastID}`;
      res.json({
        success: true,
        payment_url: payment_url,
        payment_id: this.lastID,
        instructions: "ادفع عبر شارجيلي باستخدام بطاقة EDAHABIA أو CCP"
      });
    });
});

// تأكيد الدفع من شارجيلي
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

// تحديث حالة الدفع يدوياً (للتجربة)
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

app.listen(PORT, () => {
  console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
});