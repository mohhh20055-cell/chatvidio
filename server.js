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

// ============= تهيئة Supabase - التحقق من صحة الرابط =============
// تأكد من أن هذا الرابط صحيح - يجب أن يكون مشابه لـ: https://xxxxx.supabase.co
const supabaseUrl = 'https://pvtphjcnfawphuzmzihe.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2dHBoamNuYWZ3cGh1em16aWhlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDk5MDQ4OCwiZXhwIjoyMDk2NTY2NDg4fQ.0NdMZrmGEE8JW1ZCi3WNF1CbrQMIpN_fXnpnwMOALpk';

console.log('🔌 محاولة الاتصال بـ Supabase:', supabaseUrl);

// إنشاء عميل Supabase
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// اختبار الاتصال بقاعدة البيانات
async function testConnection() {
  try {
    const { data, error } = await supabase.from('teachers').select('count', { count: 'exact', head: true });
    if (error) {
      console.error('❌ فشل الاتصال بـ Supabase:', error.message);
      console.log('⚠️ يرجى التحقق من:');
      console.log('   1. أن Supabase URL صحيح');
      console.log('   2. أن Service Role Key صحيح');
      console.log('   3. أن الجداول موجودة في Supabase');
      return false;
    }
    console.log('✅ الاتصال بـ Supabase ناجح');
    return true;
  } catch (error) {
    console.error('❌ خطأ في الاتصال:', error.message);
    return false;
  }
}

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

// ============= Chargily API =============
const CHARGILY_API_KEY = 'test_sk_2vm1gIkToN70ERrg4SUE1j65gkZcexbPFjHzLUT7';
const CHARGILY_API_URL = 'https://pay.chargily.net/test/api/v2';

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
    }
    throw new Error('لم يتم استلام رابط الدفع');
  } catch (error) {
    console.error('❌ خطأ Chargily:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.message || error.message };
  }
}

// ============= دوال مساعدة Supabase =============
async function getOne(table, column, value) {
  try {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq(column, value)
      .single();
    if (error && error.code !== 'PGRST116') return null;
    return data;
  } catch (error) {
    console.error(`خطأ في getOne (${table}):`, error.message);
    return null;
  }
}

async function insert(table, data) {
  const { data: result, error } = await supabase
    .from(table)
    .insert(data)
    .select();
  if (error) throw error;
  return result[0];
}

async function update(table, id, data) {
  const { data: result, error } = await supabase
    .from(table)
    .update(data)
    .eq('id', id)
    .select();
  if (error) throw error;
  return result[0];
}

async function remove(table, column, value) {
  const { error } = await supabase
    .from(table)
    .delete()
    .eq(column, value);
  if (error) throw error;
  return true;
}

async function getAll(table, conditions = {}) {
  let query = supabase.from(table).select('*');
  for (const [key, value] of Object.entries(conditions)) {
    query = query.eq(key, value);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// ============= إنشاء الجداول تلقائياً =============
async function createTables() {
  console.log('📦 محاولة إنشاء الجداول في Supabase...');
  
  // إنشاء جدول الأساتذة
  const createTeachers = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS teachers (
        id SERIAL PRIMARY KEY,
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
        created_at TIMESTAMP DEFAULT NOW()
      )
    `
  }).catch(e => ({ error: e }));
  
  // إنشاء جدول الطلاب
  const createStudents = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        full_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        phone TEXT,
        profile_image TEXT,
        balance INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `
  }).catch(e => ({ error: e }));
  
  // إنشاء جدول العروض
  const createOffers = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS offers (
        id SERIAL PRIMARY KEY,
        teacher_id INTEGER REFERENCES teachers(id) ON DELETE CASCADE,
        subject_name TEXT NOT NULL,
        duration INTEGER DEFAULT 60,
        offer_date TIMESTAMP NOT NULL,
        price INTEGER DEFAULT 0,
        is_free BOOLEAN DEFAULT FALSE,
        status TEXT DEFAULT 'upcoming',
        room_name TEXT UNIQUE,
        room_password TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `
  }).catch(e => ({ error: e }));
  
  // إنشاء جدول المنشورات
  const createPosts = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        teacher_id INTEGER REFERENCES teachers(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT,
        image_url TEXT,
        file_url TEXT,
        link_url TEXT,
        likes INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `
  }).catch(e => ({ error: e }));
  
  // إنشاء جدول الإعجابات
  const createLikes = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS post_likes (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
        student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(post_id, student_id)
      )
    `
  }).catch(e => ({ error: e }));
  
  // إنشاء جدول التعليقات
  const createComments = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS post_comments (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
        student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
        comment TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `
  }).catch(e => ({ error: e }));
  
  // إنشاء جدول المتابعات
  const createFollows = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS follows (
        id SERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
        teacher_id INTEGER REFERENCES teachers(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(student_id, teacher_id)
      )
    `
  }).catch(e => ({ error: e }));
  
  // إنشاء جدول الحصص
  const createSessions = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        offer_id INTEGER REFERENCES offers(id) ON DELETE CASCADE,
        student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
        payment_status TEXT DEFAULT 'pending',
        payment_amount INTEGER DEFAULT 0,
        chargily_checkout_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `
  }).catch(e => ({ error: e }));
  
  // إنشاء جدول غرفة الانتظار
  const createWaitingRoom = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS waiting_room (
        id SERIAL PRIMARY KEY,
        offer_id INTEGER REFERENCES offers(id) ON DELETE CASCADE,
        student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
        added_at TIMESTAMP DEFAULT NOW()
      )
    `
  }).catch(e => ({ error: e }));
  
  // إنشاء جدول البث المباشر
  const createActiveStream = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS active_stream (
        id SERIAL PRIMARY KEY,
        offer_id INTEGER REFERENCES offers(id) ON DELETE CASCADE,
        student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
        joined_at TIMESTAMP DEFAULT NOW()
      )
    `
  }).catch(e => ({ error: e }));
  
  // إنشاء جدول المدفوعات
  const createPayments = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
        amount INTEGER,
        checkout_url TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `
  }).catch(e => ({ error: e }));
  
  console.log('✅ تم التحقق من الجداول');
  
  // إنشاء admin افتراضي
  const existingAdmin = await getOne('teachers', 'email', 'admin@platform.com');
  if (!existingAdmin) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    try {
      await insert('teachers', {
        full_name: 'مدير المنصة',
        email: 'admin@platform.com',
        password: hashedPassword,
        phone: '00000000',
        status: 'approved'
      });
      console.log('✅ تم إنشاء حساب admin بنجاح');
    } catch(e) {
      console.log('⚠️ admin موجود مسبقاً أو خطأ في الإنشاء');
    }
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
    
    console.log('📝 محاولة تسجيل أستاذ:', email);
    
    if (!full_name || !email || !password || !phone || !specialization || !bio || !experience) {
      return res.json({ success: false, error: 'يرجى ملء جميع الحقول المطلوبة' });
    }

    // التحقق من وجود المستخدم
    const existingTeacher = await getOne('teachers', 'email', email);
    if (existingTeacher) {
      return res.json({ success: false, error: 'البريد الإلكتروني مستخدم مسبقاً' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const profile_image = req.files['profile_image'] ? req.files['profile_image'][0].filename : null;
    const diploma_image = req.files['diploma_image'] ? req.files['diploma_image'][0].filename : null;
    const id_image = req.files['id_image'] ? req.files['id_image'][0].filename : null;

    const newTeacher = await insert('teachers', {
      full_name,
      email,
      password: hashedPassword,
      phone,
      specialization,
      bio,
      experience,
      profile_image,
      diploma_image,
      id_image,
      status: 'pending'
    });

    console.log('✅ تم تسجيل الأستاذ بنجاح:', newTeacher.id);
    res.json({ success: true, message: 'تم إرسال طلبك، سيتم مراجعته من قبل الإدارة' });
  } catch (error) {
    console.error('❌ خطأ في تسجيل الأستاذ:', error.message);
    res.json({ success: false, error: 'خطأ في الاتصال بقاعدة البيانات: ' + error.message });
  }
});

// تسجيل طالب
app.post('/api/student/register', async (req, res) => {
  try {
    const { full_name, email, password, phone } = req.body;
    
    console.log('📝 محاولة تسجيل طالب:', email);
    
    if (!full_name || !email || !password || !phone) {
      return res.json({ success: false, error: 'يرجى ملء جميع الحقول' });
    }

    const existingStudent = await getOne('students', 'email', email);
    if (existingStudent) {
      return res.json({ success: false, error: 'البريد الإلكتروني مستخدم' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const newStudent = await insert('students', {
      full_name,
      email,
      password: hashedPassword,
      phone,
      balance: 0
    });

    console.log('✅ تم تسجيل الطالب بنجاح:', newStudent.id);
    res.json({ success: true, message: 'تم التسجيل بنجاح' });
  } catch (error) {
    console.error('❌ خطأ في تسجيل الطالب:', error.message);
    res.json({ success: false, error: 'خطأ في الاتصال بقاعدة البيانات' });
  }
});

// تسجيل الدخول الموحد
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    console.log('📝 محاولة تسجيل دخول:', email);
    
    let user = await getOne('teachers', 'email', email);
    let userRole = 'teacher';
    
    if (!user) {
      user = await getOne('students', 'email', email);
      userRole = 'student';
    }
    
    if (!user) return res.json({ success: false, error: 'البريد الإلكتروني غير موجود' });
    
    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) return res.json({ success: false, error: 'كلمة المرور خاطئة' });
    
    if (userRole === 'teacher' && user.status !== 'approved' && email !== 'admin@platform.com') {
      return res.json({ success: false, error: 'حسابك قيد المراجعة من قبل الإدارة' });
    }
    
    const token = Buffer.from(`${user.id}:${Date.now()}`).toString('base64');
    console.log('✅ تم تسجيل الدخول بنجاح:', user.id);
    res.json({ 
      success: true, 
      token, 
      user: { 
        id: user.id, 
        name: user.full_name, 
        email: user.email, 
        role: userRole, 
        status: user.status,
        profile_image: user.profile_image
      } 
    });
  } catch (error) {
    console.error('❌ خطأ في تسجيل الدخول:', error.message);
    res.json({ success: false, error: 'خطأ في الاتصال بقاعدة البيانات' });
  }
});

// ADMIN Routes
app.get('/api/admin/pending-teachers', async (req, res) => {
  try {
    const teachers = await getAll('teachers', { status: 'pending' });
    res.json(teachers || []);
  } catch (error) {
    res.json([]);
  }
});

app.get('/api/admin/approved-teachers', async (req, res) => {
  try {
    const teachers = await getAll('teachers', { status: 'approved' });
    res.json(teachers || []);
  } catch (error) {
    res.json([]);
  }
});

app.post('/api/admin/approve-teacher/:id', async (req, res) => {
  await update('teachers', req.params.id, { status: 'approved' });
  res.json({ success: true });
});

app.post('/api/admin/reject-teacher/:id', async (req, res) => {
  const { reason } = req.body;
  await update('teachers', req.params.id, { status: 'rejected', rejection_reason: reason });
  res.json({ success: true });
});

app.delete('/api/admin/delete-teacher/:id', async (req, res) => {
  await remove('posts', 'teacher_id', req.params.id);
  await remove('offers', 'teacher_id', req.params.id);
  await remove('follows', 'teacher_id', req.params.id);
  await remove('teachers', 'id', req.params.id);
  res.json({ success: true });
});

// ============= الصفحات العامة =============
app.get('/api/public/teachers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('teachers')
      .select('id, full_name, specialization, bio, experience, profile_image, facebook_url, instagram_url, linkedin_url, website_url')
      .eq('status', 'approved')
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch (error) {
    res.json([]);
  }
});

app.get('/api/teacher/:teacher_id', async (req, res) => {
  const teacher = await getOne('teachers', 'id', req.params.teacher_id);
  if (!teacher || teacher.status !== 'approved') return res.json({ error: 'الأستاذ غير موجود' });
  res.json(teacher);
});

// تحديث بيانات الأستاذ
app.post('/api/teacher/update-profile', upload.single('profile_image'), async (req, res) => {
  const { teacher_id, full_name, bio, specialization, experience, phone, facebook_url, instagram_url, linkedin_url, website_url } = req.body;
  let profile_image = req.body.profile_image;
  
  if (req.file) {
    profile_image = req.file.filename;
  }
  
  const updateData = {
    full_name,
    bio,
    specialization,
    experience,
    phone,
    facebook_url,
    instagram_url,
    linkedin_url,
    website_url
  };
  if (profile_image) updateData.profile_image = profile_image;

  await update('teachers', teacher_id, updateData);
  res.json({ success: true, message: 'تم تحديث الملف الشخصي بنجاح' });
});

// ============= باقي الـ Routes (مختصرة ولكنها تعمل) =============

// جلب العروض العامة
app.get('/api/public/offers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('offers')
      .select(`
        *,
        teachers:teacher_id (full_name, specialization, profile_image, id)
      `)
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
  } catch (error) {
    res.json([]);
  }
});

// جلب البث المباشر
app.get('/api/live-offers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('offers')
      .select(`
        *,
        teachers:teacher_id (full_name, specialization, profile_image, id)
      `)
      .eq('status', 'live')
      .order('offer_date', { ascending: false });
    
    const formatted = (data || []).map(o => ({
      ...o,
      teacher_name: o.teachers?.full_name,
      teacher_specialization: o.teachers?.specialization,
      teacher_profile_image: o.teachers?.profile_image,
      teacher_id: o.teachers?.id
    }));
    res.json(formatted);
  } catch (error) {
    res.json([]);
  }
});

// جلب منشورات أستاذ
app.get('/api/posts/:teacher_id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('posts')
      .select('*')
      .eq('teacher_id', req.params.teacher_id)
      .order('created_at', { ascending: false });
    
    const postsWithCounts = await Promise.all((data || []).map(async (post) => {
      const { count: likesCount } = await supabase
        .from('post_likes')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', post.id);
      const { count: commentsCount } = await supabase
        .from('post_comments')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', post.id);
      return { ...post, likes_count: likesCount || 0, comments_count: commentsCount || 0 };
    }));
    res.json(postsWithCounts);
  } catch (error) {
    res.json([]);
  }
});

// جلب منشور محدد
app.get('/api/post/:post_id', async (req, res) => {
  try {
    const { data: post, error } = await supabase
      .from('posts')
      .select('*, teachers:teacher_id (full_name, profile_image)')
      .eq('id', req.params.post_id)
      .single();
    
    if (!post) return res.json({ error: 'المنشور غير موجود' });
    
    const { data: comments } = await supabase
      .from('post_comments')
      .select('*, students:student_id (full_name, profile_image)')
      .eq('post_id', req.params.post_id)
      .order('created_at', { ascending: true });
    
    res.json({
      ...post,
      teacher_name: post.teachers?.full_name,
      teacher_image: post.teachers?.profile_image,
      comments: comments || []
    });
  } catch (error) {
    res.json({ error: 'خطأ في جلب المنشور' });
  }
});

// إعجاب
app.post('/api/post/like', async (req, res) => {
  const { post_id, student_id } = req.body;
  try {
    await insert('post_likes', { post_id, student_id });
    const { count } = await supabase
      .from('post_likes')
      .select('*', { count: 'exact', head: true })
      .eq('post_id', post_id);
    await update('posts', post_id, { likes: count });
    res.json({ success: true, liked: true });
  } catch (error) {
    res.json({ success: false });
  }
});

// إزالة إعجاب
app.post('/api/post/unlike', async (req, res) => {
  const { post_id, student_id } = req.body;
  await supabase
    .from('post_likes')
    .delete()
    .eq('post_id', post_id)
    .eq('student_id', student_id);
  
  const { count } = await supabase
    .from('post_likes')
    .select('*', { count: 'exact', head: true })
    .eq('post_id', post_id);
  await update('posts', post_id, { likes: count });
  res.json({ success: true, liked: false });
});

// إضافة تعليق
app.post('/api/post/comment', async (req, res) => {
  const { post_id, student_id, comment } = req.body;
  if (!comment || comment.trim() === '') return res.json({ success: false, error: 'التعليق لا يمكن أن يكون فارغاً' });
  const newComment = await insert('post_comments', { post_id, student_id, comment });
  res.json({ success: true, comment_id: newComment.id });
});

// حذف تعليق
app.delete('/api/post/comment/:comment_id', async (req, res) => {
  const { comment_id } = req.params;
  const { teacher_id, post_id } = req.body;
  
  const post = await getOne('posts', 'id', post_id);
  if (!post || post.teacher_id != teacher_id) {
    return res.json({ success: false, error: 'غير مصرح لك' });
  }
  await remove('post_comments', 'id', comment_id);
  res.json({ success: true });
});

// حذف منشور
app.delete('/api/post/:post_id', async (req, res) => {
  const { post_id } = req.params;
  const { teacher_id } = req.body;
  
  const post = await getOne('posts', 'id', post_id);
  if (!post || post.teacher_id != teacher_id) {
    return res.json({ success: false, error: 'غير مصرح لك' });
  }
  await supabase.from('post_likes').delete().eq('post_id', post_id);
  await supabase.from('post_comments').delete().eq('post_id', post_id);
  await remove('posts', 'id', post_id);
  res.json({ success: true });
});

// التحقق من الإعجاب
app.get('/api/post/check-like/:post_id/:student_id', async (req, res) => {
  const { data, error } = await supabase
    .from('post_likes')
    .select('*')
    .eq('post_id', req.params.post_id)
    .eq('student_id', req.params.student_id)
    .single();
  res.json({ liked: !!data });
});

// متابعة
app.post('/api/follow', async (req, res) => {
  const { student_id, teacher_id } = req.body;
  await insert('follows', { student_id, teacher_id });
  res.json({ success: true });
});

// إلغاء متابعة
app.post('/api/unfollow', async (req, res) => {
  await supabase
    .from('follows')
    .delete()
    .eq('student_id', req.body.student_id)
    .eq('teacher_id', req.body.teacher_id);
  res.json({ success: true });
});

// التحقق من المتابعة
app.get('/api/check-follow/:student_id/:teacher_id', async (req, res) => {
  const { data, error } = await supabase
    .from('follows')
    .select('*')
    .eq('student_id', req.params.student_id)
    .eq('teacher_id', req.params.teacher_id)
    .single();
  res.json({ following: !!data });
});

// ============= تشغيل الخادم =============
async function startServer() {
  // اختبار الاتصال بقاعدة البيانات
  const isConnected = await testConnection();
  
  if (!isConnected) {
    console.log('⚠️ تنبيه: فشل الاتصال بـ Supabase. بعض الميزات قد لا تعمل.');
    console.log('⚠️ يرجى التأكد من:');
    console.log('   1. أن Supabase URL صحيح');
    console.log('   2. أن Service Role Key صحيح');
    console.log('   3. أن Supabase متصل بالإنترنت');
  } else {
    // إنشاء الجداول إذا كانت غير موجودة
    await createTables();
  }
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
    console.log(`📦 قاعدة البيانات: Supabase (${supabaseUrl})`);
  });
}

startServer();
