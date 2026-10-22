// Firebase Authentication wrapper.
//   Admin        -> email + password account created in the Firebase console
//   Team member  -> anonymous sign-in (no password)
// Who may WRITE what is enforced by firestore.rules, not by this file.
import {
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserSessionPersistence
} from 'firebase/auth';
import { auth } from '../firebase.js';
import { usernameToEmail, roleOf, friendlyAuthError } from './authHelpers.js';

export { usernameToEmail, roleOf, friendlyAuthError };

// The login lasts for the browser tab only (shared-computer friendly).
const ready = setPersistence(auth, browserSessionPersistence).catch(() => {});

export function subscribeAuth(callback) {
  return onAuthStateChanged(auth, (user) => callback(user, roleOf(user)));
}

export async function loginAdmin(username, password) {
  await ready;
  await signInWithEmailAndPassword(auth, usernameToEmail(username), password);
}

export async function loginTeam() {
  await ready;
  await signInAnonymously(auth);
}

export const logout = () => signOut(auth);
