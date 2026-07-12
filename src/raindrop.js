const { parseCSV, stringifyCSV } = require('./csvTools');
const { escapeHtml } = require('./utils');

const CSV_HEADERS = ['id', 'title', 'note', 'excerpt', 'url', 'folder', 'tags', 'created', 'cover', 'highlights', 'favorite'];

function parseRaindropCSV(text) {
  const parsed = parseCSV(text);
  const indexes = new Map(parsed.headers.map((header, index) => [String(header || '').trim().toLowerCase(), index]));
  const value = (row, field) => {
    const index = indexes.get(field);
    return index === undefined ? '' : String(row[index] ?? '').trim();
  };
  return parsed.rows
    .map(row => ({
      raindrop_id: value(row, 'id'),
      title: value(row, 'title'),
      note: value(row, 'note'),
      excerpt: value(row, 'excerpt'),
      url: value(row, 'url'),
      folder: value(row, 'folder'),
      tags: value(row, 'tags'),
      created: value(row, 'created'),
      cover: value(row, 'cover'),
      highlights: value(row, 'highlights'),
      favorite: value(row, 'favorite').toLowerCase() === 'true',
    }))
    .filter(row => row.raindrop_id || row.url || row.title);
}

function generateRaindropCSV(records) {
  const rows = (records || []).map(record => [
    record.raindrop_id || record.id || '',
    record.title || record.raindrop_title || '',
    record.note || record.raindrop_note || '',
    record.excerpt || record.raindrop_excerpt || '',
    record.url || record.best_url || '',
    record.folder || record.raindrop_folder || '',
    record.tags || record.raindrop_tags || '',
    record.created || record.raindrop_created || '',
    record.cover || record.raindrop_cover || '',
    record.highlights || '',
    record.favorite === true || Number(record.favorite) === 1 ? 'true' : 'false',
  ]);
  return stringifyCSV(CSV_HEADERS, rows);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function stripHtml(value) {
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, '')).trim();
}

function parseAttributes(tag) {
  const attrs = {};
  for (const match of String(tag || '').matchAll(/([A-Z][A-Z0-9_-]*)\s*=\s*"([^"]*)"/gi)) {
    attrs[match[1].toUpperCase()] = decodeHtml(match[2]);
  }
  return attrs;
}

function epochToIso(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : '';
}

function parseRaindropHTML(text) {
  const records = [];
  const folders = [];
  let pendingFolder = '';
  let current = null;
  const lines = String(text || '').split(/\r?\n/);

  for (const line of lines) {
    const folderMatch = line.match(/<DT><H3\b([^>]*)>([\s\S]*?)<\/H3>/i);
    if (folderMatch) {
      pendingFolder = stripHtml(folderMatch[2]);
      continue;
    }
    if (/<DL><p>/i.test(line)) {
      if (pendingFolder) {
        folders.push(pendingFolder);
        pendingFolder = '';
      }
      continue;
    }
    if (/<\/DL><p>/i.test(line)) {
      if (folders.length) folders.pop();
      continue;
    }

    const anchorMatch = line.match(/<DT><A\b([^>]*)>([\s\S]*?)<\/A>/i);
    if (anchorMatch) {
      const attrs = parseAttributes(anchorMatch[1]);
      current = {
        raindrop_id: '',
        title: stripHtml(anchorMatch[2]),
        note: '',
        excerpt: '',
        url: attrs.HREF || '',
        folder: folders.join(' / '),
        tags: attrs.TAGS || '',
        created: epochToIso(attrs.ADD_DATE),
        cover: attrs['DATA-COVER'] || '',
        highlights: '',
        favorite: String(attrs['DATA-IMPORTANT'] || '').toLowerCase() === 'true',
        last_modified: epochToIso(attrs.LAST_MODIFIED),
      };
      records.push(current);
      continue;
    }

    const ddMatch = line.match(/<DD>([\s\S]*)/i);
    if (ddMatch && current) {
      const blockquotes = [...ddMatch[1].matchAll(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi)].map(match => stripHtml(match[1])).filter(Boolean);
      if (blockquotes.length) current.highlights = [current.highlights, ...blockquotes].filter(Boolean).join('\n');
      else current.note = stripHtml(ddMatch[1]);
    }
  }
  return records.filter(row => row.url || row.title);
}

function isoToEpoch(value) {
  const date = new Date(String(value || ''));
  return Number.isNaN(date.getTime()) ? '' : String(Math.floor(date.getTime() / 1000));
}

function attr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function buildFolderTree(records) {
  const root = { children: new Map(), records: [] };
  for (const record of records || []) {
    const parts = String(record.folder || record.raindrop_folder || '').split(/\s+\/\s+/).map(part => part.trim()).filter(Boolean);
    let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) node.children.set(part, { name: part, children: new Map(), records: [] });
      node = node.children.get(part);
    }
    node.records.push(record);
  }
  return root;
}

function renderBookmark(record, indent) {
  const created = isoToEpoch(record.created || record.raindrop_created) || String(Math.floor(Date.now() / 1000));
  const modified = isoToEpoch(record.last_modified) || created;
  const title = record.title || record.raindrop_title || record.url || record.best_url || 'Untitled';
  const url = record.url || record.best_url || '';
  const tags = record.tags || record.raindrop_tags || '';
  const cover = record.cover || record.raindrop_cover || '';
  const favorite = record.favorite === true || Number(record.favorite) === 1 ? 'true' : 'false';
  const lines = [`${indent}<DT><A HREF="${attr(url)}" ADD_DATE="${created}" LAST_MODIFIED="${modified}" TAGS="${attr(tags)}" DATA-COVER="${attr(cover)}" DATA-IMPORTANT="${favorite}">${escapeHtml(title)}</A>`];
  const note = record.note || record.raindrop_note || '';
  if (note) lines.push(`${indent}<DD>${escapeHtml(note)}`);
  for (const highlight of String(record.highlights || '').split(/\r?\n/).filter(Boolean)) {
    lines.push(`${indent}<DD><blockquote COLOR="undefined" ADD_DATE="${modified}">${escapeHtml(highlight)}</blockquote>`);
  }
  return lines;
}

function renderFolderNode(node, depth, lines) {
  const indent = '\t'.repeat(depth);
  for (const record of node.records) lines.push(...renderBookmark(record, indent));
  for (const child of node.children.values()) {
    const dates = child.records.map(record => isoToEpoch(record.created || record.raindrop_created)).filter(Boolean);
    const created = dates[0] || String(Math.floor(Date.now() / 1000));
    lines.push(`${indent}<DT><H3 ADD_DATE="${created}" LAST_MODIFIED="${created}">${escapeHtml(child.name)}</H3>`);
    lines.push(`${indent}<DL><p>`);
    renderFolderNode(child, depth + 1, lines);
    lines.push(`${indent}</DL><p>`);
  }
}

function generateRaindropHTML(records) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Raindrop.io Bookmarks</TITLE>',
    '<H1>Raindrop.io Bookmarks</H1>',
    '<DL><p>',
  ];
  renderFolderNode(buildFolderTree(records), 1, lines);
  lines.push('</DL><p>');
  return lines.join('\n');
}

module.exports = {
  CSV_HEADERS,
  parseRaindropCSV,
  generateRaindropCSV,
  parseRaindropHTML,
  generateRaindropHTML,
};
