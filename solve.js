// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Written from scratch from the makefun-site README semantics: its front
// matter, template dialect, Markdown subset, slug rule and report. No vendor
// or baseline code is reused.
//
// Speed strategy:
//  - Markdown renders in one pass straight to the output string: no token
//    arrays, no per-line allocations, plain-text runs escaped in chunks
//    instead of one regex replace per character.
//  - A hand-written front-matter scanner (index-based, no regex per line).
//  - Templates are compiled once into small JS functions (cached across
//    cases by template name + source); rendering is direct string building
//    with scope chains, no node-tree walk.
//  - slugify results and compiled templates are cached across run() calls.
//  - \r\n normalisation, word counting and link resolution all skip regexes
//    on their hot paths.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `text` with & < > " and ' escaped; the common no-specials path is one test. */
function esc(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESCAPES[c]) : s;
}

/** Whether a code unit is whitespace in the sense of \s. */
function isWs(code) {
  if (code <= 32) return code === 32 || (code >= 9 && code <= 13);
  if (code < 160) return false;
  return code === 160 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 ||
    code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || (c >= 160 && isWs(c))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- text rules

const slugCache = new Map();

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 *  of characters other than a-z and 0-9 one "-", none at either end, at most 64
 *  characters (a "-" left at the cut dropped), "untitled" when nothing is left. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length;) {
    const cp = plain.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    let keep = -1;
    if (cp >= 65 && cp <= 90) keep = cp + 32;
    else if ((cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57)) keep = cp;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  let n = 2;
  while (taken.has(out)) { out = slug + '-' + n; n++; }
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]} ${date.slice(0, 4)}`;
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  if (rel.indexOf('/') === -1) {
    if (rel === '.') return dir;
    if (rel === '..') {
      if (dir === '') return null;
      const i = dir.lastIndexOf('/');
      return i === -1 ? '' : dir.slice(0, i);
    }
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmString(key, raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: `key "${key}": a quoted string is not closed` };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
        out += n;
        i++;
      } else if (c === '"') return { error: `key "${key}": a quoted string holds a stray quote` };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: `key "${key}": a bare string opens on [` };
  return { value: raw };
}

function fmDate(raw) {
  const bad = { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return bad;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return bad;
  }
  const y = +raw.slice(0, 4);
  const mo = +raw.slice(5, 7);
  const d = +raw.slice(8, 10);
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return bad;
  return { value: raw };
}

function fmTags(raw) {
  if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const tags = [];
  for (const p of inner.split(',')) {
    const t = p.trim();
    if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    tags.push(t);
  }
  return { value: tags };
}

function isLayoutName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlugValue(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let i = 0;
  const alnum = () => {
    const c = raw.charCodeAt(i);
    return (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
  };
  while (i < raw.length && alnum()) i++;
  if (i === 0) return false;
  while (i < raw.length) {
    if (raw.charCodeAt(i) !== 45) return false;
    i++;
    const start = i;
    while (i < raw.length && alnum()) i++;
    if (i === start) return false;
  }
  return true;
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return fmString(key, raw);
    case 'date':
      return fmDate(raw);
    case 'tags':
      return fmTags(raw);
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isLayoutName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `text[a..b)` holds only spaces and tabs. */
function onlySpacesTabs(text, a, b) {
  for (let i = a; i < b; i++) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstEnd = firstNl === -1 ? text.length : firstNl;
  if (firstEnd !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  // The close must be found before any line is judged: an unclosed front
  // matter reports that, whatever its lines hold.
  let closeStart = -1;
  let closeEnd = -1;
  let cur = firstEnd + 1;
  while (cur <= text.length) {
    const e = text.indexOf('\n', cur);
    const end = e === -1 ? text.length : e;
    if (end - cur === 3 && text.charCodeAt(cur) === 45 && text.charCodeAt(cur + 1) === 45 && text.charCodeAt(cur + 2) === 45) {
      closeStart = cur;
      closeEnd = end;
      break;
    }
    if (e === -1) break;
    cur = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 2;
  cur = firstEnd + 1;
  while (cur < closeStart) {
    const e = text.indexOf('\n', cur);
    const end = e === -1 ? closeStart : (e < closeStart ? e : closeStart);
    if (!onlySpacesTabs(text, cur, end) && text.charCodeAt(cur) !== 35) {
      let k = cur;
      while (k < end) {
        const c = text.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === cur || k >= end || text.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const key = text.slice(cur, k);
      let raw;
      if (k + 1 === end) raw = '';
      else if (text.charCodeAt(k + 1) === 32) raw = text.slice(k + 2, end);
      else return { error: `line ${lineNo} is not "key: value"` };
      let rEnd = raw.length;
      while (rEnd > 0) {
        const c = raw.charCodeAt(rEnd - 1);
        if (c === 32 || c === 9) rEnd--;
        else break;
      }
      if (rEnd !== raw.length) raw = raw.slice(0, rEnd);
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValue(key, raw);
      if (v.error !== undefined) return v;
      data[key] = v.value;
    }
    cur = end + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

/** The end index of the line starting at `p` (its '\n', or the string end). */
function lineEnd(s, p) {
  const e = s.indexOf('\n', p);
  return e === -1 ? s.length : e;
}

/** `s[a..b)` with spaces and tabs dropped at both ends. */
function trimOf(s, a, b) {
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return s.slice(a, b);
}

/** Whether the line `s[a..b)` is blank (spaces and tabs only). */
function isBlank(s, a, b) {
  return onlySpacesTabs(s, a, b);
}

/** A fence opening line's language, or null when the line is no fence. */
function fenceLang(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return null;
  let i = a + 3;
  while (i < b) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = s.slice(a + 3, i);
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else return null;
  }
  return lang;
}

/** Whether the line `s[a..b)` closes a fence. */
function isFenceClose(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingAt(s, a, b) {
  let h = 0;
  while (h < 6 && a + h < b && s.charCodeAt(a + h) === 35) h++;
  if (h === 0) return null;
  const c = s.charCodeAt(a + h);
  if (c !== 32 && c !== 9) return null;
  const text = trimOf(s, a + h, b);
  if (text === '') return null;
  return { depth: h, text };
}

/** Whether the line `s[a..b)` is a thematic break. */
function isHr(s, a, b) {
  if (b - a < 3) return false;
  const c0 = s.charCodeAt(a);
  if (c0 !== 45 && c0 !== 42) return false;
  if (s.charCodeAt(a + 1) !== c0 || s.charCodeAt(a + 2) !== c0) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet list item's text start, or -1. */
function bulletStart(s, p, e) {
  if (e - p < 2) return -1;
  const c = s.charCodeAt(p);
  if ((c === 45 || c === 42) && s.charCodeAt(p + 1) === 32) return p + 2;
  return -1;
}

/** An ordered list item's number and text start, or null. */
function orderedNum(s, p, e) {
  let i = p;
  while (i < e) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  const digits = i - p;
  if (digits < 1 || digits > 9) return null;
  if (i + 1 >= e || s.charCodeAt(i) !== 46 || s.charCodeAt(i + 1) !== 32) return null;
  return { num: +s.slice(p, i), textStart: i + 2 };
}

/** Whether the line `s[p..e)` continues a list item (two spaces, then text). */
function isContinued(s, p, e) {
  let i = p;
  while (i < e && s.charCodeAt(i) === 32) i++;
  if (i - p < 2 || i >= e) return false;
  return !isWs(s.charCodeAt(i));
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from) {
  const wl = what.length;
  for (let j = from; j <= s.length - wl; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWs(s.charCodeAt(i))) return true;
  return false;
}

/** Whether `s` holds any inline Markdown construct at all. */
const HAS_MD = /[\\`*\[]/;
/** The next inline-special character: a construct opener or a character to escape. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/** `s` rendered inline; `link(target)` is a link's href. */
function inline(s, link) {
  // The common case: no construct at all, only escaping to do.
  if (!HAS_MD.test(s)) return esc(s);
  const parts = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const j = m === null ? n : m.index;
    if (j > i) parts.push(s.slice(i, j));
    if (j >= n) break;
    i = j;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        const nc = s[i + 1];
        parts.push(nc === '>' ? '&gt;' : nc);
        i += 2;
      } else {
        parts.push('\\');
        i++;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        parts.push('<code>', esc(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        parts.push('`');
        i++;
      }
    } else if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnesc(s, '**', i + 2);
        if (k > i + 2) {
          parts.push('<strong>', inline(s.slice(i + 2, k), link), '</strong>');
          i = k + 2;
        } else {
          parts.push('**');
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) {
          parts.push('<em>', inline(s.slice(i + 1, k), link), '</em>');
          i = k + 1;
        } else {
          parts.push('*');
          i++;
        }
      }
    } else if (c === '[') {
      const k = findUnesc(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWs(target)) {
        parts.push('<a href="', esc(link(target)), '">', inline(s.slice(i + 1, k), link), '</a>');
        i = m + 1;
      } else {
        parts.push('[');
        i++;
      }
    } else {
      parts.push(ESCAPES[c]);
      i++;
    }
  }
  return parts.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  const n = src.length;
  let p = 0;
  while (p < n) {
    const e = lineEnd(src, p);
    if (isBlank(src, p, e)) { p = e + 1; continue; }
    const lang = fenceLang(src, p, e);
    if (lang !== null) {
      out.push('<pre><code' + (lang === '' ? '' : ` class="language-${esc(lang)}"`) + '>');
      p = e + 1;
      let closed = false;
      while (p < n) {
        const e2 = lineEnd(src, p);
        if (isFenceClose(src, p, e2)) { p = e2 + 1; closed = true; break; }
        out.push(esc(src.slice(p, e2)), '\n');
        p = e2 + 1;
      }
      // An unclosed fence runs to the end, and a body ending in "\n" holds
      // one last empty line after it (the split's trailing line).
      if (!closed && n > 0 && src.charCodeAt(n - 1) === 10) out.push('\n');
      out.push('</code></pre>\n');
      continue;
    }
    const hd = headingAt(src, p, e);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inline(hd.text, link);
      out.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      p = e + 1;
      continue;
    }
    if (isHr(src, p, e)) { out.push('<hr>\n'); p = e + 1; continue; }
    if (src.charCodeAt(p) === 62) {
      const lines = [];
      while (p < n && src.charCodeAt(p) === 62) {
        const e2 = lineEnd(src, p);
        let a = p + 1;
        if (a < e2 && src.charCodeAt(a) === 32) a++;
        const t = trimOf(src, a, e2);
        if (t !== '') lines.push(t);
        p = e2 + 1;
      }
      if (lines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push('<blockquote>\n<p>', inline(lines.join('\n'), link), '</p>\n</blockquote>\n');
      continue;
    }
    const bStart = bulletStart(src, p, e);
    const oStart = bStart === -1 ? orderedNum(src, p, e) : null;
    if (bStart !== -1 || oStart !== null) {
      const ordered = oStart !== null;
      const start = ordered ? oStart.num : 1;
      const items = [];
      while (p < n) {
        const e2 = lineEnd(src, p);
        if (ordered) {
          const m = orderedNum(src, p, e2);
          if (m !== null) { items.push([trimOf(src, m.textStart, e2)]); p = e2 + 1; continue; }
        } else {
          const m = bulletStart(src, p, e2);
          if (m !== -1) { items.push([trimOf(src, m, e2)]); p = e2 + 1; continue; }
        }
        if (isContinued(src, p, e2)) { items[items.length - 1].push(trimOf(src, p, e2)); p = e2 + 1; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (const it of items) out.push('<li>', inline(it.join('\n'), link), '</li>\n');
      out.push(`</${tag}>\n`);
      continue;
    }
    const lines = [trimOf(src, p, e)];
    p = e + 1;
    while (p < n) {
      const e2 = lineEnd(src, p);
      if (isBlank(src, p, e2) || fenceLang(src, p, e2) !== null || headingAt(src, p, e2) !== null || isHr(src, p, e2)) break;
      lines.push(trimOf(src, p, e2));
      p = e2 + 1;
    }
    const html = inline(lines.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathParts(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathParts(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpacesTabs(src, lineStart, open) && onlySpacesTabs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathParts(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathParts(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lk(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += txt(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A parsed template compiled to a function (out, scope, ctx, depth, lk, txt,
 * truthy, esc). `sv` names the scope variable in scope at the point generated.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const code = [];
  const gen = (list, sv) => {
    for (const n of list) {
      if (n.kind === 'text') code.push('out.push(' + JSON.stringify(n.text) + ');');
      else if (n.kind === 'var') code.push('out.push(esc(txt(lk(' + sv + ',' + JSON.stringify(n.path) + '))));');
      else if (n.kind === 'raw') code.push('out.push(txt(lk(' + sv + ',' + JSON.stringify(n.path) + ')));');
      else if (n.kind === 'if') {
        code.push('if(truthy(lk(' + sv + ',' + JSON.stringify(n.path) + '))!==' + (n.not ? 'true' : 'false') + '){');
        gen(n.then, sv);
        if (n.else !== null) {
          code.push('}else{');
          gen(n.else, sv);
        }
        code.push('}');
      } else if (n.kind === 'for') {
        const xs = '_x' + (uid++);
        const k = '_k' + (uid++);
        const sc = '_s' + (uid++);
        code.push('{const ' + xs + '=lk(' + sv + ',' + JSON.stringify(n.path) + ');if(Array.isArray(' + xs + ')){for(let ' + k + '=0;' + k + '<' + xs + '.length;' + k + '++){const ' + sc + '={vars:{' + JSON.stringify(n.name) + ':' + xs + '[' + k + '],loop:{index:' + k + '+1,first:' + k + '===0,last:' + k + '===' + xs + '.length-1,length:' + xs + '.length}},parent:' + sv + '};');
        gen(n.body, sc);
        code.push('}}}');
      } else if (n.kind === 'include') {
        const f = '_f' + (uid++);
        code.push('if(depth<8){const ' + f + '=ctx.templates.get(' + JSON.stringify(n.name) + ');if(' + f + '!==undefined)' + f + '(out,' + sv + ',ctx,depth+1,lk,txt,truthy,esc);}');
      }
    }
  };
  gen(nodes, 'scope');
  return new Function('out', 'scope', 'ctx', 'depth', 'lk', 'txt', 'truthy', 'esc', code.join(''));
}

/** Compiled templates, cached across cases by name then source. */
const templateCache = new Map();

function getTemplate(name, src) {
  let byName = templateCache.get(name);
  if (byName === undefined) {
    byName = new Map();
    templateCache.set(name, byName);
  }
  let hit = byName.get(src);
  if (hit === undefined) {
    try {
      hit = { fn: compileTemplate(parseTemplate(name, src)) };
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      hit = { error: err.message };
    }
    byName.set(src, hit);
  }
  return hit;
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path) from the directory `dir` of a source, or null when it climbs out of the root. */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    const t = getTemplate(name, input.templates[name]);
    if (t.error !== undefined) report.push(t.error);
    else templates.set(name, t.fn);
  }
  let base = input.site.base_url;
  let be = base.length;
  while (be > 0 && base.charCodeAt(be - 1) === 47) be--;
  if (be !== base.length) base = base.slice(0, be);

  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  let pageCount = 0;
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    if (!s.post) pageCount++;
    kept.push(s);
  }

  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const t = bySource.get(path);
        if (t !== undefined) return `${t.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags;
    if (tags !== undefined) {
      for (const name of tags) {
        const slug = slugify(name);
        if (seen.has(slug)) continue;
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        const url = `${base}/tags/${slug}/`;
        tag = { name, slug, url, posts: [], view: { name, slug, url } };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      const t = bySlug.get(slug);
      if (t !== undefined) return t;
      return { name, slug, url: '', posts: [], view: { name, slug, url: '' } };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => t.view),
  });
  for (const p of posts) p.card = cardOf(p);

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const ctx = { templates };
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn(out, { vars, parent: baseScope }, ctx, 0, lk, txt, truthy, esc);
    return out.join('');
  };

  for (const s of kept) {
    const c = s.post ? s.card : cardOf(s);
    output[`${s.outDir}/index.html`] = render(s.layout, {
      page: {
        title: c.title,
        url: c.url,
        date: c.date,
        date_long: c.date_long,
        summary: c.summary,
        excerpt: c.excerpt,
        reading_minutes: c.reading_minutes,
        tags: c.tags,
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      },
    });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
