import type { Pagination as PaginationMeta } from '../api/types';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';

export function Pagination({ meta, offset, limit, onOffset }: { meta: PaginationMeta; offset: number; limit: number; onOffset: (o: number) => void }) {
  const start = meta.total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, meta.total);
  const btn =
    'inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-medium text-slate-600 shadow-soft transition enabled:hover:border-slate-300 enabled:hover:bg-slate-50 disabled:opacity-40';
  return (
    <div className="flex items-center justify-between gap-2 pt-3 text-xs text-slate-500">
      <span className="tnum">
        <span className="font-semibold text-slate-700">{start}–{end}</span> of {meta.total}
      </span>
      <div className="flex gap-1.5">
        <button type="button" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - limit))} className={btn}>
          <ChevronLeftIcon width={14} height={14} /> Prev
        </button>
        <button type="button" disabled={!meta.has_more} onClick={() => onOffset(offset + limit)} className={btn}>
          Next <ChevronRightIcon width={14} height={14} />
        </button>
      </div>
    </div>
  );
}
