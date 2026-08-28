// What one Heclus credit is worth, in USD.
//
// Its own module so a client component can price something without importing
// lib/pricing.ts, which reaches for the service-role Supabase client the moment
// it loads. Copying the number instead is how the two drift: one gets edited
// when a provider reprices and the other quietly bills last quarter's figure.

/** A Heclus credit is an abstract unit worth this much. Sanity check on any
 *  change: multiply by 8 and see whether the answer is a plausible price for
 *  one nano-banana image, since that model bills 8 credits. */
export const USD_PER_CREDIT = 0.005;
