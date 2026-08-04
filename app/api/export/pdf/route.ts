import { buildPdf } from "@/lib/export/pdfExporter";
import { collectExportData } from "@/lib/export/collectExportData";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// PDF sibling of ../docx — same auth, same collectExportData, same scope
// parameter, so the two formats always carry identical content.
export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const { projectId, scope, parts } = await req.json();

    const collected = await collectExportData(user.id, projectId, {
      promptsOnly: scope === "prompts",
      parts,
    });
    if (!collected) return new Response("Project not found", { status: 404 });

    const buffer = buildPdf(collected.data);

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${collected.filenameBase}.pdf"`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Export failed";
    return new Response(message, { status: 500 });
  }
}
