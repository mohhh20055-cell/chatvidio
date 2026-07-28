import { Link } from '@/lib/router';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/lib/toast';
import { useState } from 'react';
import { Menu, X, GraduationCap, LogOut, User as UserIcon, LayoutDashboard, Video, ExternalLink } from 'lucide-react';

const APP_URL = 'https://chatvidio.vercel.app';

export function Header() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);

  const showAppLink = () => {
    toast.show('رابط التطبيق الجديد جاهز الآن!', 'success', APP_URL, 'افتح التطبيق');
  };

  const navLink = (to: string, label: string) => (
    <Link to={to} className="text-sm font-semibold text-[rgb(var(--ink))/0.7] transition-colors hover:text-[rgb(var(--brand))]" onClick={() => setOpen(false)}>
      {label}
    </Link>
  );

  return (
    <header className="sticky top-0 z-50 glass border-b border-[rgb(var(--line))]">
      <div className="container-app flex h-16 items-center justify-between">
        <div className="flex items-center gap-2.5">
          <button
            onClick={showAppLink}
            className="group grid h-10 w-10 place-items-center rounded-xl gradient-brand text-white shadow-lg shadow-[rgb(var(--brand)/0.3)] transition-transform hover:scale-105 active:scale-95"
            aria-label="رابط التطبيق الجديد"
            title="اضغط لعرض رابط التطبيق الجديد"
          >
            <GraduationCap className="h-6 w-6" />
          </button>
          <Link to="/">
            <span className="text-xl font-black tracking-tight text-[rgb(var(--ink))]">ZoomDz</span>
          </Link>
        </div>

        <nav className="hidden items-center gap-7 md:flex">
          {navLink('/teachers', 'الأساتذة')}
          {navLink('/offers', 'العروض')}
          {navLink('/live', 'البث المباشر')}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          {user ? (
            <>
              <Link to={user.role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard'} className="btn-outline">
                <LayoutDashboard className="h-4 w-4" />
                لوحة التحكم
              </Link>
              <button onClick={logout} className="btn-ghost" aria-label="تسجيل الخروج">
                <LogOut className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="btn-ghost">تسجيل الدخول</Link>
              <Link to="/register" className="btn-primary">إنشاء حساب</Link>
            </>
          )}
        </div>

        <button className="md:hidden text-[rgb(var(--ink))]" onClick={() => setOpen(!open)} aria-label="القائمة">
          {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>

      {open && (
        <div className="md:hidden border-t border-[rgb(var(--line))] bg-white animate-fade-in">
          <div className="container-app flex flex-col gap-1 py-4">
            {navLink('/teachers', 'الأساتذة')}
            {navLink('/offers', 'العروض')}
            {navLink('/live', 'البث المباشر')}
            <div className="mt-3 flex flex-col gap-2 border-t border-[rgb(var(--line))] pt-3">
              {user ? (
                <>
                  <Link to={user.role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard'} className="btn-outline" onClick={() => setOpen(false)}>
                    <LayoutDashboard className="h-4 w-4" /> لوحة التحكم
                  </Link>
                  <button onClick={() => { logout(); setOpen(false); }} className="btn-ghost">
                    <LogOut className="h-4 w-4" /> تسجيل الخروج
                  </button>
                </>
              ) : (
                <>
                  <Link to="/login" className="btn-outline" onClick={() => setOpen(false)}>تسجيل الدخول</Link>
                  <Link to="/register" className="btn-primary" onClick={() => setOpen(false)}>إنشاء حساب</Link>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

export function Footer() {
  const toast = useToast();
  const showAppLink = () => {
    toast.show('رابط التطبيق الجديد جاهز الآن!', 'success', APP_URL, 'افتح التطبيق');
  };
  return (
    <footer className="mt-20 border-t border-[rgb(var(--line))] bg-white">
      <div className="container-app py-12">
        <div className="grid gap-8 md:grid-cols-4">
          <div className="md:col-span-2">
            <div className="flex items-center gap-2.5">
              <button
                onClick={showAppLink}
                className="group grid h-9 w-9 place-items-center rounded-lg gradient-brand text-white transition-transform hover:scale-105 active:scale-95"
                aria-label="رابط التطبيق الجديد"
                title="اضغط لعرض رابط التطبيق الجديد"
              >
                <GraduationCap className="h-5 w-5" />
              </button>
              <span className="text-lg font-black text-[rgb(var(--ink))]">ZoomDz</span>
            </div>
            <p className="mt-3 max-w-sm text-sm text-[rgb(var(--muted))]">
              منصة التعليم والبث المباشر — تعلّم من أفضل الأساتذة وانضم للحصص المباشرة مجاناً عبر Jitsi Meet.
            </p>
          </div>
          <div>
            <h4 className="mb-3 text-sm font-bold text-[rgb(var(--ink))]">روابط سريعة</h4>
            <ul className="space-y-2 text-sm text-[rgb(var(--muted))]">
              <li><Link to="/teachers" className="hover:text-[rgb(var(--brand))]">الأساتذة</Link></li>
              <li><Link to="/offers" className="hover:text-[rgb(var(--brand))]">العروض</Link></li>
              <li><Link to="/live" className="hover:text-[rgb(var(--brand))]">البث المباشر</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="mb-3 text-sm font-bold text-[rgb(var(--ink))]">الحساب</h4>
            <ul className="space-y-2 text-sm text-[rgb(var(--muted))]">
              <li><Link to="/login" className="hover:text-[rgb(var(--brand))]">تسجيل الدخول</Link></li>
              <li><Link to="/register" className="hover:text-[rgb(var(--brand))]">إنشاء حساب</Link></li>
            </ul>
          </div>
        </div>
        <div className="mt-10 border-t border-[rgb(var(--line))] pt-6 text-center text-sm text-[rgb(var(--muted))]">
          © {new Date().getFullYear()} ZoomDz — جميع الحقوق محفوظة
        </div>
      </div>
    </footer>
  );
}
