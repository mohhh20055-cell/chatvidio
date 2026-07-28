import { Star, Video, Clock, Calendar, Users } from 'lucide-react';
import { Link } from '@/lib/router';
import type { Teacher, Offer } from '@/lib/api';
import { formatPrice, formatDuration, formatDateTime, getStatusBadge, initials, avatarUrl, ratingStars } from '@/lib/format';

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div className="h-8 w-8 animate-spin-slow rounded-full border-3 border-[rgb(var(--brand)/0.2)] border-t-[rgb(var(--brand))]" />
    </div>
  );
}

export function EmptyState({ icon, title, subtitle, action }: { icon?: React.ReactNode; title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon && <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-[rgb(var(--ink)/0.04)] text-[rgb(var(--muted))]">{icon}</div>}
      <h3 className="text-lg font-bold text-[rgb(var(--ink))]">{title}</h3>
      {subtitle && <p className="mt-1 max-w-sm text-sm text-[rgb(var(--muted))]">{subtitle}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Avatar({ name, src, size = 48, className = '' }: { name: string; src?: string | null; size?: number; className?: string }) {
  const url = avatarUrl(src);
  if (url) {
    return <img src={url} alt={name} className={`rounded-full object-cover ${className}`} style={{ width: size, height: size }} />;
  }
  return (
    <div
      className={`grid place-items-center rounded-full bg-gradient-to-br from-[rgb(var(--brand))] to-[rgb(var(--brand-dark))] font-bold text-white ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials(name)}
    </div>
  );
}

export function Stars({ rating, size = 14 }: { rating: number; size?: number }) {
  const r = ratingStars(rating);
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} style={{ width: size, height: size }} className={i <= r ? 'fill-amber-400 text-amber-400' : 'text-slate-300'} />
      ))}
    </div>
  );
}

export function TeacherCard({ teacher }: { teacher: Teacher }) {
  return (
    <Link to={`/teacher/${teacher.id}`} className="card-hover group block overflow-hidden p-5">
      <div className="flex items-start gap-4">
        <div className="relative">
          <Avatar name={teacher.full_name} src={teacher.profile_image} size={64} />
          {teacher.has_live_stream && (
            <span className="absolute -bottom-1 -left-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 ring-2 ring-white">
              <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-bold text-[rgb(var(--ink))] group-hover:text-[rgb(var(--brand))]">{teacher.full_name}</h3>
          {teacher.specialization && <p className="truncate text-sm text-[rgb(var(--muted))]">{teacher.specialization}</p>}
          <div className="mt-1.5 flex items-center gap-2">
            {teacher.teaching_level_display && <span className="chip">{teacher.teaching_level_display}</span>}
            {teacher.has_live_stream && <span className="badge bg-red-100 text-red-700"><Video className="h-3 w-3" /> مباشر</span>}
          </div>
        </div>
      </div>
      {teacher.bio && <p className="mt-3 line-clamp-2 text-sm text-[rgb(var(--muted))]">{teacher.bio}</p>}
      <div className="mt-4 flex items-center justify-between border-t border-[rgb(var(--line))] pt-3">
        <Stars rating={teacher.rating || 0} />
        <span className="text-xs font-semibold text-[rgb(var(--muted))]">
          {teacher.total_students || 0} طالب
        </span>
      </div>
    </Link>
  );
}

export function OfferCard({ offer, showTeacher = true }: { offer: Offer; showTeacher?: boolean }) {
  const status = getStatusBadge(offer.status);
  const isLive = offer.status === 'live' || offer.status === 'teacher_ready';
  return (
    <div className="card-hover flex flex-col overflow-hidden p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-bold text-[rgb(var(--ink))]">{offer.subject_name}</h3>
          {showTeacher && offer.teacher_name && (
            <Link to={`/teacher/${offer.teacher_id}`} className="mt-0.5 block truncate text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--brand))]">
              {offer.teacher_name}
            </Link>
          )}
        </div>
        <span className={`badge ${status.color}`}>{status.label}</span>
      </div>

      {offer.description && <p className="mt-2 line-clamp-2 text-sm text-[rgb(var(--muted))]">{offer.description}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[rgb(var(--muted))]">
        <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {formatDuration(offer.duration)}</span>
        <span className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" /> {formatDateTime(offer.offer_date)}</span>
        {offer.max_students != null && (
          <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" /> {offer.booked_count || 0}/{offer.max_students}</span>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-[rgb(var(--line))] pt-3">
        <span className="text-lg font-black text-[rgb(var(--brand))]">{formatPrice(offer.price)}</span>
        {isLive && (
          <span className="badge bg-red-100 text-red-700 animate-pulse">
            <Video className="h-3 w-3" /> مباشر الآن
          </span>
        )}
      </div>
    </div>
  );
}

export function StatCard({ icon, label, value, color = 'brand' }: { icon: React.ReactNode; label: string; value: string | number; color?: 'brand' | 'accent' | 'amber' | 'slate' }) {
  const colors = {
    brand: 'bg-[rgb(var(--brand)/0.1)] text-[rgb(var(--brand))]',
    accent: 'bg-[rgb(var(--accent)/0.1)] text-[rgb(var(--accent-dark))]',
    amber: 'bg-amber-100 text-amber-600',
    slate: 'bg-slate-100 text-slate-600',
  };
  return (
    <div className="card flex items-center gap-4 p-5">
      <div className={`grid h-12 w-12 place-items-center rounded-xl ${colors[color]}`}>{icon}</div>
      <div>
        <div className="text-2xl font-black text-[rgb(var(--ink))]">{value}</div>
        <div className="text-sm text-[rgb(var(--muted))]">{label}</div>
      </div>
    </div>
  );
}
