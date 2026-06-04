// الصفحة الرئيسية - دوال مشتركة

function showTeachers() {
    document.getElementById('teachersSection').style.display = 'block';
    document.getElementById('loginSection').style.display = 'none';
    loadTeachersList();
}

function showLogin() {
    document.getElementById('teachersSection').style.display = 'none';
    document.getElementById('loginSection').style.display = 'block';
    switchTab('login');
}

function showTeacherRegister() {
    document.getElementById('teachersSection').style.display = 'none';
    document.getElementById('loginSection').style.display = 'block';
    switchTab('teacher-register');
}

async function loadTeachersList() {
    const res = await fetch('/api/teachers');
    const teachers = await res.json();
    const container = document.getElementById('teachersList');
    
    if (!teachers.length) {
        container.innerHTML = '<p style="text-align:center">لا يوجد أساتذة مسجلون حالياً</p>';
        return;
    }
    
    let html = '';
    teachers.forEach(t => {
        html += `<div class="teacher-card">
            <h3><i class="fas fa-user-graduate"></i> ${t.full_name}</h3>
            <p><i class="fas fa-book"></i> ${t.specialization || 'تخصص عام'}</p>
            <p>${t.bio || 'أستاذ معتمد على المنصة'}</p>
            <p><strong>${t.hourly_rate} دج</strong> / الحصة</p>
            ${localStorage.getItem('studentToken') ? 
                `<button class="btn-primary" onclick="alert('يرجى تسجيل الدخول كطالب أولاً')">حجز حصة</button>` :
                `<button class="btn-outline" onclick="showLogin()">سجل دخولك كطالب</button>`}
        </div>`;
    });
    container.innerHTML = html;
}

function switchTab(tab) {
    const tabs = ['login', 'student-register', 'teacher-register'];
    tabs.forEach(t => {
        document.getElementById(t === 'login' ? 'loginTab' : t === 'student-register' ? 'studentRegisterTab' : 'teacherRegisterTab').style.display = 'none';
    });
    
    if (tab === 'login') {
        document.getElementById('loginTab').style.display = 'block';
    } else if (tab === 'student-register') {
        document.getElementById('studentRegisterTab').style.display = 'block';
    } else {
        document.getElementById('teacherRegisterTab').style.display = 'block';
    }
    
    document.querySelectorAll('.tab-btn').forEach((btn, i) => {
        btn.classList.remove('active');
        if ((tab === 'login' && i === 0) || (tab === 'student-register' && i === 1) || (tab === 'teacher-register' && i === 2)) {
            btn.classList.add('active');
        }
    });
}

async function login() {
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const role = document.getElementById('loginRole').value;
    
    if (!email || !password) {
        alert('يرجى إدخال البريد الإلكتروني وكلمة المرور');
        return;
    }
    
    const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, role })
    });
    
    const data = await res.json();
    
    if (data.success) {
        if (role === 'admin' || email === 'admin@platform.com') {
            localStorage.setItem('adminToken', data.token);
            localStorage.setItem('adminData', JSON.stringify(data.user));
            window.location.href = '/admin.html';
        } else if (role === 'teacher') {
            localStorage.setItem('teacherToken', data.token);
            localStorage.setItem('teacherData', JSON.stringify(data.user));
            window.location.href = '/teacher-dashboard.html';
        } else {
            localStorage.setItem('studentToken', data.token);
            localStorage.setItem('studentData', JSON.stringify(data.user));
            window.location.href = '/student-dashboard.html';
        }
    } else {
        alert(data.error || 'فشل تسجيل الدخول');
    }
}

async function registerStudent() {
    const full_name = document.getElementById('studentName').value;
    const email = document.getElementById('studentEmail').value;
    const password = document.getElementById('studentPassword').value;
    const phone = document.getElementById('studentPhone').value;
    
    if (!full_name || !email || !password) {
        alert('يرجى ملء جميع الحقول المطلوبة');
        return;
    }
    
    const res = await fetch('/api/student/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name, email, password, phone })
    });
    
    const data = await res.json();
    
    if (data.success) {
        alert('تم التسجيل بنجاح! يمكنك تسجيل الدخول الآن');
        switchTab('login');
    } else {
        alert(data.error || 'حدث خطأ في التسجيل');
    }
}

async function registerTeacher() {
    const full_name = document.getElementById('teacherName').value;
    const email = document.getElementById('teacherEmail').value;
    const password = document.getElementById('teacherPassword').value;
    const phone = document.getElementById('teacherPhone').value;
    const specialization = document.getElementById('teacherSpecialization').value;
    const bio = document.getElementById('teacherBio').value;
    const hourly_rate = document.getElementById('teacherRate').value;
    
    if (!full_name || !email || !password) {
        alert('يرجى ملء الحقول الأساسية');
        return;
    }
    
    const res = await fetch('/api/teacher/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name, email, password, phone, specialization, bio, hourly_rate })
    });
    
    const data = await res.json();
    
    if (data.success) {
        alert('تم إرسال طلبك بنجاح! سيتم إعلامك عند قبول طلبك');
        switchTab('login');
    } else {
        alert(data.error || 'حدث خطأ في تقديم الطلب');
    }
}

// تحميل الأساتذة عند فتح الصفحة إذا كان القسم ظاهراً
if (document.getElementById('teachersSection').style.display === 'block') {
    loadTeachersList();
}