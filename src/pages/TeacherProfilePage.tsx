import { useEffect, useState } from 'react';
import { useParams, navigate, Link } from '@/lib/router';
import { api, type TeacherProfile, type Offer } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/lib/toast';
import { Spinner, EmptyState, Avatar, Stars, OfferCard } from '@/components/ui';
import { formatPrice, formatDate } from '@/lib/format';
import { ArrowRight, GraduationCap, Users, BookOpen, Video, Wallet, Calendar, MessageSquare } from 'lucide-react';

export function TeacherProfilePage() {
  const params = useParams();
  const id = parseInt(params.id || '0');
  const { user } = useAuth();
  const toast = useToast();
  const [teacher, setTeacher] = useState<TeacherProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [booking, setBooking] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await api.getTeacher(id);
      if ((res as any).success === false) {
        setTeacher(null);
      } else {
        setTeacher(res as TeacherProfile);
      }
      setLoading(false);
    })();
  }, [id]);

  const handleBook = async (offer: Offer) => {
    if (!user || user.role !== 'student') {
      toast.show('يجب تسجيل الدخول كطالب للحجز', 'warning');
      navigate('/login');
      return;
    }
    setBooking(offer.id);
    const res = await api.createBooking(offer.id, user.id);
    setBooking(null);
    if (res.success) {
      toast.show('تم حجز الحصة بنجاح!', 'success');
    } else {
      toast.show(res.error || 'فشل الحجز', 'error');
    }
  };

  if (loading) return <div className="py-20"><Spinner /></div>;
  if (!teacher) return <EmptyState icon={<GraduationCap className="h-8 w-8" />} title="الأستاذ غير موجود" action={<Link to="/teachers" className="btn-primary">العودة للأساتذة</Link>} />;

  return (
    <div className="container-app py-10 animate-fade-in">
      <Link to="/teachers" className="mb-6 inline-flex items-center gap-1 text-sm font-bold text-[rgb(var(--muted))] hover:text-[rgb(var(--brand))]">
        <ArrowRight className="h-4 w-4" /> العودة للأساتذة
      </Link>

      {/* Profile header */}
      <div className="card overflow-hidden">
        <div className="gradient-brand h-28" />
        <div className="px-6 pb-6">
          <div className="-mt-12 flex flex-col items-start gap-4 sm:flex-row sm:items-end">
            <div className="rounded-full border-4 border-white bg-white">
              <Avatar name={teacher.full_name} src={teacher.profile_image} size={96} />
            </div>
            <div className="flex-1 pb-2">
              <h1 className="text-2xl font-black text-[rgb(var(--ink))]">{teacher.full_name}</h1>
              {teacher.specialization && <p className="text-[rgb(var(--muted))]">{teacher.specialization}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {teacher.teaching_level_display && <span className="chip">{teacher.teaching_level_display}</span>}
                <Stars rating={teacher.rating || 0} />
              </div>
            </div>
            {teacher.has_live_stream && (
              <span className="badge bg-red-100 text-red-700 animate-pulse"><Video className="h-3.5 w-3.5" /> بث مباشر الآن</span>
            )}
          </div>

          {teacher.bio && <p className="mt-5 text-pretty text-[rgb(var(--ink))/0.8]">{teacher.bio}</p>}

          <div className="mt-5 grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-[rgb(var(--bg))] p-4 text-center">
              <BookOpen className="mx-auto h-5 w-5 text-[rgb(var(--brand))]" />
              <div className="mt-1 text-lg font-black text-[rgb(var(--ink))]">{teacher.stats.total_offers}</div>
              <div className="text-xs text-[rgb(var(--muted))]">عرض</div>
            </div>
            <div className="rounded-xl bg-[rgb(var(--bg))] p-4 text-center">
              <Users className="mx-auto h-5 w-5 text-emerald-500" />
              <div className="mt-1 text-lg font-black text-[rgb(var(--ink))]">{teacher.stats.total_students}</div>
              <div className="text-xs text-[rgb(var(--muted))]">طالب</div>
            </div>
            <div className="rounded-xl bg-[rgb(var(--bg))] p-4 text-center">
              <Wallet className="mx-auto h-5 w-5 text-amber-500" />
              <div className="mt-1 text-lg font-black text-[rgb(var(--ink))]">{formatPrice(teacher.stats.pending_balance)}</div>
              <div className="text-xs text-[rgb(var(--muted))]">معلق</div>
            </div>
          </div>
        </div>
      </div>

      {/* Offers */}
      <section className="mt-8">
        <h2 className="mb-4 text-xl font-black text-[rgb(var(--ink))]">عروض الأستاذ</h2>
        {teacher.offers && teacher.offers.length > 0 ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {teacher.offers.map((o) => (
              <div key={o.id} className="card-hover flex flex-col p-5">
                <div className="flex items-start justify-between">
                  <h3 className="text-base font-bold text-[rgb(var(--ink))]">{o.subject_name}</h3>
                  <span className={`badge ${o.status === 'live' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>
                    {o.status === 'live' ? 'مباشر' : 'قادم'}
                  </span>
                </div>
                {o.description && <p className="mt-2 line-clamp-2 text-sm text-[rgb(var(--muted))]">{o.description}</p>}
                <div className="mt-3 flex items-center gap-3 text-xs text-[rgb(var(--muted))]">
                  <span className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" /> {formatDate(o.offer_date)}</span>
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-[rgb(var(--line))] pt-3">
                  <span className="text-lg font-black text-[rgb(var(--brand))]">{formatPrice(o.price)}</span>
                  <button
                    onClick={() => handleBook(o)}
                    disabled={booking === o.id}
                    className="btn-accent text-xs"
                  >
                    {booking === o.id ? 'جاري الحجز...' : 'حجز الحصة'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={<BookOpen className="h-8 w-8" />} title="لا توجد عروض حالياً" />
        )}
      </section>

      {/* Posts */}
      {teacher.posts && teacher.posts.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-4 text-xl font-black text-[rgb(var(--ink))]">منشورات الأستاذ</h2>
          <div className="space-y-3">
            {teacher.posts.slice(0, 5).map((p: any) => (
              <div key={p.id} className="card p-5">
                <p className="text-sm text-[rgb(var(--ink))/0.8]">{p.content || p.title || ''}</p>
                <span className="mt-2 block text-xs text-[rgb(var(--muted))]">{formatDate(p.created_at)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
