import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { getHeclusBalance, listHeclusLedger } from "@/lib/heclus-credits";

export const dynamic = "force-dynamic";

// Balance and history for the Heclus Credits wallet.
//
// Separate route from /api/credits, which serves the free GenAI video wallet.
// Two wallets, two payloads: merging them would mean the panel could not tell
// which balance a number belonged to, and these two are counted in different
// units.
export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const [balance, ledger] = await Promise.all([
    getHeclusBalance(user),
    listHeclusLedger(user.id, 25),
  ]);

  return NextResponse.json({
    ...balance,
    ledger,
    // Until a pack is configured there is nothing to sell, so the panel shows
    // the balance without offering a top-up that cannot complete.
    pack: null,
    checkoutUrl: null,
  });
}
