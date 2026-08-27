import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import {
  MEDIA_SURFACES, IMPLEMENTED_SURFACES, EXEMPT_SURFACES, SWITCHABLE_OPERATORS,
  OPERATORS_FOR_SURFACE,
  isImplementedSurface, isExemptSurface,
  getMediaOperator, getMediaOperatorPerSurface, type MediaSurface,
} from "@/lib/operators/routing";
import type { Operator } from "@/lib/operators";

// Admin read/write for the media operator switch (migration 136).
//
// Shaped after app/api/admin/anthropic-routing: GET returns the effective
// value plus the raw override map so the panel can distinguish "set" from
// "inherits", PATCH writes one field at a time.

function isOperator(v: unknown): v is Operator {
  return (SWITCHABLE_OPERATORS as readonly string[]).includes(v as string);
}
function isSurface(v: unknown): v is MediaSurface {
  return (MEDIA_SURFACES as readonly string[]).includes(v as string);
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const [operator, perSurface] = await Promise.all([
    getMediaOperator(),
    getMediaOperatorPerSurface(),
  ]);

  return NextResponse.json({
    operator,
    per_surface: perSurface,
    surfaces: MEDIA_SURFACES,
    // Which of those surfaces the switch actually moves today. The panel must
    // show the rest as not-yet rather than as settable, or the control reports
    // a migration that has not happened.
    implemented: IMPLEMENTED_SURFACES,
    // Never moves, by decision: voiceover and caption alignment stay on
    // ElevenLabs whatever the operator is.
    exempt_surfaces: EXEMPT_SURFACES,
    pending: MEDIA_SURFACES.filter((s) => !isImplementedSurface(s) && !isExemptSurface(s)),
    operators: SWITCHABLE_OPERATORS,
    // Per surface, because Anthropic serves chat and nothing else. The panel
    // renders from this rather than the union, so no row offers a button that
    // could only fail.
    operators_for_surface: OPERATORS_FOR_SURFACE,
    // What the switch deliberately does not move, so the panel can say so
    // rather than leaving an admin to infer it from behaviour.
    exempt_notes: [
      "Free video (GenAIPro) — separate wallet",
      "Free voices (ai33, Qwen) — Heclus-paid perks",
      "Free images (BYO Cloudflare) — customer's own key",
      "Voiceover and caption alignment — permanently ElevenLabs",
      "BYO-key clients — their key is a KIE key, so they stay on KIE",
    ],
  });
}

export async function PATCH(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as {
    operator?: unknown;
    surface?: unknown;
    surface_operator?: unknown | null;
  };

  // Global default.
  if (body.operator !== undefined) {
    if (!isOperator(body.operator) || body.operator === "anthropic") {
      // anthropic is chat-only, and the global default is inherited by image
      // and video. Allowing it here would set two surfaces to a provider with
      // no catalog for them.
      return NextResponse.json(
        { error: "operator must be one of: " + SWITCHABLE_OPERATORS.filter((o) => o !== "anthropic").join(", ") },
        { status: 400 },
      );
    }
    const { error } = await supabase
      .from("product_config")
      .update({ media_operator: body.operator })
      .eq("service", "_global");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // One surface override. Null clears it back to inheriting the global value.
  if (body.surface !== undefined) {
    if (!isSurface(body.surface)) {
      return NextResponse.json({ error: "unknown surface" }, { status: 400 });
    }
    // Refused rather than stored. A stored override on a surface nothing reads
    // is a setting that silently does nothing, which is how an admin comes to
    // believe the workflow moved when only images did.
    if (isExemptSurface(body.surface)) {
      return NextResponse.json(
        { error: `The ${body.surface} surface is permanently on ElevenLabs and does not follow the operator switch.` },
        { status: 409 },
      );
    }
    if (!isImplementedSurface(body.surface)) {
      return NextResponse.json(
        { error: `The ${body.surface} surface does not read the operator switch yet. Implemented: ${IMPLEMENTED_SURFACES.join(", ")}.` },
        { status: 409 },
      );
    }
    const { data: cur } = await supabase
      .from("product_config")
      .select("media_operator_per_surface")
      .eq("service", "_global")
      .maybeSingle();

    const next = { ...((cur?.media_operator_per_surface ?? {}) as Record<string, unknown>) };
    if (body.surface_operator === null || body.surface_operator === "") {
      delete next[body.surface];
    } else if (isOperator(body.surface_operator)) {
      const allowed = OPERATORS_FOR_SURFACE[body.surface] ?? [];
      if (!(allowed as readonly string[]).includes(body.surface_operator)) {
        return NextResponse.json(
          { error: `${body.surface_operator} does not serve the ${body.surface} surface. Allowed: ${allowed.join(", ") || "none"}.` },
          { status: 409 },
        );
      }
      next[body.surface] = body.surface_operator;
    } else {
      return NextResponse.json({ error: "surface_operator must be an operator or null" }, { status: 400 });
    }

    const { error } = await supabase
      .from("product_config")
      .update({ media_operator_per_surface: next })
      .eq("service", "_global");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const [operator, perSurface] = await Promise.all([getMediaOperator(), getMediaOperatorPerSurface()]);
  return NextResponse.json({ operator, per_surface: perSurface });
}
