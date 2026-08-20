/**
 * Read an oas-config.yaml EXACTLY as the OAS kernel will, and refuse anything
 * the kernel would silently misread.
 *
 * This repository ships zero runtime dependencies (a package test asserts it),
 * so the manifest gate cannot reach for a YAML library — but the config
 * TEMPLATE we distribute must still be checked against
 * `schemas/oas-config.schema.json` before it reaches an adopter.
 *
 * The subtlety that matters: the kernel's own reader (`parseYamlNested` /
 * `yamlScalar` in lib/core.mjs) is itself a small YAML subset, and a validator
 * that is MORE capable than it is actively dangerous. A template using a block
 * sequence
 *
 *     agent-types:
 *       - developer
 *
 * parses as a two-element array under a general parser and validates happily
 * against the schema — while the kernel drops the `- developer` lines entirely
 * and reads `agent-types: {}`, an empty target map. The template would ship
 * "validated" and mean something else once adopted.
 *
 * So this module does two jobs:
 *
 *   1. MIRROR the kernel's semantics line for line, so whatever it returns is
 *      what the deployment will actually see (parity is asserted against the
 *      released kernel itself in scripts/consumer-probe.mjs).
 *   2. REJECT, loudly, every construct the kernel ignores or reinterprets —
 *      block sequences, block scalars, anchors, aliases, tags, document
 *      markers, directives, tabs, inconsistent indentation, duplicate keys, and
 *      any non-comment line that is not a `key: value` pair at all.
 *
 * Rule 2 is the fail-closed half: the kernel's response to syntax it does not
 * know is to skip the line, and a gate must never let authoring depend on
 * something that gets thrown away. Lists in a config are expressible only in
 * the kernel's flow form (`[a, b]`), which is accepted and parsed identically.
 */

/** `__proto__` is not an ordinary key. Assigning it walks into the object's
 * PROTOTYPE instead of creating an own property, so a template can hide a whole
 * config behind it: this gate's schema walk enumerates own properties and sees
 * an empty document, while the kernel later reads `cfg.capabilities` straight
 * off the prototype chain and applies it. Both parsers agree on the object —
 * what differs is what an enumerating validator can SEE — so the only safe
 * answer is to refuse the key. A config never legitimately needs one. */
function assertUsableKey(key) {
  if (key === "__proto__") {
    throw new Error('"__proto__" is not a usable config key — it would set an object prototype instead of a property, hiding settings from every validator that enumerates own keys while the OAS config reader still applies them');
  }
}

/** Kernel: `yamlScalar` (lib/core.mjs). Reproduced exactly, including the
 * unconditional `\s+#` strip — the kernel does not exempt quoted scalars, so
 * neither may we. The one addition is the `__proto__` refusal above. */
function yamlScalar(raw) {
  const val = String(raw).trim().replace(/\s+#.*$/, "").trim();
  if (/^(true|false)$/i.test(val)) return val.toLowerCase() === "true";
  if (/^(null|~)$/i.test(val)) return null;
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  if (val.startsWith("[") && val.endsWith("]")) {
    return val.slice(1, -1).split(",").map((v) => yamlScalar(v)).filter((v) => v !== "");
  }
  if (val.startsWith("{") && val.endsWith("}")) {
    const out = {};
    for (const part of val.slice(1, -1).split(",")) {
      const i = part.indexOf(":");
      if (i < 0) continue;
      const key = part.slice(0, i).trim().replace(/^["']|["']$/g, "");
      assertUsableKey(key);
      out[key] = yamlScalar(part.slice(i + 1));
    }
    return out;
  }
  return val.replace(/^["']|["']$/g, "");
}

/** Kernel: the `key: value` line shape `parseYamlNested` accepts. Anything else
 * is skipped by the kernel, which is exactly what we refuse. */
const KEY_LINE = /^(\s*)((?:["'][^"']+["'])|(?:[^:#][^:]*?)):\s*(.*?)\s*$/;

/** An unquoted block-sequence item: "-" alone, or "-" followed by whitespace. */
const SEQUENCE_ITEM = /^-(\s|$)/;

/** Constructs the kernel cannot represent. Each would parse as something else
 * (a literal string) or vanish, so the gate stops rather than bless it. */
function unsupported(value) {
  if (value.startsWith("|") || value.startsWith(">")) return "block scalars";
  if (value.startsWith("&")) return "anchors";
  if (value.startsWith("*")) return "aliases";
  if (value.startsWith("!")) return "tags";
  return undefined;
}

function fail(line, message) { throw new Error(`line ${line}: ${message}`); }

/**
 * The comment text of a config, decided by the PARSER'S OWN branches so the two
 * cannot drift. Three shapes count as comment, and missing any one of them
 * hands a hiding place to whatever scans this text:
 *
 *   # whole line
 *   key: value  # tail          (needs whitespace before the #)
 *   key:# text                  (a comment-only VALUE — no space required,
 *                                because `rawVal.trim().startsWith("#")` is
 *                                how the kernel opens a block here)
 *
 * Quoted `#` is deliberately not exempt: the kernel does not exempt it, so what
 * it treats as a comment is what this returns.
 *
 * @param {string} source
 * @returns {string} the comment text, one fragment per line
 */
export function extractComments(source) {
  const parts = [];
  for (const raw of String(source).split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) { parts.push(trimmed); continue; }
    const match = KEY_LINE.exec(raw);
    const value = match ? match[3] : raw;
    if (value.trim().startsWith("#")) { parts.push(value.trim()); continue; }
    const inline = /\s+#.*$/.exec(value);
    if (inline) parts.push(inline[0].trim());
  }
  return parts.join("\n");
}

/**
 * @param {string} source oas-config.yaml text
 * @returns {object} exactly what the kernel's parseYamlNested would return
 * @throws {Error} on any construct the kernel would silently drop or reinterpret
 */
export function parseKernelYaml(source) {
  const root = {};
  // `childIndent` records the indentation this block's children established, so
  // a line that lands between two levels is reported instead of being silently
  // reparented onto the nearest shallower map the way the kernel would.
  const stack = [{ indent: -1, node: root, childIndent: undefined, keys: new Set() }];
  const lines = String(source).split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const number = i + 1;
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (raw.includes("\t")) fail(number, "tabs are not valid YAML indentation");

    const trimmed = raw.trim();
    // BEFORE the key match, not after it: a sequence item whose value is itself
    // a mapping (`- developer:`) satisfies KEY_LINE and would otherwise sail
    // through as a key literally named "- developer" — the same silent misread
    // this module exists to stop.
    if (SEQUENCE_ITEM.test(trimmed)) {
      fail(number, "block sequences are dropped by the OAS config reader — write the list inline as [a, b]");
    }

    const match = KEY_LINE.exec(raw);
    if (!match) {
      if (/^(---|\.\.\.)$/.test(trimmed)) fail(number, "document markers are ignored by the OAS config reader");
      if (trimmed.startsWith("%")) fail(number, "directives are ignored by the OAS config reader");
      fail(number, `not a "key: value" pair, so the OAS config reader would skip it: ${JSON.stringify(trimmed)}`);
    }

    const [, ws, rawKey, rawVal] = match;
    const indent = ws.length;
    const key = rawKey.trim().replace(/^["']|["']$/g, "");

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const frame = stack[stack.length - 1];
    if (frame.childIndent === undefined) frame.childIndent = indent;
    else if (indent !== frame.childIndent) {
      fail(number, `inconsistent indentation (${indent} spaces where this block uses ${frame.childIndent}) — the OAS config reader would silently attach this key to a different map`);
    }
    if (frame.keys.has(key)) fail(number, `duplicate mapping key ${JSON.stringify(key)} — the OAS config reader keeps only the last one`);
    try { assertUsableKey(key); } catch (error) { fail(number, error.message); }
    frame.keys.add(key);

    // Kernel: an empty value (or a value that is only a comment) opens a block
    // and yields {} when nothing is nested under it — NOT null.
    const opensBlock = rawVal.replace(/\s+#.*$/, "").trim() === "" || rawVal.trim().startsWith("#");
    if (opensBlock) {
      const child = {};
      frame.node[key] = child;
      stack.push({ indent, node: child, childIndent: undefined, keys: new Set() });
      continue;
    }
    const bad = unsupported(rawVal.trim());
    if (bad) fail(number, `${bad} are read as literal text by the OAS config reader`);
    try { frame.node[key] = yamlScalar(rawVal); }
    catch (error) { fail(number, error.message); }
  }
  return root;
}
