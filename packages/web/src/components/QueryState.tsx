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
      <div className="space-y-2" aria-busy="true" aria-live="polite">
        {Array.from({ length: skeletonRows }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-slate-200" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    const { code, message } = apiError(query.error);
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        <div className="font-medium">Couldn’t load ({code})</div>
        <div className="mt-1 text-red-700">{message}</div>
        <button
          type="button"
          onClick={() => query.refetch()}
          className="mt-3 rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
        >
          Retry
        </button>
      </div>
    );
  }
  if (query.data === undefined) return null;
  return <>{children(query.data)}</>;
}
