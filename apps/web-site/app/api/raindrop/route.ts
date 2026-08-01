import { apiError } from "../../../lib/api-response";
import { exportRaindrop } from "../../../lib/server-store";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const format = params.get("format") === "html" ? "html" : "csv";
    const result = await exportRaindrop({
      status: params.get("status") || "", search: params.get("search") || "",
    }, format);
    return new Response(result.content, { headers: {
      "content-type": format === "html" ? "text/html; charset=utf-8" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="raindrop-missav.${format}"`,
      "x-raindrop-included": String(result.included), "x-raindrop-excluded": String(result.excluded),
    }});
  } catch (error) { return apiError(error); }
}
