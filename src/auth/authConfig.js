// ---------------------------------------------------------------------
// ADMIN LOGIN — the ONE place to set the fixed admin username/password.
//
// 1. Pick a username and put it in ADMIN_USERNAME below.
// 2. Make the password's SHA-256 fingerprint (so the password itself is
//    never written in the code). In a terminal, from the project folder:
//
//        npm run hash-password -- "YourChosenPassword"
//
//    Copy the long hex string it prints into ADMIN_PASSWORD_SHA256 below.
// 3. Commit + push. The site redeploys automatically.
//
// Leave either value empty and the "Admin login" button is disabled
// (the "As a team member" button keeps working).
//
// IMPORTANT: this is a front-end gate. Everything here ships to the
// browser, so it keeps casual users out of the admin screens but is NOT
// real security — see README "Admin login & team member access".
// ---------------------------------------------------------------------
export const ADMIN_USERNAME = import.meta.env?.VITE_ADMIN_USERNAME || '';
export const ADMIN_PASSWORD_SHA256 = (import.meta.env?.VITE_ADMIN_PASSWORD_SHA256 || '').toLowerCase();
