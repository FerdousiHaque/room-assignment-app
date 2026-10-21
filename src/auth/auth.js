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

// The login lasts for the browser tab only (shared-computer friendly).
const ready = setPersistence(auth, browserSessionPersistence).catch(() => {});

export const roleOf = (user) => (!user ? null : user.isAnonymous ? 'team' : 'admin');

export function subscribeAuth(callback) {
  return onAuthStateChanged(auth, (user) => callback(user, roleOf(user)));
}

export async function loginAdmin(email, password) {
  await ready;
  await signInWithEmailAndPassword(auth, email.trim(), password);
}

export async function loginTeam() {
  await ready;
  await signInAnonymously(auth);
}

export const logout = () => signOut(auth);

export function friendlyAuthError(err) {
  switch (err?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-email':
      return 'Incorrect email or password.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'auth/operation-not-allowed':
      return 'This sign-in method is not enabled in Firebase yet (Authentication → Sign-in method).';
    case 'auth/network-request-failed':
      return 'Network problem — check your connection.';
    default:
      return 'Could not sign in. Please try again.';
  }
}
