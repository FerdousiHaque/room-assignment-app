import React, { useState } from 'react';
import { loginAdmin, loginTeam, friendlyAuthError } from '../auth/auth.js';

// Original cartoon artwork (a friendly kidney pair with a blood-pressure
// gauge) — deliberately NOT any organization's logo or shield.
function KidneyCartoon() {
  return (
    <svg className="login-art" viewBox="0 0 240 150" role="img" aria-label="Cartoon kidneys with a blood pressure gauge">
      <defs>
        <linearGradient id="kid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff9aa8" />
          <stop offset="1" stopColor="#e8576f" />
        </linearGradient>
      </defs>
      <path d="M60 22c-26 0-38 28-34 54s20 50 40 46c16-3 14-22 6-30-9-9-4-18 4-22 12-6 10-48-16-48z" fill="url(#kid)" />
      <path d="M180 22c26 0 38 28 34 54s-20 50-40 46c-16-3-14-22-6-30 9-9 4-18-4-22-12-6-10-48 16-48z" fill="url(#kid)" />
      <circle cx="46" cy="58" r="4" fill="#2b2b3a" /><circle cx="62" cy="58" r="4" fill="#2b2b3a" />
      <path d="M45 72q8 7 17 0" stroke="#2b2b3a" strokeWidth="3" fill="none" strokeLinecap="round" />
      <circle cx="178" cy="58" r="4" fill="#2b2b3a" /><circle cx="194" cy="58" r="4" fill="#2b2b3a" />
      <path d="M177 72q8 7 17 0" stroke="#2b2b3a" strokeWidth="3" fill="none" strokeLinecap="round" />
      <circle cx="120" cy="78" r="38" fill="#fff" stroke="#0a3d8f" strokeWidth="6" />
      <path d="M92 92a30 30 0 0 1 56 0" stroke="#cfe0f7" strokeWidth="8" fill="none" strokeLinecap="round" />
      <path d="M92 92a30 30 0 0 1 22-27" stroke="#2fa36b" strokeWidth="8" fill="none" strokeLinecap="round" />
      <path d="M114 65a30 30 0 0 1 20 0" stroke="#f2b33d" strokeWidth="8" fill="none" strokeLinecap="round" />
      <path d="M134 65a30 30 0 0 1 14 27" stroke="#d9534f" strokeWidth="8" fill="none" strokeLinecap="round" />
      <path d="M120 92l16-22" stroke="#0a3d8f" strokeWidth="4" strokeLinecap="round" />
      <circle cx="120" cy="92" r="5" fill="#0a3d8f" />
      <path d="M100 118q-20 16-4 26" stroke="#0a3d8f" strokeWidth="4" fill="none" strokeLinecap="round" />
      <circle cx="94" cy="146" r="6" fill="#0a3d8f" />
    </svg>
  );
}

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await loginAdmin(username, password); // App switches screens when Firebase reports the sign-in
    } catch (err) {
      setError(friendlyAuthError(err));
      setBusy(false);
    }
  };

  const goTeam = async () => {
    setBusy(true);
    setError('');
    try {
      await loginTeam();
    } catch (err) {
      setError(friendlyAuthError(err));
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <KidneyCartoon />
        <p className="login-eyebrow">Department of</p>
        <h1 className="login-title">Nephrology &amp; Hypertension</h1>
        <p className="login-sub">Daily Room Assignments</p>

        <form className="login-form" onSubmit={submit}>
          <label>
            Username or email
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="login-btn login-btn-admin" disabled={busy || !username.trim() || !password}>
            {busy ? 'Checking…' : 'Admin Login'}
          </button>
          <button type="button" className="login-btn login-btn-team" onClick={goTeam} disabled={busy}>
            As a team member
          </button>
        </form>
      </div>
    </div>
  );
}
