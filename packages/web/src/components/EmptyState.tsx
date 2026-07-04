import type { ReactNode } from 'react';

// R17: distinguish "nothing exists yet" from "no match for your filter".
// A `win` variant renders an empty DLQ as a positive state, not a sad-face.
export function EmptyState({
  title,
  hint,
  variant = 'empty',
  action,
}: {
  title: string;
  hint?: string;
  variant?: 'empty' | 'filter' | 'win';
  action?: ReactNode;
}) {
  const icon = variant === 'win' ? '✓' : variant === 'filter' ? '⌕' : '∅';
  const iconColor = variant === 'win' ? 'text-emerald-500' : 'text-slate-400';
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white/50 px-6 py-12 text-center">
      <div className={`text-3xl ${iconColor}`} aria-hidden>
        {icon}
      </div>
      <div className="text-sm font-medium text-slate-700">{title}</div>
      {hint && <div className="max-w-md text-xs text-slate-500">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
