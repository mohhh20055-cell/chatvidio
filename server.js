const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============= مفاتيح Chargily API (وضع التجربة) =============
const CHARGILY_API_KEY = 'test_sk_2vm1gIkToN70ERrg4SUE1j65gkZcexbPFjHzLUT7';
const CHARGILY_PUBLIC_KEY = 'test_pk_GPW4qFJrOq2qoYaz2BXNfVEJUC2ScvpwQ5jgVYf2';
const CHARGILY_API_URL = 'https://api.preprod.chargily.com.dz';

// إعداد رفع الملفات
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

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

// ============= دالة إنشاء Checkout في Chargily مباشرة =============
async function createChargilyCheckout(amount, studentName, studentEmail, studentPhone, offerName, successUrl, failureUrl) {
  try {
    console.log(`💰 إنشاء دفع للمبلغ: ${amount} DZD`);
    console.log(`👤 الطالب: ${studentName} - ${studentEmail}`);
    
    // استخدام API المباشر لـ Chargily لإنشاء Checkout
    const axios = require('axios');
    
    const checkoutData = {
      amount: amount,
      currency: 'dzd',
      success_url: successUrl,
      failure_url: failureUrl,
      metadata: {
        student_name: studentName,
        student_email: studentEmail,
        offer_name: offerName
      }
    };
    
    console.log(`📤 إرسال طلب إلى Chargily...`);
    
    const response = await axios.post(`${CHARGILY_API_URL}/api/checkouts`, checkoutData, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CHARGILY_API_KEY}`
      },
      timeout: 30000
    });
    
    console.log(`✅ استجابة Chargily:`, response.status);
    
    if (response.data && response.data.checkout_url) {
      return {
        success: true,
        checkout_url: response.data.checkout_url,
        checkout_id: response.data.id
      };
    } else {
      throw new Error('لم يتم استلام رابط الدفع');
    }
  } catch (error) {
    console.error('❌ خطأ Chargily:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message
    };
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

// تسجيل طالب
app.post('/api/student/register', async (req, res) => {
  try {
    const { full_name, email, password, phone } = req.body;
    if (!full_name || !email || !password || !phone) {
      return res.json({ success: false, error: 'يرجى ملء جميع الحقول' });
    }
    const hashedPassword = bcrypt.hashSync(password, 10);
    
    db.run(`INSERT INTO students (full_name, email, password, phone, balance)
            VALUES (?, ?, ?, ?, 0)`,
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
      res.json({ success: true, token, user: { id: user.id, name: user.full_name, email: user.email, role, status: user.status } });
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
  db.all("SELECT id, full_name, email, phone, specialization, bio, experience, profile_image, created_at FROM teachers WHERE status = 'approved'", [], (err, rows) => {
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

// ============= العروض العامة =============

app.get('/api/public/teachers', (req, res) => {
  db.all(`SELECT id, full_name, specialization, bio, experience, profile_image FROM teachers WHERE status = 'approved' ORDER BY created_at DESC`, [], (err, rows) => {
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
    if (!offer) return res.json({ success: false, error: 'غير مصرح لك' });
    
    db.run(`DELETE FROM sessions WHERE offer_id = ?`, [offer_id]);
    db.run(`DELETE FROM waiting_room WHERE offer_id = ?`, [offer_id]);
    db.run(`DELETE FROM active_stream WHERE offer_id = ?`, [offer_id]);
    db.run(`DELETE FROM offers WHERE id = ?`, [offer_id], function(err) {
      res.json({ success: true });
    });
  });
});

// ============= نظام الحجز والدفع =============

app.post('/api/booking/create', async (req, res) => {
  const { offer_id, student_id } = req.body;
  
  db.get(`SELECT * FROM sessions WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, existing) => {
    if (existing) {
      return res.json({ success: false, error: 'أنت مسجل بالفعل في هذه الحصة' });
    }
    
    db.get(`SELECT o.*, t.full_name as teacher_name FROM offers o JOIN teachers t ON o.teacher_id = t.id WHERE o.id = ?`, [offer_id], async (err, offer) => {
      if (!offer) return res.json({ success: false, error: 'العرض غير موجود' });
      
      const payment_status = offer.is_free === 1 ? 'paid' : 'pending';
      
      db.run(`INSERT INTO sessions (offer_id, student_id, payment_status, payment_amount) VALUES (?, ?, ?, ?)`,
        [offer_id, student_id, payment_status, offer.price],
        async function(err) {
          if (err) return res.json({ success: false, error: err.message });
          
          if (offer.is_free === 1) {
            db.run(`INSERT INTO waiting_room (offer_id, student_id) VALUES (?, ?)`, [offer_id, student_id]);
            return res.json({ success: true, session_id: this.lastID, is_free: true });
          } else {
            db.get(`SELECT full_name, email, phone FROM students WHERE id = ?`, [student_id], async (err, student) => {
              if (err || !student) {
                return res.json({ success: false, error: 'بيانات الطالب غير مكتملة' });
              }
              
              const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://chatvidio-api.onrender.com`;
              const successUrl = `${baseUrl}/api/payment/success/${this.lastID}`;
              const failureUrl = `${baseUrl}/student-dashboard.html?payment_failed=true`;
              
              console.log(`🌐 رابط النجاح: ${successUrl}`);
              
              const checkout = await createChargilyCheckout(
                offer.price,
                student.full_name,
                student.email,
                student.phone,
                offer.subject_name,
                successUrl,
                failureUrl
              );
              
              if (checkout.success && checkout.checkout_url) {
                db.run(`UPDATE sessions SET chargily_checkout_url = ? WHERE id = ?`, [checkout.checkout_url, this.lastID]);
                db.run(`INSERT INTO payments (session_id, amount, checkout_url, status) VALUES (?, ?, ?, 'pending')`,
                  [this.lastID, offer.price, checkout.checkout_url]);
                
                console.log(`✅ رابط الدفع: ${checkout.checkout_url}`);
                
                res.json({ 
                  success: true, 
                  session_id: this.lastID,
                  checkout_url: checkout.checkout_url,
                  amount: offer.price
                });
              } else {
                console.error(`❌ فشل إنشاء الدفع: ${checkout.error}`);
                res.json({ 
                  success: false, 
                  error: 'فشل الاتصال ببوابة الدفع. يرجى المحاولة مرة أخرى.'
                });
              }
            });
          }
        });
    });
  });
});

// صفحة نجاح الدفع
app.get('/api/payment/success/:session_id', (req, res) => {
  const { session_id } = req.params;
  
  console.log(`✅ دفع ناجح للحصة: ${session_id}`);
  
  db.run(`UPDATE sessions SET payment_status = 'paid' WHERE id = ?`, [session_id]);
  db.run(`UPDATE payments SET status = 'completed' WHERE session_id = ?`, [session_id]);
  
  db.get(`SELECT offer_id, student_id FROM sessions WHERE id = ?`, [session_id], (err, session) => {
    if (session) {
      db.run(`INSERT OR IGNORE INTO waiting_room (offer_id, student_id) VALUES (?, ?)`, [session.offer_id, session.student_id]);
      console.log(`✅ تمت إضافة الطالب ${session.student_id} إلى غرفة الانتظار`);
    }
  });
  
  res.send(`
    <!DOCTYPE html>
    <html lang="ar">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>تم الدفع بنجاح</title>
        <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
        <style>
            body { font-family: 'Cairo', sans-serif; background: linear-gradient(135deg, #1e3c72, #0f5cbf); min-height: 100vh; display: flex; justify-content: center; align-items: center; }
            .card { background: white; padding: 40px; border-radius: 30px; text-align: center; max-width: 500px; margin: 20px; }
            .btn { background: #10b981; color: white; padding: 12px 30px; border-radius: 30px; text-decoration: none; display: inline-block; margin-top: 20px; }
            h1 { color: #10b981; margin-bottom: 20px; }
        </style>
    </head>
    <body>
        <div class="card">
            <h1>✅ تم الدفع بنجاح!</h1>
            <p>شكراً لك على الثقة. تم تأكيد حجزك وسيتم إضافتك إلى غرفة الانتظار.</p>
            <a href="/student-dashboard.html" class="btn">العودة إلى لوحة التحكم</a>
        </div>
    </body>
    </html>
  `);
});

// ============= نظام البث المباشر =============

app.post('/api/stream/enter-teacher/:offer_id', (req, res) => {
  const { offer_id, teacher_id } = req.body;
  
  db.get(`SELECT * FROM offers WHERE id = ? AND teacher_id = ?`, [offer_id, teacher_id], (err, offer) => {
    if (!offer) return res.json({ success: false, error: 'غير مصرح لك' });
    db.run(`UPDATE offers SET status = 'teacher_ready' WHERE id = ?`, [offer_id]);
    res.json({ success: true, room_name: offer.room_name });
  });
});

app.post('/api/stream/add-students/:offer_id', (req, res) => {
  const { offer_id, teacher_id } = req.body;
  
  db.get(`SELECT * FROM offers WHERE id = ? AND teacher_id = ?`, [offer_id, teacher_id], (err, offer) => {
    if (!offer) return res.json({ success: false, error: 'غير مصرح لك' });
    
    db.run(`UPDATE offers SET status = 'live' WHERE id = ?`, [offer_id]);
    
    db.all(`SELECT student_id FROM waiting_room WHERE offer_id = ?`, [offer_id], (err, students) => {
      const studentIds = students || [];
      studentIds.forEach(s => {
        db.run(`INSERT INTO active_stream (offer_id, student_id) VALUES (?, ?)`, [offer_id, s.student_id]);
        db.run(`DELETE FROM waiting_room WHERE offer_id = ? AND student_id = ?`, [offer_id, s.student_id]);
      });
      res.json({ success: true, students_count: studentIds.length });
    });
  });
});

app.post('/api/stream/end/:offer_id', (req, res) => {
  const { offer_id, teacher_id } = req.body;
  db.run(`UPDATE offers SET status = 'completed' WHERE id = ?`, [offer_id]);
  db.run(`DELETE FROM active_stream WHERE offer_id = ?`, [offer_id]);
  db.run(`DELETE FROM waiting_room WHERE offer_id = ?`, [offer_id]);
  res.json({ success: true });
});

app.get('/api/stream/status/:offer_id', (req, res) => {
  db.get(`SELECT status, room_name FROM offers WHERE id = ?`, [req.params.offer_id], (err, offer) => {
    if (!offer) return res.json({ status: 'not_found' });
    res.json({ status: offer.status, room_name: offer.room_name });
  });
});

app.get('/api/student/stream-status/:offer_id/:student_id', (req, res) => {
  const { offer_id, student_id } = req.params;
  
  db.get(`SELECT status, room_name FROM offers WHERE id = ?`, [offer_id], (err, offer) => {
    if (!offer) return res.json({ can_join: false, error: 'العرض غير موجود' });
    
    if (offer.status === 'live') {
      db.get(`SELECT * FROM active_stream WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, active) => {
        if (active) {
          return res.json({ can_join: true, room_name: offer.room_name });
        }
        return res.json({ can_join: false, error: 'غير مصرح لك' });
      });
    } else if (offer.status === 'upcoming' || offer.status === 'teacher_ready') {
      db.get(`SELECT * FROM sessions WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, session) => {
        if (!session) return res.json({ can_join: false, error: 'غير مسجل' });
        
        if (session.payment_status === 'paid') {
          db.get(`SELECT * FROM waiting_room WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, waiting) => {
            if (!waiting) {
              db.run(`INSERT INTO waiting_room (offer_id, student_id) VALUES (?, ?)`, [offer_id, student_id]);
            }
            return res.json({ can_join: false, is_waiting: true, teacher_ready: offer.status === 'teacher_ready' });
          });
        } else {
          return res.json({ can_join: false, payment_required: true, session_id: session.id, amount: session.payment_amount });
        }
      });
    } else {
      return res.json({ can_join: false, error: 'انتهت الحصة' });
    }
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

app.get('/api/student/bookings/:student_id', (req, res) => {
  db.all(`SELECT s.*, o.subject_name, o.offer_date, o.duration, o.price, o.is_free, o.status as offer_status, t.full_name as teacher_name
          FROM sessions s
          JOIN offers o ON s.offer_id = o.id
          JOIN teachers t ON o.teacher_id = t.id
          WHERE s.student_id = ?
          ORDER BY o.offer_date DESC`, [req.params.student_id], (err, rows) => {
    res.json(rows || []);
  });
});

// ============= صفحات البث =============

app.get('/api/teacher-stream/:offer_id/:teacher_id', (req, res) => {
  const { offer_id, teacher_id } = req.params;
  
  db.get(`SELECT room_name, status FROM offers WHERE id = ? AND teacher_id = ?`, [offer_id, teacher_id], (err, offer) => {
    if (!offer) return res.redirect('/teacher-dashboard.html');
    
    res.send(`
<!DOCTYPE html>
<html lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>بث مباشر - الأستاذ</title>
    <script src="https://meet.jit.si/external_api.js"></script>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Cairo',sans-serif;background:#0a0a1a}
        .header{background:#0f3460;color:white;padding:12px 24px;display:flex;justify-content:space-between;align-items:center;position:fixed;top:0;left:0;right:0;z-index:100;flex-wrap:wrap}
        .btn{background:#ef4444;color:white;border:none;padding:8px 20px;border-radius:30px;cursor:pointer;margin-left:10px}
        .btn-green{background:#10b981}
        #jitsi-container{position:fixed;top:60px;left:0;right:0;bottom:0}
        .info{background:#f59e0b;padding:8px 16px;border-radius:30px;margin:5px}
    </style>
</head>
<body>
    <div class="header">
        <div><span class="info">👨‍🏫 أنت المضيف</span></div>
        <div>
            <span id="waitingCount" class="info">⏳ جاري التحميل...</span>
            <button id="addBtn" class="btn btn-green" style="display:none" onclick="addStudents()">➕ إضافة الطلاب</button>
            <button class="btn" onclick="endStream()">⏹️ إنهاء البث</button>
            <button class="btn" onclick="leaveStream()">🚪 مغادرة</button>
        </div>
    </div>
    <div id="jitsi-container"></div>
    <script>
        let studentsAdded = false;
        const api = new JitsiMeetExternalAPI('meet.jit.si', {
            roomName: '${offer.room_name}',
            width: '100%',
            height: window.innerHeight - 60,
            parentNode: document.querySelector('#jitsi-container'),
            userInfo: { displayName: '👨‍🏫 الأستاذ' }
        });
        
        async function loadWaitingCount() {
            try {
                const res = await fetch('/api/stream/waiting-list/${offer_id}/${teacher_id}');
                const students = await res.json();
                const count = students?.length || 0;
                document.getElementById('waitingCount').innerHTML = \`⏳ \${count} طالب ينتظرون\`;
                if (count > 0 && !studentsAdded) {
                    document.getElementById('addBtn').style.display = 'inline-block';
                }
            } catch(e) {}
        }
        
        async function addStudents() {
            if (confirm('إضافة جميع الطلاب المنتظرين إلى البث؟')) {
                const res = await fetch('/api/stream/add-students/${offer_id}', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ offer_id: ${offer_id}, teacher_id: ${teacher_id} })
                });
                const data = await res.json();
                if (data.success) {
                    studentsAdded = true;
                    document.getElementById('addBtn').style.display = 'none';
                    alert(\`✅ تم إضافة \${data.students_count} طالب\`);
                }
            }
        }
        
        function leaveStream() { api.dispose(); window.location.href = '/teacher-dashboard.html'; }
        async function endStream() {
            if (confirm('إنهاء البث؟')) {
                await fetch('/api/stream/end/${offer_id}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offer_id: ${offer_id}, teacher_id: ${teacher_id} }) });
                api.dispose();
                window.location.href = '/teacher-dashboard.html';
            }
        }
        loadWaitingCount();
        setInterval(loadWaitingCount, 3000);
    </script>
</body>
</html>
    `);
  });
});

app.get('/api/enter-teacher-stream/:offer_id/:teacher_id', async (req, res) => {
  const { offer_id, teacher_id } = req.params;
  
  const axios = require('axios');
  try {
    await axios.post(`http://localhost:${PORT}/api/stream/enter-teacher/${offer_id}`, {
      offer_id: parseInt(offer_id),
      teacher_id: parseInt(teacher_id)
    });
  } catch(e) {
    console.log(e);
  }
  
  res.redirect(`/api/teacher-stream/${offer_id}/${teacher_id}`);
});

app.get('/api/join-stream/:offer_id/:student_id', (req, res) => {
  const { offer_id, student_id } = req.params;
  
  db.get(`SELECT room_name FROM offers WHERE id = ? AND status = 'live'`, [offer_id], (err, offer) => {
    if (!offer) return res.redirect('/student-dashboard.html?error=stream_not_started');
    
    db.get(`SELECT * FROM active_stream WHERE offer_id = ? AND student_id = ?`, [offer_id, student_id], (err, active) => {
      if (!active) return res.redirect('/student-dashboard.html?error=not_authorized');
      
      res.send(`
<!DOCTYPE html>
<html lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>حصة مباشرة - طالب</title>
    <script src="https://meet.jit.si/external_api.js"></script>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Cairo',sans-serif;background:#0a0a1a}
        .header{background:#0f3460;color:white;padding:12px 24px;display:flex;justify-content:space-between;align-items:center;position:fixed;top:0;left:0;right:0;z-index:100}
        .btn{background:#ef4444;color:white;border:none;padding:8px 20px;border-radius:30px;cursor:pointer}
        #jitsi-container{position:fixed;top:60px;left:0;right:0;bottom:0}
        .badge{background:#f59e0b;padding:5px 15px;border-radius:30px}
    </style>
</head>
<body>
    <div class="header">
        <div><span class="badge">👨‍🎓 أنت طالب - مشاهدة فقط</span></div>
        <button class="btn" onclick="leaveStream()">🚪 مغادرة</button>
    </div>
    <div id="jitsi-container"></div>
    <script>
        const api = new JitsiMeetExternalAPI('meet.jit.si', {
            roomName: '${offer.room_name}',
            width: '100%',
            height: window.innerHeight - 60,
            parentNode: document.querySelector('#jitsi-container'),
            userInfo: { displayName: '👨‍🎓 طالب' },
            configOverwrite: { startWithVideoMuted: true, startWithAudioMuted: true }
        });
        function leaveStream() { api.dispose(); window.location.href = '/student-dashboard.html'; }
    </script>
</body>
</html>
      `);
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
  console.log(`💳 Chargily API: ${CHARGILY_API_URL}`);
});
