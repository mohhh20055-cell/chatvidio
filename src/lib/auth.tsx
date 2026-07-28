import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { api, setToken, type User, type Role } from './api';

interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string, role: Role) => Promise<{ success: boolean; error?: string; user?: User }>;
  registerStudent: (data: any) => Promise<{ success: boolean; error?: string; user?: User; token?: string }>;
  registerTeacher: (data: any) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setTok] = useState<string | null>(localStorage.getItem('zd_token'));
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const saved = localStorage.getItem('zd_user');
    if (saved) {
      try { setUser(JSON.parse(saved)); } catch { /* ignore */ }
    }
    const t = localStorage.getItem('zd_token');
    if (!t) { setLoading(false); return; }
    setTok(t);
    const res = await api.verifyToken();
    if (res.success && res.valid && res.user) {
      setUser(res.user);
      localStorage.setItem('zd_user', JSON.stringify(res.user));
    } else if (!res.success) {
      setToken(null);
      localStorage.removeItem('zd_user');
      setUser(null);
      setTok(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = useCallback(async (email: string, password: string, role: Role) => {
    const res = await api.login(email, password, role);
    if (res.success && res.token && res.user) {
      setToken(res.token);
      setTok(res.token);
      setUser(res.user);
      localStorage.setItem('zd_user', JSON.stringify(res.user));
      return { success: true, user: res.user };
    }
    return { success: false, error: res.error || 'فشل تسجيل الدخول' };
  }, []);

  const registerStudent = useCallback(async (data: any) => {
    const res = await api.registerStudent(data);
    if (res.success && res.token) {
      setToken(res.token);
      setTok(res.token);
      const u: User = { id: res.student_id || 0, name: data.full_name, role: 'student', email_verified: true, education_level: data.education_level };
      setUser(u);
      localStorage.setItem('zd_user', JSON.stringify(u));
      return { success: true, token: res.token, user: u };
    }
    return { success: false, error: res.error || 'فشل التسجيل' };
  }, []);

  const registerTeacher = useCallback(async (data: any) => {
    const res = await api.registerTeacher(data);
    if (res.success) return { success: true };
    return { success: false, error: res.error || 'فشل التسجيل' };
  }, []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* ignore */ }
    setToken(null);
    setTok(null);
    setUser(null);
    localStorage.removeItem('zd_user');
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, registerStudent, registerTeacher, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
