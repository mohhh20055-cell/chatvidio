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
    if (file.fieldname === 'post_image') dir = './uploads/posts';
    if (file.fieldname === 'post_file') dir = './uploads/files';
    if (file.fieldname === 'profile_image') dir = './uploads/profiles';
    if (file.fieldname === 'student_profile_image') dir = './uploads/students';
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
    if (finalAmount < 50) {
      finalAmount = 50;
      console.log(`⚠️ تم تعديل المبلغ من ${amount} إلى ${finalAmount}`);
    }
    
    const checkoutData = {
      amount: finalAmount,
      currency: 'dzd',
      success_url: successUrl,
      failure_url: failureUrl,
      locale: 'ar',
      description: offerName,
      metadata: { 
        student_name: studentName, 
        student_email: studentEmail, 
        offer_name: offerName,
        original_amount: amount
      }
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

// ============= Routes =============

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

    const existingTeacher = await getOne('teachers', 'email', email);
    if (existingTeacher) {
      return res.json({ success: false, error: 'البريد الإلكتروني مستخدم مسبقاً' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const profile_image = req.files['profile_image'] ? req.files['profile_image'][0].filename : null;
    const diploma_image = req.files['diploma_image'] ? req.files['diploma_image'][0].filename : null;
    const id_image = req.files['id_image'] ? req.files['id_image'][0].filename : null;

    await insert('teachers', {
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

    res.json({ success: true, message: 'تم إرسال طلبك، سيتم مراجعته من قبل الإدارة' });
  } catch (error) {
    console.error('❌ خطأ:', error.message);
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

    const existingStudent = await getOne('students', 'email', email);
    if (existingStudent) {
      return res.json({ success: false, error: 'البريد الإلكتروني مستخدم' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    await insert('students', {
      full_name,
      email,
      password: hashedPassword,
      phone,
      balance: 0,
      profile_image: null
    });

    res.json({ success: true, message: 'تم التسجيل بنجاح' });
  } catch (error) {
    console.error('❌ خطأ:', error.message);
    res.json({ success: false, error: 'خطأ في الخادم' });
  }
});

// تحديث بيانات الطالب
app.post('/api/student/update-profile', upload.single('profile_image'), async (req, res) => {
  try {
    const { student_id, full_name, phone, bio } = req.body;
    let profile_image = null;
    
    if (req.file) {
      profile_image = req.file.filename;
    }
    
    const updateData = {
      full_name,
      phone,
      bio: bio || '',
      updated_at: new Date().toISOString()
    };
    
    if (profile_image) {
      updateData.profile_image = profile_image;
    }
    
    const { data, error } = await supabase
      .from('students')
      .update(updateData)
      .eq('id', parseInt(student_id))
      .select();
    
    if (error) throw error;
    
    res.json({ 
      success: true, 
      message: 'تم تحديث الملف الشخصي بنجاح',
      user: data[0]
    });
  } catch (error) {
    console.error('❌ خطأ:', error.message);
    res.json({ success: false, error: 'خطأ في تحديث الملف الشخصي' });
  }
});

// جلب بيانات طالب واحد
app.get('/api/student/:student_id', async (req, res) => {
  try {
    const student = await getOne('students', 'id', req.params.student_id);
    if (!student) {
      return res.json({ error: 'الطالب غير موجود' });
    }
    res.json(student);
  } catch (error) {
    res.json({ error: error.message });
  }
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

// تسجيل الدخول
app.post('/api/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    
    console.log(`📝 محاولة تسجيل دخول: ${email} كـ ${role}`);
    
    if (email === 'admin@platform.com' && password === 'admin123') {
      return res.json({ 
        success: true, 
        token: 'admin_token_' + Date.now(),
        user: { 
          id: 0, 
          name: 'مدير المنصة', 
          email: 'admin@platform.com', 
          role: 'admin', 
          status: 'approved'
        } 
      });
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
      return res.json({ success: false, error: `هذا الحساب مسجل كـ ${userRole === 'teacher' ? 'أستاذ' : 'طالب'}. يرجى اختيار الدور الصحيح.` });
    }
    
    if (userRole === 'teacher' && user.status !== 'approved') {
      return res.json({ success: false, error: 'حسابك قيد المراجعة من قبل الإدارة' });
    }
    
    const token = `${userRole}_token_${user.id}_${Date.now()}`;
    console.log(`✅ تم تسجيل الدخول بنجاح: ${user.id} كـ ${userRole}`);
    res.json({ 
      success: true, 
      token: token,
      user: { 
        id: user.id, 
        name: user.full_name, 
        email: user.email, 
        role: userRole, 
        status: user.status,
        profile_image: user.profile_image,
        phone: user.phone,
        bio: user.bio
      } 
    });
  } catch (error) {
    console.error('❌ خطأ في تسجيل الدخول:', error.message);
    res.json({ success: false, error: 'خطأ في الاتصال بقاعدة البيانات' });
  }
});

// ADMIN Routes
app.get('/api/admin/pending-teachers', async (req, res) => {
  const teachers = await getAll('teachers', { status: 'pending' });
  res.json(teachers || []);
});

app.get('/api/admin/approved-teachers', async (req, res) => {
  const teachers = await getAll('teachers', { status: 'approved' });
  res.json(teachers || []);
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
  const { data } = await supabase
    .from('teachers')
    .select('id, full_name, specialization, bio, experience, profile_image')
    .eq('status', 'approved')
    .order('created_at', { ascending: false });
  res.json(data || []);
});

app.get('/api/teacher/:teacher_id', async (req, res) => {
  const teacher = await getOne('teachers', 'id', req.params.teacher_id);
  if (!teacher || teacher.status !== 'approved') return res.json({ error: 'الأستاذ غير موجود' });
  res.json(teacher);
});

app.get('/api/public/offers', async (req, res) => {
  const { data } = await supabase
    .from('offers')
    .select('*, teachers:teacher_id (full_name, specialization, profile_image, id)')
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

app.get('/api/live-offers', async (req, res) => {
  const { data } = await supabase
    .from('offers')
    .select('*, teachers:teacher_id (full_name, specialization, profile_image, id)')
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
  
  await insert('posts', {
    teacher_id: parseInt(teacher_id),
    title,
    content,
    image_url,
    file_url,
    link_url,
    likes: 0
  });
  res.json({ success: true });
});

app.get('/api/posts/:teacher_id', async (req, res) => {
  const { data } = await supabase
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
});

app.get('/api/post/:post_id', async (req, res) => {
  const { data: post } = await supabase
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
});

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

app.post('/api/post/unlike', async (req, res) => {
  const { post_id, student_id } = req.body;
  await supabase.from('post_likes').delete().eq('post_id', post_id).eq('student_id', student_id);
  const { count } = await supabase.from('post_likes').select('*', { count: 'exact', head: true }).eq('post_id', post_id);
  await update('posts', post_id, { likes: count });
  res.json({ success: true, liked: false });
});

app.post('/api/post/comment', async (req, res) => {
  const { post_id, student_id, comment } = req.body;
  if (!comment || comment.trim() === '') return res.json({ success: false, error: 'التعليق لا يمكن أن يكون فارغاً' });
  await insert('post_comments', { post_id, student_id, comment });
  res.json({ success: true });
});

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

app.get('/api/post/check-like/:post_id/:student_id', async (req, res) => {
  const { data } = await supabase.from('post_likes').select('*').eq('post_id', req.params.post_id).eq('student_id', req.params.student_id).single();
  res.json({ liked: !!data });
});

// ============= نظام المتابعات =============
app.post('/api/follow', async (req, res) => {
  const { student_id, teacher_id } = req.body;
  await insert('follows', { student_id, teacher_id });
  res.json({ success: true });
});

app.post('/api/unfollow', async (req, res) => {
  await supabase.from('follows').delete().eq('student_id', req.body.student_id).eq('teacher_id', req.body.teacher_id);
  res.json({ success: true });
});

app.get('/api/check-follow/:student_id/:teacher_id', async (req, res) => {
  const { data } = await supabase.from('follows').select('*').eq('student_id', req.params.student_id).eq('teacher_id', req.params.teacher_id).single();
  res.json({ following: !!data });
});

// ============= التغذية الرئيسية =============
app.get('/api/feed/:student_id', async (req, res) => {
  const { data: follows } = await supabase
    .from('follows')
    .select('teacher_id')
    .eq('student_id', req.params.student_id);
  
  const teacherIds = (follows || []).map(f => f.teacher_id);
  
  if (teacherIds.length === 0) {
    return res.json([]);
  }
  
  const { data } = await supabase
    .from('posts')
    .select('*, teachers:teacher_id (id, full_name, profile_image)')
    .in('teacher_id', teacherIds)
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
    return {
      ...post,
      teacher_id: post.teachers?.id,
      teacher_name: post.teachers?.full_name,
      teacher_image: post.teachers?.profile_image,
      likes_count: likesCount || 0,
      comments_count: commentsCount || 0
    };
  }));
  res.json(postsWithCounts);
});

app.get('/api/all-posts', async (req, res) => {
  const { data } = await supabase
    .from('posts')
    .select('*, teachers:teacher_id (id, full_name, profile_image)')
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
    return {
      ...post,
      teacher_id: post.teachers?.id,
      teacher_name: post.teachers?.full_name,
      teacher_image: post.teachers?.profile_image,
      likes_count: likesCount || 0,
      comments_count: commentsCount || 0
    };
  }));
  res.json(postsWithCounts);
});

app.get('/api/suggested-teachers/:student_id', async (req, res) => {
  const { data: followedIds } = await supabase
    .from('follows')
    .select('teacher_id')
    .eq('student_id', req.params.student_id);
  
  const followedTeacherIds = (followedIds || []).map(f => f.teacher_id);
  
  let query = supabase
    .from('teachers')
    .select('id, full_name, specialization, profile_image, bio')
    .eq('status', 'approved');
  
  if (followedTeacherIds.length > 0) {
    query = query.not('id', 'in', `(${followedTeacherIds.join(',')})`);
  }
  
  const { data } = await query.limit(10);
  res.json(data || []);
});

// ============= نظام العروض =============
app.post('/api/offer/create', async (req, res) => {
  const { teacher_id, subject_name, duration, offer_date, price, is_free } = req.body;
  const room_name = `stream_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
  await insert('offers', {
    teacher_id,
    subject_name,
    duration,
    offer_date,
    price,
    is_free: is_free ? 1 : 0,
    room_name,
    status: 'upcoming'
  });
  res.json({ success: true, room_name });
});

app.get('/api/offers', async (req, res) => {
  const { data } = await supabase
    .from('offers')
    .select('*, teachers:teacher_id (full_name, specialization, profile_image, id)')
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
  const { data } = await supabase
    .from('offers')
    .select('*')
    .eq('teacher_id', req.params.teacher_id)
    .order('offer_date', { ascending: false });
  res.json(data || []);
});

app.delete('/api/offer/delete/:offer_id', async (req, res) => {
  const { offer_id } = req.params;
  const { teacher_id } = req.body;
  const offer = await getOne('offers', 'id', offer_id);
  if (!offer || offer.teacher_id != teacher_id) {
    return res.json({ success: false, error: 'غير مصرح لك' });
  }
  await supabase.from('sessions').delete().eq('offer_id', offer_id);
  await supabase.from('waiting_room').delete().eq('offer_id', offer_id);
  await supabase.from('active_stream').delete().eq('offer_id', offer_id);
  await remove('offers', 'id', offer_id);
  res.json({ success: true });
});

// ============= نظام الحجز =============
app.post('/api/booking/create', async (req, res) => {
  const { offer_id, student_id } = req.body;
  
  console.log(`📝 [حجز] محاولة حجز العرض: ${offer_id} للطالب: ${student_id}`);
  
  if (!offer_id || !student_id) {
    return res.json({ success: false, error: 'بيانات غير مكتملة' });
  }
  
  try {
    const offer = await getOne('offers', 'id', offer_id);
    if (!offer) {
      return res.json({ success: false, error: 'العرض غير موجود' });
    }
    
    console.log(`📝 [حجز] معلومات العرض: اسم=${offer.subject_name}, is_free=${offer.is_free}, سعر=${offer.price}`);
    
    const { data: existingSession } = await supabase
      .from('sessions')
      .select('*')
      .eq('offer_id', offer_id)
      .eq('student_id', student_id)
      .maybeSingle();
    
    if (existingSession) {
      return res.json({ success: false, error: 'أنت مسجل بالفعل في هذه الحصة' });
    }
    
    // العرض المجاني
    if (offer.is_free === 1 || offer.price === 0 || offer.price === null) {
      console.log(`🎉 [حجز] عرض مجاني - حجز مباشر للطالب ${student_id}`);
      
      const session = await insert('sessions', {
        offer_id: parseInt(offer_id),
        student_id: parseInt(student_id),
        payment_status: 'paid',
        payment_amount: 0,
        created_at: new Date().toISOString()
      });
      
      await insert('waiting_room', { 
        offer_id: parseInt(offer_id), 
        student_id: parseInt(student_id)
      });
      
      return res.json({ 
        success: true, 
        session_id: session.id, 
        is_free: true,
        message: 'تم حجز مكانك في الحصة المجانية بنجاح!'
      });
    }
    
    // العرض المدفوع
    console.log(`💰 [حجز] عرض مدفوع - إنشاء رابط دفع`);
    
    const session = await insert('sessions', {
      offer_id: parseInt(offer_id),
      student_id: parseInt(student_id),
      payment_status: 'pending',
      payment_amount: offer.price,
      created_at: new Date().toISOString()
    });
    
    const student = await getOne('students', 'id', student_id);
    if (!student) {
      return res.json({ success: false, error: 'بيانات الطالب غير موجودة' });
    }
    
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const successUrl = `${baseUrl}/api/payment/success/${session.id}`;
    const failureUrl = `${baseUrl}/api/payment/failure/${session.id}`;
    
    let checkoutAmount = offer.price;
    if (checkoutAmount < 50) checkoutAmount = 50;
    
    const checkout = await createChargilyCheckout(
      checkoutAmount,
      student.full_name,
      student.email,
      student.phone,
      offer.subject_name,
      successUrl,
      failureUrl
    );
    
    if (checkout.success && checkout.checkout_url) {
      await update('sessions', session.id, { chargily_checkout_url: checkout.checkout_url });
      return res.json({ 
        success: true, 
        session_id: session.id, 
        checkout_url: checkout.checkout_url, 
        amount: offer.price,
        is_free: false
      });
    } else {
      return res.json({ 
        success: false, 
        error: checkout.error || 'فشل الاتصال ببوابة الدفع',
        session_id: session.id,
        can_retry: true 
      });
    }
  } catch (error) {
    console.error('❌ خطأ في معالجة الحجز:', error);
    return res.json({ 
      success: false, 
      error: 'حدث خطأ داخلي في الخادم'
    });
  }
});

// صفحات الدفع
app.get('/api/payment/success/:session_id', async (req, res) => {
  const { session_id } = req.params;
  await update('sessions', session_id, { payment_status: 'paid' });
  
  const session = await getOne('sessions', 'id', session_id);
  if (session) {
    await insert('waiting_room', { 
      offer_id: session.offer_id, 
      student_id: session.student_id
    });
  }
  
  res.send(`
    <!DOCTYPE html>
    <html lang="ar">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>تم الدفع بنجاح</title>
        <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: 'Cairo', sans-serif; background: linear-gradient(135deg, #1e3c72 0%, #0f5cbf 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; }
            .card { background: white; padding: 50px 40px; border-radius: 30px; text-align: center; max-width: 500px; }
            .success-icon { width: 80px; height: 80px; background: #10b981; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 25px; }
            .success-icon svg { width: 50px; height: 50px; color: white; }
            h1 { color: #10b981; margin-bottom: 15px; }
            .btn { background: #10b981; color: white; padding: 14px 35px; border-radius: 40px; text-decoration: none; display: inline-block; margin-top: 25px; }
            .btn-secondary { background: #0f5cbf; margin-left: 10px; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="success-icon">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                </svg>
            </div>
            <h1>✅ تم الدفع بنجاح!</h1>
            <p>تم تأكيد حجزك وإضافتك إلى قائمة الانتظار</p>
            <div>
                <a href="/student-dashboard.html" class="btn">📋 لوحة التحكم</a>
                <a href="/" class="btn btn-secondary">🏠 الرئيسية</a>
            </div>
        </div>
    </body>
    </html>
  `);
});

app.get('/api/payment/failure/:session_id', async (req, res) => {
  const { session_id } = req.params;
  res.send(`
    <!DOCTYPE html>
    <html lang="ar">
    <head>
        <meta charset="UTF-8">
        <title>فشل الدفع</title>
        <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
        <style>
            body { font-family: 'Cairo', sans-serif; background: linear-gradient(135deg, #1e3c72, #0f5cbf); min-height: 100vh; display: flex; justify-content: center; align-items: center; }
            .card { background: white; padding: 40px; border-radius: 30px; text-align: center; max-width: 500px; }
            .error-icon { width: 80px; height: 80px; background: #ef4444; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 25px; }
            .error-icon svg { width: 50px; height: 50px; color: white; }
            h1 { color: #ef4444; }
            .btn { background: #f59e0b; color: white; padding: 12px 30px; border-radius: 30px; text-decoration: none; display: inline-block; margin-top: 20px; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="error-icon">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </div>
            <h1>❌ فشل الدفع!</h1>
            <p>حدث خطأ أثناء معالجة الدفع</p>
            <a href="/student-dashboard.html" class="btn">العودة للوحة التحكم</a>
        </div>
    </body>
    </html>
  `);
});

app.post('/api/retry-payment/:session_id', async (req, res) => {
  const { session_id } = req.params;
  const session = await getOne('sessions', 'id', session_id);
  if (!session) return res.json({ success: false, error: 'الجلسة غير موجودة' });
  
  const offer = await getOne('offers', 'id', session.offer_id);
  const student = await getOne('students', 'id', session.student_id);
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const successUrl = `${baseUrl}/api/payment/success/${session_id}`;
  const failureUrl = `${baseUrl}/api/payment/failure/${session_id}`;
  
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
    await update('sessions', session_id, { chargily_checkout_url: checkout.checkout_url });
    res.json({ success: true, checkout_url: checkout.checkout_url });
  } else {
    res.json({ success: false, error: checkout.error });
  }
});

app.get('/api/student/bookings/:student_id', async (req, res) => {
  const { data } = await supabase
    .from('sessions')
    .select(`
      *,
      offers:offer_id (
        id, subject_name, offer_date, duration, price, is_free, status, room_name,
        teachers:teacher_id (id, full_name, profile_image)
      )
    `)
    .eq('student_id', req.params.student_id)
    .order('created_at', { ascending: false });
  
  const formatted = await Promise.all((data || []).map(async (s) => {
    const { count: waitingCount } = await supabase
      .from('waiting_room')
      .select('*', { count: 'exact', head: true })
      .eq('offer_id', s.offer_id);
    
    return {
      id: s.id,
      offer_id: s.offer_id,
      student_id: s.student_id,
      payment_status: s.payment_status,
      payment_amount: s.payment_amount,
      chargily_checkout_url: s.chargily_checkout_url,
      created_at: s.created_at,
      subject_name: s.offers?.subject_name,
      offer_date: s.offers?.offer_date,
      duration: s.offers?.duration,
      price: s.offers?.price,
      is_free: s.offers?.is_free,
      offer_status: s.offers?.status,
      room_name: s.offers?.room_name,
      teacher_id: s.offers?.teachers?.id,
      teacher_name: s.offers?.teachers?.full_name,
      teacher_image: s.offers?.teachers?.profile_image,
      waiting_count: waitingCount || 0
    };
  }));
  
  res.json(formatted);
});

app.get('/api/waiting-count/:offer_id', async (req, res) => {
  const { count } = await supabase
    .from('waiting_room')
    .select('*', { count: 'exact', head: true })
    .eq('offer_id', req.params.offer_id);
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
  
  const { data: waitingStudents } = await supabase
    .from('waiting_room')
    .select('student_id')
    .eq('offer_id', offer_id);
  
  for (const student of waitingStudents || []) {
    await insert('active_stream', { offer_id, student_id: student.student_id });
    await supabase
      .from('waiting_room')
      .delete()
      .eq('offer_id', offer_id)
      .eq('student_id', student.student_id);
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
    const { data: active } = await supabase
      .from('active_stream')
      .select('*')
      .eq('offer_id', req.params.offer_id)
      .eq('student_id', req.params.student_id)
      .single();
    if (active) {
      const { count: waitingCount } = await supabase
        .from('waiting_room')
        .select('*', { count: 'exact', head: true })
        .eq('offer_id', req.params.offer_id);
      return res.json({ can_join: true, room_name: offer.room_name, waiting_count: waitingCount });
    }
    return res.json({ can_join: false });
  } else if (offer.status === 'upcoming' || offer.status === 'teacher_ready') {
    const session = await getOne('sessions', 'offer_id', req.params.offer_id);
    if (session && session.payment_status === 'paid' && session.student_id == req.params.student_id) {
      await insert('waiting_room', { offer_id: req.params.offer_id, student_id: req.params.student_id });
      const { count: waitingCount } = await supabase
        .from('waiting_room')
        .select('*', { count: 'exact', head: true })
        .eq('offer_id', req.params.offer_id);
      return res.json({ can_join: false, is_waiting: true, waiting_count: waitingCount });
    }
    return res.json({ can_join: false, payment_required: true });
  }
  return res.json({ can_join: false });
});

app.get('/api/stream/waiting-list/:offer_id/:teacher_id', async (req, res) => {
  const { data } = await supabase
    .from('waiting_room')
    .select('*, students:student_id (full_name, email)')
    .eq('offer_id', req.params.offer_id);
  
  const formatted = (data || []).map(w => ({
    ...w,
    full_name: w.students?.full_name,
    email: w.students?.email
  }));
  res.json(formatted);
});

// ============= صفحات البث =============
app.get('/api/teacher-stream/:offer_id/:teacher_id', async (req, res) => {
  const offer = await getOne('offers', 'id', req.params.offer_id);
  if (!offer || offer.teacher_id != req.params.teacher_id) return res.redirect('/teacher-dashboard.html');
  res.send(`<!DOCTYPE html><html lang="ar"><head><meta charset="UTF-8"><title>بث مباشر - الأستاذ</title><script src="https://meet.jit.si/external_api.js"></script><style>*{margin:0;padding:0}body{font-family:'Cairo',sans-serif;background:#0a0a1a}.header{background:#0f3460;color:white;padding:12px 24px;display:flex;justify-content:space-between;position:fixed;top:0;left:0;right:0;z-index:100}.btn{background:#ef4444;color:white;border:none;padding:8px 20px;border-radius:30px;cursor:pointer;margin-left:10px}.btn-green{background:#10b981}#jitsi-container{position:fixed;top:60px;left:0;right:0;bottom:0}.info{background:#f59e0b;padding:8px 16px;border-radius:30px}</style></head><body><div class="header"><div><span class="info">👨‍🏫 أنت المضيف</span></div><div><span id="waitingCount" class="info">⏳ جاري التحميل...</span><button id="addBtn" class="btn btn-green" style="display:none" onclick="addStudents()">➕ إضافة الطلاب</button><button class="btn" onclick="endStream()">⏹️ إنهاء البث</button><button class="btn" onclick="leaveStream()">🚪 مغادرة</button></div></div><div id="jitsi-container"></div><script>let studentsAdded=false;const api=new JitsiMeetExternalAPI('meet.jit.si',{roomName:'${offer.room_name}',width:'100%',height:window.innerHeight-60,parentNode:document.querySelector('#jitsi-container'),userInfo:{displayName:'👨‍🏫 الأستاذ'}});async function loadWaitingCount(){try{const res=await fetch('/api/stream/waiting-list/${req.params.offer_id}/${req.params.teacher_id}');const students=await res.json();const count=students?.length||0;document.getElementById('waitingCount').innerHTML=\`⏳ \${count} طالب ينتظرون\`;if(count>0&&!studentsAdded)document.getElementById('addBtn').style.display='inline-block';}catch(e){}}async function addStudents(){if(confirm('إضافة الطلاب إلى البث؟')){const res=await fetch('/api/stream/add-students/${req.params.offer_id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offer_id:${req.params.offer_id},teacher_id:${req.params.teacher_id}})});const data=await res.json();if(data.success){studentsAdded=true;document.getElementById('addBtn').style.display='none';alert(\`✅ تم إضافة \${data.students_count} طالب\`);}}}function leaveStream(){api.dispose();window.location.href='/teacher-dashboard.html';}async function endStream(){if(confirm('إنهاء البث؟')){await fetch('/api/stream/end/${req.params.offer_id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offer_id:${req.params.offer_id},teacher_id:${req.params.teacher_id}})});api.dispose();window.location.href='/teacher-dashboard.html';}}loadWaitingCount();setInterval(loadWaitingCount,3000);</script></body></html>`);
});

app.get('/api/enter-teacher-stream/:offer_id/:teacher_id', async (req, res) => {
  try {
    await axios.post(`http://localhost:${PORT}/api/stream/enter-teacher/${req.params.offer_id}`, { offer_id: parseInt(req.params.offer_id), teacher_id: parseInt(req.params.teacher_id) });
  } catch(e) { console.log(e); }
  res.redirect(`/api/teacher-stream/${req.params.offer_id}/${req.params.teacher_id}`);
});

app.get('/api/join-stream/:offer_id/:student_id', async (req, res) => {
  const offer = await getOne('offers', 'id', req.params.offer_id);
  if (!offer || offer.status !== 'live') return res.redirect('/student-dashboard.html');
  const { data: active } = await supabase.from('active_stream').select('*').eq('offer_id', req.params.offer_id).eq('student_id', req.params.student_id).single();
  if (!active) return res.redirect('/student-dashboard.html');
  res.send(`<!DOCTYPE html><html><head><title>حصة مباشرة</title><script src="https://meet.jit.si/external_api.js"></script><style>*{margin:0;padding:0}body{font-family:'Cairo',sans-serif;background:#0a0a1a}.header{background:#0f3460;color:white;padding:12px 24px;display:flex;justify-content:space-between;position:fixed;top:0;left:0;right:0;z-index:100}.btn{background:#ef4444;color:white;border:none;padding:8px 20px;border-radius:30px;cursor:pointer}#jitsi-container{position:fixed;top:60px;left:0;right:0;bottom:0}.badge{background:#f59e0b;padding:5px 15px;border-radius:30px}</style></head><body><div class="header"><div><span class="badge">👨‍🎓 أنت طالب - مشاهدة فقط</span></div><button class="btn" onclick="leaveStream()">🚪 مغادرة</button></div><div id="jitsi-container"></div><script>const api=new JitsiMeetExternalAPI('meet.jit.si',{roomName:'${offer.room_name}',width:'100%',height:window.innerHeight-60,parentNode:document.querySelector('#jitsi-container'),userInfo:{displayName:'👨‍🎓 طالب'},configOverwrite:{startWithVideoMuted:true,startWithAudioMuted:true}});function leaveStream(){api.dispose();window.location.href='/student-dashboard.html';}</script></body></html>`);
});

// ============= تشغيل الخادم =============
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
  console.log(`📦 قاعدة البيانات: Supabase (${supabaseUrl})`);
  console.log(`✅ العروض المجانية: حجز مباشر فوري بدون بوابة دفع`);
  console.log(`💰 العروض المدفوعة: عبر Chargily`);
});
