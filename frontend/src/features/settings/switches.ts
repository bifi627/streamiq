/** TV Settings' Household & gateway pickers: each only with 2+ to pick from,
 * none outside TV mode (the phone/PC has the Household and Gateways pages). */
export const tvPickers = (
  tv: boolean,
  households: number,
  gateways: number,
) => ({ household: tv && households > 1, gateway: tv && gateways > 1 })
