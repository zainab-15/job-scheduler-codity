import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { apiError } from '../api/client';

// R17: one wrapper for the three states every data view shares —
// loading skeleton, error-with-retry, and (delegated) content. Empty is the
// page's own concern (it knows whether it's "nothing exists" vs "no match").
export function QueryState<T>({
  query,
  children,
  skeletonRows = 4,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  skeletonRows?: number;
}) {
  if (query.isLoading) {
    return (
      <div className="space-y-2.5" aria-busy="true" aria-live="polite">
        {Array.from({ length: skeletonRows }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-xl border border-slate-200/70 bg-slate-100" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    const { code, message } = apiError(query.error);
    return (
      <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
        <div className="font-semibold">Couldn’t load ({code})</div>
        <div className="mt-1 text-red-700/90">{message}</div>
        <button
          type="button"
          onClick={() => query.refetch()}
          className="mt-4 rounded-xl border border-red-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100"
        >
          Retry
        </button>
      </div>
    );
  }
  if (query.data === undefined) return null;
  return <>{children(query.data)}</>;
}
