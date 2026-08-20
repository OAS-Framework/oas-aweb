/**
 * Strict parser for the YAML SUBSET an oas-config.yaml is allowed to use.
 *
 * This repository ships zero runtime dependencies (a package test asserts it),
 * so the manifest gate cannot reach for a YAML library — but the config
 * TEMPLATE we distribute must still be checked against
 * `schemas/oas-config.schema.json` before it ever reaches an adopter. A subset
 * parser is the honest way to do that: it understands exactly what a portable
 * reference config needs (comments, block mappings, block sequences, plain and
 * quoted scalars) and THROWS on anything else rather than guessing.
 *
 * Failing closed matters more than breadth here. If a future template needs
 * multi-line scalars, anchors, or flow collections, this parser must be
 * extended deliberately — silently mis-parsing a deployment config would let an
 * invalid template ship as if it had been validated.
 */

const UNSUPPORTED = [
  [/^\s*[&*]/, "anchors and aliases"],
  [/^\s*[[{]/, "flow collections"],
  [/^\s*---\s*$/, "document markers"],
  [/^\s*\.\.\.\s*$/, "document markers"],
  [/^\s*%/, "directives"],
];

function fail(line, message) {
  throw new Error(`line ${line}: ${message}`);
}

/** Strip a trailing `#` comment that is not inside a quoted scalar. */
function stripComment(text) {
  let quote;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = undefined; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

function parseScalar(raw, line) {
  const text = raw.trim();
  if (!text) return null;
  if (text[0] === "[" || text[0] === "{") fail(line, "flow collections are outside the supported subset");
  if (text[0] === "|" || text[0] === ">") fail(line, "block scalars are outside the supported subset");
  if (text[0] === "&" || text[0] === "*" || text[0] === "!") fail(line, "anchors, aliases and tags are outside the supported subset");
  if (text[0] === '"' || text[0] === "'") {
    const quote = text[0];
    if (text.length < 2 || text[text.length - 1] !== quote) fail(line, `unterminated ${quote === '"' ? "double" : "single"}-quoted scalar`);
    const body = text.slice(1, -1);
    if (body.includes(quote)) fail(line, "escaped or nested quotes are outside the supported subset");
    return quote === '"' ? body.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\") : body;
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  if (/[:#]\s/.test(text)) fail(line, `ambiguous plain scalar ${JSON.stringify(text)} — quote it`);
  return text;
}

/** Parse the supported subset into plain JS values. Throws on anything else. */
export function parseYamlSubset(source) {
  const lines = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const number = index + 1;
    if (raw.includes("\t")) fail(number, "tabs are not valid YAML indentation");
    for (const [pattern, what] of UNSUPPORTED) if (pattern.test(raw)) fail(number, `${what} are outside the supported subset`);
    const text = stripComment(raw);
    if (!text.trim()) return;
    lines.push({ number, indent: text.length - text.trimStart().length, text: text.trim() });
  });

  let cursor = 0;
  const parseBlock = (indent) => {
    const first = lines[cursor];
    if (!first) return null;
    return first.text.startsWith("- ") || first.text === "-" ? parseSequence(indent) : parseMapping(indent);
  };

  const parseSequence = (indent) => {
    const items = [];
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.indent < indent) break;
      if (line.indent > indent) fail(line.number, "unexpected indentation inside a block sequence");
      if (!line.text.startsWith("-")) break;
      const rest = line.text === "-" ? "" : line.text.slice(1).trimStart();
      cursor += 1;
      if (rest) { items.push(parseScalar(rest, line.number)); continue; }
      const next = lines[cursor];
      items.push(next && next.indent > indent ? parseBlock(next.indent) : null);
    }
    return items;
  };

  const parseMapping = (indent) => {
    const map = {};
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.indent < indent) break;
      if (line.indent > indent) fail(line.number, "unexpected indentation inside a block mapping");
      if (line.text.startsWith("- ") || line.text === "-") fail(line.number, "sequence item where a mapping key was expected");
      const separator = findKeySeparator(line.text, line.number);
      const key = parseScalar(line.text.slice(0, separator), line.number);
      if (typeof key !== "string" || !key) fail(line.number, "mapping keys must be non-empty strings");
      if (Object.prototype.hasOwnProperty.call(map, key)) fail(line.number, `duplicate mapping key ${JSON.stringify(key)}`);
      const inline = line.text.slice(separator + 1).trim();
      cursor += 1;
      if (inline) { map[key] = parseScalar(inline, line.number); continue; }
      const next = lines[cursor];
      map[key] = next && next.indent > indent ? parseBlock(next.indent) : null;
    }
    return map;
  };

  const findKeySeparator = (text, line) => {
    let quote;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) { if (ch === quote) quote = undefined; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === ":" && (i === text.length - 1 || /\s/.test(text[i + 1]))) return i;
    }
    fail(line, `expected "key: value" but found ${JSON.stringify(text)}`);
    return -1;
  };

  if (!lines.length) return {};
  const value = parseBlock(lines[0].indent);
  if (cursor < lines.length) fail(lines[cursor].number, "trailing content after the document root");
  return value;
}
