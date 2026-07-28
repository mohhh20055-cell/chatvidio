import { useEffect, useState } from 'react';
import { api, type Booking, type Offer } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/lib/toast';
import { Spinner, EmptyState, StatCard, Avatar } from '@/components/ui';
import { Link, navigate } from '@/lib/router';
import { formatPrice, formatDateTime, getStatusBadge } from '@/lib/format';
import { Wallet, BookOpen, Video, Calendar, X, GraduationCap, ArrowRight, Clock } from 'lucide-react';

export function StudentDashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const toast = useToast();
  const [balance, setBalance] = useState<number | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<number | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user || user.role !== 'student') { navigate('/login'); return; }
    (async () => {
      const [b, bk] = await Promise.all([
        api.getStudentBalance(user.id),
        api.getStudentBookings(user.id),
      ]);
      if ((b as any).success !== false) setBalance((b as any).balance ?? 0);
      setBookings(bk as Booking[]);
      setLoading(false);
    })();
  }, [user, authLoading]);

  const cancelBooking = async (sessionId: number) => {
    if (!user) return;
    setCancelling(sessionId);
    const res = await api.cancelBooking(sessionId, user.id);
    setCancelling(null);
    if (res.success) {
      toast.show('تم إلغاء الحجز', 'success');
      setBookings((b) => b.filter((x) => x.id !== sessionId));
    } else {
      toast.show(res.error || 'فشل الإلغاء', 'error');
    }
  };

  if (authLoading || loading) return <div className="py-20"><Spinner /></div>;
  if (!user) return null;

  const activeBookings = bookings.filter((b) => b.payment_status === 'paid' || b.payment_status === 'pending_stream');
  const pastBookings = bookings.filter((b) => b.payment_status !== 'paid' && b.payment_status !== 'pending_stream');

  return (
    <div className="container-app py-10 animate-fade-in">
      {/* Header */}
      <div className="mb-8 flex items-center gap-4">
        <Avatar name={user.name} size={56} />
        <div>
          <h1 className="text-2xl font-black text-[rgb(var(--ink))]">{user.name}</h1>
          <p className="text-sm text-[rgb(var(--muted))]">{user.education_level || 'طالب'}</p>
        </div>
      </div>

      {/* Stats */}
      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatCard icon={<Wallet className="h-6 w-6" />} label="رصيد المحفظة" value={formatPrice(balance ?? 0)} color="amber" />
        <StatCard icon={<BookOpen className="h-6 w-6" />} label="الحجوزات النشطة" value={activeBookings.length} color="brand" />
        <StatCard icon={<Video className="h-6 w-6" />} label="إجمالي الحصص" value={bookings.length} color="accent" />
      </div>

      {/* Active bookings */}
      <section className="mb-8">
        <h2 className="mb-4 text-xl font-black text-[rgb(var(--ink))]">حصصي النشطة</h2>
        {activeBookings.length === 0 ? (
          <EmptyState
            icon={<Calendar className="h-8 w-8" />}
            title="لا توجد حجوزات نشطة"
            subtitle="تصفح العروض واحجز حصتك الأولى"
            action={<Link to="/offers" className="btn-primary">تصفح العروض</Link>}
          />
        ) : (
          <div className="space-y-3">
            {activeBookings.map((b) => {
              const status = getStatusBadge(b.payment_status);
              return (
                <div key={b.id} className="card flex items-center gap-4 p-4">
                  <div className="grid h-12 w-12 place-items-center rounded-xl bg-[rgb(var(--brand)/0.1)] text-[rgb(var(--brand))]">
                    <Video className="h-6 w-6" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-bold text-[rgb(var(--ink))]">{b.offers?.subject_name || 'حصة'}</h3>
                    <span className="text-xs text-[rgb(var(--muted))]">{formatDateTime(b.created_at)}</span>
                  </div>
                  <span className={`badge ${status.color}`}>{status.label}</span>
                  {b.payment_status === 'paid' && (
                    <a href={api.getJoinUrl(b.offer_id)} target="_blank" rel="noopener noreferrer" className="btn-accent text-xs">
                      انضم للبث <ArrowRight className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {b.payment_status === 'pending' && (
                    <button onClick={() => cancelBooking(b.id)} disabled={cancelling === b.id} className="btn-ghost text-xs text-red-500">
                      {cancelling === b.id ? '...' : <X className="h-4 w-4" />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Past bookings */}
      {pastBookings.length > 0 && (
        <section>
          <h2 className="mb-4 text-xl font-black text-[rgb(var(--ink))]">السجل</h2>
          <div className="space-y-2">
            {pastBookings.slice(0, 10).map((b) => {
              const status = getStatusBadge(b.payment_status);
              return (
                <div key={b.id} className="card flex items-center gap-4 p-3 opacity-70">
                  <div className="grid h-10 w-10 place-items-center rounded-lg bg-[rgb(var(--ink)/0.04)] text-[rgb(var(--muted))]">
                    <Clock className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-bold text-[rgb(var(--ink))]">{b.offers?.subject_name || 'حصة'}</h3>
                    <span className="text-xs text-[rgb(var(--muted))]">{formatDateTime(b.created_at)}</span>
                  </div>
                  <span className={`badge ${status.color}`}>{status.label}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

export function TeacherDashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const toast = useToast();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [balance, setBalance] = useState<{ balance: number; total_earned: number; pending_withdraw: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newOffer, setNewOffer] = useState({ subject_name: '', description: '', duration: 60, price: 0, offer_date: '', max_students: 30 });

  useEffect(() => {
    if (authLoading) return;
    if (!user || user.role !== 'teacher') { navigate('/login'); return; }
    (async () => {
      const [o, b] = await Promise.all([
        api.getTeacherOffers(user.id),
        api.getTeacherBalance(user.id),
      ]);
      setOffers(o as Offer[]);
      if ((b as any).success !== false) setBalance(b as any);
      setLoading(false);
    })();
  }, [user, authLoading]);

  const createOffer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setCreating(true);
    const res = await api.createOffer({
      subject_name: newOffer.subject_name,
      description: newOffer.description,
      duration: newOffer.duration,
      price: newOffer.price,
      offer_date: newOffer.offer_date ? new Date(newOffer.offer_date).toISOString() : new Date().toISOString(),
      max_students: newOffer.max_students,
    });
    setCreating(false);
    if (res.success && res.offer) {
      toast.show('تم إنشاء العرض بنجاح!', 'success');
      setOffers((o) => [res.offer!, ...o]);
      setShowCreate(false);
      setNewOffer({ subject_name: '', description: '', duration: 60, price: 0, offer_date: '', max_students: 30 });
    } else {
      toast.show(res.error || 'فشل إنشاء العرض', 'error');
    }
  };

  const startStream = async (offerId: number) => {
    const res = await api.startJitsiStream(offerId);
    if (res.success && res.room_url) {
      toast.show('تم بدء البث — جاري الفتح', 'success');
      window.open(res.room_url, '_blank');
      setOffers((o) => o.map((x) => x.id === offerId ? { ...x, status: 'live' } : x));
    } else {
      toast.show(res.error || 'فشل بدء البث', 'error');
    }
  };

  const deleteOffer = async (offerId: number) => {
    if (!confirm('هل أنت متأكد من حذف هذا العرض؟')) return;
    const res = await api.deleteOffer(offerId);
    if (res.success) {
      toast.show('تم حذف العرض', 'success');
      setOffers((o) => o.filter((x) => x.id !== offerId));
    } else {
      toast.show(res.error || 'فشل الحذف', 'error');
    }
  };

  if (authLoading || loading) return <div className="py-20"><Spinner /></div>;
  if (!user) return null;

  return (
    <div className="container-app py-10 animate-fade-in">
      {/* Header */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Avatar name={user.name} size={56} />
          <div>
            <h1 className="text-2xl font-black text-[rgb(var(--ink))]">{user.name}</h1>
            <p className="text-sm text-[rgb(var(--muted))]">
              {user.status === 'approved' ? 'أستاذ معتمد' : user.status === 'pending' ? 'قيد المراجعة' : 'أستاذ'}
            </p>
          </div>
        </div>
        <button onClick={() => setShowCreate(!showCreate)} className="btn-primary">
          {showCreate ? 'إلغاء' : 'إنشاء عرض جديد'}
        </button>
      </div>

      {/* Stats */}
      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard icon={<Wallet className="h-6 w-6" />} label="الرصيد" value={formatPrice(balance?.balance ?? 0)} color="amber" />
        <StatCard icon={<GraduationCap className="h-6 w-6" />} label="إجمالي الأرباح" value={formatPrice(balance?.total_earned ?? 0)} color="accent" />
        <StatCard icon={<Clock className="h-6 w-6" />} label="معلق" value={formatPrice(balance?.pending_withdraw ?? 0)} color="slate" />
        <StatCard icon={<BookOpen className="h-6 w-6" />} label="العروض" value={offers.length} color="brand" />
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="card mb-8 animate-scale-in p-6">
          <h3 className="mb-4 text-lg font-bold text-[rgb(var(--ink))]">عرض جديد</h3>
          <form onSubmit={createOffer} className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="label">اسم المادة</label>
              <input required value={newOffer.subject_name} onChange={(e) => setNewOffer({ ...newOffer, subject_name: e.target.value })} className="input" placeholder="مثال: الرياضيات" />
            </div>
            <div>
              <label className="label">المدة (دقيقة)</label>
              <input type="number" required min={1} max={360} value={newOffer.duration} onChange={(e) => setNewOffer({ ...newOffer, duration: parseInt(e.target.value) || 60 })} className="input" />
            </div>
            <div>
              <label className="label">السعر (دج)</label>
              <input type="number" required min={0} value={newOffer.price} onChange={(e) => setNewOffer({ ...newOffer, price: parseInt(e.target.value) || 0 })} className="input" />
            </div>
            <div>
              <label className="label">عدد الطلاب الأقصى</label>
              <input type="number" required min={1} value={newOffer.max_students} onChange={(e) => setNewOffer({ ...newOffer, max_students: parseInt(e.target.value) || 30 })} className="input" />
            </div>
            <div className="md:col-span-2">
              <label className="label">تاريخ ووقت الحصة</label>
              <input type="datetime-local" required value={newOffer.offer_date} onChange={(e) => setNewOffer({ ...newOffer, offer_date: e.target.value })} className="input" />
            </div>
            <div className="md:col-span-2">
              <label className="label">الوصف</label>
              <textarea value={newOffer.description} onChange={(e) => setNewOffer({ ...newOffer, description: e.target.value })} className="input min-h-[80px]" placeholder="وصف محتوى الحصة..." />
            </div>
            <div className="md:col-span-2">
              <button type="submit" disabled={creating} className="btn-primary w-full">
                {creating ? 'جاري الإنشاء...' : 'نشر العرض'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Offers */}
      <section>
        <h2 className="mb-4 text-xl font-black text-[rgb(var(--ink))]">عروضي</h2>
        {offers.length === 0 ? (
          <EmptyState icon={<BookOpen className="h-8 w-8" />} title="لا توجد عروض بعد" subtitle="ابدأ بإنشاء عرضك الأول" action={<button onClick={() => setShowCreate(true)} className="btn-primary">إنشاء عرض</button>} />
        ) : (
          <div className="space-y-3">
            {offers.map((o) => {
              const status = getStatusBadge(o.status);
              const canStream = o.status === 'upcoming';
              return (
                <div key={o.id} className="card p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[rgb(var(--brand)/0.1)] text-[rgb(var(--brand))]">
                      <BookOpen className="h-6 w-6" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-bold text-[rgb(var(--ink))]">{o.subject_name}</h3>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-[rgb(var(--muted))]">
                        <span className={`badge ${status.color}`}>{status.label}</span>
                        <span>{formatPrice(o.price)}</span>
                        <span>{formatDateTime(o.offer_date)}</span>
                        <span>{o.booked_count || 0}/{o.max_students || '∞'} طالب</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {canStream && (
                        <button onClick={() => startStream(o.id)} className="btn-accent text-xs">
                          <Video className="h-3.5 w-3.5" /> بدء البث
                        </button>
                      )}
                      {o.status === 'live' && (
                        <a href={api.getJoinUrl(o.id)} target="_blank" rel="noopener noreferrer" className="btn-primary text-xs">
                          دخول البث
                        </a>
                      )}
                      <button onClick={() => deleteOffer(o.id)} className="btn-ghost text-xs text-red-500">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
