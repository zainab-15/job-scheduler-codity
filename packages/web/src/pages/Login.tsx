import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { apiError } from '../api/client';
import { Button, Field, inputClass } from '../components/ui';
import { CodityMark } from '../components/icons';
import { LoginPreview } from '../components/LoginPreview';

/** Left brand panel: a realistic product preview (a premium scheduling
 *  dashboard) built from the app's own design system. Purely decorative and
 *  hidden below xl, where there isn't room to render it without cramping. */
function BrandPanel() {
  return (
    <div className="relative hidden overflow-hidden border-r border-slate-200/70 bg-[#FBF5F1] xl:flex xl:items-center xl:justify-center">
      <div className="absolute inset-0 bg-dot-grid opacity-50" aria-hidden />
      {/* soft blush wash in a corner — a wash, never a gradient button */}
      <div className="pointer-events-none absolute -right-28 -top-28 h-80 w-80 rounded-full bg-indigo-100/50 blur-3xl" aria-hidden />
      <div className="pointer-events-none absolute -bottom-32 -left-24 h-80 w-80 rounded-full bg-[#F8E1D2]/40 blur-3xl" aria-hidden />
      <div className="relative flex w-full justify-center px-10 py-10 2xl:px-16">
        <LoginPreview />
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login, register, isAuthed } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('admin@demo.test');
  const [password, setPassword] = useState('demo12345678');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already-authed user landing on /login: redirect declaratively (never call
  // navigate() during render — that's a React anti-pattern that warns and
  // double-renders).
  if (isAuthed) return <Navigate to="/overview" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, orgName);
      navigate('/overview', { replace: true });
    } catch (err) {
      // R19: a wrong-password 401 surfaces here inline, not a logout loop.
      setError(apiError(err).message);
    } finally {
      setBusy(false);
    }
  }

  const tab = (active: boolean) =>
    `flex-1 rounded-lg py-1.5 text-sm font-semibold transition ${
      active ? 'bg-white text-indigo-700 shadow-soft' : 'text-slate-500 hover:text-slate-700'
    }`;

  return (
    <div className="grid min-h-full xl:grid-cols-[1.62fr_1fr]">
      <BrandPanel />

      <div className="flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          {/* Compact brand lockup for smaller screens where the panel is hidden. */}
          <div className="mb-8 flex items-center gap-2.5 xl:hidden">
            <CodityMark className="h-9 w-9" />
            <span className="text-lg font-bold tracking-tight text-slate-900">Codity</span>
          </div>

          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              {mode === 'login' ? 'Welcome back' : 'Create your account'}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {mode === 'login' ? 'Sign in to your Codity workspace.' : 'Spin up a new organization in seconds.'}
            </p>
          </div>

          <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-200/80 bg-white p-6 shadow-card">
            <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
              <button type="button" onClick={() => setMode('login')} className={tab(mode === 'login')}>
                Log in
              </button>
              <button type="button" onClick={() => setMode('register')} className={tab(mode === 'register')}>
                Register
              </button>
            </div>

            <Field label="Email">
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} autoComplete="email" />
            </Field>
            <Field label="Password">
              <input
                type="password"
                required
                minLength={10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            </Field>
            {mode === 'register' && (
              <Field label="Organization name">
                <input type="text" required value={orgName} onChange={(e) => setOrgName(e.target.value)} className={inputClass} placeholder="Acme Inc" />
              </Field>
            )}

            {error && (
              <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
                {error}
              </div>
            )}

            <Button type="submit" variant="primary" disabled={busy} className="w-full">
              {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
            </Button>

            {mode === 'login' && (
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-center text-xs text-slate-500">
                Demo account · <span className="font-mono text-slate-700">admin@demo.test</span> /{' '}
                <span className="font-mono text-slate-700">demo12345678</span>
              </p>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
