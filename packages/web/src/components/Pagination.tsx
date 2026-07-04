import type { Pagination as PaginationMeta } from '../api/types';

export function Pagination({ meta, offset, limit, onOffset }: { meta: PaginationMeta; offset: number; limit: number; onOffset: (o: number) => void }) {
  const start = meta.total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, meta.total);
  return (
    <div className="flex items-center justify-between gap-2 pt-2 text-xs text-slate-600">
      <span>
        {start}–{end} of {meta.total}
      </span>
      <div className="flex gap-1">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => onOffset(Math.max(0, offset - limit))}
          className="rounded border border-slate-300 bg-white px-2 py-1 disabled:opacity-40 enabled:hover:bg-slate-50"
        >
          Prev
        </button>
        <button
          type="button"
          disabled={!meta.has_more}
          onClick={() => onOffset(offset + limit)}
          className="rounded border border-slate-300 bg-white px-2 py-1 disabled:opacity-40 enabled:hover:bg-slate-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
