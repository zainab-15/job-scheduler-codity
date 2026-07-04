import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { apiError } from '../api/client';
import { Button, Field, inputClass } from '../components/ui';

export function LoginPage() {
  const { login, register, isAuthed } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('admin@demo.test');
  const [password, setPassword] = useState('demo12345678');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isAuthed) {
    navigate('/overview', { replace: true });
  }

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

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-slate-900">Job Scheduler</h1>
          <p className="text-sm text-slate-500">Distributed job scheduler dashboard</p>
        </div>
        <form onSubmit={submit} className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex gap-2 text-sm">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={`flex-1 rounded-md py-1.5 font-medium ${mode === 'login' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}
            >
              Log in
            </button>
            <button
              type="button"
              onClick={() => setMode('register')}
              className={`flex-1 rounded-md py-1.5 font-medium ${mode === 'register' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}
            >
              Register
            </button>
          </div>

          <Field label="Email">
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Password">
            <input type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
          </Field>
          {mode === 'register' && (
            <Field label="Organization name">
              <input type="text" required value={orgName} onChange={(e) => setOrgName(e.target.value)} className={inputClass} placeholder="Acme Inc" />
            </Field>
          )}

          {error && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <Button type="submit" variant="primary" disabled={busy} className="w-full">
            {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
          </Button>

          {mode === 'login' && (
            <p className="text-center text-xs text-slate-400">
              Seed account: <span className="font-mono">admin@demo.test</span> / <span className="font-mono">demo12345678</span>
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
