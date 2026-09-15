/**
 * Money is stored in paise (integer minor units) so that reconciliation
 * arithmetic never rounds, and converted at the API boundary so responses
 * stay in whole rupees, which is what the dashboard already consumes.
 */
export const toPaise = (rupees: number) => Math.round(rupees * 100);
export const toRupees = (paise: number) => Math.round(paise / 100);
