import { useEffect, useState } from 'react';
import { dismissToast, subscribeToasts, type Toast } from './toast';
import { CloseIcon } from './icons';

const KIND_STYLE: Record<Toast['kind'], string> = {
  success: 'border-emerald-200 bg-white text-slate-800',
  error: 'border-red-200 bg-white text-slate-800',
  info: 'border-slate-200 bg-white text-slate-800',
};
const DOT: Record<Toast['kind'], string> = {
  success: 'bg-emerald-500',
  error: 'bg-red-500',
  info: 'bg-indigo-500',
};

export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setToasts), []);

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-80 flex-col gap-2.5" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2.5 rounded-2xl border px-3.5 py-3 text-sm shadow-pop animate-toast-in ${KIND_STYLE[t.kind]}`}
        >
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[t.kind]}`} aria-hidden />
          <span className="min-w-0 flex-1 leading-snug">{t.message}</span>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            className="-mr-1 shrink-0 rounded-md p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label="Dismiss"
          >
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
