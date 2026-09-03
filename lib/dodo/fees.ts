// What Dodo keeps, and why none of our figures knew about it.
//
// revenue_events stores Dodo's settlement_amount. Two different deductions sit
// between what a customer pays and what reaches the bank, and only one of them
// is in that number:
//
//   tax / settlement_tax — Dodo is the merchant of record, so sales tax and VAT
//     are theirs to collect and remit. They arrive as their own fields on the
//     payment and are already outside settlement_amount. A German customer's
//     €33.65 carries €5.37 of VAT we never see, correctly.
//
//   the platform fee — taken at payout, reported nowhere on the payment. So
//     settlement_amount is gross of it, and every total, MRR figure and margin
//     derived from that column has been counting money we do not keep.
//
// Hence this file: one place that says what the fee is, so a net figure can be
// shown beside a gross one rather than the two being quietly conflated.

/** Dodo's merchant-of-record rate: 4% of the transaction plus a fixed 40¢.
 *
 *  Two things this does NOT model, both of which make the real fee larger:
 *  cross-border card surcharges, and the currency conversion on a payment that
 *  settles in a currency the customer did not pay in — the NZ$69.73 that
 *  settled as $39.00 crossed both. Treat a net figure here as the best case. */
export const DODO_FEE_PERCENT = 0.04;
export const DODO_FEE_FIXED_CENTS = 40;

/** What Dodo takes from one settled payment, in the same cents it was given.
 *
 *  Never more than the payment itself: a $0.50 top-up would otherwise report a
 *  negative net, which is arithmetically true of the fixed fee and useless as a
 *  number to read. */
export function dodoFeeCents(settlementCents: number): number {
  if (!(settlementCents > 0)) return 0;
  const fee = Math.round(settlementCents * DODO_FEE_PERCENT) + DODO_FEE_FIXED_CENTS;
  return Math.min(settlementCents, fee);
}

/** What one settled payment is actually worth to us. */
export function netOfDodoCents(settlementCents: number): number {
  return Math.max(0, settlementCents - dodoFeeCents(settlementCents));
}

/** The fee on a set of payments. Per payment, not on the sum: the fixed 40¢ is
 *  charged per transaction, so ten $21 payments cost four dollars more in fees
 *  than one $210 payment does. */
export function dodoFeeCentsOver(payments: number[]): number {
  return payments.reduce((sum, cents) => sum + dodoFeeCents(cents), 0);
}
