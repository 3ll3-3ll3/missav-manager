import defaultTemplate from "./assets/missav-browser-script.txt?raw";
import {
  applyReferenceTagBlacklist, defaultMissavReferenceTagLibrary, normalizeReferenceTagBlacklist, normalizeReferenceTags,
} from "./missavReferenceTags";

export const MISSAV_SCRIPT_TEMPLATE_SETTING = "missav.browserScriptTemplate";

export function normalizeScriptCodes(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    let value = raw.trim().toUpperCase().replace(/[＿_\s]+/g, "-").replace(/-{2,}/g, "-");
    const fc2 = value.match(/^FC2-?(?:PPV-?)?(\d{5,9})$/i);
    if (fc2) value = `FC2-PPV-${fc2[1]}`;
    if (!/^(?:FC2-PPV-\d{5,9}|[A-Z]{2,12}-\d{2,7}(?:-[A-Z0-9]{1,12})?)$/.test(value)) continue;
    const key = value.replaceAll("-", "");
    if (seen.has(key)) continue;
    seen.add(key); output.push(value);
  }
  return output;
}

export function defaultMissavScriptTemplate() {
  return defaultTemplate.replace(/^\uFEFF/, "").trimEnd();
}

export function validateMissavScriptTemplate(template: string): string {
  const pattern = /const\s+CODE_TEXT\s*=\s*`[\s\S]*?`\.trim\(\);/;
  if (!pattern.test(template)) throw new Error("脚本模板缺少 `const CODE_TEXT = `...`.trim();` 占位区。请导入你提供的完整脚本。\n");
  if (!template.includes("(async () =>")) throw new Error("脚本模板不是可直接运行的异步浏览器脚本。");
  return template.replace(/^\uFEFF/, "").trimEnd();
}

export function generateMissavBrowserScript(
  template: string,
  values: string[],
  referenceTagValues?: Iterable<unknown>,
  referenceBlacklistValues: Iterable<unknown> = [],
  exportBlacklistValues: Iterable<unknown> = [],
) {
  const codes = normalizeScriptCodes(values);
  if (!codes.length) throw new Error("当前范围没有可写入脚本的有效番号。");
  const safe = codes.map((code) => code.replaceAll("`", "\\`").replaceAll("${", "\\${")).join("\n");
  const checked = validateMissavScriptTemplate(template);
  const unfilteredReferenceTags = normalizeReferenceTags(referenceTagValues ?? defaultMissavReferenceTagLibrary().tags);
  const referenceBlacklist = normalizeReferenceTagBlacklist(referenceBlacklistValues);
  const exportBlacklist = normalizeReferenceTagBlacklist(exportBlacklistValues);
  const referenceTags = applyReferenceTagBlacklist(unfilteredReferenceTags, referenceBlacklist);
  if (!referenceTags.length) throw new Error("参考女优 Tag 库为空，请先到设置页导入 Miss_AV.html 或填写参考 Tag。");
  const codePattern = /const\s+CODE_TEXT\s*=\s*`[\s\S]*?`\.trim\(\);/;
  const codeBlock = `const CODE_TEXT = \`${safe}\`.trim();`;
  const referenceBlock = `const REFERENCE_ACTRESS_TAGS = ${JSON.stringify(referenceTags, null, 2)};`;
  const exportBlacklistBlock = `const RAINDROP_EXPORT_BLACKLIST_TAGS = ${JSON.stringify(exportBlacklist, null, 2)};`;
  const referencePattern = /const\s+REFERENCE_ACTRESS_TAGS\s*=\s*\[[\s\S]*?\];/;
  const exportBlacklistPattern = /const\s+RAINDROP_EXPORT_BLACKLIST_TAGS\s*=\s*\[[\s\S]*?\];/;
  let script = checked.replace(codePattern, codeBlock);
  script = referencePattern.test(script)
    ? script.replace(referencePattern, referenceBlock)
    : script.replace(codeBlock, `${codeBlock}\n\n  ${referenceBlock}`);
  script = exportBlacklistPattern.test(script)
    ? script.replace(exportBlacklistPattern, exportBlacklistBlock)
    : script.replace(referenceBlock, `${referenceBlock}\n\n  ${exportBlacklistBlock}`);
  return {
    codes,
    script,
    referenceTags,
    referenceTagCount: referenceTags.length,
    referenceBlacklistCount: referenceBlacklist.length,
    blacklistedReferenceTagCount: unfilteredReferenceTags.length - referenceTags.length,
    exportBlacklistCount: exportBlacklist.length,
    templateVersion: hashTemplate(`${checked}\n${referenceTags.join("\n")}\nREFERENCE_BLACKLIST\n${referenceBlacklist.join("\n")}\nEXPORT_BLACKLIST\n${exportBlacklist.join("\n")}`),
  };
}

export function hashTemplate(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
