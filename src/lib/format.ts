// Shared formatting helpers

export function formatPrice(price: number | null | undefined): string {
  if (price == null || price === 0) return 'مجاني';
  return `${Number(price).toLocaleString('ar-EG')} دج`;
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('ar-EG', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return dateStr; }
}

export function formatTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

export function formatDateTime(dateStr: string | null | undefined): string {
  return `${formatDate(dateStr)} - ${formatTime(dateStr)}`;
}

export function formatDuration(minutes: number | null | undefined): string {
  if (!minutes) return '';
  if (minutes < 60) return `${minutes} دقيقة`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ساعة ${m} دقيقة` : `${h} ساعة`;
}

export function formatCountdown(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return 'انتهى';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  live: { label: 'مباشر', color: 'bg-red-100 text-red-700' },
  teacher_ready: { label: 'الأستاذ جاهز', color: 'bg-emerald-100 text-emerald-700' },
  paused: { label: 'متوقف مؤقتاً', color: 'bg-amber-100 text-amber-700' },
  upcoming: { label: 'قادم', color: 'bg-blue-100 text-blue-700' },
  completed: { label: 'منتهي', color: 'bg-slate-100 text-slate-600' },
  expired: { label: 'منتهي', color: 'bg-slate-100 text-slate-600' },
  pending: { label: 'بانتظار الدفع', color: 'bg-amber-100 text-amber-700' },
  paid: { label: 'مدفوع', color: 'bg-emerald-100 text-emerald-700' },
  pending_stream: { label: 'بانتظار البث', color: 'bg-blue-100 text-blue-700' },
};

export function getStatusBadge(status: string) {
  const s = STATUS_LABELS[status] || { label: status, color: 'bg-slate-100 text-slate-600' };
  return { ...s };
}

export function initials(name: string | null | undefined): string {
  if (!name) return '؟';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2);
}

export function avatarUrl(img: string | null | undefined): string | null {
  if (!img) return null;
  if (img.startsWith('http')) return img;
  return `https://zoomdz.com${img.startsWith('/') ? '' : '/'}${img}`;
}

export function ratingStars(rating: number | null | undefined): number {
  if (!rating) return 0;
  return Math.round(Number(rating));
}
