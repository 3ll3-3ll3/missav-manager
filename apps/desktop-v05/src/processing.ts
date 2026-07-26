import { legacyInput, legacyToolbox } from "./legacyCore";
import type { ResultInput, ToolKind } from "./types";

export interface InputMessage {
  text: string;
  links: string[];
  messageDate: string;
  sourceType: string;
  source: string;
}

export interface ProcessedInput {
  messages: InputMessage[];
  results: ResultInput[];
}

function textFromTelegramJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "string" ? part : String((part as { text?: unknown })?.text ?? "")).join("");
}

function collectJsonMessages(value: unknown, source: string, output: InputMessage[]) {
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.messages)) {
    for (const item of object.messages) {
      if (!item || typeof item !== "object") continue;
      const message = item as Record<string, unknown>;
      const text = textFromTelegramJson(message.text);
      const links = [...text.matchAll(/https?:\/\/[^\s<>"']+/gi)].map((match) => match[0]);
      output.push({
        text,
        links,
        messageDate: String(message.date ?? message.date_unixtime ?? ""),
        sourceType: "export_json",
        source,
      });
    }
  }
  for (const child of Object.values(object)) {
    if (child && typeof child === "object" && child !== object.messages) collectJsonMessages(child, source, output);
  }
}

function telegramHtmlMessages(text: string, source: string): InputMessage[] {
  const document = new DOMParser().parseFromString(text, "text/html");
  const nodes = [...document.querySelectorAll<HTMLElement>(".message[id], .message.default")];
  return nodes
    .filter((node) => !node.classList.contains("service"))
    .map((node) => {
      const textNode = node.querySelector<HTMLElement>(".text");
      const messageText = textNode?.innerText || textNode?.textContent || "";
      const links = [...node.querySelectorAll<HTMLAnchorElement>("a[href]")]
        .map((anchor) => anchor.href || anchor.getAttribute("href") || "")
        .filter((href) => /^https?:\/\//i.test(href));
      const date = node.querySelector<HTMLElement>(".date.details, .pull_right.date.details");
      return {
        text: messageText,
        links,
        messageDate: date?.getAttribute("title") || date?.dataset.time || "",
        sourceType: "export_html",
        source,
      };
    });
}

export function parseInputDocument(text: string, name = "粘贴内容"): InputMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (/^\s*[\[{]/.test(trimmed)) {
    try {
      const output: InputMessage[] = [];
      collectJsonMessages(JSON.parse(trimmed), name, output);
      if (output.length) return output;
    } catch { /* fall through to plain text */ }
  }
  if (/<html[\s>]|class=["'][^"']*message/i.test(trimmed)) {
    const messages = telegramHtmlMessages(text, name);
    if (messages.length) return messages;
  }
  return [{
    text,
    links: [...text.matchAll(/https?:\/\/[^\s<>"']+/gi)].map((match) => match[0]),
    messageDate: "",
    sourceType: "manual",
    source: name,
  }];
}

function sourceFor(value: string, messages: InputMessage[]): string {
  const lower = value.toLowerCase();
  return messages.find((message) => `${message.text}\n${message.links.join("\n")}`.toLowerCase().includes(lower))?.source || "";
}

export function processToolInput(tool: ToolKind, documents: Array<{ name: string; text: string }>, start = "", end = ""): ProcessedInput {
  const messages = documents.flatMap((document) => parseInputDocument(document.text, document.name));
  const options = { start, end };
  if (tool === "twitter") {
    const profiles = legacyToolbox.extractTwitterProfiles(messages, options);
    return {
      messages,
      results: profiles.map((item) => ({
        resultKey: item.name.toLowerCase(), primaryValue: item.name, secondaryValue: item.url,
        source: sourceFor(item.name, messages), metadata: { profileUrl: item.url },
      })),
    };
  }
  if (tool === "badnews" || tool === "haijiao") {
    const links = tool === "badnews"
      ? legacyToolbox.extractBadNewsLinks(messages, options)
      : legacyToolbox.extractHaijiaoLinks(messages, options);
    return {
      messages,
      results: links.map((url) => ({
        resultKey: url, primaryValue: url, source: sourceFor(url, messages), metadata: { url },
      })),
    };
  }
  const combined = documents.map((document) => document.text).join("\n");
  const entries = legacyInput.parseInputEntries(combined);
  return {
    messages,
    results: entries.map((entry) => ({
      resultKey: entry.code.toLowerCase(),
      primaryValue: entry.code,
      secondaryValue: entry.sourceUrl || "",
      status: "pending",
      source: entry.sourceUrl || documents.map((document) => document.name).join(", "),
      metadata: tool === "av123" ? { querySite: "123AV" } : { querySite: "MissAV" },
    })),
  };
}

export function resultText(tool: ToolKind, results: ResultInput[]): string {
  if (tool === "twitter") return results.map((item) => item.primaryValue).join("\n");
  return results.map((item) => tool === "missav" || tool === "av123" ? item.primaryValue : item.primaryValue).join("\n");
}

export function secondaryResultText(tool: ToolKind, results: ResultInput[]): string {
  return tool === "twitter" ? results.map((item) => item.secondaryValue || "").filter(Boolean).join("\n") : "";
}
