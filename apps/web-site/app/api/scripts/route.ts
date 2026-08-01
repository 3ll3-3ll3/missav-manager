import { apiError, bodyJson, requireAuthenticated } from "../../../lib/api-response";
import { generateScriptAction, listScriptGenerations, previewReferenceHtml } from "../../../lib/server-missav";

export async function GET(request: Request) {
  try { requireAuthenticated(request); return Response.json({ generations: await listScriptGenerations(50) }); }
  catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    requireAuthenticated(request);
    const input = await bodyJson(request);
    if (input.action === "preview-reference-html") return Response.json(await previewReferenceHtml(input));
    return Response.json(await generateScriptAction(input));
  } catch (error) { return apiError(error); }
}

