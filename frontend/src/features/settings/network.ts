/** What the Data saver row says this browser reports: the Network
 * Information API's connection type and save-data flag, or that it has none. */
export const netReport = (net?: { saveData?: boolean; type?: string }) =>
  net
    ? `connection ${net.type ?? 'unknown'}, save data ${net.saveData ? 'on' : 'off'}`
    : 'nothing (no Network Information API)'
