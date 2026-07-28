import { useEffect, useState } from 'react';
import { api, type Offer } from '@/lib/api';
import { Spinner, EmptyState } from '@/components/ui';
import { Link } from '@/lib/router';
import { Video, ArrowRight, Radio } from 'lucide-react';
import { formatPrice, formatDateTime, getStatusBadge } from '@/lib/format';

export function LiveStreamsPage() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await api.getLiveOffers();
      setOffers((res as Offer[]).filter((o) => o.status === 'live' || o.status === 'teacher_ready'));
      setLoading(false);
    })();
  }, []);

  if (loading) return <div className="py-20"><Spinner /></div>;

  return (
    <div className="container-app py-10 animate-fade-in">
      <div className="mb-8 flex items-center gap-3">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-red-100 text-red-600">
          <Radio className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-3xl font-black text-[rgb(var(--ink))]">البث المباشر</h1>
          <p className="mt-1 text-[rgb(var(--muted))]">الحصص المباشرة الآن — انضم فوراً</p>
        </div>
      </div>

      {offers.length === 0 ? (
        <EmptyState
          icon={<Video className="h-8 w-8" />}
          title="لا يوجد بث مباشر حالياً"
          subtitle="تابعنا لاحقاً أو تصفح العروض القادمة"
          action={<Link to="/offers" className="btn-primary">تصفح العروض</Link>}
        />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {offers.map((o) => {
            const status = getStatusBadge(o.status);
            return (
              <div key={o.id} className="card-hover overflow-hidden p-5">
                <div className="flex items-center justify-between">
                  <span className={`badge ${status.color} animate-pulse`}>
                    <span className="h-2 w-2 rounded-full bg-current" /> {status.label}
                  </span>
                  <span className="text-xs text-[rgb(var(--muted))]">{o.booked_count || 0} مشاهد</span>
                </div>
                <h3 className="mt-3 text-lg font-bold text-[rgb(var(--ink))]">{o.subject_name}</h3>
                {o.teacher_name && (
                  <Link to={`/teacher/${o.teacher_id}`} className="mt-1 block text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--brand))]">
                    {o.teacher_name}
                  </Link>
                )}
                {o.description && <p className="mt-2 line-clamp-2 text-sm text-[rgb(var(--muted))]">{o.description}</p>}
                <div className="mt-4 flex items-center justify-between border-t border-[rgb(var(--line))] pt-3">
                  <span className="text-sm font-bold text-[rgb(var(--muted))]">{formatDateTime(o.offer_date)}</span>
                  <span className="text-lg font-black text-[rgb(var(--brand))]">{formatPrice(o.price)}</span>
                </div>
                <Link to={`/teacher/${o.teacher_id}`} className="btn-primary mt-4 w-full text-xs">
                  انضم للبث <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
