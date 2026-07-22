import { initializeApp } from 'firebase/app';
import { GoogleAuthProvider, getAuth, signInWithPopup, signOut } from 'firebase/auth';
import { firebaseConfig } from './config';

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);

/**
 * `signInWithPopup` rather than `signInWithRedirect`.
 *
 * Redirect sign-in loses the whole page, and this flow already spends its
 * one full-page navigation on the Google Calendar OAuth handoff (see
 * `lib/connectCallback.ts`). Two different steps that both destroy and
 * restore app state would mean two separate resumption paths to get
 * right. A popup keeps sign-in entirely in-page, so the only navigation
 * that has to be survivable is the calendar one.
 */
export async function signInWithGoogle(): Promise<void> {
  const provider = new GoogleAuthProvider();
  await signInWithPopup(auth, provider);
}

export async function signOutOfKairos(): Promise<void> {
  await signOut(auth);
}

/**
 * Maps Firebase's error codes to copy a person can act on. A popup that
 * the user closed is not an error worth shouting about — it is the most
 * common outcome of changing your mind — so it gets a quiet, blameless
 * line, and popup-blocked gets an instruction rather than a description.
 */
export function describeAuthError(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Sign-in was closed before it finished. You can try again when you are ready.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.';
    case 'auth/network-request-failed':
      return 'We could not reach Google. Check your connection and try again.';
    case 'auth/unauthorized-domain':
      return 'This site is not authorized for sign-in yet. Please let us know where you are seeing this.';
    default:
      return 'Sign-in did not complete. Please try again.';
  }
}
