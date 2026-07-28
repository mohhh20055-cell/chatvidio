// API client for the ZoomDz education platform backend
const API_BASE = 'https://zoomdz.com/api';

export const RECAPTCHA_SITE_KEY = '6Lcv8kctAAAAAHcoWBv_e87vrjP7I6IzQJSV6THf';

export type Role = 'student' | 'teacher' | 'admin';

export interface User {
  id: number;
  name: string;
  role: Role;
  profile_image?: string | null;
  profile_url?: string | null;
  balance?: number;
  email_verified?: boolean;
  referral_code?: string;
  education_level?: string | null;
  teaching_level?: string | null;
  status?: string | null;
  has_active_stream?: boolean;
  requires_profile_completion?: boolean;
  profile_completion?: boolean;
}

export interface AuthResponse {
  success: boolean;
  token?: string;
  user?: User;
  redirectTo?: string;
  error?: string;
  message?: string;
  pending_approval?: boolean;
  requires_profile_completion?: boolean;
  banned?: boolean;
  rejected?: boolean;
  student_id?: number;
  teacher_id?: number;
}

export interface Teacher {
  id: number;
  full_name: string;
  email?: string;
  specialization?: string | null;
  bio?: string | null;
  experience?: string | null;
  teaching_level?: string | null;
  teaching_level_display?: string | null;
  profile_image?: string | null;
  profile_url?: string | null;
  rating?: number | null;
  total_students?: number;
  has_live_stream?: boolean;
  stream_status?: string | null;
  stream_students?: number;
  stream_remaining_seconds?: number;
  referral_code?: string;
}

export interface Offer {
  id: number;
  teacher_id: number;
  subject_name: string;
  description?: string | null;
  duration: number;
  price: number;
  offer_date: string;
  status: string;
  education_level?: string | null;
  booked_count?: number;
  max_students?: number;
  stream_url?: string | null;
  room_password?: string | null;
  teacher_name?: string;
  teacher_image?: string | null;
  teacher_rating?: number;
  remaining_seconds?: number;
  formatted_date?: string;
}

export interface PlatformStats {
  teachers_count: number;
  students_count: number;
  live_streams: number;
  paused_streams: number;
  active_streams: number;
  education_levels?: string[];
}

export interface TeacherProfile extends Teacher {
  offers: Offer[];
  live_stream?: {
    id: number;
    subject_name: string;
    status: string;
    stream_url: string;
    room_password: string;
    duration: number;
    booked_count: number;
  } | null;
  posts?: any[];
  courses?: any[];
  stats: {
    total_offers: number;
    total_students: number;
    pending_balance: number;
  };
}

export interface Booking {
  id: number;
  offer_id: number;
  student_id: number;
  teacher_id: number;
  payment_status: string;
  payment_amount: number;
  is_free: boolean;
  created_at: string;
  offers?: { subject_name: string };
}

function getToken(): string | null {
  return localStorage.getItem('zd_token');
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem('zd_token', token);
  else localStorage.removeItem('zd_token');
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const text = await res.text();
    let data: any;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { success: false, error: 'استجابة غير صالحة من الخادم' }; }
    if (!res.ok && !data.error) {
      data.error = data.error || `خطأ في الخادم (${res.status})`;
    }
    return data as T;
  } catch (err: any) {
    return { success: false, error: err.message || 'تعذر الاتصال بالخادم' } as T;
  }
}

export async function getRecaptchaToken(): Promise<string> {
  return new Promise((resolve) => {
    const grecaptcha = (window as any).grecaptcha;
    if (!grecaptcha || !grecaptcha.execute) { resolve(''); return; }
    grecaptcha.ready(() => {
      grecaptcha.execute(RECAPTCHA_SITE_KEY, { action: 'submit' })
        .then((token: string) => resolve(token))
        .catch(() => resolve(''));
    });
  });
}

// ===== Auth =====
export const api = {
  login: (email: string, password: string, role: Role) =>
    request<AuthResponse>('/login', { method: 'POST', body: JSON.stringify({ email, password, role }) }),

  registerStudent: (data: { full_name: string; email: string; password: string; phone: string; education_level: string; recaptcha_token: string }) =>
    request<AuthResponse>('/student/register', { method: 'POST', body: JSON.stringify(data) }),

  registerTeacher: (data: { full_name: string; email: string; password: string; recaptcha_token: string }) =>
    request<AuthResponse>('/teacher/register', { method: 'POST', body: JSON.stringify(data) }),

  logout: () => request<{ success: boolean }>('/logout', { method: 'POST' }),

  verifyToken: () => request<{ success: boolean; valid: boolean; user?: User }>('/verify-token'),

  refreshToken: () => request<{ success: boolean; token?: string }>('/refresh-token', { method: 'POST' }),

  getMe: (role: Role) => request<{ success: boolean; teacher?: any; student?: any }>(`/${role}/me`),

  // ===== Public =====
  getTeachers: (level?: string) =>
    request<Teacher[]>(`/public/teachers${level && level !== 'all' ? `?level=${encodeURIComponent(level)}` : ''}`),

  getOffers: (level?: string) =>
    request<Offer[]>(`/public/offers${level && level !== 'all' ? `?level=${encodeURIComponent(level)}` : ''}`),

  getTeacher: (id: number) => request<TeacherProfile>(`/public/teacher/${id}`),

  getStats: () => request<PlatformStats>('/public/stats'),

  getLiveStreams: () => request<Offer[]>('/public/live-streams'),

  getEducationLevels: () => request<{ levels: string[] }>('/public/education-levels'),

  // ===== Offers =====
  getOffer: (id: number) => request<Offer>(`/offer/${id}`),

  getLiveOffers: () => request<Offer[]>('/live-offers'),

  // ===== Booking =====
  createBooking: (offer_id: number, student_id: number) =>
    request<{ success: boolean; error?: string; message?: string; session?: any }>('/booking/create', { method: 'POST', body: JSON.stringify({ offer_id, student_id }) }),

  cancelBooking: (session_id: number, student_id: number) =>
    request<{ success: boolean; error?: string }>('/booking/cancel', { method: 'POST', body: JSON.stringify({ session_id, student_id }) }),

  getStudentBookings: (student_id: number) =>
    request<Booking[]>(`/booking/student/${student_id}`),

  // ===== Stream =====
  startJitsiStream: (offer_id: number) =>
    request<{ success: boolean; room_url?: string; password?: string; room_name?: string; error?: string }>('/start-jitsi-stream', { method: 'POST', body: JSON.stringify({ offer_id }) }),

  getJoinUrl: (offer_id: number) => `/join-jitsi/${offer_id}?token=${getToken()}`,

  // ===== Teacher dashboard =====
  getTeacherOffers: (teacher_id: number) => request<Offer[]>(`/teacher/offers/${teacher_id}`),

  getTeacherBalance: (teacher_id: number) =>
    request<{ success: boolean; balance: number; total_earned: number; pending_withdraw: number; sessions?: any[] }>(`/teacher/balance/${teacher_id}`),

  createOffer: (data: { subject_name: string; duration: number; price: number; offer_date: string; description?: string; education_level?: string; max_students?: number }) =>
    request<{ success: boolean; error?: string; offer?: Offer }>('/offer/create', { method: 'POST', body: JSON.stringify(data) }),

  deleteOffer: (offer_id: number) =>
    request<{ success: boolean; error?: string }>(`/offer/delete/${offer_id}`, { method: 'DELETE' }),

  // ===== Student balance =====
  getStudentBalance: (student_id: number) =>
    request<{ success: boolean; balance: number }>(`/student/balance/${student_id}`),
};

export const FULL_JOIN_URL = (offer_id: number) => `${API_BASE}/join-jitsi/${offer_id}?token=${getToken()}`;
