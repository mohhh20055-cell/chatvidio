import { useEffect, useState } from 'react';
import { api, type Teacher, type Offer } from '@/lib/api';
import { TeacherCard, OfferCard, Spinner, EmptyState } from '@/components/ui';
import { useQueryParam } from '@/lib/router';
import { Users, Video, Search } from 'lucide-react';

const LEVELS = ['all', 'الابتدائي', 'المتوسط', 'الثانية ثانوي', 'الثالثة ثانوي', 'الجامعي'];

export function TeachersPage() {
  const [level, setLevel] = useQueryParam('level');
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await api.getTeachers(level || 'all');
      setTeachers(res as Teacher[]);
      setLoading(false);
    })();
  }, [level]);

  const filtered = teachers.filter((t) =>
    !search || t.full_name.toLowerCase().includes(search.toLowerCase()) ||
    (t.specialization || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="container-app py-10 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-3xl font-black text-[rgb(var(--ink))]">الأساتذة</h1>
        <p className="mt-1 text-[rgb(var(--muted))]">تصفّح نخبة الأساتذة المعتمدين</p>
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l === 'all' ? '' : l)}
              className={`rounded-full px-4 py-2 text-sm font-bold transition-all ${(level || 'all') === l ? 'gradient-brand text-white shadow-md' : 'bg-white text-[rgb(var(--muted))] border border-[rgb(var(--line))] hover:border-[rgb(var(--brand))]'}`}
            >
              {l === 'all' ? 'الكل' : l}
            </button>
          ))}
        </div>
        <div className="relative sm:w-64">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[rgb(var(--muted))]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} className="input pr-11" placeholder="بحث عن أستاذ..." />
        </div>
      </div>

      {loading ? (
        <div className="py-20"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Users className="h-8 w-8" />} title="لا يوجد أساتذة" subtitle="جرّب تغيير الفلتر أو البحث" />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((t) => <TeacherCard key={t.id} teacher={t} />)}
        </div>
      )}
    </div>
  );
}

export function OffersPage() {
  const [level, setLevel] = useQueryParam('level');
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await api.getOffers(level || 'all');
      setOffers(res as Offer[]);
      setLoading(false);
    })();
  }, [level]);

  return (
    <div className="container-app py-10 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-3xl font-black text-[rgb(var(--ink))]">العروض</h1>
        <p className="mt-1 text-[rgb(var(--muted))]">الحصص القادمة والمباشرة الآن</p>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {LEVELS.map((l) => (
          <button
            key={l}
            onClick={() => setLevel(l === 'all' ? '' : l)}
            className={`rounded-full px-4 py-2 text-sm font-bold transition-all ${(level || 'all') === l ? 'gradient-brand text-white shadow-md' : 'bg-white text-[rgb(var(--muted))] border border-[rgb(var(--line))] hover:border-[rgb(var(--brand))]'}`}
          >
            {l === 'all' ? 'الكل' : l}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-20"><Spinner /></div>
      ) : offers.length === 0 ? (
        <EmptyState icon={<Video className="h-8 w-8" />} title="لا توجد عروض حالياً" subtitle="تابعنا لاحقاً لعرض الحصص الجديدة" />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {offers.map((o) => <OfferCard key={o.id} offer={o} />)}
        </div>
      )}
    </div>
  );
}
