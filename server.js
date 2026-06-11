require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ============= تهيئة Supabase =============
const supabaseUrl = process.env.SUPABASE_URL || 'https://pvtphjcnafwphuzmzihe.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2dHBoamNuYWZ3cGh1em16aWhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5OTA0ODgsImV4cCI6MjA5NjU2NjQ4OH0.iyDo5UnNM7mAFFjZfNSr2Z8tpdI4FiHAfabJU1uAVEk';

console.log('🔌 الاتصال بـ Supabase:', supabaseUrl);
const supabase = createClient(supabaseUrl, supabaseKey);

// إعداد رفع الملفات
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let dir = './uploads';
    if (file.fieldname === 'profile_image') dir = './uploads/profiles';
    if (file.fieldname === 'cover_image') dir = './uploads/covers';
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

// ============= Chargily API =============
const CHARGILY_API_KEY = 'test_sk_2vm1gIkToN70ERrg4SUE1j65gkZcexbPFjHzLUT7';
const CHARGILY_API_URL = 'https://pay.chargily.net/test/api/v2';

async function createChargilyCheckout(amount, studentName, studentEmail, studentPhone, offerName, successUrl, failureUrl) {
  try {
    let finalAmount = amount;
    if (finalAmount < 50) finalAmount = 50;
    
    const checkoutData = {
      amount: finalAmount,
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
      return { success: true, checkout_url: response.data.checkout_url };
    }
    throw new Error('لم يتم استلام رابط الدفع');
  } catch (error) {
    console.error('❌ خطأ Chargily:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.message || error.message };
  }
}

// ============= دوال مساعدة =============
async function getOne(table, column, value) {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq(column, value)
    .single();
  if (error && error.code !== 'PGRST116') return null;
  return data;
}

async function insert(table, data) {
  const { data: result, error } = await supabase.from(table).insert(data).select();
  if (error) throw error;
  return result[0];
}

async function update(table, id, data) {
  const { data: result, error } = await supabase.from(table).update(data).eq('id', id).select();
  if (error) throw error;
  return result[0];
}

// ============= Routes =============

// تسجيل أستاذ جديد
app.post('/api/teacher/register', upload.single('profile_image'), async (req, res) => {
  try {
    const { full_name, email, password, phone, specialization, bio, experience } = req.body;
    
    if (!full_name || !email || !password || !phone || !specialization || !bio || !experience) {
      return res.json({ success: false, error: 'يرجى ملء جميع الحقول المطلوبة' });
    }

    const existingTeacher = await getOne('teachers', 'email', email);
    if (existingTeacher) {
      return res.json({ success: false, error: 'البريد الإلكتروني مستخدم مسبقاً' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const profile_image = req.file ? req.file.filename : null;

    await insert('teachers', {
      full_name, email, password: hashedPassword, phone, specialization, bio, experience,
      profile_image, status: 'pending'
    });

    res.json({ success: true, message: 'تم إرسال طلبك، سيتم مراجعته من قبل الإدارة' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// تسجيل طالب
app.post('/api/student/register', async (req, res) => {
  try {
    const { full_name, email, password, phone } = req.body;
    if (!full_name || !email || !password || !phone) {
      return res.json({ success: false, error: 'يرجى ملء جميع الحقول' });
    }

    const existingStudent = await getOne('students', 'email', email);
    if (existingStudent) {
      return res.json({ success: false, error: 'البريد الإلكتروني مستخدم' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    await insert('students', { full_name, email, password: hashedPassword, phone });

    res.json({ success: true, message: 'تم التسجيل بنجاح' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// تحديث بيانات الطالب
app.post('/api/student/update-profile', upload.single('profile_image'), async (req, res) => {
  try {
    const { student_id, full_name, phone } = req.body;
    let profile_image = null;
    
    if (req.file) profile_image = req.file.filename;
    
    const updateData = {};
    if (full_name) updateData.full_name = full_name;
    if (phone) updateData.phone = phone;
    if (profile_image) updateData.profile_image = profile_image;
    
    const { data, error } = await supabase
      .from('students')
      .update(updateData)
      .eq('id', parseInt(student_id))
      .select();
    
    if (error) throw error;
    
    res.json({ success: true, message: 'تم تحديث الملف الشخصي', user: data[0] });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// جلب بيانات طالب
app.get('/api/student/:student_id', async (req, res) => {
  try {
    const student = await getOne('students', 'id', req.params.student_id);
    res.json(student || { error: 'غير موجود' });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// تحديث بيانات الأستاذ
app.post('/api/teacher/update-profile', upload.single('profile_image'), async (req, res) => {
  try {
    const { teacher_id, full_name, bio, specialization, experience, phone } = req.body;
    let profile_image = null;
    
    if (req.file) profile_image = req.file.filename;
    
    const updateData = { full_name, bio, specialization, experience, phone };
    if (profile_image) updateData.profile_image = profile_image;
    
    await update('teachers', teacher_id, updateData);
    res.json({ success: true, message: 'تم تحديث الملف الشخصي' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// جلب بيانات أستاذ
app.get('/api/teacher/:teacher_id', async (req, res) => {
  try {
    const teacher = await getOne('teachers', 'id', req.params.teacher_id);
    res.json(teacher || { error: 'غير موجود' });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// جلب جميع الأساتذة المقبولين
app.get('/api/teachers', async (req, res) => {
  const { data } = await supabase
    .from('teachers')
    .select('id, full_name, specialization, bio, experience, profile_image')
    .eq('status', 'approved')
    .order('created_at', { ascending: false });
  res.json(data || []);
});

// تسجيل الدخول
app.post('/api/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    
    if (email === 'admin@platform.com' && password === 'admin123') {
      return res.json({ success: true, token: 'admin_token', user: { id: 0, name: 'مدير المنصة', role: 'admin' } });
    }
    
    let user = await getOne('teachers', 'email', email);
    let userRole = 'teacher';
    
    if (!user) {
      user = await getOne('students', 'email', email);
      userRole = 'student';
    }
    
    if (!user) return res.json({ success: false, error: 'البريد الإلكتروني غير موجود' });
    
    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) return res.json({ success: false, error: 'كلمة المرور خاطئة' });
    
    if (role !== userRole) {
      return res.json({ success: false, error: `هذا الحساب مسجل كـ ${userRole === 'teacher' ? 'أستاذ' : 'طالب'}` });
    }
    
    if (userRole === 'teacher' && user.status !== 'approved') {
      return res.json({ success: false, error: 'حسابك قيد المراجعة' });
    }
    
    res.json({ success: true, token: `${userRole}_token`, user: { id: user.id, name: user.full_name, role: userRole, profile_image: user.profile_image } });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ADMIN Routes
app.get('/api/admin/pending-teachers', async (req, res) => {
  const { data } = await supabase.from('teachers').select('*').eq('status', 'pending');
  res.json(data || []);
});

app.post('/api/admin/approve-teacher/:id', async (req, res) => {
  await update('teachers', req.params.id, { status: 'approved' });
  res.json({ success: true });
});

app.post('/api/admin/reject-teacher/:id', async (req, res) => {
  await update('teachers', req.params.id, { status: 'rejected' });
  res.json({ success: true });
});

// ============= نظام العروض =============
app.post('/api/offer/create', async (req, res) => {
  const { teacher_id, subject_name, duration, offer_date, price, is_free } = req.body;
  const room_name = `stream_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
  await insert('offers', {
    teacher_id, subject_name, duration, offer_date, price, is_free: is_free ? 1 : 0,
    room_name, status: 'upcoming'
  });
  res.json({ success: true, room_name });
});

app.get('/api/offers', async (req, res) => {
  const { data } = await supabase
    .from('offers')
    .select('*, teachers:teacher_id (id, full_name, specialization, profile_image)')
    .eq('status', 'upcoming')
    .gt('offer_date', new Date().toISOString())
    .order('offer_date', { ascending: true });
  
  const formatted = (data || []).map(o => ({
    ...o,
    teacher_name: o.teachers?.full_name,
    teacher_specialization: o.teachers?.specialization,
    teacher_profile_image: o.teachers?.profile_image,
    teacher_id: o.teachers?.id
  }));
  res.json(formatted);
});

app.get('/api/teacher/offers/:teacher_id', async (req, res) => {
  const { data } = await supabase.from('offers').select('*').eq('teacher_id', req.params.teacher_id).order('offer_date', { ascending: false });
  res.json(data || []);
});

app.delete('/api/offer/delete/:offer_id', async (req, res) => {
  const { teacher_id } = req.body;
  const offer = await getOne('offers', 'id', req.params.offer_id);
  if (!offer || offer.teacher_id != teacher_id) {
    return res.json({ success: false, error: 'غير مصرح' });
  }
  await supabase.from('sessions').delete().eq('offer_id', req.params.offer_id);
  await supabase.from('waiting_room').delete().eq('offer_id', req.params.offer_id);
  await supabase.from('active_stream').delete().eq('offer_id', req.params.offer_id);
  await supabase.from('offers').delete().eq('id', req.params.offer_id);
  res.json({ success: true });
});

// ============= نظام الحجز =============
app.post('/api/booking/create', async (req, res) => {
  const { offer_id, student_id } = req.body;
  
  try {
    const offer = await getOne('offers', 'id', offer_id);
    if (!offer) return res.json({ success: false, error: 'العرض غير موجود' });
    
    const { data: existing } = await supabase.from('sessions').select('*').eq('offer_id', offer_id).eq('student_id', student_id).maybeSingle();
    if (existing) return res.json({ success: false, error: 'مسجل بالفعل' });
    
    // عرض مجاني
    if (offer.is_free === 1 || offer.price === 0) {
      const session = await insert('sessions', { offer_id, student_id, payment_status: 'paid', payment_amount: 0 });
      await insert('waiting_room', { offer_id, student_id });
      return res.json({ success: true, session_id: session.id, is_free: true });
    }
    
    // عرض مدفوع
    const session = await insert('sessions', { offer_id, student_id, payment_status: 'pending', payment_amount: offer.price });
    
    const student = await getOne('students', 'id', student_id);
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const successUrl = `${baseUrl}/api/payment/success/${session.id}`;
    const failureUrl = `${baseUrl}/api/payment/failure/${session.id}`;
    
    const checkout = await createChargilyCheckout(offer.price, student.full_name, student.email, student.phone, offer.subject_name, successUrl, failureUrl);
    
    if (checkout.success && checkout.checkout_url) {
      await update('sessions', session.id, { chargily_checkout_url: checkout.checkout_url });
      return res.json({ success: true, session_id: session.id, checkout_url: checkout.checkout_url });
    } else {
      return res.json({ success: false, error: checkout.error });
    }
  } catch (error) {
    return res.json({ success: false, error: error.message });
  }
});

app.get('/api/payment/success/:session_id', async (req, res) => {
  const { session_id } = req.params;
  await update('sessions', session_id, { payment_status: 'paid' });
  const session = await getOne('sessions', 'id', session_id);
  if (session) await insert('waiting_room', { offer_id: session.offer_id, student_id: session.student_id });
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>تم الدفع</title>
    <style>body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:white;padding:40px;border-radius:20px;text-align:center}.btn{background:#10b981;color:white;padding:12px 25px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}</style>
    </head>
    <body>
    <div class="card"><h1>✅ تم الدفع بنجاح!</h1><p>تم تأكيد حجزك</p><a href="/student-dashboard.html" class="btn">العودة للوحة</a></div>
    </body>
    </html>
  `);
});

app.get('/api/payment/failure/:session_id', async (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>فشل الدفع</title>
    <style>body{font-family:Cairo;background:#0f5cbf;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:white;padding:40px;border-radius:20px;text-align:center}.btn{background:#0f5cbf;color:white;padding:12px 25px;border-radius:30px;text-decoration:none;display:inline-block;margin-top:20px}</style>
    </head>
    <body>
    <div class="card"><h1>❌ فشل الدفع!</h1><p>حدث خطأ</p><a href="/student-dashboard.html" class="btn">المحاولة مرة أخرى</a></div>
    </body>
    </html>
  `);
});

app.get('/api/student/bookings/:student_id', async (req, res) => {
  const { data } = await supabase
    .from('sessions')
    .select('*, offers:offer_id (id, subject_name, offer_date, duration, price, is_free, status, room_name, teachers:teacher_id (id, full_name, profile_image))')
    .eq('student_id', req.params.student_id)
    .order('created_at', { ascending: false });
  
  const formatted = (data || []).map(s => ({
    ...s,
    subject_name: s.offers?.subject_name,
    offer_date: s.offers?.offer_date,
    duration: s.offers?.duration,
    price: s.offers?.price,
    is_free: s.offers?.is_free,
    offer_status: s.offers?.status,
    room_name: s.offers?.room_name,
    teacher_id: s.offers?.teachers?.id,
    teacher_name: s.offers?.teachers?.full_name,
    teacher_image: s.offers?.teachers?.profile_image
  }));
  res.json(formatted);
});

app.get('/api/waiting-count/:offer_id', async (req, res) => {
  const { count } = await supabase.from('waiting_room').select('*', { count: 'exact', head: true }).eq('offer_id', req.params.offer_id);
  res.json({ count: count || 0 });
});

// ============= نظام البث المباشر =============
app.post('/api/stream/enter-teacher/:offer_id', async (req, res) => {
  const { offer_id, teacher_id } = req.body;
  const offer = await getOne('offers', 'id', offer_id);
  if (!offer || offer.teacher_id != teacher_id) return res.json({ success: false });
  await update('offers', offer_id, { status: 'teacher_ready' });
  res.json({ success: true, room_name: offer.room_name });
});

app.post('/api/stream/add-students/:offer_id', async (req, res) => {
  const { offer_id, teacher_id } = req.body;
  const offer = await getOne('offers', 'id', offer_id);
  if (!offer || offer.teacher_id != teacher_id) return res.json({ success: false });
  
  await update('offers', offer_id, { status: 'live' });
  
  const { data: waitingStudents } = await supabase.from('waiting_room').select('student_id').eq('offer_id', offer_id);
  
  for (const student of waitingStudents || []) {
    await insert('active_stream', { offer_id, student_id: student.student_id });
    await supabase.from('waiting_room').delete().eq('offer_id', offer_id).eq('student_id', student.student_id);
  }
  
  res.json({ success: true, students_count: waitingStudents?.length || 0 });
});

app.post('/api/stream/end/:offer_id', async (req, res) => {
  await update('offers', req.params.offer_id, { status: 'completed' });
  await supabase.from('active_stream').delete().eq('offer_id', req.params.offer_id);
  await supabase.from('waiting_room').delete().eq('offer_id', req.params.offer_id);
  res.json({ success: true });
});

app.get('/api/stream/status/:offer_id', async (req, res) => {
  const offer = await getOne('offers', 'id', req.params.offer_id);
  res.json({ status: offer?.status || 'not_found', room_name: offer?.room_name });
});

app.get('/api/student/stream-status/:offer_id/:student_id', async (req, res) => {
  const offer = await getOne('offers', 'id', req.params.offer_id);
  if (!offer) return res.json({ can_join: false });
  
  if (offer.status === 'live') {
    const { data: active } = await supabase.from('active_stream').select('*').eq('offer_id', req.params.offer_id).eq('student_id', req.params.student_id).single();
    if (active) return res.json({ can_join: true, room_name: offer.room_name });
    return res.json({ can_join: false });
  } else if (offer.status === 'upcoming' || offer.status === 'teacher_ready') {
    const session = await getOne('sessions', 'offer_id', req.params.offer_id);
    if (session && session.payment_status === 'paid' && session.student_id == req.params.student_id) {
      await insert('waiting_room', { offer_id: req.params.offer_id, student_id: req.params.student_id });
      return res.json({ can_join: false, is_waiting: true });
    }
    return res.json({ can_join: false, payment_required: true });
  }
  return res.json({ can_join: false });
});

app.get('/api/stream/waiting-list/:offer_id/:teacher_id', async (req, res) => {
  const { data } = await supabase.from('waiting_room').select('*, students:student_id (full_name, email)').eq('offer_id', req.params.offer_id);
  res.json(data || []);
});

// صفحات البث
app.get('/api/teacher-stream/:offer_id/:teacher_id', async (req, res) => {
  const offer = await getOne('offers', 'id', req.params.offer_id);
  if (!offer || offer.teacher_id != req.params.teacher_id) return res.redirect('/teacher-dashboard.html');
  res.send(`
    <!DOCTYPE html>
    <html lang="ar">
    <head><meta charset="UTF-8"><title>بث مباشر</title><script src="https://meet.jit.si/external_api.js"></script>
    <style>
      *{margin:0;padding:0}body{font-family:Cairo,sans-serif;background:#0a0a1a}
      .header{background:#0f3460;color:white;padding:12px 24px;display:flex;justify-content:space-between;position:fixed;top:0;left:0;right:0;z-index:100}
      .btn{background:#ef4444;color:white;border:none;padding:8px 20px;border-radius:30px;cursor:pointer;margin-left:10px}
      .btn-green{background:#10b981}
      #jitsi-container{position:fixed;top:60px;left:0;right:0;bottom:0}
      .info{background:#f59e0b;padding:8px 16px;border-radius:30px}
    </style>
    </head>
    <body>
    <div class="header">
      <div><span class="info">👨‍🏫 أنت المضيف</span></div>
      <div>
        <span id="waitingCount" class="info">⏳ جاري التحميل...</span>
        <button id="addBtn" class="btn btn-green" onclick="addStudents()" style="display:none">➕ إضافة الطلاب</button>
        <button class="btn" onclick="endStream()">⏹️ إنهاء البث</button>
        <button class="btn" onclick="leaveStream()">🚪 مغادرة</button>
      </div>
    </div>
    <div id="jitsi-container"></div>
    <script>
      let studentsAdded=false;
      const api=new JitsiMeetExternalAPI('meet.jit.si',{roomName:'${offer.room_name}',width:'100%',height:window.innerHeight-60,parentNode:document.querySelector('#jitsi-container'),userInfo:{displayName:'👨‍🏫 الأستاذ'}});
      async function loadWaitingCount(){
        try{
          const res=await fetch('/api/stream/waiting-list/${req.params.offer_id}/${req.params.teacher_id}');
          const students=await res.json();
          const count=students?.length||0;
          document.getElementById('waitingCount').innerHTML=\`⏳ \${count} طالب ينتظرون\`;
          if(count>0 && !studentsAdded) document.getElementById('addBtn').style.display='inline-block';
        }catch(e){}
      }
      async function addStudents(){
        if(confirm('إضافة الطلاب إلى البث؟')){
          const res=await fetch('/api/stream/add-students/${req.params.offer_id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offer_id:${req.params.offer_id},teacher_id:${req.params.teacher_id}})});
          const data=await res.json();
          if(data.success){
            studentsAdded=true;
            document.getElementById('addBtn').style.display='none';
            alert(\`✅ تم إضافة \${data.students_count} طالب\`);
          }
        }
      }
      function leaveStream(){api.dispose();window.location.href='/teacher-dashboard.html';}
      async function endStream(){
        if(confirm('إنهاء البث؟')){
          await fetch('/api/stream/end/${req.params.offer_id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offer_id:${req.params.offer_id},teacher_id:${req.params.teacher_id}})});
          api.dispose();window.location.href='/teacher-dashboard.html';
        }
      }
      loadWaitingCount();
      setInterval(loadWaitingCount,3000);
    </script>
    </body>
    </html>
  `);
});

app.get('/api/enter-teacher-stream/:offer_id/:teacher_id', async (req, res) => {
  await axios.post(`http://localhost:${PORT}/api/stream/enter-teacher/${req.params.offer_id}`, { offer_id: parseInt(req.params.offer_id), teacher_id: parseInt(req.params.teacher_id) }).catch(e=>console.log(e));
  res.redirect(`/api/teacher-stream/${req.params.offer_id}/${req.params.teacher_id}`);
});

app.get('/api/join-stream/:offer_id/:student_id', async (req, res) => {
  const offer = await getOne('offers', 'id', req.params.offer_id);
  if (!offer || offer.status !== 'live') return res.redirect('/student-dashboard.html');
  const { data: active } = await supabase.from('active_stream').select('*').eq('offer_id', req.params.offer_id).eq('student_id', req.params.student_id).single();
  if (!active) return res.redirect('/student-dashboard.html');
  res.send(`
    <!DOCTYPE html>
    <html lang="ar">
    <head><meta charset="UTF-8"><title>حصة مباشرة</title><script src="https://meet.jit.si/external_api.js"></script>
    <style>
      *{margin:0;padding:0}body{font-family:Cairo,sans-serif;background:#0a0a1a}
      .header{background:#0f3460;color:white;padding:12px 24px;display:flex;justify-content:space-between;position:fixed;top:0;left:0;right:0;z-index:100}
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
      const api=new JitsiMeetExternalAPI('meet.jit.si',{roomName:'${offer.room_name}',width:'100%',height:window.innerHeight-60,parentNode:document.querySelector('#jitsi-container'),userInfo:{displayName:'👨‍🎓 طالب'},configOverwrite:{startWithVideoMuted:true,startWithAudioMuted:true}});
      function leaveStream(){api.dispose();window.location.href='/student-dashboard.html';}
    </script>
    </body>
    </html>
  `);
});

// ============= تشغيل الخادم =============
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
  console.log(`✅ العروض المجانية: حجز مباشر`);
  console.log(`💰 العروض المدفوعة: عبر Chargily`);
});
