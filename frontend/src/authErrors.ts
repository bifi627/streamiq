// Readable text for every auth failure the sign-in page can hit: never
// Firebase's raw "Firebase: Error (auth/…)." text.
const wrong = 'Wrong email or password.'
const popupClosed = 'Sign-in window was closed before finishing.'
const authErrors: Record<string, string> = {
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/missing-email': 'Enter your email address.',
  'auth/missing-password': 'Enter your password.',
  'auth/weak-password': 'Choose a password with at least 6 characters.',
  'auth/email-already-in-use':
    'An account with this email already exists. Sign in instead.',
  // Firebase's own default (email enumeration protection) only ever sends
  // invalid-credential; the older two map to the same line.
  'auth/invalid-credential': wrong,
  'auth/wrong-password': wrong,
  'auth/user-not-found': wrong,
  'auth/user-disabled': 'This account is disabled.',
  'auth/too-many-requests':
    'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed':
    "Can't reach the sign-in service. Check your connection and try again.",
  'auth/account-exists-with-different-credential':
    'This email already signs in another way. Use email and password.',
  'auth/popup-closed-by-user': popupClosed,
  'auth/cancelled-popup-request': popupClosed,
  'auth/popup-blocked':
    'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.',
}

export function authMessage(e: unknown) {
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return 'Sign-in failed. Try again.'
  // Any other code: our sentence, the code kept for a bug report.
  return authErrors[code] ?? `Sign-in failed (${code}). Try again.`
}
