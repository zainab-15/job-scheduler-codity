import { CheckIcon, InboxIcon, SearchIcon } from './icons';

// R17: distinguish "nothing exists yet" from "no match for your filter".
// A `win` variant renders an empty DLQ as a positive state, not a sad-face.
export function EmptyState({
  title,
  hint,
  variant = 'empty',
}: {
  title: string;
  hint?: string;
  variant?: 'empty' | 'filter' | 'win';
}) {
  const Icon = variant === 'win' ? CheckIcon : variant === 'filter' ? SearchIcon : InboxIcon;
  const tile =
    variant === 'win'
      ? 'bg-emerald-50 text-emerald-600 ring-emerald-100'
      : 'bg-slate-100 text-slate-400 ring-slate-200/70';
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
      <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ring-1 ${tile}`}>
        <Icon width={22} height={22} />
      </div>
      <div className="text-sm font-semibold text-slate-800">{title}</div>
      {hint && <div className="max-w-md text-sm leading-relaxed text-slate-500">{hint}</div>}
    </div>
  );
}
