import {
  getAdditionalUserInfo,
  GoogleAuthProvider,
  signInWithPopup,
  updateProfile,
  type User,
} from '@firebase/auth'
import { auth } from './firebase'

// Accounts made before aliases keep their email as alias and are never asked.
// ponytail: a fixed date, not a flag: Firebase's creationTime is all we have.
const ALIASES_SINCE = Date.parse('2026-11-16T00:00:00Z')

export const needsAlias = (u: User) =>
  !u.displayName && Date.parse(u.metadata.creationTime ?? '') >= ALIASES_SINCE

// A Google sign-up arrives with the Google profile name as displayName: clear
// it, so it picks an alias like an email sign-up, prefilled with that name.
// App holds the signed-in user back until this settles, so the app
// never renders with the Google name in between.
// ponytail: if the clear fails, the account keeps the Google name unasked;
// a retry needs a flag Firebase doesn't keep (a custom claim).
export let signingIn: Promise<unknown> = Promise.resolve()
export const signInWithGoogle = () =>
  (signingIn = signInWithPopup(auth, new GoogleAuthProvider()).then(
    async (cred) => {
      if (getAdditionalUserInfo(cred)?.isNewUser)
        await updateProfile(cred.user, { displayName: '' }) // null = unchanged
    },
  ))
