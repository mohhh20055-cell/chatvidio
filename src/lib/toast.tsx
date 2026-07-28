import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { CheckCircle2, XCircle, Info, AlertTriangle, X, ExternalLink } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info' | 'warning';
interface Toast { id: number; type: ToastType; message: string; link?: string; linkLabel?: string; }

interface ToastCtx { show: (message: string, type?: ToastType, link?: string, linkLabel?: string) => void; }

const Ctx = createContext<ToastCtx | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((message: string, type: ToastType = 'info', link?: string, linkLabel?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, type, message, link, linkLabel }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const remove = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  const icons = {
    success: <CheckCircle2 className="h-5 w-5 text-emerald-500" />,
    error: <XCircle className="h-5 w-5 text-red-500" />,
    info: <Info className="h-5 w-5 text-blue-500" />,
    warning: <AlertTriangle className="h-5 w-5 text-amber-500" />,
  };

  return (
    <Ctx.Provider value={{ show }}>
      {children}
      <div className="fixed bottom-4 left-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="animate-scale-in flex items-center gap-3 rounded-xl border border-[rgb(var(--line))] bg-white px-4 py-3 shadow-lg max-w-sm"
          >
            {icons[t.type]}
            <div className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-[rgb(var(--ink))]">{t.message}</span>
              {t.link && (
                <a
                  href={t.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm font-bold text-[rgb(var(--brand))] hover:underline"
                >
                  {t.linkLabel || t.link}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <button onClick={() => remove(t.id)} className="text-[rgb(var(--muted))] hover:text-[rgb(var(--ink))]">
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
