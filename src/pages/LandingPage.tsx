import { useEffect, useState } from 'react';
import { Link } from '@/lib/router';
import { api, type PlatformStats, type Teacher } from '@/lib/api';
import { TeacherCard, Spinner, StatCard } from '@/components/ui';
import { GraduationCap, Users, Video, PlayCircle, ArrowLeft, ShieldCheck, Clock, Wallet, Sparkles } from 'lucide-react';

export function LandingPage() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [s, t] = await Promise.all([api.getStats(), api.getTeachers()]);
      setStats(s as any);
      setTeachers((t as Teacher[]).slice(0, 4));
      setLoading(false);
    })();
  }, []);

  return (
    <div className="animate-fade-in">
      {/* Hero */}
      <section className="gradient-hero">
        <div className="container-app py-16 md:py-24">
          <div className="grid items-center gap-10 md:grid-cols-2">
            <div className="animate-fade-up">
              <span className="badge bg-[rgb(var(--brand)/0.1)] text-[rgb(var(--brand))]">
                <Sparkles className="h-3.5 w-3.5" /> منصة تعليمية متكاملة
              </span>
              <h1 className="mt-4 text-4xl font-black leading-tight text-balance text-[rgb(var(--ink))] md:text-5xl">
                تعلّم من أفضل الأساتذة
                <br />
                <span className="gradient-text">وانضم للبث المباشر</span>
              </h1>
              <p className="mt-5 max-w-md text-lg text-pretty text-[rgb(var(--muted))]">
                احجز دروسك مع نخبة الأساتذة، وتابع الحصص المباشرة مجاناً عبر Jitsi Meet — في أي وقت ومن أي مكان.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/register" className="btn-primary">
                  ابدأ الآن مجاناً
                  <ArrowLeft className="h-4 w-4" />
                </Link>
                <Link to="/teachers" className="btn-outline">
                  تصفح الأساتذة
                </Link>
              </div>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-[rgb(var(--muted))]">
                <span className="flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-emerald-500" /> آمن وموثوق</span>
                <span className="flex items-center gap-1.5"><Video className="h-4 w-4 text-blue-500" /> بث مباشر مجاني</span>
                <span className="flex items-center gap-1.5"><Wallet className="h-4 w-4 text-amber-500" /> محفظة ذكية</span>
              </div>
            </div>

            <div className="relative hidden md:block animate-fade-up" style={{ animationDelay: '0.1s' }}>
              <div className="animate-float rounded-3xl border border-[rgb(var(--line))] bg-white p-6 shadow-2xl shadow-[rgb(var(--brand)/0.12)]">
                <div className="flex items-center gap-3 border-b border-[rgb(var(--line))] pb-4">
                  <div className="grid h-11 w-11 place-items-center rounded-xl gradient-brand text-white">
                    <PlayCircle className="h-6 w-6" />
                  </div>
                  <div>
                    <div className="text-sm font-bold text-[rgb(var(--ink))]">حصة مباشرة الآن</div>
                    <div className="text-xs text-[rgb(var(--muted))]">الرياضيات — الثالثة ثانوي</div>
                  </div>
                  <span className="badge bg-red-100 text-red-700 mr-auto animate-pulse">مباشر</span>
                </div>
                <div className="mt-4 space-y-3">
                  {['الفيزياء — الثانية ثانوي', 'العلوم الطبيعية — الأولى ثانوي', 'اللغة العربية — متوسط'].map((s, i) => (
                    <div key={i} className="flex items-center gap-3 rounded-xl bg-[rgb(var(--bg))] p-3">
                      <div className="grid h-9 w-9 place-items-center rounded-lg bg-[rgb(var(--brand)/0.1)] text-[rgb(var(--brand))]">
                        <GraduationCap className="h-5 w-5" />
                      </div>
                      <span className="text-sm font-semibold text-[rgb(var(--ink))]">{s}</span>
                      <Clock className="mr-auto h-4 w-4 text-[rgb(var(--muted))]" />
                    </div>
                  ))}
                </div>
              </div>
              <div className="absolute -bottom-4 -left-4 rounded-2xl border border-[rgb(var(--line))] bg-white p-4 shadow-lg">
                <div className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-emerald-500" />
                  <span className="text-sm font-bold text-[rgb(var(--ink))]">+1000 طالب</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Stats */}
      {stats && (
        <section className="container-app -mt-8 relative z-10">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatCard icon={<GraduationCap className="h-6 w-6" />} label="أساتذة" value={stats.teachers_count || 0} color="brand" />
            <StatCard icon={<Users className="h-6 w-6" />} label="طلاب" value={stats.students_count || 0} color="accent" />
            <StatCard icon={<Video className="h-6 w-6" />} label="بث مباشر" value={stats.live_streams || 0} color="amber" />
            <StatCard icon={<PlayCircle className="h-6 w-6" />} label="حصص نشطة" value={stats.active_streams || 0} color="slate" />
          </div>
        </section>
      )}

      {/* Features */}
      <section className="container-app py-16">
        <div className="text-center">
          <h2 className="text-3xl font-black text-[rgb(var(--ink))]">لماذا ZoomDz؟</h2>
          <p className="mt-2 text-[rgb(var(--muted))]">كل ما تحتاجه للتعلم في مكان واحد</p>
        </div>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {[
            { icon: <Video className="h-7 w-7" />, title: 'بث مباشر مجاني', desc: 'انضم للحصص المباشرة عبر Jitsi Meet بدون أي تكلفة إضافية.', color: 'text-blue-500 bg-blue-50' },
            { icon: <GraduationCap className="h-7 w-7" />, title: 'أساتذة مؤهلون', desc: 'نخبة من الأساتذة المعتمدين في جميع المواد والمستويات.', color: 'text-emerald-500 bg-emerald-50' },
            { icon: <Wallet className="h-7 w-7" />, title: 'محفظة ذكية', desc: 'ادفع بسهولة وأمان عبر SofizPay وتابع رصيدك في الوقت الفعلي.', color: 'text-amber-500 bg-amber-50' },
          ].map((f, i) => (
            <div key={i} className="card-hover p-6">
              <div className={`grid h-14 w-14 place-items-center rounded-2xl ${f.color}`}>{f.icon}</div>
              <h3 className="mt-4 text-lg font-bold text-[rgb(var(--ink))]">{f.title}</h3>
              <p className="mt-2 text-sm text-[rgb(var(--muted))]">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Featured teachers */}
      <section className="container-app pb-16">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-3xl font-black text-[rgb(var(--ink))]">أساتذة مميزون</h2>
            <p className="mt-2 text-[rgb(var(--muted))]">تعرّف على نخبة من أفضل الأساتذة</p>
          </div>
          <Link to="/teachers" className="link hidden text-sm sm:inline-flex items-center gap-1">
            عرض الكل <ArrowLeft className="h-4 w-4" />
          </Link>
        </div>
        {loading ? (
          <div className="py-16"><Spinner /></div>
        ) : (
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {teachers.map((t) => <TeacherCard key={t.id} teacher={t} />)}
          </div>
        )}
      </section>

      {/* CTA */}
      <section className="container-app pb-20">
        <div className="overflow-hidden rounded-3xl gradient-brand p-10 text-center text-white md:p-16">
          <h2 className="text-3xl font-black md:text-4xl">جاهز لبدء رحلتك التعليمية؟</h2>
          <p className="mx-auto mt-3 max-w-md text-white/80">انضم لآلاف الطلاب وابدأ التعلم مع أفضل الأساتذة اليوم.</p>
          <Link to="/register" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-bold text-[rgb(var(--brand))] shadow-lg transition hover:scale-105">
            إنشاء حساب مجاني <ArrowLeft className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}
