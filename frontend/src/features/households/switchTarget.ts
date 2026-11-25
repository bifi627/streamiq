/** Where a household switch reloads to: a page that doesn't depend on the
 *  household stays, any other goes home. */
export const switchTarget = (path: string) =>
  /^\/(settings(\/.*)?|gateways)\/?$/.test(path) ? path : '/'
