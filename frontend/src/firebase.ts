import { initializeApp } from '@firebase/app'
import { getAuth, connectAuthEmulator } from '@firebase/auth'

// Dev uses the emulator (no real Firebase project needed). projectId is all the
// emulator requires; prod supplies the real apiKey/authDomain via VITE_ vars.
const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'demo-key',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'demo-streamiq',
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ??
    'demo-streamiq.firebaseapp.com',
})

export const auth = getAuth(app)

// `vite dev` defaults to the local emulator so a bare `npm run dev` signs in;
// prod builds never do. Set VITE_FIREBASE_AUTH_EMULATOR= (empty) to opt out in dev.
const emulator =
  import.meta.env.VITE_FIREBASE_AUTH_EMULATOR ??
  (import.meta.env.DEV ? 'http://localhost:9099' : undefined)
if (emulator) connectAuthEmulator(auth, emulator, { disableWarnings: true })
