export const TOOL_IDS = ["twitter", "badnews", "haijiao", "missav", "av123"] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export type ToolResult = {
  resultKey: string;
  primaryValue: string;
  secondaryValue?: string;
  status?: string;
  tags?: string[];
  actressTags?: string[];
  genreTags?: string[];
  source?: string;
  metadata?: Record<string, unknown>;
};

export const TASK_STAGES = ["new", "filtered", "website", "review", "error", "completed"] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

export type RecordRow = {
  id: string;
  tool: ToolId;
  recordKey: string;
  primaryValue: string;
  secondaryValue: string;
  status: string;
  tags: string[];
  actressTags: string[];
  genreTags: string[];
  sourceUrl: string;
  missavUrl: string;
  av123Url: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type RecordFilters = {
  tool?: string;
  status?: string;
  search?: string;
  sort?: string;
  direction?: "asc" | "desc";
};

export type SanitizedImportRecord = {
  tool: ToolId;
  recordKey: string;
  primaryValue: string;
  secondaryValue?: string;
  status?: string;
  tags?: string[];
  actressTags?: string[];
  genreTags?: string[];
  sourceUrl?: string;
  missavUrl?: string;
  av123Url?: string;
  metadata?: Record<string, unknown>;
};
