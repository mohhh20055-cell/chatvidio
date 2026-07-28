import { useEffect, useState, useCallback } from 'react';

// Simple hash-based router
export function useRoute() {
  const [path, setPath] = useState(() => window.location.hash.slice(1) || '/');

  useEffect(() => {
    const onChange = () => {
      setPath(window.location.hash.slice(1) || '/');
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return path;
}

export function navigate(to: string) {
  window.location.hash = to;
  window.scrollTo(0, 0);
}

export function useParams(): Record<string, string> {
  const path = window.location.hash.slice(1) || '/';
  const segments = path.split('?')[0].split('/').filter(Boolean);
  const params: Record<string, string> = {};
  if (segments.length >= 2) {
    params.id = segments[1];
  }
  return params;
}

export function Link({ to, children, className, onClick }: { to: string; children: React.ReactNode; className?: string; onClick?: () => void }) {
  const handle = (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(to);
    onClick?.();
  };
  return (
    <a href={`#${to}`} onClick={handle} className={className}>
      {children}
    </a>
  );
}

export function useQueryParam(key: string): [string | null, (v: string) => void] {
  const get = useCallback(() => {
    const hash = window.location.hash.slice(1);
    const idx = hash.indexOf('?');
    if (idx === -1) return null;
    const params = new URLSearchParams(hash.slice(idx + 1));
    return params.get(key);
  }, [key]);

  const [val, setVal] = useState<string | null>(get);

  useEffect(() => {
    const onChange = () => setVal(get());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, [get]);

  const set = useCallback((v: string) => {
    const hash = window.location.hash.slice(1);
    const idx = hash.indexOf('?');
    const base = idx === -1 ? hash : hash.slice(0, idx);
    const params = new URLSearchParams(idx === -1 ? '' : hash.slice(idx + 1));
    if (v) params.set(key, v); else params.delete(key);
    const qs = params.toString();
    navigate(qs ? `${base}?${qs}` : base);
  }, [key]);

  return [val, set];
}
