import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { usernameToEmail, roleOf, friendlyAuthError } from '../authHelpers.js';

const rules = fs.readFileSync('firestore.rules', 'utf8') // vitest runs from the project root;

describe('login & roles', () => {
  it('turns the typed username RSTNEPDESK into the lowercase Firebase address, and leaves real emails alone', () => {
    expect(usernameToEmail('  RSTNEPDESK ')).toBe('rstnepdesk@roomassign.app');
    expect(usernameToEmail('a@b.org')).toBe('a@b.org');
  });

  it('maps Firebase users to roles: none -> login page, anonymous -> team member, password user -> admin', () => {
    expect(roleOf(null)).toBeNull();
    expect(roleOf({ isAnonymous: true })).toBe('team');
    expect(roleOf({ isAnonymous: false })).toBe('admin');
  });

  it('shows a clear message for a wrong password, a blocked team sign-in, and any unknown error code', () => {
    expect(friendlyAuthError({ code: 'auth/invalid-credential' })).toMatch(/Incorrect username or password/);
    expect(friendlyAuthError({ code: 'auth/admin-restricted-operation' })).toMatch(/sign-up/);
    expect(friendlyAuthError({ code: 'auth/weird' })).toContain('auth/weird');
  });

  it('firestore.rules: admin address is set (no placeholder), providers/rooms are admin-write only, team may write only day-* docs, reads need sign-in', () => {
    expect(rules).toContain("'rstnepdesk@roomassign.app'");
    expect(rules).not.toContain('REPLACE_WITH');
    expect(rules).toMatch(/allow read: if signedIn\(\)/);
    expect(rules).toMatch(/allow write: if isAdmin\(\) \|\| \(signedIn\(\) && docId\.matches\('day-\.\*'\)\)/);
    expect(rules).toMatch(/sign_in_provider == 'password'/);
  });
});
