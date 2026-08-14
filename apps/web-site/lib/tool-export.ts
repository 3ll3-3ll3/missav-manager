import { csvSafe } from "./security";
import { toolOutputFields } from "./tool-output";
import type { ToolId, ToolResult } from "./types";

function metadata(row: ToolResult) {
  return row.metadata &&
    typeof row.metadata === "object" &&
    !Array.isArray(row.metadata)
    ? row.metadata
    : {};
}

function meta(row: ToolResult, key: string) {
  return String(metadata(row)[key] ?? "");
}

export function toolFieldText(
  tool: ToolId,
  rows: ToolResult[],
  key: "primary" | "secondary",
) {
  return (
    toolOutputFields(tool, rows)
      .find((field) => field.key === key)
      ?.values.join("\r\n") || ""
  );
}

export function toolCsv(tool: ToolId, rows: ToolResult[]) {
  let headers: string[];
  let values: unknown[][];
  if (tool === "twitter") {
    headers = ["name", "url", "status", "source", "message_id", "message_date"];
    values = rows.map((row) => [
      row.primaryValue,
      row.secondaryValue || "",
      row.status || "success",
      row.source || meta(row, "sourceName"),
      meta(row, "messageId"),
      meta(row, "messageDate"),
    ]);
  } else if (tool === "badnews") {
    headers = [
      "url",
      "original_url",
      "status",
      "source",
      "message_id",
      "message_date",
    ];
    values = rows.map((row) => [
      row.primaryValue,
      meta(row, "originalValue"),
      row.status || "success",
      row.source || meta(row, "sourceName"),
      meta(row, "messageId"),
      meta(row, "messageDate"),
    ]);
  } else if (tool === "haijiao") {
    headers = [
      "url",
      "category",
      "post_id",
      "original_url",
      "status",
      "source",
      "message_id",
      "message_date",
    ];
    values = rows.map((row) => [
      row.primaryValue,
      meta(row, "category"),
      meta(row, "postId"),
      meta(row, "originalValue"),
      row.status || "success",
      row.source || meta(row, "sourceName"),
      meta(row, "messageId"),
      meta(row, "messageDate"),
    ]);
  } else if (tool === "missav") {
    headers = [
      "code",
      "source_url",
      "status",
      "actress_tags",
      "type_tags",
      "tags",
      "error",
      "source",
      "message_id",
      "message_date",
    ];
    values = rows.map((row) => [
      row.primaryValue,
      row.secondaryValue || "",
      row.status || "pending",
      (row.actressTags || []).join("|"),
      (row.genreTags || []).join("|"),
      (row.tags || []).join("|"),
      row.error || row.remark || "",
      row.source || meta(row, "sourceName"),
      meta(row, "messageId"),
      meta(row, "messageDate"),
    ]);
  } else {
    headers = [
      "code",
      "url",
      "status",
      "error",
      "source",
      "message_id",
      "message_date",
      "imported_at",
    ];
    values = rows.map((row) => [
      row.primaryValue,
      row.secondaryValue || "",
      row.status || "task_ready",
      row.error || row.remark || "",
      row.source || meta(row, "sourceName"),
      meta(row, "messageId"),
      meta(row, "messageDate"),
      meta(row, "importedAt"),
    ]);
  }
  return `\uFEFF${[headers.join(","), ...values.map((row) => row.map(csvSafe).join(","))].join("\r\n")}`;
}

export function toolJson(tool: ToolId, rows: ToolResult[], runId = "") {
  return JSON.stringify(
    {
      tool,
      runId,
      exportedAt: new Date().toISOString(),
      count: rows.length,
      results: rows,
    },
    null,
    2,
  );
}

export function av123TaskCsv(rows: ToolResult[], runId = "") {
  const header = ["task_id", "code", "url", "status"];
  return `\uFEFF${[header.join(","), ...rows.map((row) => [String(row.metadata?.taskId || (runId ? `${runId}:${row.resultKey}` : row.resultKey)), row.primaryValue, row.secondaryValue || "", row.status || "task_ready"].map(csvSafe).join(","))].join("\r\n")}`;
}
