// Rebuilt before dev and production builds from the exact v0.4.5 rule modules.
// @ts-expect-error generated JavaScript boundary
import legacy from "./generated/legacyBundle.js";

export interface LegacyInputEntry { code: string; sourceUrl: string }
export interface LegacyTwitterProfile { name: string; url: string }
export const legacyParser = legacy.parser as { normalizeCode(value: string): string; codeComparableKey(value: string): string; parseCodeList(value: string): string[] };
export const legacyInput = legacy.input as { parseInputEntries(value: string): LegacyInputEntry[]; parseInputCodeList(value: string): string[] };
export const legacyToolbox = legacy.toolbox as {
  extractTwitterProfiles(input: unknown, options?: Record<string, unknown>): LegacyTwitterProfile[];
  extractBadNewsLinks(input: unknown, options?: Record<string, unknown>): string[];
  extractHaijiaoLinks(input: unknown, options?: Record<string, unknown>): string[];
};
export const legacyFetcher = legacy.fetcher as {
  classifyCandidateResponse(page: unknown, code: string, requestedUrl?: string): { status: string; url: string; html: string; error: string; statusCode: number };
  resolveCandidateAttempts(attempts: unknown[], fallbackUrl?: string): { status: string; url: string; html: string; error: string; statusCode: number };
  shouldStopCandidateSearch(status: string): boolean;
  extractMetadata(html: string, code: string, finalUrl: string): { status: string; actresses: string[]; genres: string[] };
};
export const legacyAv123 = legacy.av123 as {
  buildDetailUrl(code: string, locale?: string): string;
  buildDetailCandidateUrls(code: string, locale?: string): string[];
  classifyResponse(page: unknown, code: string, requestedUrl?: string): unknown;
};
