const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Chargily API Keys
const CHARGILY_API_KEY = 'test_sk_2vm1gIkToN70ERrg4SUE1j65gkZcexbPFjHzLUT7';
const CHARGILY_API_URL = 'https://pay.chargily.net/test/api/v2';

// إعداد رفع الملفات
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let dir = './uploads';
    if (file.fieldname === 'post_image') dir = './uploads/posts';
    if (file.fieldname === 'post_file') dir = './uploads/files';
    if (file.fieldname === 'profile_image') dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ============= قاعدة بيانات =============
const DB_PATH = path.join(__dirname, 'platform.db');
const db = new sqlite3.Database(DB_PATH);

function initDatabase() {
  db.serialize(() => {
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
      facebook_url TEXT,
      instagram_url TEXT,
      linkedin_url TEXT,
      website_url TEXT,
      status TEXT DEFAULT 'pending',
      rejection_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      phone TEXT,
      profile_image TEXT,
      balance INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

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

    db.run(`CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER,
      title TEXT NOT NULL,
      content TEXT,
      image_url TEXT,
      file_url TEXT,
      link_url TEXT,
      likes INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(teacher_id) REFERENCES teachers(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS post_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER,
      student_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(post_id) REFERENCES posts(id),
      FOREIGN KEY(student_id) REFERENCES students(id),
      UNIQUE(post_id, student_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS post_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER,
      student_id INTEGER,
      comment TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(post_id) REFERENCES posts(id),
      FOREIGN KEY(student_id) REFERENCES students(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER,
      student_id INTEGER,
      payment_status TEXT DEFAULT 'pending',
      payment_amount INTEGER DEFAULT 0,
      chargily_checkout_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(offer_id) REFERENCES offers(id),
      FOREIGN KEY(student_id) REFERENCES students(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS waiting_room (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER,
      student_id INTEGER,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(offer_id) REFERENCES offers(id),
      FOREIGN KEY(student_id) REFERENCES students(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS active_stream (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER,
      student_id INTEGER,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(offer_id) REFERENCES offers(id),
      FOREIGN KEY(student_id) REFERENCES students(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      amount INTEGER,
      checkout_url TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    )`);

    db.get("SELECT * FROM teachers WHERE email = 'admin@platform.com'", [], (err, row) => {
      if (!row && !err) {
        const hashedPassword = bcrypt.hashSync('admin123', 10);
        db.run("INSERT INTO teachers (full_name, email, password, phone, status) VALUES (?, ?, ?, ?, 'approved')",
          ['مدير المنصة', 'admin@platform.com', hashedPassword, '00000000']);
        console.log('✅ تم إنشاء حساب admin بنجاح');
      }
    });
  });
}

initDatabase();

// ============= دوال Chargily =============
async function createChargilyCheckout(amount, studentName, studentEmail, studentPhone, offerName, successUrl, failureUrl) {
  try {
    const checkoutData = {
      amount: amount,
      currency: 'dzd',
      success_url: successUrl,
      failure_url: failureUrl,
      locale: 'ar',
      description: offerName,
      metadata: { student_name: studentName, student_email: studentEmail, offer_name: offerName }
    };

    const response = await axios.post(`${CHARGILY_API_URL}/checkouts`, checkoutData, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CHARGILY_API_KEY}` },
      timeout: 30000
    });

    if (response.data && response.data.checkout_url) {
      return { success: true, checkout_url: response.data.checkout_url, checkout_id: response.data.id };
    } else {
      throw new Error('لم يتم استلام رابط الدفع');
    }
  } catch (error) {
    console.error('❌ خطأ Chargily:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.message || error.message };
  }
}

// ============= API Routes =============

// تسجيل أستاذ جديد
app.post('/api/teacher/register', upload.fields([
  { name: 'profile_image', maxCount: 1 },
  { name: 'diploma_image', maxCount: 1 },
  { name: 'id_image', maxCount: 1 }
]), async (req, res) => {
  try {
    const { full_name, email, password, phone, specialization, bio, experience } = req.body;
    if (!full_name || !email || !password || !phone || !specialization || !bio || !experience) {
      return res.json({ success: false, error: 'يرجى ملء جميع الحقول المطلوبة' });
    }
    if (!req.files || !req.files['profile_image'] || !req.files['diploma_image'] || !req.files['id_image']) {
      return res.json({ success: false, error: 'يرجى رفع جميع الصور المطلوبة' });
    }
    const hashedPassword = bcrypt.hashSync(password, 10);
    const profile_image = req.files['profile_image'][0].filename;
    const diploma_image = req.files['diploma_image'][0].filename;
    const id_image = req.files['id_image'][0].filename;

    db.run(`INSERT INTO teachers (full_name, email, password, phone, specialization, bio, experience, profile_image, diploma_image, id_image, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [full_name, email, hashedPassword, phone, specialization, bio, experience, profile_image, diploma_image, id_image],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) return res.json({ success: false, error: 'البريد الإلكتروني مستخدم مسبقاً' });
          return res.json({ success: false, error: 'حدث خطأ: ' + err.message });
        }
        res.json({ success: true, message: 'تم إرسال طلبك، سيتم مراجعته من قبل الإدارة' });
      });
  } catch(error) {
    res.json({ success: false, error: 'خطأ في الخادم: ' + error.message });
  }
});

// تحديث بيانات الأستاذ
app.post('/api/teacher/update-profile', upload.single('profile_image'), async (req, res) => {
  const { teacher_id, full_name, bio, specialization, experience, phone, facebook_url, instagram_url, linkedin_url, website_url } = req.body;
  let profile_image = req.body.profile_image;
  
  if (req.file) {
    profile_image = req.file.filename;
  }
  
  db.run(`UPDATE teachers SET full_name = ?, bio = ?, specialization = ?, experience = ?, phone = ?, facebook_url = ?, instagram_url = ?, linkedin_url = ?, website_url = ?, profile_image = COALESCE(?, profile_image) WHERE id = ?`,
    [full_name, bio, specialization, experience, phone, facebook_url, instagram_url, linkedin_url, website_url, profile_image, teacher_id],
    function(err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, message: 'تم تحديث الملف الشخصي بنجاح' });
    });
});

// تسجيل طالب
app.post('/api/student/register', async (req, res) => {
  try {
    const { full_name, email, password, phone } = req.body;
    if (!full_name || !email || !password || !phone) {
      return res.json({ success: false, error: 'يرجى ملء جميع الحقول' });
    }
    const hashedPassword = bcrypt.hashSync(password, 10);
    db.run(`INSERT INTO students (full_name, email, password, phone, balance) VALUES (?, ?, ?, ?, 0)`,
      [full_name, email, hashedPassword, phone],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) return res.json({ success: false, error: 'البريد الإلكتروني مستخدم' });
          return res.json({ success: false, error: 'حدث خطأ: ' + err.message });
        }
        res.json({ success: true, message: 'تم التسجيل بنجاح' });
      });
  } catch(error) {
    res.json({ success: false, error: 'خطأ في الخادم' });
  }
});

// تسجيل الدخول
app.post('/api/login', (req, res) => {
  try {
    const { email, password, role } = req.body;
    const table = role === 'teacher' ? 'teachers' : 'students';
    db.get(`SELECT * FROM ${table} WHERE email = ?`, [email], (err, user) => {
      if (err || !user) return res.json({ success: false, error: 'البريد الإلكتروني غير موجود' });
      const validPassword = bcrypt.compareSync(password, user.password);
      if (!validPassword) return res.json({ success: false, error: 'كلمة المرور خاطئة' });
      if (role === 'teacher' && user.status !== 'approved' && user.email !== 'admin@platform.com') {
        return res.json({ success: false, error: 'حسابك قيد المراجعة من قبل الإدارة' });
      }
      const token = jwt.sign({ id: user.id, email: user.email, role, name: user.full_name }, 'secret_key', { expiresIn: '7d' });
      res.json({ success: true, token, user: { id: user.id, name: user.full_name, email: user.email, role, status: user.status, profile_image: user.profile_image } });
    });
  } catch(error) {
    res.json({ success: false, error: 'خطأ في الخادم' });
  }
});

// ADMIN Routes
app.get('/api/admin/pending-teachers', (req, res) => {
  db.all("SELECT id, full_name, email, phone, specialization, bio, experience, profile_image, diploma_image, id_image, created_at FROM teachers WHERE status = 'pending'", [], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/admin/approved-teachers', (req, res) => {
  db.all("SELECT id, full_name, email, phone, specialization, bio, experience, profile_image, facebook_url, instagram_url, linkedin_url, website_url, created_at FROM teachers WHERE status = 'approved'", [], (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/admin/approve-teacher/:id', (req, res) => {
  db.run("UPDATE teachers SET status = 'approved' WHERE id = ?", [req.params.id], function(err) {
    res.json({ success: true });
  });
});

app.post('/api/admin/reject-teacher/:id', (req, res) => {
  const { reason } = req.body;
  db.run("UPDATE teachers SET status = 'rejected', rejection_reason = ? WHERE id = ?", [reason, req.params.id], function(err) {
    res.json({ success: true });
  });
});

app.delete('/api/admin/delete-teacher/:id', (req, res) => {
  db.run(`DELETE FROM posts WHERE teacher_id = ?`, [req.params.id]);
  db.run(`DELETE FROM offers WHERE teacher_id = ?`, [req.params.id]);
  db.run(`DELETE FROM teachers WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true, message: 'تم حذف الأستاذ بنجاح' });
  });
});

// ============= الصفحات العامة =============
app.get('/api/public/teachers', (req, res) => {
  db.all(`SELECT id, full_name, specialization, bio, experience, profile_image, facebook_url, instagram_url, linkedin_url, website_url FROM teachers WHERE status = 'approved' ORDER BY created_at DESC`, [], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/teacher/:teacher_id', (req, res) => {
  db.get(`SELECT id, full_name, email, phone, specialization, bio, experience, profile_image, facebook_url, instagram_url, linkedin_url, website_url, created_at FROM teachers WHERE id = ? AND status = 'approved'`, [req.params.teacher_id], (err, teacher) => {
    if (!teacher) return res.json({ error: 'الأستاذ غير موجود' });
    res.json(teacher);
  });
});

app.get('/api/public/offers', (req, res) => {
  db.all(`SELECT o.*, t.full_name as teacher_name, t.specialization, t.profile_image, t.id as teacher_id
          FROM offers o JOIN teachers t ON o.teacher_id = t.id 
          WHERE o.status = 'upcoming' AND o.offer_date > datetime('now') AND t.status = 'approved'
          ORDER BY o.offer_date ASC`, [], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/live-offers', (req, res) => {
  db.all(`SELECT o.*, t.full_name as teacher_name, t.specialization, t.profile_image, t.id as teacher_id
          FROM offers o JOIN teachers t ON o.teacher_id = t.id 
          WHERE o.status = 'live' AND t.status = 'approved'
          ORDER BY o.offer_date DESC`, [], (err, rows) => {
    res.json(rows || []);
  });
});

// ============= نظام المنشورات =============
app.post('/api/post/create', upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'file', maxCount: 1 }
]), async (req, res) => {
  const { teacher_id, title, content, link_url } = req.body;
  let image_url = null, file_url = null;
  if (req.files['image']) image_url = `/uploads/posts/${req.files['image'][0].filename}`;
  if (req.files['file']) file_url = `/uploads/files/${req.files['file'][0].filename}`;
  
  db.run(`INSERT INTO posts (teacher_id, title, content, image_url, file_url, link_url) VALUES (?, ?, ?, ?, ?, ?)`,
    [teacher_id, title, content, image_url, file_url, link_url],
    function(err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, post_id: this.lastID });
    });
});

app.get('/api/posts/:teacher_id', (req, res) => {
  db.all(`SELECT p.*, 
          (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes_count,
          (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comments_count
          FROM posts p WHERE p.teacher_id = ? ORDER BY p.created_at DESC`, [req.params.teacher_id], (err, posts) => {
    res.json(posts || []);
  });
});

app.get('/api/post/:post_id', (req, res) => {
  db.get(`SELECT p.*, t.full_name as teacher_name, t.profile_image as teacher_image
          FROM posts p JOIN teachers t ON p.teacher_id = t.id WHERE p.id = ?`, [req.params.post_id], (err, post) => {
    if (!post) return res.json({ error: 'المنشور غير موجود' });
    
    db.all(`SELECT c.*, s.full_name as student_name, s.profile_image as student_image 
            FROM post_comments c JOIN students s ON c.student_id = s.id 
            WHERE c.post_id = ? ORDER BY c.created_at ASC`, [req.params.post_id], (err, comments) => {
      post.comments = comments || [];
      res.json(post);
    });
  });
});

app.post('/api/post/like', (req, res) => {
  const { post_id, student_id } = req.body;
  db.run(`INSERT OR IGNORE INTO post_likes (post_id, student_id) VALUES (?, ?)`, [post_id, student_id], function(err) {
    if (err) return res.json({ success: false, error: err.message });
    db.run(`UPDATE posts SET likes = (SELECT COUNT(*) FROM post_likes WHERE post_id = ?) WHERE id = ?`, [post_id, post_id]);
    res.json({ success: true, liked: true });
  });
});

app.post('/api/post/unlike', (req, res) => {
  const { post_id, student_id } = req.body;
  db.run(`DELETE FROM post_likes WHERE post_id = ? AND student_id = ?`, [post_id, student_id], function(err) {
    if (err) return res.json({ success: false, error: err.message });
    db.run(`UPDATE posts SET likes = (SELECT COUNT(*) FROM post_likes WHERE post_id = ?) WHERE id = ?`, [post_id, post_id]);
    res.json({ success: true, liked: false });
  });
});

app.post('/api/post/comment', (req, res) => {
  const { post_id, student_id, comment } = req.body;
  if (!comment || comment.trim() === '') return res.json({ success: false, error: 'التعليق لا يمكن أن يكون فارغاً' });
  db.run(`INSERT INTO post_comments (post_id, student_id, comment) VALUES (?, ?, ?)`, [post_id, student_id, comment], function(err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true, comment_id: this.lastID });
  });
});

app.delete('/api/post/comment/:comment_id', (req, res) => {
  const { comment_id } = req.params;
  const { teacher_id, post_id } = req.body;
  
  db.get(`SELECT teacher_id FROM posts WHERE id = ?`, [post_id], (err, post) => {
    if (!post || post.teacher_id != teacher_id) {
      return res.json({ success: false, error: 'غير مصرح لك بحذف هذا التعليق' });
    }
    db.run(`DELETE FROM post_comments WHERE id = ?`, [comment_id], function(err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true });
    });
  });
});

app.delete('/api/post/:post_id', (req, res) => {
  const { post_id } = req.params;
  const { teacher_id } = req.body;
  
  db.get(`SELECT teacher_id FROM posts WHERE id = ?`, [post_id], (err, post) => {
    if (!post || post.teacher_id != teacher_id) {
      return res.json({ success: false, error: 'غير مصرح لك بحذف هذا المنشور' });
    }
    db.run(`DELETE FROM post_likes WHERE post_id = ?`, [post_id]);
    db.run(`DELETE FROM post_comments WHERE post_id = ?`, [post_id]);
    db.run(`DELETE FROM posts WHERE id = ?`, [post_id], function(err) {
      res.json({ success: true });
    });
  });
});

app.get('/api/post/check-like/:post_id/:student_id', (req, res) => {
  db.get(`SELECT * FROM post_likes WHERE post_id = ? AND student_id = ?`, [req.params.post_id, req.params.student_id], (err, like) => {
    res.json({ liked: !!like });
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
  db.all(`SELECT o.*, t.full_name as teacher_name, t.specialization, t.profile_image, t.id as teacher_id
          FROM offers o JOIN teachers t ON o.teacher_id = t.id 
          WHERE o.status = 'upcoming' AND o.offer_date > datetime('now') AND t.status = 'approved'
          ORDER BY o.offer_date ASC`, [], (err, rows) => {
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
    if (!offer) return res.json({ success: false, error: 'غير مصرح لك' });
    db.run(`DELETE FROM sessions WHERE offer_id = ?`, [offer_id]);
    db.run(`DELETE FROM waiting_room WHERE offer_id = ?`, [offer_id]);
    db.run(`DELETE FROM active_stream WHERE offer_id = ?`, [offer_id]);
    db.run(`DELETE FROM offers WHERE id = ?`, [offer_id]);
    res.json({ success: true });
  });
});

// ============= نظام الحجز =============
app.post('/api/booking/create', async (req, res) => {
  const { offer_id, student_id } = req.body;
  db.get(`SELECT * FROM sessions WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, existing) => {
    if (existing) return res.json({ success: false, error: 'أنت مسجل بالفعل' });
    db.get(`SELECT o.* FROM offers o WHERE o.id = ?`, [offer_id], async (err, offer) => {
      if (!offer) return res.json({ success: false, error: 'العرض غير موجود' });
      db.run(`INSERT INTO sessions (offer_id, student_id, payment_status, payment_amount) VALUES (?, ?, ?, ?)`,
        [offer_id, student_id, offer.is_free === 1 ? 'paid' : 'pending', offer.price],
        function(err) {
          if (err) return res.json({ success: false, error: err.message });
          const sessionId = this.lastID;
          if (offer.is_free === 1) {
            db.run(`INSERT INTO waiting_room (offer_id, student_id) VALUES (?, ?)`, [offer_id, student_id]);
            return res.json({ success: true, session_id: sessionId, is_free: true });
          }
          db.get(`SELECT full_name, email, phone FROM students WHERE id = ?`, [student_id], async (err, student) => {
            const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://chatvidio-api.onrender.com`;
            const checkout = await createChargilyCheckout(offer.price, student.full_name, student.email, student.phone, offer.subject_name, `${baseUrl}/api/payment/success/${sessionId}`, `${baseUrl}/student-dashboard.html`);
            if (checkout.success) {
              db.run(`UPDATE sessions SET chargily_checkout_url = ? WHERE id = ?`, [checkout.checkout_url, sessionId]);
              res.json({ success: true, session_id: sessionId, checkout_url: checkout.checkout_url, amount: offer.price });
            } else {
              db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
              res.json({ success: false, error: 'فشل الاتصال ببوابة الدفع' });
            }
          });
        });
    });
  });
});

app.get('/api/payment/success/:session_id', (req, res) => {
  const { session_id } = req.params;
  db.run(`UPDATE sessions SET payment_status = 'paid' WHERE id = ?`, [session_id]);
  db.get(`SELECT offer_id, student_id FROM sessions WHERE id = ?`, [session_id], (err, session) => {
    if (session) db.run(`INSERT OR IGNORE INTO waiting_room (offer_id, student_id) VALUES (?, ?)`, [session.offer_id, session.student_id]);
  });
  res.send(`<!DOCTYPE html><html><head><title>تم الدفع بنجاح</title><style>body{font-family:'Cairo',sans-serif;background:linear-gradient(135deg,#1e3c72,#0f5cbf);display:flex;justify-content:center;align-items:center;height:100vh}.card{background:white;padding:40px;border-radius:30px;text-align:center}.btn{background:#10b981;color:white;padding:12px 30px;border-radius:30px;text-decoration:none}</style></head><body><div class='card'><h1>✅ تم الدفع بنجاح!</h1><p>شكراً لك! تم إضافتك إلى قائمة الانتظار.</p><a href='/student-dashboard.html' class='btn'>العودة</a></div></body></html>`);
});

app.get('/api/student/bookings/:student_id', (req, res) => {
  db.all(`SELECT s.*, o.subject_name, o.offer_date, o.duration, o.price, o.is_free, o.status as offer_status, t.full_name as teacher_name, t.profile_image as teacher_image, t.id as teacher_id
          FROM sessions s JOIN offers o ON s.offer_id = o.id JOIN teachers t ON o.teacher_id = t.id
          WHERE s.student_id = ? ORDER BY o.offer_date DESC`, [req.params.student_id], (err, rows) => {
    res.json(rows || []);
  });
});

// ============= نظام البث المباشر =============
app.post('/api/stream/enter-teacher/:offer_id', (req, res) => {
  const { offer_id, teacher_id } = req.body;
  db.get(`SELECT * FROM offers WHERE id = ? AND teacher_id = ?`, [offer_id, teacher_id], (err, offer) => {
    if (!offer) return res.json({ success: false });
    db.run(`UPDATE offers SET status = 'teacher_ready' WHERE id = ?`, [offer_id]);
    res.json({ success: true, room_name: offer.room_name });
  });
});

app.post('/api/stream/add-students/:offer_id', (req, res) => {
  const { offer_id, teacher_id } = req.body;
  db.get(`SELECT * FROM offers WHERE id = ? AND teacher_id = ?`, [offer_id, teacher_id], (err, offer) => {
    if (!offer) return res.json({ success: false });
    db.run(`UPDATE offers SET status = 'live' WHERE id = ?`, [offer_id]);
    db.all(`SELECT student_id FROM waiting_room WHERE offer_id = ?`, [offer_id], (err, students) => {
      (students || []).forEach(s => {
        db.run(`INSERT INTO active_stream (offer_id, student_id) VALUES (?, ?)`, [offer_id, s.student_id]);
        db.run(`DELETE FROM waiting_room WHERE offer_id = ? AND student_id = ?`, [offer_id, s.student_id]);
      });
      res.json({ success: true, students_count: (students || []).length });
    });
  });
});

app.post('/api/stream/end/:offer_id', (req, res) => {
  db.run(`UPDATE offers SET status = 'completed' WHERE id = ?`, [req.params.offer_id]);
  db.run(`DELETE FROM active_stream WHERE offer_id = ?`, [req.params.offer_id]);
  db.run(`DELETE FROM waiting_room WHERE offer_id = ?`, [req.params.offer_id]);
  res.json({ success: true });
});

app.get('/api/stream/status/:offer_id', (req, res) => {
  db.get(`SELECT status, room_name FROM offers WHERE id = ?`, [req.params.offer_id], (err, offer) => {
    res.json({ status: offer?.status || 'not_found', room_name: offer?.room_name });
  });
});

app.get('/api/student/stream-status/:offer_id/:student_id', (req, res) => {
  db.get(`SELECT status FROM offers WHERE id = ?`, [req.params.offer_id], (err, offer) => {
    if (!offer) return res.json({ can_join: false });
    if (offer.status === 'live') {
      db.get(`SELECT * FROM active_stream WHERE offer_id = ? AND student_id = ?`, [req.params.offer_id, req.params.student_id], (err, active) => {
        res.json({ can_join: !!active, room_name: offer.room_name });
      });
    } else if (offer.status === 'upcoming' || offer.status === 'teacher_ready') {
      db.get(`SELECT payment_status FROM sessions WHERE offer_id = ? AND student_id = ?`, [req.params.offer_id, req.params.student_id], (err, session) => {
        if (session?.payment_status === 'paid') {
          db.run(`INSERT OR IGNORE INTO waiting_room (offer_id, student_id) VALUES (?, ?)`, [req.params.offer_id, req.params.student_id]);
          res.json({ can_join: false, is_waiting: true });
        } else {
          res.json({ can_join: false, payment_required: true });
        }
      });
    } else {
      res.json({ can_join: false });
    }
  });
});

app.get('/api/stream/waiting-list/:offer_id/:teacher_id', (req, res) => {
  db.all(`SELECT w.*, s.full_name, s.email FROM waiting_room w JOIN students s ON w.student_id = s.id WHERE w.offer_id = ?`, [req.params.offer_id], (err, rows) => {
    res.json(rows || []);
  });
});

// ============= صفحات البث =============
app.get('/api/teacher-stream/:offer_id/:teacher_id', (req, res) => {
  db.get(`SELECT room_name FROM offers WHERE id = ? AND teacher_id = ?`, [req.params.offer_id, req.params.teacher_id], (err, offer) => {
    if (!offer) return res.redirect('/teacher-dashboard.html');
    res.send(`
<!DOCTYPE html>
<html lang="ar">
<head><meta charset="UTF-8"><title>بث مباشر - الأستاذ</title><script src="https://meet.jit.si/external_api.js"></script>
<style>*{margin:0;padding:0}body{font-family:'Cairo',sans-serif;background:#0a0a1a}.header{background:#0f3460;color:white;padding:12px 24px;display:flex;justify-content:space-between;position:fixed;top:0;left:0;right:0;z-index:100}.btn{background:#ef4444;color:white;border:none;padding:8px 20px;border-radius:30px;cursor:pointer;margin-left:10px}.btn-green{background:#10b981}#jitsi-container{position:fixed;top:60px;left:0;right:0;bottom:0}.info{background:#f59e0b;padding:8px 16px;border-radius:30px}</style>
</head>
<body>
<div class="header"><div><span class="info">👨‍🏫 أنت المضيف</span></div><div><span id="waitingCount" class="info">⏳ جاري التحميل...</span><button id="addBtn" class="btn btn-green" style="display:none" onclick="addStudents()">➕ إضافة الطلاب</button><button class="btn" onclick="endStream()">⏹️ إنهاء البث</button><button class="btn" onclick="leaveStream()">🚪 مغادرة</button></div></div>
<div id="jitsi-container"></div>
<script>
let studentsAdded=false;const api=new JitsiMeetExternalAPI('meet.jit.si',{roomName:'${offer.room_name}',width:'100%',height:window.innerHeight-60,parentNode:document.querySelector('#jitsi-container'),userInfo:{displayName:'👨‍🏫 الأستاذ'}});
async function loadWaitingCount(){try{const res=await fetch('/api/stream/waiting-list/${req.params.offer_id}/${req.params.teacher_id}');const students=await res.json();const count=students?.length||0;document.getElementById('waitingCount').innerHTML=\`⏳ \${count} طالب ينتظرون\`;if(count>0&&!studentsAdded)document.getElementById('addBtn').style.display='inline-block';}catch(e){}}
async function addStudents(){if(confirm('إضافة الطلاب إلى البث؟')){const res=await fetch('/api/stream/add-students/${req.params.offer_id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offer_id:${req.params.offer_id},teacher_id:${req.params.teacher_id}})});const data=await res.json();if(data.success){studentsAdded=true;document.getElementById('addBtn').style.display='none';alert(\`✅ تم إضافة \${data.students_count} طالب\`);}}}
function leaveStream(){api.dispose();window.location.href='/teacher-dashboard.html';}
async function endStream(){if(confirm('إنهاء البث؟')){await fetch('/api/stream/end/${req.params.offer_id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offer_id:${req.params.offer_id},teacher_id:${req.params.teacher_id}})});api.dispose();window.location.href='/teacher-dashboard.html';}}
loadWaitingCount();setInterval(loadWaitingCount,3000);
</script>
</body></html>`);
  });
});

app.get('/api/enter-teacher-stream/:offer_id/:teacher_id', async (req, res) => {
  await axios.post(`http://localhost:${PORT}/api/stream/enter-teacher/${req.params.offer_id}`, { offer_id: parseInt(req.params.offer_id), teacher_id: parseInt(req.params.teacher_id) }).catch(e=>console.log(e));
  res.redirect(`/api/teacher-stream/${req.params.offer_id}/${req.params.teacher_id}`);
});

app.get('/api/join-stream/:offer_id/:student_id', (req, res) => {
  db.get(`SELECT room_name FROM offers WHERE id = ? AND status = 'live'`, [req.params.offer_id], (err, offer) => {
    if (!offer) return res.redirect('/student-dashboard.html');
    db.get(`SELECT * FROM active_stream WHERE offer_id = ? AND student_id = ?`, [req.params.offer_id, req.params.student_id], (err, active) => {
      if (!active) return res.redirect('/student-dashboard.html');
      res.send(`<!DOCTYPE html><html><head><title>حصة مباشرة</title><script src="https://meet.jit.si/external_api.js"></script><style>*{margin:0;padding:0}body{font-family:'Cairo',sans-serif;background:#0a0a1a}.header{background:#0f3460;color:white;padding:12px 24px;display:flex;justify-content:space-between;position:fixed;top:0;left:0;right:0;z-index:100}.btn{background:#ef4444;color:white;border:none;padding:8px 20px;border-radius:30px;cursor:pointer}#jitsi-container{position:fixed;top:60px;left:0;right:0;bottom:0}.badge{background:#f59e0b;padding:5px 15px;border-radius:30px}</style></head><body><div class="header"><div><span class="badge">👨‍🎓 أنت طالب - مشاهدة فقط</span></div><button class="btn" onclick="leaveStream()">🚪 مغادرة</button></div><div id="jitsi-container"></div><script>const api=new JitsiMeetExternalAPI('meet.jit.si',{roomName:'${offer.room_name}',width:'100%',height:window.innerHeight-60,parentNode:document.querySelector('#jitsi-container'),userInfo:{displayName:'👨‍🎓 طالب'},configOverwrite:{startWithVideoMuted:true,startWithAudioMuted:true}});function leaveStream(){api.dispose();window.location.href='/student-dashboard.html';}</script></body></html>`);
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
});
