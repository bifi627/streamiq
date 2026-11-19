// Firebase rejects ' a@b.c' as auth/invalid-email: a phone's autocomplete
// often adds the trailing space (#622).
export const cleanEmail = (email: string) => email.trim()
