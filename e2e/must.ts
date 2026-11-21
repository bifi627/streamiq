/** x, or a thrown error naming what is missing. */
export function must<T>(x: T | null | undefined, what: string): T {
  if (x === null || x === undefined) throw new Error(`missing: ${what}`)
  return x
}

/** An env var the stack or global setup sets: unset is an error naming it. */
export const envVar = (name: string) => must(process.env[name], `env ${name}`)
