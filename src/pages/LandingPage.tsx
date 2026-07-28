import { useEffect, useState } from 'react';
import { Link } from '@/lib/router';
import { api, type PlatformStats, type Teacher } from '@/lib/api';
import { TeacherCard, Spinner, StatCard } from '@/components/ui';
import { GraduationCap, Users, Video, PlayCircle, ArrowLeft, ShieldCheck, Clock, Wallet, Sparkles, Star, CreditCard, Trophy, Smartphone, Send, Headset, Gift } from 'lucide-react';

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
                <Star className="h-3.5 w-3.5" /> منصة تعليمية جزائرية
              </span>
              <h1 className="mt-4 text-4xl font-black leading-tight text-balance text-[rgb(var(--ink))] md:text-5xl">
                تعلم مع أفضل الأساتذة
                <br />
                <span className="gradient-text">في الجزائر</span>
              </h1>
              <p className="mt-5 max-w-md text-lg text-pretty text-[rgb(var(--muted))]">
                دروس خصوصية عبر الفيديو مع نخبة من الأساتذة المعتمدين. ادفع عبر البطاقة الذهبية بسهولة وأمان
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/teachers" className="btn-primary">
                  <Users className="h-4 w-4" />
                  تعرف على أساتذتنا
                </Link>
                <Link to="/register" className="btn-accent">
                  <GraduationCap className="h-4 w-4" />
                  انضم كأستاذ
                </Link>
                <a href="https://t.me/zoomdz1" target="_blank" rel="noopener noreferrer" className="btn-outline">
                  <Send className="h-4 w-4" />
                  قناتنا
                </a>
              </div>
            </div>

            <div className="relative hidden md:block animate-fade-up" style={{ animationDelay: '0.1s' }}>
              <div className="animate-float rounded-3xl border border-[rgb(var(--line))] bg-white p-6 shadow-2xl shadow-[rgb(var(--brand)/0.12)]">
                <div className="flex items-center gap-3 border-b border-[rgb(var(--line))] pb-4">
                  <div className="grid h-11 w-11 place-items-center rounded-xl gradient-brand text-white">
                    <Smartphone className="h-6 w-6" />
                  </div>
                  <div>
                    <div className="text-sm font-bold text-[rgb(var(--ink))]">تطبيق موبايل</div>
                    <div className="text-xs text-[rgb(var(--muted))]">تجربة سلسة</div>
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  {[
                    { icon: <Star className="h-5 w-5" />, title: 'أفضل الأساتذة', sub: 'معتمدون' },
                    { icon: <CreditCard className="h-5 w-5" />, title: 'دفع آمن', sub: 'البطاقة الذهبية' },
                    { icon: <Video className="h-5 w-5" />, title: 'بث مباشر', sub: 'مجاني 100%' },
                  ].map((s, i) => (
                    <div key={i} className="flex items-center gap-3 rounded-xl bg-[rgb(var(--bg))] p-3">
                      <div className="grid h-9 w-9 place-items-center rounded-lg bg-[rgb(var(--brand)/0.1)] text-[rgb(var(--brand))]">
                        {s.icon}
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-[rgb(var(--ink))]">{s.title}</div>
                        <div className="text-xs text-[rgb(var(--muted))]">{s.sub}</div>
                      </div>
                    </div>
                  ))}
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

      {/* About */}
      <section className="container-app py-16">
        <div className="card p-8 md:p-10">
          <div className="grid gap-8 md:grid-cols-2">
            <div>
              <h2 className="text-2xl font-black text-[rgb(var(--ink))]">
                <GraduationCap className="ml-2 inline h-7 w-7 text-[rgb(var(--brand))]" />
                عن منصة ZoomDz
              </h2>
              <p className="mt-4 text-[rgb(var(--muted))]">
                <span className="font-bold text-[rgb(var(--ink))]">ZoomDz</span>
                {' '}هي منصة تعليمية جزائرية مبتكرة تهدف إلى ربط الطلاب مع أفضل الأساتذة في مختلف التخصصات عبر دروس خصوصية مباشرة عن بعد.
              </p>
              <p className="mt-3 text-[rgb(var(--muted))]">
                <ShieldCheck className="ml-1 inline h-4 w-4 text-[rgb(var(--brand))]" />
                <strong className="text-[rgb(var(--ink))]"> رؤيتنا:</strong>
                {' '}تمكين كل طالب في الجزائر من الوصول إلى تعليم نوعي بأسعار معقولة، دون قيود جغرافية أو زمانية.
              </p>
              <p className="mt-3 text-[rgb(var(--muted))]">
                <Trophy className="ml-1 inline h-4 w-4 text-emerald-500" />
                <strong className="text-[rgb(var(--ink))]"> هدفنا:</strong>
                {' '}بناء مجتمع تعليمي رقمي متكامل يجمع بين الجودة، السهولة، والأمان، حيث يمكن للطلاب التعلم بمرونة والأساتذة مشاركة خبراتهم بكفاءة.
              </p>
              <p className="mt-4 rounded-lg border-r-4 border-[rgb(var(--brand))] bg-[rgb(var(--bg))] p-4 text-sm text-[rgb(var(--muted))]">
                نؤمن بأن التعليم الجيد هو حق لكل جزائري، ومنصتنا هي الجسر الذي يوصلك إلى أفضل الكفاءات في وطننا.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {[
                { icon: <Smartphone className="h-6 w-6" />, title: 'تطبيق موبايل', desc: 'منصة حديثة وسريعة تعمل بسلاسة على الهاتف', color: 'bg-blue-50 text-blue-500' },
                { icon: <CreditCard className="h-6 w-6" />, title: 'دفع آمن', desc: 'عبر EDAHABIA و CCP', color: 'bg-emerald-50 text-emerald-500' },
                { icon: <Trophy className="h-6 w-6" />, title: 'أساتذة معتمدون', desc: 'نخبة من أفضل الأساتذة في الجزائر', color: 'bg-amber-50 text-amber-500' },
                { icon: <Smartphone className="h-6 w-6" />, title: 'سهولة الاستخدام', desc: 'تصميم عصري يتكيف مع جميع الأجهزة', color: 'bg-slate-50 text-slate-500' },
              ].map((f, i) => (
                <div key={i} className="rounded-2xl border border-[rgb(var(--line))] bg-white p-5">
                  <div className={`grid h-12 w-12 place-items-center rounded-xl ${f.color}`}>{f.icon}</div>
                  <h4 className="mt-3 font-bold text-[rgb(var(--ink))]">{f.title}</h4>
                  <p className="mt-1 text-sm text-[rgb(var(--muted))]">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Steps */}
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            {[
              'اختر الأستاذ المناسب',
              'احجز الدرس المناسب',
              'ادفع بأمان عبر البطاقة الذهبية',
              'استخدم التطبيق من هاتفك مباشرة',
              'أو تصفّح الدورات التعليمية حسب مستواك',
            ].map((step, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-full gradient-brand text-sm font-black text-white">{i + 1}</span>
                <span className="text-sm font-semibold text-[rgb(var(--ink))]">{step}</span>
                {i < 4 && <ArrowLeft className="h-4 w-4 text-[rgb(var(--muted))]" />}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="container-app pb-16">
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

      {/* Referral teaser */}
      <section className="container-app pb-16">
        <div className="card-hover overflow-hidden p-8 md:p-10">
          <div className="flex flex-col items-center gap-6 md:flex-row">
            <div className="grid h-16 w-16 place-items-center rounded-2xl bg-amber-50 text-amber-500">
              <Gift className="h-8 w-8" />
            </div>
            <div className="flex-1 text-center md:text-right">
              <h2 className="text-2xl font-black text-[rgb(var(--ink))]">نظام الإحالة والمكافآت</h2>
              <p className="mt-2 text-[rgb(var(--muted))]">ادعُ أصدقاءك واحصل على مكافآت مجزية — 100 دج لكل أستاذ تحيله، وصندوق هدايا لكل طالب!</p>
            </div>
            <Link to="/register" className="btn-primary shrink-0">
              ابدأ واربح <ArrowLeft className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* Support */}
      <section className="container-app pb-16">
        <div className="card p-8 md:p-10">
          <div className="text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-blue-50 text-blue-500">
              <Headset className="h-7 w-7" />
            </div>
            <h2 className="mt-4 text-2xl font-black text-[rgb(var(--ink))]">تواصل مع الدعم الفني</h2>
            <p className="mt-2 text-[rgb(var(--muted))]">لديك سؤال أو استفسار؟ فريق الدعم جاهز لمساعدتك على مدار الساعة</p>
          </div>
          <form className="mx-auto mt-8 max-w-lg space-y-4" onSubmit={(e) => { e.preventDefault(); }}>
            <div className="grid gap-4 sm:grid-cols-2">
              <input className="input" placeholder="الاسم الكامل" required />
              <input type="email" className="input" placeholder="البريد الإلكتروني" required />
            </div>
            <input className="input" placeholder="رقم الهاتف (اختياري)" />
            <input className="input" placeholder="الموضوع" required />
            <textarea className="input min-h-[100px]" placeholder="اكتب رسالتك هنا..." required />
            <button type="submit" className="btn-primary w-full">
              <Send className="h-4 w-4" /> إرسال الرسالة
            </button>
          </form>
        </div>
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
