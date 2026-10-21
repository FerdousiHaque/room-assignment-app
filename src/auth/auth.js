import { ADMIN_USERNAME, ADMIN_PASSWORD_SHA256 } from './authConfig.js';

const KEY = 'roomAssignmentRole';

export const isAdminConfigured = () => Boolean(ADMIN_USERNAME && ADMIN_PASSWORD_SHA256);

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function checkAdminCredentials(username, password) {
  if (!isAdminConfigured()) return false;
  const hash = await sha256Hex(password);
  return username.trim() === ADMIN_USERNAME && hash === ADMIN_PASSWORD_SHA256;
}

export const loadRole = () => {
  try {
    const r = sessionStorage.getItem(KEY);
    return r === 'admin' || r === 'team' ? r : null;
  } catch {
    return null;
  }
};

export const saveRole = (role) => {
  try {
    if (role) sessionStorage.setItem(KEY, role);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — role just lasts until refresh */
  }
};
