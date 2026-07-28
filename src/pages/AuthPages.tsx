import { useState } from 'react';
import { Link, navigate } from '@/lib/router';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/lib/toast';
import type { Role } from '@/lib/api';
import { Mail, Lock, Eye, EyeOff, GraduationCap, User, ShieldCheck, Phone, BookOpen } from 'lucide-react';

export function LoginPage() {
  const { login } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('student');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const res = await login(email, password, role);
    setLoading(false);
    if (res.success && res.user) {
      toast.show('مرحباً بعودتك!', 'success');
      navigate(res.user.role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard');
    } else {
      toast.show(res.error || 'فشل تسجيل الدخول', 'error');
    }
  };

  return (
    <div className="container-app py-12 md:py-16">
      <div className="mx-auto max-w-md animate-fade-up">
        <div className="card p-8">
          <div className="mb-6 text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl gradient-brand text-white shadow-lg">
              <GraduationCap className="h-7 w-7" />
            </div>
            <h1 className="mt-4 text-2xl font-black text-[rgb(var(--ink))]">تسجيل الدخول</h1>
            <p className="mt-1 text-sm text-[rgb(var(--muted))]">أهلاً بك من جديد في ZoomDz</p>
          </div>

          {/* Role toggle */}
          <div className="mb-5 grid grid-cols-2 gap-2 rounded-xl bg-[rgb(var(--bg))] p-1">
            {(['student', 'teacher'] as Role[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className={`rounded-lg py-2.5 text-sm font-bold transition-all ${role === r ? 'bg-white text-[rgb(var(--brand))] shadow-sm' : 'text-[rgb(var(--muted))] hover:text-[rgb(var(--ink))]'}`}
              >
                {r === 'student' ? 'طالب' : 'أستاذ'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label">البريد الإلكتروني</label>
              <div className="relative">
                <Mail className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[rgb(var(--muted))]" />
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="input pr-11" placeholder="example@email.com" />
              </div>
            </div>
            <div>
              <label className="label">كلمة المرور</label>
              <div className="relative">
                <Lock className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[rgb(var(--muted))]" />
                <input type={showPw ? 'text' : 'password'} required value={password} onChange={(e) => setPassword(e.target.value)} className="input px-11" placeholder="••••••••" />
                <button type="button" onClick={() => setShowPw(!showPw)} className="absolute left-3 top-1/2 -translate-y-1/2 text-[rgb(var(--muted))] hover:text-[rgb(var(--ink))]">
                  {showPw ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? 'جاري الدخول...' : 'تسجيل الدخول'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-[rgb(var(--muted))]">
            ليس لديك حساب؟ <Link to="/register" className="link">إنشاء حساب جديد</Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export function RegisterPage() {
  const { registerStudent, registerTeacher } = useAuth();
  const toast = useToast();
  const [role, setRole] = useState<Role>('student');
  const [form, setForm] = useState({ full_name: '', email: '', password: '', phone: '', education_level: '' });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);

  const levels = ['الابتدائي', 'المتوسط', 'الثانية ثانوي', 'الثالثة ثانوي', 'الجامعي'];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    if (role === 'student') {
      const res = await registerStudent({ ...form, recaptcha_token: 'dummy' });
      setLoading(false);
      if (res.success) {
        toast.show('تم إنشاء حسابك بنجاح!', 'success');
        navigate('/student-dashboard');
      } else {
        toast.show(res.error || 'فشل التسجيل', 'error');
      }
    } else {
      const res = await registerTeacher({ full_name: form.full_name, email: form.email, password: form.password, recaptcha_token: 'dummy' });
      setLoading(false);
      if (res.success) {
        toast.show('تم إنشاء حسابك! يرجى تسجيل الدخول', 'success');
        navigate('/login');
      } else {
        toast.show(res.error || 'فشل التسجيل', 'error');
      }
    }
  };

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="container-app py-12 md:py-16">
      <div className="mx-auto max-w-md animate-fade-up">
        <div className="card p-8">
          <div className="mb-6 text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl gradient-brand text-white shadow-lg">
              <User className="h-7 w-7" />
            </div>
            <h1 className="mt-4 text-2xl font-black text-[rgb(var(--ink))]">إنشاء حساب</h1>
            <p className="mt-1 text-sm text-[rgb(var(--muted))]">انضم لمنصة ZoomDz التعليمية</p>
          </div>

          <div className="mb-5 grid grid-cols-2 gap-2 rounded-xl bg-[rgb(var(--bg))] p-1">
            {(['student', 'teacher'] as Role[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className={`rounded-lg py-2.5 text-sm font-bold transition-all ${role === r ? 'bg-white text-[rgb(var(--brand))] shadow-sm' : 'text-[rgb(var(--muted))] hover:text-[rgb(var(--ink))]'}`}
              >
                {r === 'student' ? 'طالب' : 'أستاذ'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label">الاسم الكامل</label>
              <input required value={form.full_name} onChange={(e) => set('full_name', e.target.value)} className="input" placeholder="الاسم الكامل" />
            </div>
            <div>
              <label className="label">البريد الإلكتروني</label>
              <div className="relative">
                <Mail className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[rgb(var(--muted))]" />
                <input type="email" required value={form.email} onChange={(e) => set('email', e.target.value)} className="input pr-11" placeholder="example@email.com" />
              </div>
            </div>
            <div>
              <label className="label">كلمة المرور</label>
              <div className="relative">
                <Lock className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[rgb(var(--muted))]" />
                <input type={showPw ? 'text' : 'password'} required minLength={8} value={form.password} onChange={(e) => set('password', e.target.value)} className="input px-11" placeholder="8 أحرف على الأقل" />
                <button type="button" onClick={() => setShowPw(!showPw)} className="absolute left-3 top-1/2 -translate-y-1/2 text-[rgb(var(--muted))] hover:text-[rgb(var(--ink))]">
                  {showPw ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
              <p className="mt-1 text-xs text-[rgb(var(--muted))]">يجب أن تحتوي على حرف كبير وحرف صغير ورقم</p>
            </div>
            {role === 'student' && (
              <>
                <div>
                  <label className="label">رقم الهاتف</label>
                  <div className="relative">
                    <Phone className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[rgb(var(--muted))]" />
                    <input required value={form.phone} onChange={(e) => set('phone', e.target.value)} className="input pr-11" placeholder="06xxxxxxxx" />
                  </div>
                </div>
                <div>
                  <label className="label">المستوى الدراسي</label>
                  <div className="relative">
                    <BookOpen className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[rgb(var(--muted))]" />
                    <select required value={form.education_level} onChange={(e) => set('education_level', e.target.value)} className="input pr-11">
                      <option value="">اختر المستوى</option>
                      {levels.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                </div>
              </>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? 'جاري الإنشاء...' : 'إنشاء الحساب'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-[rgb(var(--muted))]">
            لديك حساب بالفعل؟ <Link to="/login" className="link">تسجيل الدخول</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
