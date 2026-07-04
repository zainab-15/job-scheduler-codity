import { useEffect, useState } from 'react';
import { dismissToast, subscribeToasts, type Toast } from './toast';

const KIND_STYLE: Record<Toast['kind'], string> = {
  success: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  error: 'border-red-300 bg-red-50 text-red-800',
  info: 'border-slate-300 bg-white text-slate-800',
};

export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setToasts), []);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-sm shadow-sm ${KIND_STYLE[t.kind]}`}
        >
          <span>{t.message}</span>
          <button type="button" onClick={() => dismissToast(t.id)} className="text-xs opacity-60 hover:opacity-100" aria-label="Dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
