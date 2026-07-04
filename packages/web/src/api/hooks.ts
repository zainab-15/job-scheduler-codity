import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from './client';
import { toast } from '../components/toast';
import { isTerminal } from '../lib/format';
import type {
  BatchCreateResult,
  DlqRow,
  HealthResult,
  JobDetail,
  JobRow,
  OverviewResult,
  PaginatedResult,
  ProjectRow,
  QueueDetail,
  QueueRow,
  QueueStatsResult,
  ScheduleCreateResult,
  ThroughputResult,
  WorkerRow,
} from './types';

// ---- Query keys ----
export const qk = {
  overview: ['metrics', 'overview'] as const,
  health: ['metrics', 'health'] as const,
  throughput: (windowHours: number, bucket: string) => ['metrics', 'throughput', windowHours, bucket] as const,
  projects: (limit: number, offset: number) => ['projects', limit, offset] as const,
  queues: (projectId: string, limit: number, offset: number) => ['queues', projectId, limit, offset] as const,
  queue: (queueId: string) => ['queue', queueId] as const,
  queueStats: (queueId: string) => ['queue', queueId, 'stats'] as const,
  queueJobs: (queueId: string, params: unknown) => ['queueJobs', queueId, params] as const,
  projectJobs: (projectId: string, params: unknown) => ['projectJobs', projectId, params] as const,
  job: (jobId: string) => ['job', jobId] as const,
  queueDlq: (queueId: string, limit: number, offset: number) => ['dlq', 'queue', queueId, limit, offset] as const,
  workers: (limit: number, offset: number) => ['workers', limit, offset] as const,
};

// ---- Metrics (Overview 10s) ----
export function useOverview() {
  return useQuery({
    queryKey: qk.overview,
    queryFn: async () => (await api.get<OverviewResult>('/metrics/overview')).data,
    refetchInterval: 10_000,
  });
}
export function useHealth() {
  return useQuery({
    queryKey: qk.health,
    queryFn: async () => (await api.get<HealthResult>('/metrics/health')).data,
    refetchInterval: 10_000,
  });
}
export function useThroughput(windowHours = 24, bucket: 'hour' | 'minute' = 'hour') {
  return useQuery({
    queryKey: qk.throughput(windowHours, bucket),
    queryFn: async () =>
      (await api.get<ThroughputResult>('/metrics/throughput', { params: { window_hours: windowHours, bucket } })).data,
    refetchInterval: 10_000,
  });
}

// ---- Projects ----
export function useProjects(limit = 50, offset = 0) {
  return useQuery({
    queryKey: qk.projects(limit, offset),
    queryFn: async () => (await api.get<PaginatedResult<ProjectRow>>('/projects', { params: { limit, offset } })).data,
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
}
export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => (await api.get<ProjectRow>(`/projects/${projectId}`)).data,
    enabled: !!projectId,
  });
}
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; description?: string }) =>
      (await api.post<ProjectRow>('/projects', body)).data,
    onSuccess: () => {
      toast.success('Project created');
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => toast.error(apiError(e).message),
  });
}
export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: string) => api.delete(`/projects/${projectId}`),
    onSuccess: () => {
      toast.success('Project deleted');
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => toast.error(apiError(e).message),
  });
}

// ---- Queues (list 5s, detail, stats 10s) ----
export function useQueues(projectId: string | undefined, limit = 50, offset = 0) {
  return useQuery({
    queryKey: qk.queues(projectId ?? '', limit, offset),
    queryFn: async () =>
      (await api.get<PaginatedResult<QueueRow>>(`/projects/${projectId}/queues`, { params: { limit, offset } })).data,
    enabled: !!projectId,
    placeholderData: keepPreviousData,
    refetchInterval: 5_000,
  });
}
export function useQueue(queueId: string | undefined) {
  return useQuery({
    queryKey: qk.queue(queueId ?? ''),
    queryFn: async () => (await api.get<QueueDetail>(`/queues/${queueId}`)).data,
    enabled: !!queueId,
    refetchInterval: 5_000,
  });
}
export function useQueueStats(queueId: string | undefined, windowHours = 24) {
  return useQuery({
    queryKey: qk.queueStats(queueId ?? ''),
    queryFn: async () =>
      (await api.get<QueueStatsResult>(`/queues/${queueId}/stats`, { params: { window_hours: windowHours } })).data,
    enabled: !!queueId,
    refetchInterval: 10_000,
  });
}
export function useCreateQueue(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; priority?: number; concurrency_limit?: number }) =>
      (await api.post<QueueRow>(`/projects/${projectId}/queues`, body)).data,
    onSuccess: () => {
      toast.success('Queue created');
      qc.invalidateQueries({ queryKey: ['queues', projectId] });
    },
    onError: (e) => toast.error(apiError(e).message),
  });
}
export function usePauseResumeQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ queueId, pause }: { queueId: string; pause: boolean }) =>
      (await api.post(`/queues/${queueId}/${pause ? 'pause' : 'resume'}`)).data,
    onSuccess: (_d, v) => {
      toast.success(v.pause ? 'Queue paused' : 'Queue resumed');
      qc.invalidateQueries({ queryKey: ['queues'] });
      qc.invalidateQueries({ queryKey: qk.queue(v.queueId) });
    },
    onError: (e) => toast.error(apiError(e).message),
  });
}
export function useDeleteQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (queueId: string) => api.delete(`/queues/${queueId}`),
    onSuccess: () => {
      toast.success('Queue deleted');
      qc.invalidateQueries({ queryKey: ['queues'] });
    },
    onError: (e) => toast.error(apiError(e).message),
  });
}

// ---- Jobs ----
export interface JobListParams {
  status?: string[];
  type?: string;
  sort?: string;
  limit: number;
  offset: number;
}
/** Job explorer: poll 5s, but PAUSE when a filter is active or paging past 1
 *  (§7 discipline — don't yank a filtered/paged view out from under the user). */
function jobListInterval(params: JobListParams): number | false {
  const filtering = (params.status && params.status.length > 0) || !!params.type || params.offset > 0;
  return filtering ? false : 5_000;
}
export function useQueueJobs(queueId: string | undefined, params: JobListParams) {
  return useQuery({
    queryKey: qk.queueJobs(queueId ?? '', params),
    queryFn: async () => (await api.get<PaginatedResult<JobRow>>(`/queues/${queueId}/jobs`, { params })).data,
    enabled: !!queueId,
    placeholderData: keepPreviousData,
    refetchInterval: jobListInterval(params),
  });
}
export function useProjectJobs(projectId: string | undefined, params: JobListParams) {
  return useQuery({
    queryKey: qk.projectJobs(projectId ?? '', params),
    queryFn: async () => (await api.get<PaginatedResult<JobRow>>(`/projects/${projectId}/jobs`, { params })).data,
    enabled: !!projectId,
    placeholderData: keepPreviousData,
    refetchInterval: jobListInterval(params),
  });
}
/** Job detail: poll 3s but STOP entirely once the job reaches a terminal state. */
export function useJob(jobId: string | undefined) {
  return useQuery({
    queryKey: qk.job(jobId ?? ''),
    queryFn: async () => (await api.get<JobDetail>(`/jobs/${jobId}`)).data,
    enabled: !!jobId,
    refetchInterval: (query) => (isTerminal(query.state.data?.job.status) ? false : 3_000),
  });
}

export interface CreateJobBody {
  type: 'immediate' | 'delayed' | 'scheduled';
  handler_name: string;
  payload: Record<string, unknown>;
  priority?: number;
  dedupe_key?: string;
  delay_seconds?: number;
  scheduled_at?: string;
}
export function useCreateJob(queueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateJobBody) => (await api.post<JobRow>(`/queues/${queueId}/jobs`, body)).data,
    onSuccess: () => {
      toast.success('Job enqueued');
      qc.invalidateQueries({ queryKey: ['queueJobs', queueId] });
      qc.invalidateQueries({ queryKey: qk.queue(queueId) });
    },
    onError: (e) => toast.error(apiError(e).message),
  });
}
export function useCreateSchedule(queueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { handler_name: string; cron: string; timezone?: string; payload?: Record<string, unknown> }) =>
      (await api.post<ScheduleCreateResult>(`/queues/${queueId}/schedules`, body)).data,
    onSuccess: (d) => {
      toast.success(`Schedule created — next run ${new Date(d.next_run_at).toLocaleString()}`);
      qc.invalidateQueries({ queryKey: qk.queue(queueId) });
    },
    onError: (e) => toast.error(apiError(e).message),
  });
}
export function useCreateBatch(queueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { handler_name: string; items: Array<{ payload: Record<string, unknown> }> }) =>
      (await api.post<BatchCreateResult>(`/queues/${queueId}/jobs/batch`, body)).data,
    onSuccess: (d) => {
      toast.success(`Batch: ${d.count.created} created, ${d.count.skipped} skipped`);
      qc.invalidateQueries({ queryKey: ['queueJobs', queueId] });
    },
    onError: (e) => toast.error(apiError(e).message),
  });
}
export function useRetryJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string) => (await api.post(`/jobs/${jobId}/retry`)).data,
    onSuccess: (_d, jobId) => {
      toast.success('Job requeued for retry');
      qc.invalidateQueries({ queryKey: qk.job(jobId) });
      qc.invalidateQueries({ queryKey: ['dlq'] });
    },
    onError: (e) => toast.error(apiError(e).message),
  });
}
export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string) => (await api.post(`/jobs/${jobId}/cancel`)).data,
    onSuccess: (_d, jobId) => {
      toast.success('Job cancelled');
      qc.invalidateQueries({ queryKey: qk.job(jobId) });
    },
    onError: (e) => toast.error(apiError(e).message),
  });
}

// ---- Dead-letter (15s) ----
export function useQueueDlq(queueId: string | undefined, limit = 50, offset = 0) {
  return useQuery({
    queryKey: qk.queueDlq(queueId ?? '', limit, offset),
    queryFn: async () =>
      (await api.get<PaginatedResult<DlqRow>>(`/queues/${queueId}/dead-letter`, { params: { limit, offset } })).data,
    enabled: !!queueId,
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
}
export function useProjectDlq(projectId: string | undefined, limit = 50, offset = 0) {
  return useQuery({
    queryKey: ['dlq', 'project', projectId ?? '', limit, offset],
    queryFn: async () =>
      (await api.get<PaginatedResult<DlqRow>>(`/projects/${projectId}/dead-letter`, { params: { limit, offset } })).data,
    enabled: !!projectId,
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
}
export function useRequeueDlq() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (dlqId: string) => (await api.post(`/dead-letter/${dlqId}/requeue`)).data,
    onSuccess: () => {
      toast.success('Dead-letter entry requeued');
      qc.invalidateQueries({ queryKey: ['dlq'] });
    },
    onError: (e) => toast.error(apiError(e).message),
  });
}
export function useDiscardDlq() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (dlqId: string) => api.delete(`/dead-letter/${dlqId}`),
    onSuccess: () => {
      toast.success('Dead-letter entry discarded');
      qc.invalidateQueries({ queryKey: ['dlq'] });
    },
    onError: (e) => toast.error(apiError(e).message),
  });
}

// ---- Workers (5s) ----
export function useWorkers(limit = 50, offset = 0) {
  return useQuery({
    queryKey: qk.workers(limit, offset),
    queryFn: async () => (await api.get<PaginatedResult<WorkerRow>>('/workers', { params: { limit, offset } })).data,
    placeholderData: keepPreviousData,
    refetchInterval: 5_000,
  });
}
