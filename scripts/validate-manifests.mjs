#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseKernelYaml } from "./lib/kernel-yaml.mjs";

// Repo root holds dev tooling (scripts/, schemas/); the DISTRIBUTED package
// payload lives in the `oas-package/` subtree. Manifests and their resources
// are validated against the payload root; the containment boundary is the
// payload root, never the repo root (contract: repo-only tooling is not
// installed bytes and must never be reachable from a package resource path).
//
// The rules enforced here mirror the RELEASED @oas-framework/oas@0.20.0 engine
// (lib/core.mjs: loadPackageManifest, isCanonicalTemplatePath,
// assertCapabilitySelfContained). They exist so a contract break is caught in
// this repo's own gate rather than at an adopter's `oas install`.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(repoRoot, "oas-package");
const errors = [];
const report = (path, message) => errors.push(`${path}: ${message}`);
const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { report(relative(root, path), `invalid JSON (${error.message})`); return undefined; }
};

/** Minimal JSON-Schema evaluator covering the keywords our vendored schemas
 * actually use. `collect` gathers errors instead of reporting them, so oneOf
 * branches can be tried without polluting the real error list. */
function checkSchema(value, schema, at, rootSchema, collect) {
  const emit = collect || report;
  if (schema === true || schema === undefined) return;
  if (schema === false) { emit(at, "is not allowed here"); return; }
  if (typeof schema !== "object") return;
  if (schema.$ref) {
    const target = schema.$ref.startsWith("#/$defs/") ? rootSchema?.$defs?.[schema.$ref.slice("#/$defs/".length)] : undefined;
    if (target) checkSchema(value, target, at, rootSchema, collect);
    return;
  }
  if (schema.allOf) for (const sub of schema.allOf) checkSchema(value, sub, at, rootSchema, collect);
  if (schema.oneOf) {
    const failures = schema.oneOf.map((sub) => { const bucket = []; checkSchema(value, sub, at, rootSchema, (p, m) => bucket.push(`${p}: ${m}`)); return bucket; });
    if (!failures.some((bucket) => bucket.length === 0)) emit(at, `matches none of the allowed forms (${failures.flat().join("; ")})`);
    return;
  }
  if ("const" in schema && !Object.is(value, schema.const)) emit(at, `must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) emit(at, `must be one of ${schema.enum.join(", ")}`);
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && actual !== schema.type) { emit(at, `must be ${schema.type}, got ${actual}`); return; }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) emit(at, `must contain at least ${schema.minLength} character(s)`);
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) emit(at, `must match ${schema.pattern}`);
    if (schema.not?.pattern && (new RegExp(schema.not.pattern)).test(value)) emit(at, `must not match ${schema.not.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) emit(at, `must contain at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) emit(at, "must contain unique items");
    value.forEach((item, index) => checkSchema(item, schema.items, `${at}[${index}]`, rootSchema, collect));
  }
  if (value && actual === "object") {
    for (const key of schema.required || []) if (!(key in value)) emit(at, `missing required property ${key}`);
    const properties = schema.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames?.pattern && !(new RegExp(schema.propertyNames.pattern)).test(key)) emit(`${at}.${key}`, `property name must match ${schema.propertyNames.pattern}`);
      if (key in properties) checkSchema(item, properties[key], `${at}.${key}`, rootSchema, collect);
      else if (schema.additionalProperties === false) emit(`${at}.${key}`, "unknown property");
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") checkSchema(item, schema.additionalProperties, `${at}.${key}`, rootSchema, collect);
    }
  }
}

const validateSchema = (value, schema, at) => checkSchema(value, schema, at, schema, undefined);

function safeResource(base, candidate, at, kind = "path", boundary = root) {
  if (typeof candidate !== "string" || !candidate.trim()) { report(at, `${kind} must be a non-empty string`); return undefined; }
  if (isAbsolute(candidate) || candidate.split(/[\\/]+/).includes("..")) { report(at, `${kind} must be package-relative and may not contain '..'`); return undefined; }
  const target = resolve(base, candidate);
  if (!existsSync(target)) { report(at, `${kind} does not exist: ${candidate}`); return undefined; }
  const realBoundary = realpathSync(boundary);
  const realTarget = realpathSync(target);
  if (realTarget !== realBoundary && !realTarget.startsWith(realBoundary + sep)) {
    report(at, `${kind} escapes ${boundary === root ? "the package root" : "its capability root"} after symlink resolution`);
    return undefined;
  }
  return realTarget;
}

/** Contract §2.5 (assertCapabilitySelfContained): a declared directory resource
 * must not merely resolve inside the capability root — nothing UNDER it may
 * escape either, or the materialized artifact is not independently hashable. */
function assertContainedTree(dir, at, kind, capabilityRoot, visited = new Set()) {
  const realRoot = realpathSync(capabilityRoot);
  let realDir;
  try { realDir = realpathSync(dir); } catch { report(at, `${kind} contains a broken symlink`); return; }
  if (visited.has(realDir)) return;
  visited.add(realDir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    let real;
    try { real = realpathSync(path); }
    catch { report(at, `${kind} contains a broken symlink: ${relative(capabilityRoot, path)}`); continue; }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      report(at, `${kind} contains a path escaping its capability root: ${relative(capabilityRoot, path)}`);
      continue;
    }
    if (entry.isSymbolicLink()) { if (lstatSync(real).isDirectory()) assertContainedTree(real, at, kind, capabilityRoot, visited); }
    else if (entry.isDirectory()) assertContainedTree(path, at, kind, capabilityRoot, visited);
  }
}

/** Mirrors isCanonicalTemplatePath in the released kernel. */
const CANONICAL_TEMPLATE_ROOT = "config-templates/";
function isCanonicalTemplatePath(p) {
  if (typeof p !== "string" || !p.startsWith(CANONICAL_TEMPLATE_ROOT)) return false;
  const rest = p.slice(CANONICAL_TEMPLATE_ROOT.length);
  if (!rest || rest.includes("\\")) return false;
  return !rest.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/** A distributed template is adopted verbatim into someone else's deployment,
 * so it must carry nothing local to ours. */
const NON_PORTABLE = [
  [/(^|[^\w])\/(Users|home|var|opt|private)\//, "an absolute machine path"],
  [/\$\{?(HOME|USER|PWD)\b/, "a host environment path"],
  [/\b(token|secret|password|api[_-]?key|credential)\b\s*[:=]/i, "a credential-shaped setting"],
];

const packagePath = join(root, "oas-package.json");
const packageManifest = readJson(packagePath);
const packageSchema = readJson(join(repoRoot, "schemas", "oas-package.schema.json"));
const capabilitySchema = readJson(join(repoRoot, "schemas", "capability-manifest.schema.json"));
const configSchemaPath = join(repoRoot, "schemas", "oas-config.schema.json");

if (packageManifest && packageSchema) validateSchema(packageManifest, packageSchema, "oas-package.json");

// ---------------------------------------------------------------- templates
// `configTemplates` is the canonical 0.20 spelling; `configs` is read-only
// compatibility for immutable 0.19 tags. Carrying both is an invalid manifest,
// and NEW authoring (this package) must emit the canonical spelling only.
const hasCanonical = packageManifest?.configTemplates !== undefined;
const hasLegacy = packageManifest?.configs !== undefined;
if (hasCanonical && hasLegacy) report("oas-package.json", 'declares both "configTemplates" and the deprecated "configs" spelling — use "configTemplates" only');
if (hasLegacy && !hasCanonical) report("oas-package.json.configs", 'uses the DEPRECATED 0.19 spelling — newly authored packages must emit "configTemplates"');

const templateKey = hasCanonical ? "configTemplates" : "configs";
const rawTemplates = (hasCanonical ? packageManifest?.configTemplates : packageManifest?.configs) || {};
const templates = typeof rawTemplates === "object" && !Array.isArray(rawTemplates) ? rawTemplates : {};
const defaults = Object.entries(templates).filter(([, spec]) => spec?.default === true);
if (defaults.length > 1) report(`oas-package.json.${templateKey}`, "at most one config template may be marked default");

const configSchema = Object.keys(templates).length ? readJson(configSchemaPath) : undefined;
for (const [name, spec] of Object.entries(templates)) {
  const at = `oas-package.json.${templateKey}.${name}`;
  if (!spec?.path) continue;
  if (hasCanonical && !isCanonicalTemplatePath(spec.path)) {
    report(`${at}.path`, `${JSON.stringify(spec.path)} must live under "${CANONICAL_TEMPLATE_ROOT}" with a contained file path (e.g. "${CANONICAL_TEMPLATE_ROOT}default/oas-config.yaml")`);
    continue;
  }
  const real = safeResource(root, spec.path, `${at}.path`, "config template");
  if (!real) continue;
  if (!statSync(real).isFile()) { report(`${at}.path`, `config template is not a file: ${spec.path}`); continue; }
  const source = readFileSync(real, "utf8");
  for (const [pattern, what] of NON_PORTABLE) {
    if (pattern.test(source)) report(at, `config template is not portable — it contains ${what}; templates are adopted verbatim into other people's deployments`);
  }
  // Parsed with the KERNEL's own semantics, so what is schema-checked here is
  // what an adopter's deployment will actually see.
  let parsed;
  try { parsed = parseKernelYaml(source); }
  catch (error) { report(at, `config template uses YAML the OAS config reader does not support: ${error.message}`); continue; }
  if (configSchema) validateSchema(parsed, configSchema, `${spec.path}`);
}

// ------------------------------------------------------------- capabilities
const declaredCapabilities = Array.isArray(packageManifest?.capabilities) ? packageManifest.capabilities : [];
if (declaredCapabilities.length !== 1) {
  report("oas-package.json.capabilities", `official single-capability package must enumerate exactly one capability directory (found ${declaredCapabilities.length})`);
}
// A "." root is READ COMPATIBILITY for already-published packages. Authoring
// never emits it, and the released kernel rejects it outright next to
// `configTemplates`, so a materialized artifact stays self-contained.
if (declaredCapabilities.includes(".")) {
  report("oas-package.json.capabilities", 'the package root "." is not a valid capability root for a newly authored package — use a dedicated root such as "capabilities/<slug>" so the materialized artifact is self-contained');
}

const capabilities = [];
for (const [index, capabilityDir] of declaredCapabilities.entries()) {
  safeResource(root, capabilityDir, `oas-package.json.capabilities[${index}]`, "capability directory");
  if (isAbsolute(capabilityDir) || capabilityDir.split(/[\\/]+/).includes("..")) continue;
  const manifestPath = join(root, capabilityDir, "oas.json");
  if (!existsSync(manifestPath)) { report(`oas-package.json.capabilities[${index}]`, `${capabilityDir} has no oas.json`); continue; }
  const manifest = readJson(manifestPath);
  if (!manifest) continue;
  capabilities.push(manifest);
  if (capabilitySchema) validateSchema(manifest, capabilitySchema, `${capabilityDir}/oas.json`);
  const capabilityRoot = dirname(manifestPath);
  // SELF-CONTAINMENT: every declared resource resolves inside the capability's
  // OWN root, not merely inside the package. A capability reaching package-only
  // paths cannot be materialized and is rejected rather than installed broken.
  for (const [resourceIndex, resource] of (manifest.skills || []).entries()) {
    const at = `${capabilityDir}/oas.json.skills[${resourceIndex}]`;
    const real = safeResource(capabilityRoot, resource, at, "skill path", capabilityRoot);
    if (real && statSync(real).isDirectory()) assertContainedTree(join(capabilityRoot, resource), at, "skill tree", capabilityRoot);
  }
  if (manifest.inject) safeResource(capabilityRoot, manifest.inject, `${capabilityDir}/oas.json.inject`, "injection path", capabilityRoot);
  for (const [agentIndex, agent] of (manifest.agents || []).entries()) {
    const at = `${capabilityDir}/oas.json.agents[${agentIndex}]`;
    const real = safeResource(capabilityRoot, agent, at, "agent path", capabilityRoot);
    if (real) {
      if (!statSync(real).isDirectory()) report(at, "capability-defined agent is not a directory");
      else assertContainedTree(join(capabilityRoot, agent), at, "capability-defined agent", capabilityRoot);
    }
  }
  // A hook may be a plain "entrypoint args" string or the object form
  // { command, required } (only the spawn hook may set required). Commands are
  // always strings. Reduce either to the executable entrypoint for containment.
  const entrypoint = (spec) => {
    const command = typeof spec === "string" ? spec : (spec && typeof spec === "object" ? spec.command : undefined);
    return typeof command === "string" ? command.trim().split(/\s+/)[0] : command;
  };
  for (const [name, command] of Object.entries(manifest.commands || {})) safeResource(capabilityRoot, entrypoint(command), `${capabilityDir}/oas.json.commands.${name}`, "command entrypoint", capabilityRoot);
  for (const [event, hook] of Object.entries(manifest.hooks || {})) safeResource(capabilityRoot, entrypoint(hook), `${capabilityDir}/oas.json.hooks.${event}`, "hook entrypoint", capabilityRoot);
  for (const forbidden of ["global", "agent-types", "souls"]) if (forbidden in manifest) report(`${capabilityDir}/oas.json.${forbidden}`, "deployment targeting belongs to config, not a capability manifest");
}

if (capabilities.length === 1 && packageManifest) {
  const capability = capabilities[0];
  if (packageManifest.package === "oas.dev") {
    if (packageManifest.version !== "1.0.0") report("oas-package.json.version", "oas.dev distribution must start at 1.0.0");
    if (capability.capability !== "oas.review" || capability.version !== "1.2.0") {
      report("oas-package.json.capabilities[0]", "oas.dev must export capability oas.review@1.2.0");
    }
  } else {
    if (packageManifest.package !== capability.capability) report("oas-package.json.package", "single-capability official package ID must equal its capability ID");
    if (packageManifest.version !== capability.version) report("oas-package.json.version", "must start at the extracted capability version");
  }
  if (packageManifest.compatibility?.oas !== capability.compatibility?.oas) report("oas-package.json.compatibility.oas", "must match the staged capability compatibility floor");
}

if (errors.length) {
  process.stderr.write(`Manifest validation failed:\n- ${errors.join("\n- ")}\n`);
  process.exit(1);
}
process.stdout.write(`Validated ${relative(process.cwd(), packagePath) || "oas-package.json"}, ${capabilities.length} capability manifest(s), and ${Object.keys(templates).length} config template(s).\n`);
