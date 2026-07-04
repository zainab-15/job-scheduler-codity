import axios, { AxiosError } from 'axios';
import type { ErrorEnvelope } from './types';

const TOKEN_KEY = 'scheduler.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// Falls back to '/api/v1' (same-origin) for local dev, where the Vite proxy
// forwards it to the API on :3000. A production build sets VITE_API_URL to
// the deployed API's own origin, since web and api are separate Railway
// services there — see DEPLOY.md.
const baseURL = import.meta.env.VITE_API_URL ?? '/api/v1';

// indexes:null serializes arrays as `status=a&status=b` (repeated key, no
// brackets), which is what the API's jobListQuerySchema expects — the default
// axios `status[]=a` form would arrive under the wrong key.
export const api = axios.create({ baseURL, paramsSerializer: { indexes: null } });

// Attach the bearer token on every request.
api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// R19 (functional bug fix): a 401 forces logout ONLY for non-auth routes. A
// wrong-password 401 on /auth/login must surface inline on the login form, not
// trigger a logout+redirect loop that swallows the error.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

api.interceptors.response.use(
  (res) => res,
  (error: AxiosError<ErrorEnvelope>) => {
    const url = error.config?.url ?? '';
    const isAuthRoute = url.startsWith('/auth/');
    if (error.response?.status === 401 && !isAuthRoute) {
      clearToken();
      onUnauthorized?.();
    }
    return Promise.reject(error);
  },
);

/** Pull the API's structured error code/message out of an axios error, falling
 *  back to a generic message for network failures. */
export function apiError(err: unknown): { code: string; message: string } {
  const ax = err as AxiosError<ErrorEnvelope>;
  const env = ax.response?.data?.error;
  if (env) return { code: env.code, message: env.message };
  if (ax.request) return { code: 'NETWORK', message: 'Could not reach the API. Is `npm run dev:api` running?' };
  return { code: 'UNKNOWN', message: ax.message ?? 'Something went wrong' };
}
