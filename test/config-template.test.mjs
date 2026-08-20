import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseKernelYaml } from "../scripts/lib/kernel-yaml.mjs";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = join(REPO, "oas-package");
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "oas-package.json"), "utf8"));

test("the package ships exactly one canonical, default config template", () => {
  assert.equal(PACKAGE.configs, undefined, "the deprecated 0.19 `configs` spelling must not be emitted");
  const names = Object.keys(PACKAGE.configTemplates);
  assert.deepEqual(names, ["default"]);
  assert.equal(PACKAGE.configTemplates.default.default, true, "the only template is the default one, so --config is never needed");
  assert.match(PACKAGE.configTemplates.default.path, /^config-templates\/[^./][^\\]*$/);
});

test("the capability root is dedicated, never the package root", () => {
  assert.deepEqual(PACKAGE.capabilities, ["capabilities/oas-aweb"]);
  assert.ok(!PACKAGE.capabilities.includes("."), 'a "." root cannot be materialized as a self-contained artifact');
});

test("the reference config binds aweb as the exclusive messaging layer", () => {
  const template = parseKernelYaml(readFileSync(join(ROOT, PACKAGE.configTemplates.default.path), "utf8"));
  assert.equal(template.capabilities.layers.messaging.capability, "oas.aweb");
  // `from: installed` is what binds the artifact this package materialized,
  // rather than whatever else happens to carry the same id at that scope.
  assert.equal(template.capabilities.layers.messaging.from, "installed");
  assert.equal(template.capabilities.layers.messaging.global, true);
  assert.deepEqual(Object.keys(template.capabilities.layers), ["messaging"], "the template claims no layer it does not supply");
});

test("the reference config is portable: a team name to change, no team id", () => {
  const source = readFileSync(join(ROOT, PACKAGE.configTemplates.default.path), "utf8");
  const template = parseKernelYaml(source);
  assert.equal(template.team.name, "my-team", "a placeholder the adopter must replace");
  assert.equal(template.team.id, undefined, "a provider team id is deployment-local and must not ship");
  // Adopted verbatim into someone else's deployment: nothing here may be ours.
  assert.doesNotMatch(source, /\/(Users|home)\//);
  assert.doesNotMatch(source, /\b(token|secret|password|api[_-]?key)\b\s*:/i);
  assert.doesNotMatch(source, /aweb\.ai\/[a-z0-9-]+\b(?!\/)/i);
});

test("the template tells adopters that installation applies nothing", () => {
  const source = readFileSync(join(ROOT, PACKAGE.configTemplates.default.path), "utf8");
  assert.match(source, /`oas install` NEVER applies this file/);
  assert.match(source, /oas init --package oas\.aweb/);
});
