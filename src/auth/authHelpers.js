// Pure helpers (no Firebase imports) so they can be unit-tested.
// Firebase Authentication identifies password accounts by email, but the
// admin wants a plain username. The username is turned into a behind-the-
// scenes email ("<username>@roomassign.app") — never shown, never mailed.
// The Firebase console user and firestore.rules use that same address.
export const USERNAME_EMAIL_DOMAIN = 'roomassign.app';
export const usernameToEmail = (username) => {
  const u = String(username || '').trim().toLowerCase();
  return u.includes('@') ? u : `${u}@${USERNAME_EMAIL_DOMAIN}`;
};

export const roleOf = (user) => (!user ? null : user.isAnonymous ? 'team' : 'admin');

export function friendlyAuthError(err) {
  switch (err?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-email':
      return 'Incorrect username or password.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'auth/operation-not-allowed':
      return 'This sign-in method is not enabled in Firebase yet (Authentication → Sign-in method).';
    case 'auth/admin-restricted-operation':
      return 'Team-member sign-in is blocked: in Firebase → Authentication → Settings → User actions, turn "Enable create (sign-up)" back ON.';
    case 'auth/network-request-failed':
      return 'Network problem — check your connection.';
    default:
      console.error('Sign-in failed:', err);
      return `Could not sign in (${err?.code || 'unknown error'}). Please try again.`;
  }
}
