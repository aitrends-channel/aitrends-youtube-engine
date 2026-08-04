import { buildDocx } from "@/lib/export/docxExporter";
import { collectExportData } from "@/lib/export/collectExportData";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    // scope "prompts" = the Prompts step's export (prompts only). Anything
    // else, or absent, keeps the original full-project document.
    const { projectId, scope, parts } = await req.json();

    const collected = await collectExportData(user.id, projectId, {
      promptsOnly: scope === "prompts",
      parts,
    });
    if (!collected) return new Response("Project not found", { status: 404 });

    const buffer = await buildDocx(collected.data);

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${collected.filenameBase}.docx"`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Export failed";
    return new Response(message, { status: 500 });
  }
}
