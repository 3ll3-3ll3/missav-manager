// Generated from the tested v0.4.5 business-rule modules. Do not hand-edit.
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// ../../src/parser.js
var require_parser = __commonJS({
  "../../src/parser.js"(exports, module) {
    function extractFC2Number(s) {
      const text = String(s || "").trim().toUpperCase();
      const m1 = text.match(/^FC2[_\-\s]*PPV[_\-\s]*(\d+)$/i);
      if (m1) return m1[1];
      const m2 = text.match(/^FC2[_\-\s]*(\d+)$/i);
      if (m2) return m2[1];
      const m3 = text.match(/FC2[_\-\s]*PPV[_\-\s]*(\d+)/i);
      if (m3) return m3[1];
      const m4 = text.match(/FC2[_\-\s]*(\d+)/i);
      if (m4) return m4[1];
      return "";
    }
    function extractCodeFromUrl(input) {
      const raw = String(input || "").trim();
      if (!raw) return "";
      let slug = raw;
      try {
        if (/^https?:\/\//i.test(raw)) {
          const url = new URL(raw);
          slug = url.pathname.split("/").filter(Boolean).pop() || "";
        }
      } catch {
        slug = raw.split(/[?#]/)[0].split("/").filter(Boolean).pop() || raw;
      }
      slug = decodeURIComponent(slug).replace(/-chinese-subtitle$/i, "").replace(/-uncensored-leak$/i, "").replace(/[_\s]+/g, "-").trim();
      const fc2 = slug.match(/^fc2(?:-?ppv)?-?(\d{4,10})$/i);
      if (fc2) return `FC2-PPV-${fc2[1]}`;
      const normal = slug.match(/^([a-z]{2,8})-?(\d{2,5})$/i);
      if (normal) return `${normal[1].toUpperCase()}-${normal[2]}`;
      return "";
    }
    function normalizeCode(s) {
      s = String(s || "").trim();
      const shouldExtractFromSlug = /^https?:\/\//i.test(s) || /missav\./i.test(s) || /-(chinese-subtitle|uncensored-leak)$/i.test(s);
      const urlCode = shouldExtractFromSlug ? extractCodeFromUrl(s) : "";
      if (urlCode) return normalizeCode(urlCode);
      s = decodeLooseText(s).toUpperCase().replace(/\s+/g, "");
      if (/^FC2/i.test(s)) {
        const n = extractFC2Number(s);
        if (n) return `FC2-PPV-${n}`;
      }
      const m = s.match(/^([A-Z]{2,8})[-_]?(\d{2,5})$/);
      if (m) return `${m[1]}-${m[2]}`;
      return s;
    }
    function codeComparableKey(code) {
      const c = normalizeCode(code);
      if (c.startsWith("FC2-PPV-")) {
        const n = extractFC2Number(c);
        return `FC2PPV${n}`;
      }
      return c.replace(/-/g, "");
    }
    function codeVariants(code) {
      const c = normalizeCode(code);
      const variants = /* @__PURE__ */ new Set([c, c.replace(/-/g, "")]);
      if (c.startsWith("FC2-PPV-")) {
        const n = extractFC2Number(c);
        variants.add(`FC2-${n}`);
        variants.add(`FC2PPV${n}`);
        variants.add(`FC2PPV-${n}`);
        variants.add(`FC2-PPV-${n}`);
      }
      return [...variants];
    }
    function candidateUrls(code) {
      const c = normalizeCode(code);
      const urls = [];
      if (c.startsWith("FC2-PPV-")) {
        const n = extractFC2Number(c);
        urls.push(`https://missav.ai/cn/fc2-ppv-${n}`);
        urls.push(`https://missav.ai/cn/fc2-ppv-${n}-chinese-subtitle`);
        urls.push(`https://missav.ai/cn/fc2-ppv-${n}-uncensored-leak`);
        urls.push(`https://missav.ai/dm96/cn/FC2-${n}`);
        urls.push(`https://missav.ai/dm89/cn/FC2-${n}`);
        urls.push(`https://missav.ai/dm96/cn/FC2-PPV-${n}`);
        urls.push(`https://missav.ai/dm89/cn/FC2-PPV-${n}`);
      } else {
        const lower = c.toLowerCase();
        urls.push(`https://missav.ai/cn/${lower}`);
        urls.push(`https://missav.ai/cn/${lower}-chinese-subtitle`);
        urls.push(`https://missav.ai/cn/${lower}-uncensored-leak`);
        urls.push(`https://missav.ai/dm96/cn/${c}`);
        urls.push(`https://missav.ai/dm89/cn/${c}`);
      }
      return urls;
    }
    var NOISE_CODE_PREFIXES = /* @__PURE__ */ new Set([
      "MESSAGE",
      "MESSAGES",
      "USERPIC",
      "MEDIA",
      "VIDEO",
      "PHOTO",
      "AVATAR",
      "PAGINATION",
      "DETAILS",
      "STATUS",
      "TITLE",
      "BODY",
      "CLASS",
      "STYLE",
      "DATE",
      "HTML",
      "BUTTON",
      "INPUT",
      "IMAGE",
      "THUMB",
      "THUMBNAIL",
      "AV",
      "TOP",
      "BEST",
      "FUCK",
      "MOODYZ",
      "TAMEIKE",
      "ALL",
      "PDF",
      "TELEGRAM",
      "LOGO",
      "JOHREN",
      "IEOR",
      "PROBABILITY",
      "STATISTICS",
      "PYTHON",
      "OFFICE",
      "GITHUB",
      "SERIES",
      "WEIXIN",
      "RESULT",
      "RELATED",
      "THREAD",
      "XIUREN",
      "WXSYNC",
      "JAVA",
      "LARGE",
      "RJ",
      "NO",
      "PRO",
      "YOUPORN",
      "TV"
    ]);
    var DATE_WORD_PREFIXES = /* @__PURE__ */ new Set([
      "JAN",
      "JANUARY",
      "FEB",
      "FEBRUARY",
      "MAR",
      "MARCH",
      "APR",
      "APRIL",
      "MAY",
      "JUN",
      "JUNE",
      "JUL",
      "JULY",
      "AUG",
      "AUGUST",
      "SEP",
      "SEPT",
      "SEPTEMBER",
      "OCT",
      "OCTOBER",
      "NOV",
      "NOVEMBER",
      "DEC",
      "DECEMBER"
    ]);
    function isNoiseCodePrefix(code) {
      const m = String(code || "").toUpperCase().match(/^([A-Z]+)-([0-9]+)$/);
      if (!m) return false;
      const prefix = m[1];
      const num = Number(m[2]);
      if (NOISE_CODE_PREFIXES.has(prefix)) return true;
      if (DATE_WORD_PREFIXES.has(prefix) && num >= 1900 && num <= 2099) return true;
      return ["SPRING", "SUMMER", "FALL", "AUTUMN", "WINTER"].includes(prefix) && num >= 1900 && num <= 2099;
    }
    function decodeLooseText(text) {
      return String(text || "").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
    }
    function isLikelyStandardCode(code) {
      if (/^PPV-\d+/i.test(code)) return false;
      if (isNoiseCodePrefix(code)) return false;
      return /^(FC2-PPV-\d{4,10}|[A-Z]{2,8}-\d{2,5})$/.test(code);
    }
    function addCode(codes, raw, index = 0) {
      const code = normalizeCode(raw);
      if (isLikelyStandardCode(code)) codes.push({ code, index });
    }
    function addTrustedCode(codes, raw, index = 0) {
      const code = normalizeCode(raw);
      if (/^(FC2-PPV-\d{4,10}|[A-Z]{2,8}-\d{2,5})$/.test(code)) codes.push({ code, index });
    }
    var TRUSTED_AV_HOSTS = [
      "missav.ai",
      "missav.ws",
      "123av.com",
      "avbase.net",
      "javdb.com",
      "javbus.com",
      "javlibrary.com",
      "supjav.com",
      "njav.tv",
      "jable.tv",
      "jav.guru"
    ];
    function isTrustedAvHost(hostname) {
      const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
      return TRUSTED_AV_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
    }
    function extractCodesFromTrustedAvUrl(input) {
      const raw = String(input || "").trim().replace(/[.,;!?]+$/, "");
      if (!/^https?:\/\//i.test(raw)) return [];
      let url;
      try {
        url = new URL(raw);
      } catch {
        return [];
      }
      if (!isTrustedAvHost(url.hostname)) return [];
      const source = decodeURIComponent(url.pathname);
      const matches = [];
      const exactSlugCode = extractCodeFromUrl(url.href);
      if (/^(FC2-PPV-\d{4,10}|[A-Z]{2,8}-\d{2,5})$/.test(exactSlugCode)) matches.push(exactSlugCode);
      const fc2Pattern = /(?:^|[^a-z0-9])fc2(?:[\s_-]*ppv)?[\s_-]*(\d{4,10})(?=$|[^0-9])/gi;
      for (const match of source.matchAll(fc2Pattern)) matches.push(`FC2-PPV-${match[1]}`);
      const standardPattern = /(?:^|[^a-z])([a-z]{2,8})[\s_-]+(\d{2,5})(?=$|[^0-9])/gi;
      for (const match of source.matchAll(standardPattern)) {
        const code = normalizeCode(`${match[1]}-${match[2]}`);
        if (isLikelyStandardCode(code)) matches.push(code);
      }
      return [...new Set(matches)];
    }
    function maskGenericNoise(text) {
      const preserveLength = (match) => match.replace(/[^\r\n]/g, " ");
      return String(text || "").replace(/https?:\/\/[^\s"'<>)]*/gi, preserveLength).replace(/<[^>]*>/g, preserveLength).replace(/\b\d{1,5}\s*[×x]\s*\d{1,5}\b/gi, preserveLength).replace(/\b\d+(?:[.,]\d+)?\s*(?:bytes?|[kmgt]i?b)\b/gi, preserveLength).replace(/\bview\s+results\s+page\b/gi, preserveLength).replace(/\b(?:powered\s+by\s+)?whos\.tv\b/gi, preserveLength).replace(/\bmissav\s+daily\b/gi, preserveLength).replace(/\buncensored[\s_-]+leak(?:ed)?\b/gi, preserveLength).replace(/@\s*[a-z][a-z0-9_]{1,31}/gi, preserveLength).replace(/\b[a-z][a-z0-9_]{1,31}\s+\d{1,2}\s*(?:岁|years?\s+old)/gi, preserveLength).replace(/\b[a-z][a-z0-9_]{1,31}\s+\d{1,3}\s*(?:秒|分钟|小时|小時|天)前/gi, preserveLength);
    }
    function parseCodeList(text) {
      const raw = String(text || "");
      const decoded = decodeLooseText(raw);
      const codes = [];
      const urlPattern = /https?:\/\/[^\s"'<>)]*/gi;
      for (const match of decoded.matchAll(urlPattern)) {
        for (const code of extractCodesFromTrustedAvUrl(match[0])) addTrustedCode(codes, code, match.index || 0);
      }
      const visibleText = maskGenericNoise(decoded);
      const fc2Pattern = /(^|[^A-Za-z0-9])FC2(?:[ \t_-]*PPV)?[ \t_-]*(\d{4,10})(?=$|[^A-Za-z0-9])/gi;
      for (const match of visibleText.matchAll(fc2Pattern)) {
        addCode(codes, `FC2-PPV-${match[2]}`, (match.index || 0) + match[1].length);
      }
      const separatedPattern = /(^|[^A-Za-z0-9])([A-Za-z]{2,8})[ \t_-]+(\d{2,5})(?=$|[^A-Za-z0-9])/g;
      for (const match of visibleText.matchAll(separatedPattern)) {
        addCode(codes, `${match[2]}-${match[3]}`, (match.index || 0) + match[1].length);
      }
      const compactUpperPattern = /(^|[^A-Za-z0-9])([A-Z]{2,8})(\d{2,5})(?=$|[^A-Za-z0-9])/g;
      for (const match of visibleText.matchAll(compactUpperPattern)) {
        addCode(codes, `${match[2]}-${match[3]}`, (match.index || 0) + match[1].length);
      }
      const seen = /* @__PURE__ */ new Set();
      return codes.sort((a, b) => a.index - b.index).filter((item) => {
        const key = codeComparableKey(item.code);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map((item) => item.code);
    }
    module.exports = {
      extractFC2Number,
      extractCodeFromUrl,
      extractCodesFromTrustedAvUrl,
      normalizeCode,
      codeComparableKey,
      codeVariants,
      candidateUrls,
      parseCodeList
    };
  }
});

// ../../src/csvTools.js
var require_csvTools = __commonJS({
  "../../src/csvTools.js"(exports, module) {
    var { normalizeCode, codeComparableKey } = require_parser();
    function parseCSV(text) {
      const input = String(text || "").replace(/^\ufeff/, "");
      const records = [];
      let row = [];
      let field = "";
      let inQuotes = false;
      for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        const next = input[i + 1];
        if (ch === '"') {
          if (inQuotes && next === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
          continue;
        }
        if (ch === "," && !inQuotes) {
          row.push(field);
          field = "";
          continue;
        }
        if ((ch === "\n" || ch === "\r") && !inQuotes) {
          if (ch === "\r" && next === "\n") i++;
          row.push(field);
          records.push(row);
          row = [];
          field = "";
          continue;
        }
        field += ch;
      }
      if (field.length || row.length) {
        row.push(field);
        records.push(row);
      }
      while (records.length && records[records.length - 1].every((v) => !String(v || "").trim())) {
        records.pop();
      }
      const rawHeaders = records.shift() || [];
      const headers = uniqueHeaders(rawHeaders.map((h, i) => String(h || "").trim() || `Column${i + 1}`));
      const colCount = Math.max(headers.length, ...records.map((r) => r.length), 0);
      while (headers.length < colCount) headers.push(`Column${headers.length + 1}`);
      const rowLengths = records.map((r) => r.length);
      const rows = records.map((r) => {
        const next = r.slice(0, colCount);
        while (next.length < colCount) next.push("");
        return next;
      });
      return { headers, rows: repairRaindropLineBreaks(headers, rows, rowLengths) };
    }
    function repairRaindropLineBreaks(headers, rows, rowLengths) {
      const official = ["id", "title", "note", "excerpt", "url", "folder", "tags", "created", "cover", "highlights", "favorite"];
      if (headers.length !== official.length || official.some((name, index) => String(headers[index] || "").toLowerCase() !== name)) return rows;
      const repaired = [];
      let current = null;
      let continuationColumn = null;
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const rawLength = rowLengths[index] || 0;
        if (/^\d+$/.test(String(row[0] || "").trim())) {
          current = row.slice();
          repaired.push(current);
          continuationColumn = rawLength > 0 && rawLength < official.length ? rawLength - 1 : null;
          continue;
        }
        if (!current || continuationColumn === null) {
          if (row.some((value) => String(value || "").trim())) repaired.push(row);
          continue;
        }
        const sourceUrl = row.findIndex((value) => /^https?:\/\//i.test(String(value || "").trim()));
        if (sourceUrl >= 0 && continuationColumn < 4 && !String(current[4] || "").trim()) {
          appendCsvContinuation(current, continuationColumn, row.slice(0, sourceUrl).join(","));
          for (let source = sourceUrl, target = 4; source < rawLength && target < official.length; source++, target++) {
            current[target] = row[source] ?? "";
          }
          continuationColumn = null;
          continue;
        }
        appendCsvContinuation(current, continuationColumn, row.slice(0, rawLength).join(","));
      }
      return repaired;
    }
    function appendCsvContinuation(row, column, value) {
      const current = String(row[column] || "");
      row[column] = current ? `${current}
${value}` : String(value || "");
    }
    function uniqueHeaders(headers) {
      const seen = /* @__PURE__ */ new Map();
      return headers.map((h, i) => {
        const base = String(h || "").trim() || `Column${i + 1}`;
        const count = seen.get(base) || 0;
        seen.set(base, count + 1);
        return count ? `${base}_${count + 1}` : base;
      });
    }
    function stringifyCSV(headers, rows) {
      const out = [];
      out.push(headers.map(escapeCell).join(","));
      for (const row of rows) {
        out.push(headers.map((_, i) => escapeCell(row[i] ?? "")).join(","));
      }
      return out.join("\r\n");
    }
    function escapeCell(value) {
      const s = String(value ?? "");
      if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }
    function analyzeCSV(headers, rows) {
      const issues = [];
      const codeCol = guessColumn(headers, ["\u756A\u53F7", "code", "movie", "\u54C1\u756A"]);
      const urlCol = guessColumn(headers, ["url", "\u94FE\u63A5", "link", "\u7F51\u5740"]);
      const statusCol = guessColumn(headers, ["\u72B6\u6001", "status"]);
      const seenCodes = /* @__PURE__ */ new Map();
      let unknownActress = 0;
      let needCheck = 0;
      let notFound = 0;
      rows.forEach((row, rowIndex) => {
        const text = row.map((v) => String(v || "")).join(" | ");
        if (text.includes("#\u672A\u77E5\u5973\u4F18")) unknownActress++;
        if (/需要查找|待核验|可点待核验/.test(text)) needCheck++;
        if (/未找到|not_found/i.test(text)) notFound++;
        if (codeCol >= 0) {
          const rawCode = String(row[codeCol] || "").trim();
          if (!rawCode) {
            issues.push({ type: "empty_code", severity: "error", row: rowIndex, column: codeCol, message: "\u756A\u53F7\u4E3A\u7A7A" });
          } else {
            const normalized = normalizeCode(rawCode);
            if (!/^(FC2-PPV-\d{4,10}|[A-Z]{2,12}-\d{2,8})$/.test(normalized)) {
              issues.push({ type: "bad_code", severity: "warning", row: rowIndex, column: codeCol, message: `\u756A\u53F7\u683C\u5F0F\u53EF\u7591\uFF1A${rawCode}` });
            }
            const key = codeComparableKey(rawCode);
            if (seenCodes.has(key)) {
              const message = `\u7591\u4F3C\u91CD\u590D\u756A\u53F7\uFF1A${normalized}`;
              issues.push({ type: "duplicate_code", severity: "warning", row: rowIndex, column: codeCol, message });
              issues.push({ type: "duplicate_code", severity: "warning", row: seenCodes.get(key), column: codeCol, message });
            } else {
              seenCodes.set(key, rowIndex);
            }
          }
        }
        if (urlCol >= 0) {
          const url = String(row[urlCol] || "").trim();
          if (url && !/^https?:\/\//i.test(url)) {
            issues.push({ type: "bad_url", severity: "warning", row: rowIndex, column: urlCol, message: `\u94FE\u63A5\u683C\u5F0F\u53EF\u7591\uFF1A${url}` });
          }
        }
      });
      const uniqueIssues = dedupeIssues(issues);
      return {
        rowCount: rows.length,
        columnCount: headers.length,
        codeColumn: codeCol,
        urlColumn: urlCol,
        statusColumn: statusCol,
        unknownActress,
        needCheck,
        notFound,
        issueCount: uniqueIssues.length,
        issues: uniqueIssues
      };
    }
    function guessColumn(headers, names) {
      const lower = headers.map((h) => String(h || "").toLowerCase());
      for (const name of names) {
        const key = String(name).toLowerCase();
        const exact = lower.findIndex((h) => h === key);
        if (exact >= 0) return exact;
      }
      for (const name of names) {
        const key = String(name).toLowerCase();
        const partial = lower.findIndex((h) => h.includes(key));
        if (partial >= 0) return partial;
      }
      return -1;
    }
    function dedupeIssues(issues) {
      const seen = /* @__PURE__ */ new Set();
      return issues.filter((issue) => {
        const key = `${issue.type}:${issue.row}:${issue.column}:${issue.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    module.exports = {
      parseCSV,
      stringifyCSV,
      analyzeCSV,
      guessColumn
    };
  }
});

// ../../src/inputExtractor.js
var require_inputExtractor = __commonJS({
  "../../src/inputExtractor.js"(exports, module) {
    var parser = require_parser();
    var csvTools = require_csvTools();
    var JAV_FOLDER_PATTERN = /(?:日本\s*av|missav|123av|\bjav\b|番号)/i;
    function uniqueCodes(values) {
      const seen = /* @__PURE__ */ new Set();
      return (values || []).filter((code) => {
        const key = parser.codeComparableKey(code);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    function normalizeTrustedMissavUrl(value) {
      const raw = String(value || "").trim().replace(/[.,;!?，。；！？]+$/, "");
      if (!/^https?:\/\//i.test(raw)) return "";
      try {
        const parsed = new URL(raw);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
        const trustedHosts = ["missav.ai", "missav.ws"];
        if (!trustedHosts.some((domain) => host === domain || host.endsWith(`.${domain}`))) return "";
        parsed.hash = "";
        return parsed.href;
      } catch {
        return "";
      }
    }
    function entriesFromCodesAndUrls(codes, urlPairs = []) {
      const sourceByKey = /* @__PURE__ */ new Map();
      for (const pair of urlPairs) {
        const sourceUrl = normalizeTrustedMissavUrl(pair?.url);
        if (!sourceUrl) continue;
        const values = Array.isArray(pair?.codes) ? pair.codes : parser.extractCodesFromTrustedAvUrl(sourceUrl);
        for (const code of values) {
          const key = parser.codeComparableKey(code);
          if (key && !sourceByKey.has(key)) sourceByKey.set(key, sourceUrl);
        }
      }
      return uniqueCodes(codes).map((code) => ({
        code,
        sourceUrl: sourceByKey.get(parser.codeComparableKey(code)) || ""
      }));
    }
    function isRaindropCsv(parsed) {
      const headers = new Set((parsed?.headers || []).map((header) => String(header || "").trim().toLowerCase()));
      return ["title", "url", "folder", "tags", "created", "cover"].every((header) => headers.has(header));
    }
    function titleIsEssentiallyCode(title, code) {
      const normalizedTitle = String(title || "").trim().replace(/[【】[\]()]/g, "").replace(/\s*#\d+\s*$/, "").trim();
      if (!normalizedTitle) return false;
      const only = parser.parseCodeList(normalizedTitle);
      if (only.length !== 1 || parser.codeComparableKey(only[0]) !== parser.codeComparableKey(code)) return false;
      const codePattern = String(code).replace("-", "[\\s_-]*");
      return new RegExp(`^${codePattern}$`, "i").test(normalizedTitle);
    }
    function parseRaindropCsvCodes(parsed) {
      const indexByName = new Map(parsed.headers.map((header, index) => [String(header || "").trim().toLowerCase(), index]));
      const at = (row, name) => String(row[indexByName.get(name)] || "");
      const output = [];
      for (const row of parsed.rows || []) {
        const title = at(row, "title");
        const url = at(row, "url");
        const folder = at(row, "folder");
        const trustedUrlCodes = parser.extractCodesFromTrustedAvUrl(url);
        const contextualCodes = parser.parseCodeList(title);
        output.push(...trustedUrlCodes);
        const trustedContext = JAV_FOLDER_PATTERN.test(folder) || trustedUrlCodes.length > 0;
        for (const code of contextualCodes) {
          if (trustedContext || titleIsEssentiallyCode(title, code)) output.push(code);
        }
      }
      return uniqueCodes(output);
    }
    function parseRaindropCsvEntries(parsed) {
      const indexByName = new Map(parsed.headers.map((header, index) => [String(header || "").trim().toLowerCase(), index]));
      const urlIndex = indexByName.get("url");
      const urls = [];
      for (const row of parsed.rows || []) {
        const url = String(row[urlIndex] || "");
        const sourceUrl = normalizeTrustedMissavUrl(url);
        if (sourceUrl) urls.push({ url: sourceUrl, codes: parser.extractCodesFromTrustedAvUrl(sourceUrl) });
      }
      return entriesFromCodesAndUrls(parseRaindropCsvCodes(parsed), urls);
    }
    function parseInputEntries(text) {
      const raw = String(text || "");
      const firstLine = raw.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].toLowerCase();
      if (firstLine.includes("title") && firstLine.includes("url") && firstLine.includes("folder") && firstLine.includes("cover")) {
        try {
          const parsed = csvTools.parseCSV(raw);
          if (isRaindropCsv(parsed)) return parseRaindropCsvEntries(parsed);
        } catch {
        }
      }
      const urlPairs = [];
      for (const match of raw.matchAll(/https?:\/\/[^\s"'<>)]*/gi)) {
        const sourceUrl = normalizeTrustedMissavUrl(match[0]);
        if (sourceUrl) urlPairs.push({ url: sourceUrl, codes: parser.extractCodesFromTrustedAvUrl(sourceUrl) });
      }
      return entriesFromCodesAndUrls(parser.parseCodeList(raw), urlPairs);
    }
    function parseInputCodeList(text) {
      return parseInputEntries(text).map((entry) => entry.code);
    }
    module.exports = {
      JAV_FOLDER_PATTERN,
      isRaindropCsv,
      normalizeTrustedMissavUrl,
      parseRaindropCsvCodes,
      parseRaindropCsvEntries,
      parseInputEntries,
      parseInputCodeList
    };
  }
});

// ../../src/tools/common.js
var require_common = __commonJS({
  "../../src/tools/common.js"(exports, module) {
    function normalizedText(value) {
      return String(value || "").replace(/\r/g, "");
    }
    function messageText(message = {}) {
      return [
        normalizedText(message.text),
        ...Array.isArray(message.links) ? message.links.map(normalizedText) : []
      ].filter(Boolean).join("\n");
    }
    function parseTelegramDate(value) {
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
      if (typeof value === "number" && Number.isFinite(value)) {
        const date = new Date(value > 1e12 ? value : value * 1e3);
        return Number.isNaN(date.getTime()) ? null : date;
      }
      const text = String(value || "").trim();
      if (!text) return null;
      const telegram = text.match(
        /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+UTC([+-])(\d{2}):?(\d{2})$/i
      );
      if (telegram) {
        const [, day, month, year, hour, minute, second = "0", sign, offsetHour, offsetMinute] = telegram;
        const offset = (Number(offsetHour) * 60 + Number(offsetMinute)) * (sign === "+" ? 1 : -1);
        const utc = Date.UTC(
          Number(year),
          Number(month) - 1,
          Number(day),
          Number(hour),
          Number(minute),
          Number(second)
        ) - offset * 60 * 1e3;
        const date = new Date(utc);
        return Number.isNaN(date.getTime()) ? null : date;
      }
      const parsed = new Date(text);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    function normalizeDate(value) {
      const date = parseTelegramDate(value);
      return date ? date.toISOString() : "";
    }
    function localMinuteBoundary(value, end = false) {
      const text = String(value || "").trim();
      if (!text) return null;
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) return null;
      if (end && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) {
        date.setSeconds(59, 999);
      }
      return date;
    }
    function filterMessagesByTime(messages, range = {}) {
      const start = localMinuteBoundary(range.start);
      const end = localMinuteBoundary(range.end, true);
      return (messages || []).filter((message) => {
        const rawDate = message?.messageDate || message?.date || "";
        const date = parseTelegramDate(rawDate);
        if (!date) {
          const telegramSource = /^(?:export_|api|bot_|telegram)/i.test(String(message?.sourceType || ""));
          return !(telegramSource && (start || end));
        }
        if (start && date < start) return false;
        if (end && date > end) return false;
        return true;
      });
    }
    function messageTimeExtent(messages) {
      const dates = (messages || []).map((message) => parseTelegramDate(message?.messageDate || message?.date)).filter(Boolean).sort((left, right) => left - right);
      return {
        start: dates[0]?.toISOString() || "",
        end: dates.at(-1)?.toISOString() || "",
        dated: dates.length,
        total: Array.isArray(messages) ? messages.length : 0
      };
    }
    module.exports = {
      normalizedText,
      messageText,
      parseTelegramDate,
      normalizeDate,
      filterMessagesByTime,
      messageTimeExtent
    };
  }
});

// ../../src/tools/twitter.js
var require_twitter = __commonJS({
  "../../src/tools/twitter.js"(exports, module) {
    var { normalizedText, messageText, filterMessagesByTime } = require_common();
    var TWITTER_RESERVED_PATHS = /* @__PURE__ */ new Set([
      "about",
      "compose",
      "explore",
      "hashtag",
      "home",
      "i",
      "intent",
      "login",
      "messages",
      "notifications",
      "search",
      "settings",
      "share",
      "signup"
    ]);
    var manifest = Object.freeze({
      id: "twitter",
      label: "\u63A8\u7279\u535A\u4E3B",
      description: "\u4ECE Telegram \u6D88\u606F\u6216\u6587\u4EF6\u4E2D\u63D0\u53D6\u535A\u4E3B\u540D\u548C X \u4E3B\u9875\u94FE\u63A5",
      category: "text",
      categoryLabel: "\u6587\u672C\u63D0\u53D6",
      icon: "at-sign",
      accent: "blue",
      defaultPage: "twitter",
      pages: ["twitter"],
      capabilities: Object.freeze({
        telegram: true,
        fileInput: true,
        timeRange: true,
        network: false,
        accountAction: false,
        persistentResults: true
      })
    });
    function validTwitterHandle(value) {
      const handle = String(value || "").trim().replace(/^[@#]/, "");
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return "";
      if (TWITTER_RESERVED_PATHS.has(handle.toLowerCase())) return "";
      return handle;
    }
    function validTwitterHashtag(value, context = {}) {
      const handle = validTwitterHandle(value);
      if (!handle || handle.length < 4) return "";
      const prefix = String(context.text || "").slice(Math.max(0, Number(context.index || 0) - 24), Number(context.index || 0));
      if (/传送门[\s：:→-]*$/u.test(prefix)) return "";
      return handle;
    }
    function validMentionedTwitterHandle(value) {
      const handle = validTwitterHandle(value);
      if (!handle || /_bot$/i.test(handle)) return "";
      return handle;
    }
    function extractTwitterProfiles(input, options = {}) {
      const messages = Array.isArray(input) ? filterMessagesByTime(input, options) : [{ text: normalizedText(input), links: [] }];
      const output = [];
      const seen = /* @__PURE__ */ new Set();
      const add = (value) => {
        const handle = validTwitterHandle(value);
        const key = handle.toLowerCase();
        if (!handle || seen.has(key)) return;
        seen.add(key);
        output.push({ name: handle, url: `https://x.com/${handle}` });
      };
      for (const message of messages) {
        const text = messageText(message);
        for (const match of text.matchAll(/(?:^|[^\p{L}\p{N}_])#([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/gu)) {
          add(validTwitterHashtag(match[1], { text, index: Number(match.index || 0) + match[0].lastIndexOf("#") }));
        }
        for (const match of text.matchAll(/(?:^|[^\p{L}\p{N}_])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/gu)) {
          add(validMentionedTwitterHandle(match[1]));
        }
        for (const match of text.matchAll(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?=$|[/?#\s"'<>])/gi)) {
          add(match[1]);
        }
      }
      return output;
    }
    module.exports = {
      manifest,
      TWITTER_RESERVED_PATHS,
      validTwitterHandle,
      validTwitterHashtag,
      validMentionedTwitterHandle,
      extractTwitterProfiles
    };
  }
});

// ../../src/tools/badnews.js
var require_badnews = __commonJS({
  "../../src/tools/badnews.js"(exports, module) {
    var { normalizedText, messageText, filterMessagesByTime } = require_common();
    var manifest = Object.freeze({
      id: "badnews",
      label: "Bad.news \u5E16\u5B50",
      description: "\u63D0\u53D6\u5E76\u89C4\u8303\u5316 Bad.news \u5E16\u5B50\u94FE\u63A5",
      category: "text",
      categoryLabel: "\u6587\u672C\u63D0\u53D6",
      icon: "link",
      accent: "orange",
      defaultPage: "badnews",
      pages: ["badnews"],
      capabilities: Object.freeze({
        telegram: true,
        fileInput: true,
        timeRange: true,
        network: false,
        accountAction: false,
        persistentResults: true
      })
    });
    function canonicalBadNewsUrl(value) {
      const match = String(value || "").match(/https?:\/\/(?:www\.)?bad\.news\/t\/(\d+)(?=$|[/?#\s"'<>])/i);
      return match ? `https://bad.news/t/${match[1]}` : "";
    }
    function extractBadNewsLinks(input, options = {}) {
      const messages = Array.isArray(input) ? filterMessagesByTime(input, options) : [{ text: normalizedText(input), links: [] }];
      const output = [];
      const seen = /* @__PURE__ */ new Set();
      for (const message of messages) {
        for (const match of messageText(message).matchAll(/https?:\/\/(?:www\.)?bad\.news\/t\/\d+(?:[/?#][^\s"'<>]*)?/gi)) {
          const url = canonicalBadNewsUrl(match[0]);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          output.push(url);
        }
      }
      return output;
    }
    module.exports = {
      manifest,
      canonicalBadNewsUrl,
      extractBadNewsLinks
    };
  }
});

// ../../src/tools/haijiao.js
var require_haijiao = __commonJS({
  "../../src/tools/haijiao.js"(exports, module) {
    var { normalizedText, messageText, filterMessagesByTime } = require_common();
    var HAIJIAO_POST_CATEGORIES = Object.freeze([
      "hjjd",
      "hjmz",
      "hjyc",
      "hjfn",
      "hjsz",
      "hjrq",
      "hjhj"
    ]);
    var HAIJIAO_CATEGORY_PATTERN = HAIJIAO_POST_CATEGORIES.join("|");
    var manifest = Object.freeze({
      id: "haijiao",
      label: "\u6D77\u89D2\u5E16\u5B50",
      description: "\u63D0\u53D6\u5E76\u89C4\u8303\u5316\u6D77\u89D2\u5185\u5BB9\u5E16\u76F4\u8FBE\u94FE\u63A5",
      category: "text",
      categoryLabel: "\u6587\u672C\u63D0\u53D6",
      icon: "waves",
      accent: "cyan",
      defaultPage: "haijiao",
      pages: ["haijiao"],
      capabilities: Object.freeze({
        telegram: true,
        fileInput: true,
        timeRange: true,
        network: false,
        accountAction: false,
        persistentResults: true
      })
    });
    function canonicalHaijiaoUrl(value) {
      const match = String(value || "").match(new RegExp(
        `https?:\\/\\/(?:www\\.)?haijiaolove\\.xyz\\/(${HAIJIAO_CATEGORY_PATTERN})\\/(\\d+)\\.html(?=$|[/?#\\s"'<>])`,
        "i"
      ));
      if (!match) return "";
      return `https://www.haijiaolove.xyz/${match[1].toLowerCase()}/${match[2]}.html`;
    }
    function extractHaijiaoLinks(input, options = {}) {
      const messages = Array.isArray(input) ? filterMessagesByTime(input, options) : [{ text: normalizedText(input), links: [] }];
      const output = [];
      const seen = /* @__PURE__ */ new Set();
      const candidatePattern = new RegExp(
        `https?:\\/\\/(?:www\\.)?haijiaolove\\.xyz\\/(?:${HAIJIAO_CATEGORY_PATTERN})\\/\\d+\\.html(?:[/?#][^\\s"'<>]*)?`,
        "gi"
      );
      for (const message of messages) {
        for (const match of messageText(message).matchAll(candidatePattern)) {
          const url = canonicalHaijiaoUrl(match[0]);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          output.push(url);
        }
      }
      return output;
    }
    module.exports = {
      manifest,
      HAIJIAO_POST_CATEGORIES,
      canonicalHaijiaoUrl,
      extractHaijiaoLinks
    };
  }
});

// ../../src/toolboxFilters.js
var require_toolboxFilters = __commonJS({
  "../../src/toolboxFilters.js"(exports, module) {
    var common = require_common();
    var twitter = require_twitter();
    var badnews = require_badnews();
    var haijiao = require_haijiao();
    module.exports = {
      TWITTER_RESERVED_PATHS: twitter.TWITTER_RESERVED_PATHS,
      parseTelegramDate: common.parseTelegramDate,
      normalizeDate: common.normalizeDate,
      filterMessagesByTime: common.filterMessagesByTime,
      messageTimeExtent: common.messageTimeExtent,
      validTwitterHandle: twitter.validTwitterHandle,
      extractTwitterProfiles: twitter.extractTwitterProfiles,
      canonicalBadNewsUrl: badnews.canonicalBadNewsUrl,
      extractBadNewsLinks: badnews.extractBadNewsLinks,
      HAIJIAO_POST_CATEGORIES: haijiao.HAIJIAO_POST_CATEGORIES,
      canonicalHaijiaoUrl: haijiao.canonicalHaijiaoUrl,
      extractHaijiaoLinks: haijiao.extractHaijiaoLinks
    };
  }
});

// ../../src/utils.js
var require_utils = __commonJS({
  "../../src/utils.js"(exports, module) {
    function cleanText(s) {
      return String(s ?? "").replace(/\s+/g, " ").trim();
    }
    function cleanRaindropTag(s) {
      return cleanText(s).replace(/[#,;"'<>?:|\\\/[\]{}]/g, "").replace(/\s+/g, "_").slice(0, 120);
    }
    function escapeHtml(s) {
      return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function csvCell(s) {
      return `"${String(s ?? "").replace(/"/g, '""')}"`;
    }
    function timePrefixToMinute() {
      const d = /* @__PURE__ */ new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${y}${m}${day}_${hh}${mm}`;
    }
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    function isBadTypeTag(name) {
      const s = cleanText(name);
      const tag = cleanRaindropTag(s);
      if (!s || !tag) return true;
      if (/女优|女優|男优|男優|系列|发行商|發行商|导演|導演|标签|標籤|片商|收藏|登录|注册|更多|首页|首頁/i.test(s)) return true;
      if (/官方.*电报|官方.*電報|电报群|電報群|Telegram|TG群/i.test(s)) return true;
      if (/无广告|無廣告|免费漫画|免費漫畫|漫画|漫畫/i.test(s)) return true;
      if (/AI[_\s\-]*Jerk|Jerk[_\s\-]*Off/i.test(s)) return true;
      if (/亚博|亞博|赌场|賭場|世界杯|博彩|投注/i.test(s)) return true;
      if (/VPN|性价王|性價王/i.test(s)) return true;
      if (/色色主播|主播|直播|约炮|約炮|交友/i.test(s)) return true;
      if (/下载|下載|磁力|种子|種子|网盘|網盤|云盘|雲盤|torrent|magnet/i.test(s)) return true;
      if (/MissAV|DM\d+|^\d+$/.test(s)) return true;
      if (/[a-z]{2,}\d{2,}/i.test(s)) return true;
      if (/https?:\/\//i.test(s) || /\.[a-z]{2,}/i.test(s)) return true;
      if (/^_+$/.test(tag)) return true;
      return false;
    }
    module.exports = {
      cleanText,
      cleanRaindropTag,
      escapeHtml,
      csvCell,
      timePrefixToMinute,
      sleep,
      isBadTypeTag
    };
  }
});

// ../../src/fetcher.js
var require_fetcher = __commonJS({
  "../../src/fetcher.js"(exports, module) {
    var { cleanText, cleanRaindropTag, isBadTypeTag } = require_utils();
    async function fetchPage(url, fetchImpl, options = {}) {
      const timeout = Number(options.timeout || 15e3);
      let result;
      try {
        result = await fetchImpl(url, { timeout });
      } catch (err) {
        return { statusCode: 0, body: "", error: err.message };
      }
      let redirects = 0;
      while (result.redirected && redirects < 3) {
        try {
          result = await fetchImpl(result.redirectUrl, { timeout });
          redirects++;
        } catch (err) {
          return { statusCode: 0, body: "", error: err.message, redirectedFrom: result.redirectUrl };
        }
      }
      if (result.redirected) {
        return {
          statusCode: result.statusCode || 0,
          body: "",
          finalUrl: result.redirectUrl || url,
          error: "\u91CD\u5B9A\u5411\u6B21\u6570\u8D85\u8FC7\u9650\u5236"
        };
      }
      return {
        statusCode: result.statusCode,
        body: result.body || "",
        finalUrl: result.finalUrl || url,
        error: result.error || null,
        transport: result.transport || "",
        durationMs: Number(result.durationMs || 0),
        responseBytes: Number(result.responseBytes || 0),
        timedOut: result.timedOut === true
      };
    }
    function detectAccessChallenge(pageHtml, code = "") {
      const html = String(pageHtml || "").toLowerCase();
      if (!html) return "";
      const strongMarkers = [
        ["cloudflare_challenge", "cf-chl-"],
        ["checking_browser", "checking your browser"],
        ["verify_human", "verify you are human"],
        ["cloudflare_attention_required", "attention required! | cloudflare"],
        ["title_just_a_moment", "<title>just a moment"],
        ["title_403_forbidden", "<title>403 forbidden"]
      ];
      const strongMatch = strongMarkers.find(([, marker]) => html.includes(marker));
      if (strongMatch) return strongMatch[0];
      const hasTargetCode = code ? hasCodeEvidence(pageHtml, code) : false;
      const hasDetailStructure = hasDetailPageEvidence(pageHtml);
      if (hasTargetCode && hasDetailStructure) return "";
      const weakMarkers = [
        ["cloudflare_challenge_platform", "challenge-platform"],
        ["too_many_requests", "too many requests"],
        ["rate_limit_exceeded", "rate limit exceeded"],
        ["access_denied", "access denied"],
        ["captcha", "captcha"],
        ["human_verification_zh", "\u4EBA\u673A\u9A8C\u8BC1"],
        ["security_verification_zh", "\u5B89\u5168\u9A8C\u8BC1"],
        ["access_denied_zh", "\u8BBF\u95EE\u88AB\u62D2\u7EDD"],
        ["rate_limit_zh", "\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41"]
      ];
      const weakMatch = weakMarkers.find(([, marker]) => html.includes(marker));
      return weakMatch ? weakMatch[0] : "";
    }
    function isAccessChallengePage(pageHtml, code = "") {
      return Boolean(detectAccessChallenge(pageHtml, code));
    }
    function hasCodeEvidence(pageHtml, code) {
      const html = String(pageHtml || "").toLowerCase();
      const normalizedCode = String(code || "").trim().toLowerCase();
      if (!html || !normalizedCode) return false;
      const forms = /* @__PURE__ */ new Set([
        normalizedCode,
        normalizedCode.replace(/-/g, ""),
        normalizedCode.replace(/-/g, "_"),
        normalizedCode.replace(/-/g, " ")
      ]);
      if (normalizedCode.startsWith("fc2-ppv-")) {
        const number = normalizedCode.replace("fc2-ppv-", "");
        forms.add(`fc2-${number}`);
        forms.add(`fc2 ppv ${number}`);
        forms.add(`fc2_ppv_${number}`);
      }
      return [...forms].some((form) => form && html.includes(form));
    }
    function hasDetailPageEvidence(pageHtml) {
      const html = String(pageHtml || "").toLowerCase();
      return html.includes("video") || html.includes("player") || html.includes("m3u8") || html.includes("\u64AD\u653E") || html.includes("iframe") || html.includes("jwplayer") || html.includes("/video/") || html.includes("/actresses/") || html.includes("/genres/");
    }
    function checkPageStatus(pageHtml, code, finalUrl) {
      const rawHtml = String(pageHtml || "");
      const html = rawHtml.toLowerCase();
      if (!rawHtml.trim()) {
        return "not_found";
      }
      if (isAccessChallengePage(rawHtml, code)) {
        return "network_error";
      }
      if (!hasCodeEvidence(rawHtml, code)) {
        return "not_found";
      }
      if (rawHtml.length < 200) {
        return "need_manual_check";
      }
      const hasVideoIndicator = html.includes("video") || html.includes("player") || html.includes("m3u8") || html.includes("\u64AD\u653E") || html.includes("iframe") || html.includes("jwplayer") || html.includes("/video/");
      const hasActress = html.includes("/actresses/");
      const hasGenre = html.includes("/genres/");
      if (!hasActress && !hasGenre && !hasVideoIndicator) {
        return "need_manual_check";
      }
      if (!hasVideoIndicator && hasActress) {
        return "page_ok_play_unknown";
      }
      if (!hasActress) {
        return "no_actress_found";
      }
      return "ok";
    }
    function classifyCandidateResponse(page, code, requestedUrl = "") {
      const response = page || {};
      const url = response.finalUrl || requestedUrl || "";
      const statusCode = Number(response.statusCode || 0);
      const html = String(response.body || "");
      if (response.error) {
        return { status: "network_error", url, html: "", statusCode, error: String(response.error) };
      }
      if (statusCode === 404 || statusCode === 410) {
        return { status: "not_found", url, html, statusCode, error: "" };
      }
      if (!statusCode || statusCode >= 400) {
        return { status: "network_error", url, html: "", statusCode, error: statusCode ? `HTTP ${statusCode}` : "\u672A\u53D6\u5F97\u6709\u6548 HTTP \u54CD\u5E94" };
      }
      const status = checkPageStatus(html, code, url);
      const challengeReason = status === "network_error" ? detectAccessChallenge(html, code) : "";
      return {
        status,
        url,
        html,
        statusCode,
        error: status === "network_error" ? `\u9875\u9762\u89E6\u53D1\u8BBF\u95EE\u9A8C\u8BC1\u3001\u9650\u6D41\u6216\u9632\u722C\u4FDD\u62A4${challengeReason ? `\uFF08\u7279\u5F81\uFF1A${challengeReason}\uFF09` : ""}` : ""
      };
    }
    function shouldStopCandidateSearch(status) {
      return ["ok", "no_actress_found", "page_ok_play_unknown"].includes(status);
    }
    function resolveCandidateAttempts(attempts, fallbackUrl = "") {
      const rows = Array.isArray(attempts) ? attempts : [];
      const priority = /* @__PURE__ */ new Map([
        ["ok", 5],
        ["no_actress_found", 4],
        ["page_ok_play_unknown", 3],
        ["need_manual_check", 2]
      ]);
      let best = null;
      for (const row of rows) {
        const score = priority.get(row.status) || 0;
        if (score && (!best || score > best.score)) best = { ...row, score };
      }
      if (best) {
        const { score, ...result } = best;
        return result;
      }
      const network = rows.find((row) => row.status === "network_error");
      if (network) return network;
      const missing = rows.find((row) => row.status === "not_found");
      return missing || { status: "not_found", url: fallbackUrl, html: "", statusCode: 0, error: "" };
    }
    function extractActressTags(pageHtml) {
      const html = String(pageHtml || "").replace(/\\\//g, "/");
      const actressPattern = /<a\b[^>]*href\s*=\s*(["'])[^"']*\/actresses\/[^"']*\1[^>]*>([\s\S]*?)<\/a>/gi;
      const result = [];
      const seen = /* @__PURE__ */ new Set();
      let match;
      while ((match = actressPattern.exec(html)) !== null) {
        const raw = cleanText(match[2].replace(/<[^>]*>/g, ""));
        if (!raw || raw.length > 80) continue;
        const tag = cleanRaindropTag(raw);
        if (!tag || seen.has(tag)) continue;
        if (isBadTypeTag(raw)) continue;
        seen.add(tag);
        result.push(tag);
      }
      return result;
    }
    function extractGenreTags(pageHtml) {
      const html = String(pageHtml || "").replace(/\\\//g, "/");
      const genrePattern = /<a\b[^>]*href\s*=\s*(["'])[^"']*\/genres\/[^"']*\1[^>]*>([\s\S]*?)<\/a>/gi;
      const result = [];
      const seen = /* @__PURE__ */ new Set();
      let match;
      while ((match = genrePattern.exec(html)) !== null) {
        const raw = cleanText(match[2].replace(/<[^>]*>/g, ""));
        if (!raw || raw.length > 40) continue;
        if (isBadTypeTag(raw)) continue;
        const tag = cleanRaindropTag(raw);
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        result.push(tag);
      }
      return result;
    }
    function extractMetadata(pageHtml, code, finalUrl) {
      const status = checkPageStatus(pageHtml, code, finalUrl);
      const actresses = status === "ok" || status === "page_ok_play_unknown" ? extractActressTags(pageHtml) : [];
      const genres = status === "ok" || status === "page_ok_play_unknown" || status === "no_actress_found" ? extractGenreTags(pageHtml) : [];
      return { status, actresses, genres };
    }
    module.exports = {
      fetchPage,
      detectAccessChallenge,
      isAccessChallengePage,
      hasCodeEvidence,
      hasDetailPageEvidence,
      checkPageStatus,
      classifyCandidateResponse,
      resolveCandidateAttempts,
      shouldStopCandidateSearch,
      extractActressTags,
      extractGenreTags,
      extractMetadata
    };
  }
});

// ../../src/av123.js
var require_av123 = __commonJS({
  "../../src/av123.js"(exports, module) {
    var { normalizeCode, codeComparableKey } = require_parser();
    var { cleanText } = require_utils();
    var BASE_URL = "https://123av.com";
    var DETAIL_SUFFIXES = [
      "-uncensored-leaked",
      "-uncensored-leak",
      "-chinese-subtitle",
      "-english-subtitle",
      "-uncensored",
      "-leaked"
    ];
    function buildSearchUrl(code, locale = "cn") {
      const normalized = normalizeCode(code);
      const safeLocale = /^[a-z]{2}$/i.test(String(locale || "")) ? String(locale).toLowerCase() : "cn";
      return `${BASE_URL}/${safeLocale}/search?keyword=${encodeURIComponent(normalized)}`;
    }
    function buildDetailUrl(code, locale = "cn") {
      const normalized = normalizeCode(code).toLowerCase();
      const safeLocale = /^[a-z]{2}$/i.test(String(locale || "")) ? String(locale).toLowerCase() : "cn";
      return `${BASE_URL}/${safeLocale}/v/${encodeURIComponent(normalized)}`;
    }
    function buildDetailCandidateUrls(code, locale = "cn") {
      const base = buildDetailUrl(code, locale);
      return [base, ...DETAIL_SUFFIXES.map((suffix) => `${base}${suffix}`)];
    }
    function decodeHtml(value) {
      return String(value || "").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_match, value2) => String.fromCodePoint(Number(value2))).replace(/&#x([0-9a-f]+);/gi, (_match, value2) => String.fromCodePoint(parseInt(value2, 16)));
    }
    function visibleText(html) {
      return cleanText(decodeHtml(String(html || "").replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")));
    }
    function extractCodeTokens(text) {
      const source = String(text || "").toUpperCase();
      const tokens = [];
      const patterns = [
        /(?:^|[^A-Z0-9])(FC2(?:[-_\s]*PPV)?[-_\s]*\d{4,10})(?![A-Z0-9])/g,
        /(?:^|[^A-Z0-9])([A-Z]{2,8}[-_\s]?\d{2,5})(?![A-Z0-9])/g
      ];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(source)) !== null) tokens.push(normalizeCode(match[1]));
      }
      return [...new Set(tokens.filter(Boolean))];
    }
    function hasExactCodeEvidence(text, code) {
      const target = codeComparableKey(code);
      if (!target) return false;
      return extractCodeTokens(text).some((token) => codeComparableKey(token) === target);
    }
    function extractAttribute(attributes, name) {
      const match = String(attributes || "").match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
      return match ? decodeHtml(match[2]).trim() : "";
    }
    function normalizeDetailUrl(href, baseUrl = BASE_URL) {
      try {
        const parsed = new URL(String(href || ""), baseUrl);
        if (!["123av.com", "www.123av.com"].includes(parsed.hostname.toLowerCase())) return "";
        if (!/^\/[a-z]{2}\/v\//i.test(parsed.pathname)) return "";
        parsed.hash = "";
        return parsed.href;
      } catch {
        return "";
      }
    }
    function detailSlug(url) {
      try {
        return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "").toLowerCase();
      } catch {
        return "";
      }
    }
    function candidateScore(url, code) {
      const target = normalizeCode(code).toLowerCase();
      const slug = detailSlug(url);
      if (slug === target) return 3;
      if (DETAIL_SUFFIXES.some((suffix) => slug === `${target}${suffix}`)) return 2;
      return 1;
    }
    function extractExactSearchCandidates(html, code, finalUrl = BASE_URL) {
      const source = String(html || "");
      const candidates = [];
      const seen = /* @__PURE__ */ new Set();
      const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = anchorPattern.exec(source)) !== null) {
        const href = extractAttribute(match[1], "href");
        if (!href || !/\/v\//i.test(href)) continue;
        const title = visibleText(match[2]);
        if (!title || !hasExactCodeEvidence(title, code)) continue;
        const url = normalizeDetailUrl(href, finalUrl || BASE_URL);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        candidates.push({ url, title, score: candidateScore(url, code) });
      }
      return candidates.sort((left, right) => right.score - left.score || left.url.length - right.url.length);
    }
    function accessChallengeReason(html) {
      const source = String(html || "").toLowerCase();
      const markers = [
        ["cloudflare_challenge", "cf-chl-"],
        ["checking_browser", "checking your browser"],
        ["verify_human", "verify you are human"],
        ["attention_required", "attention required! | cloudflare"],
        ["just_a_moment", "<title>just a moment"],
        ["rate_limit", "too many requests"],
        ["rate_limit", "rate limit exceeded"],
        ["access_denied", "<title>403 forbidden"],
        ["human_verification_zh", "\u4EBA\u673A\u9A8C\u8BC1"],
        ["rate_limit_zh", "\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41"]
      ];
      return markers.find(([, marker]) => source.includes(marker))?.[0] || "";
    }
    function isLoginRequired(html, finalUrl = "") {
      const source = String(html || "").toLowerCase();
      let pathname = "";
      try {
        pathname = new URL(String(finalUrl || "")).pathname.toLowerCase();
      } catch {
      }
      if (/\/(?:login|signin)(?:\/|$)/.test(pathname)) return true;
      return /<input\b[^>]*type\s*=\s*(["'])password\1/i.test(source) && /<form\b[^>]*(?:login|signin)/i.test(source);
    }
    function extractDetailEvidence(html, code) {
      const source = String(html || "");
      const evidenceBlocks = [];
      for (const pattern of [
        /<title\b[^>]*>([\s\S]*?)<\/title>/gi,
        /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi,
        /<dt\b[^>]*>\s*(?:代码|番[號号]|code)\s*<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi
      ]) {
        let match;
        while ((match = pattern.exec(source)) !== null) evidenceBlocks.push(visibleText(match[1]));
      }
      const exact = evidenceBlocks.find((text) => hasExactCodeEvidence(text, code)) || "";
      const hasStructure = /<h1\b/i.test(source) && (/<dt\b/i.test(source) || /\/genres\//i.test(source) || /\/actresses\//i.test(source)) && (/<iframe\b/i.test(source) || /<video\b/i.test(source) || /class\s*=\s*(["'])[^"']*player/i.test(source));
      return { exact, hasStructure };
    }
    function pageKind(html, finalUrl = "") {
      const source = String(html || "");
      let pathname = "";
      try {
        pathname = new URL(String(finalUrl || "")).pathname.toLowerCase();
      } catch {
      }
      if (/\/[a-z]{2}\/v\//.test(pathname)) return "detail";
      if (/\/search\/?$/.test(pathname)) return "search";
      if (/<dt\b[^>]*>\s*(?:代码|番[號号]|code)\s*<\/dt>/i.test(source)) return "detail";
      if (/class\s*=\s*(["'])[^"']*card__link/i.test(source)) return "search";
      return "unknown";
    }
    function retryAfterMs(headers = {}) {
      const value = String(headers["retry-after"] ?? headers["Retry-After"] ?? "").trim();
      if (!value) return 0;
      if (/^\d+(?:\.\d+)?$/.test(value)) return Math.min(12e4, Math.max(0, Math.round(Number(value) * 1e3)));
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) ? Math.min(12e4, Math.max(0, timestamp - Date.now())) : 0;
    }
    function classifyResponse(page, code, requestedUrl = "") {
      const response = page || {};
      const statusCode = Number(response.statusCode || 0);
      const finalUrl = String(response.finalUrl || requestedUrl || "");
      const html = String(response.body || "");
      const normalized = normalizeCode(code);
      const retryDelay = retryAfterMs(response.headers || {});
      if (response.error) {
        return { status: "network_error", url: finalUrl, statusCode, error: String(response.error), metadata: { responseKind: "network" } };
      }
      if ([403, 408, 425, 429].includes(statusCode) || statusCode >= 500) {
        return { status: "network_error", url: finalUrl, statusCode, error: `HTTP ${statusCode}`, metadata: { responseKind: "network", retryAfterMs: retryDelay } };
      }
      if (statusCode === 404 || statusCode === 410) {
        return { status: "not_found", url: "", statusCode, error: "", metadata: { responseKind: "not_found" } };
      }
      if (!statusCode || statusCode >= 400) {
        return { status: "network_error", url: finalUrl, statusCode, error: statusCode ? `HTTP ${statusCode}` : "\u672A\u53D6\u5F97\u6709\u6548 HTTP \u54CD\u5E94", metadata: { responseKind: "network" } };
      }
      const challenge = accessChallengeReason(html);
      if (challenge) {
        return {
          status: "network_error",
          url: finalUrl,
          statusCode,
          error: `123AV \u89E6\u53D1\u8BBF\u95EE\u9A8C\u8BC1\u3001\u9650\u6D41\u6216\u9632\u722C\u4FDD\u62A4\uFF08\u7279\u5F81\uFF1A${challenge}\uFF09`,
          metadata: { responseKind: "challenge", challenge }
        };
      }
      if (isLoginRequired(html, finalUrl)) {
        return { status: "manual", url: finalUrl, statusCode, error: "123AV \u8981\u6C42\u767B\u5F55\u540E\u624D\u80FD\u67E5\u8BE2", metadata: { responseKind: "login_required" } };
      }
      const kind = pageKind(html, finalUrl);
      if (kind === "detail") {
        const evidence = extractDetailEvidence(html, normalized);
        if (evidence.exact && evidence.hasStructure) {
          return {
            status: "succeeded",
            url: normalizeDetailUrl(finalUrl) || finalUrl,
            statusCode,
            error: "",
            metadata: { responseKind: "detail", matchedTitle: evidence.exact, candidateCount: 1 }
          };
        }
        if (!evidence.exact) {
          return { status: "not_found", url: "", statusCode, error: "", metadata: { responseKind: "detail_mismatch" } };
        }
        return { status: "manual", url: finalUrl, statusCode, error: "\u8BE6\u60C5\u9875\u5305\u542B\u756A\u53F7\uFF0C\u4F46\u9875\u9762\u7ED3\u6784\u4E0D\u8DB3\uFF0C\u9700\u4EBA\u5DE5\u6838\u9A8C", metadata: { responseKind: "detail_unverified" } };
      }
      if (kind === "search") {
        const candidates = extractExactSearchCandidates(html, normalized, finalUrl || BASE_URL);
        if (candidates.length) {
          return {
            status: "succeeded",
            url: candidates[0].url,
            statusCode,
            error: "",
            metadata: {
              responseKind: "search",
              matchedTitle: candidates[0].title,
              candidateCount: candidates.length,
              alternateUrls: candidates.slice(1, 5).map((item) => item.url)
            }
          };
        }
        return { status: "not_found", url: "", statusCode, error: "", metadata: { responseKind: "search", candidateCount: 0 } };
      }
      return {
        status: "manual",
        url: finalUrl,
        statusCode,
        error: "123AV \u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684\u9875\u9762\uFF0C\u9700\u4EBA\u5DE5\u6838\u9A8C",
        metadata: { responseKind: "unknown" }
      };
    }
    async function fetchPage(url, fetchImpl, options = {}) {
      const timeout = Number(options.timeout || 15e3);
      let result;
      try {
        result = await fetchImpl(url, { timeout });
      } catch (err) {
        return { statusCode: 0, body: "", finalUrl: url, error: err.message || String(err) };
      }
      let redirects = 0;
      while (result.redirected && redirects < 3) {
        try {
          result = await fetchImpl(result.redirectUrl, { timeout });
          redirects++;
        } catch (err) {
          return { statusCode: 0, body: "", finalUrl: result.redirectUrl || url, error: err.message || String(err) };
        }
      }
      if (result.redirected) {
        return { statusCode: result.statusCode || 0, body: "", finalUrl: result.redirectUrl || url, error: "\u91CD\u5B9A\u5411\u6B21\u6570\u8D85\u8FC7\u9650\u5236" };
      }
      return {
        statusCode: result.statusCode || 0,
        body: result.body || "",
        finalUrl: result.finalUrl || url,
        error: result.error || null,
        transport: result.transport || "",
        headers: result.headers || {},
        durationMs: Number(result.durationMs || 0),
        responseBytes: Number(result.responseBytes || 0),
        timedOut: result.timedOut === true
      };
    }
    module.exports = {
      BASE_URL,
      DETAIL_SUFFIXES,
      buildSearchUrl,
      buildDetailUrl,
      buildDetailCandidateUrls,
      extractCodeTokens,
      hasExactCodeEvidence,
      extractExactSearchCandidates,
      accessChallengeReason,
      isLoginRequired,
      extractDetailEvidence,
      retryAfterMs,
      classifyResponse,
      fetchPage
    };
  }
});

// scripts/legacy-entry.cjs
var require_legacy_entry = __commonJS({
  "scripts/legacy-entry.cjs"(exports, module) {
    var parser = require_parser();
    var input = require_inputExtractor();
    var toolbox = require_toolboxFilters();
    var fetcher = require_fetcher();
    var av123 = require_av123();
    module.exports = { parser, input, toolbox, fetcher, av123 };
  }
});
export default require_legacy_entry();
