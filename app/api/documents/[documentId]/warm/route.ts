import { z } from "zod";
import { handleErrors } from "@/lib/api";
import {
  answerHeader,
  docTokenCount,
  documentBlock,
  warmDocumentCache,
} from "@/lib/answer";
import { getDocumentWithPages } from "@/lib/docs";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/supabase/server";

export const maxDuration = 60;

/**
 * Cache keep-warm: the reader pings this while a document is open so the
 * provider prompt cache (system -> full document prefix) stays hot and every
 * question — including the first — pays cached-input prices.
 */
export const POST = handleErrors(
  async (_request: Request, ctx: { params: Promise<{ documentId: string }> }) => {
    const { supabase } = await requireUser();
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(await ctx.params);

    if (!env.hasOpenAI) return Response.json({ skipped: "no-key" });

    const { document, pages } = await getDocumentWithPages(supabase, documentId);
    if (docTokenCount(pages) > env.docFullContextMaxTokens) {
      return Response.json({ skipped: "oversized" }); // RAG branch has no big prefix
    }
    const { data: docAi } = await supabase
      .from("document_ai")
      .select("*")
      .eq("document_id", documentId)
      .maybeSingle();
    const meta = docAi?.status === "ready" ? docAi.summary_meta : null;

    const docBlock = documentBlock(
      pages,
      docAi?.status === "ready" ? docAi.markdown : null,
      answerHeader(document, meta),
    );
    // The provider cache is partitioned by reasoning effort AND by
    // text.verbosity "low" (explicit "medium" ≡ default — measured, see
    // warmDocumentCache). Warm every lane real answers use: effort{low,medium}
    // × verb{low,default}. "high" (either dial) is rare and user-requested.
    const [low, medium, lowVlow, mediumVlow] = await Promise.all([
      warmDocumentCache(docBlock, documentId, "low"),
      warmDocumentCache(docBlock, documentId, "medium"),
      warmDocumentCache(docBlock, documentId, "low", "low"),
      warmDocumentCache(docBlock, documentId, "medium", "low"),
    ]);
    const pct = (u: { inputTokens: number; cachedInputTokens: number }) =>
      u.inputTokens ? Math.round((100 * u.cachedInputTokens) / u.inputTokens) : 0;
    console.log(
      `[warm] doc=${documentId.slice(0, 8)} low=${pct(low)}% medium=${pct(medium)}% ` +
        `lowVlow=${pct(lowVlow)}% mediumVlow=${pct(mediumVlow)}% (in=${low.inputTokens})`,
    );
    return Response.json({ low, medium, lowVlow, mediumVlow });
  },
);
