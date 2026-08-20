import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const PORTABLE_TEMPLATE = `name: fixture-deployment
team:
  name: my-team
capabilities:
  layers:
    messaging:
      capability: test.capability-1
      from: installed
      global: true
`;

/** Build a throwaway repo with the real validator, the real schemas, and a
 * synthetic package payload, then run the gate against it. */
function runFixture(t, {
  capabilityDirs = ["capabilities/one"],
  omitCapabilities = false,
  manifestExtras = {},
  capabilityExtras = () => ({}),
  files = {},
  links = [],
} = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "oas-manifest-negative-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, "scripts", "lib"), { recursive: true });
  mkdirSync(join(fixture, "schemas"), { recursive: true });
  mkdirSync(join(fixture, "oas-package"), { recursive: true });
  copyFileSync(join(ROOT, "scripts", "validate-manifests.mjs"), join(fixture, "scripts", "validate-manifests.mjs"));
  copyFileSync(join(ROOT, "scripts", "lib", "kernel-yaml.mjs"), join(fixture, "scripts", "lib", "kernel-yaml.mjs"));
  for (const schema of ["oas-package", "capability-manifest", "oas-config"]) {
    copyFileSync(join(ROOT, "schemas", `${schema}.schema.json`), join(fixture, "schemas", `${schema}.schema.json`));
  }

  const packageManifest = {
    package: "test.capability-1",
    version: "1.0.0",
    description: "Negative manifest-validation fixture.",
    compatibility: { oas: ">=0.20.0" },
    ...(omitCapabilities ? {} : { capabilities: capabilityDirs }),
    ...manifestExtras,
  };
  writeFileSync(join(fixture, "oas-package", "oas-package.json"), JSON.stringify(packageManifest, null, 2) + "\n");

  for (const [relative, contents] of Object.entries(files)) {
    const path = join(fixture, "oas-package", relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  for (const [index, capabilityDir] of (omitCapabilities ? [] : capabilityDirs).entries()) {
    const path = join(fixture, "oas-package", capabilityDir, "oas.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      capability: `test.capability-${index + 1}`,
      version: "1.0.0",
      compatibility: { oas: ">=0.20.0" },
      description: "Negative manifest-validation fixture capability.",
      requires: [],
      ...capabilityExtras(capabilityDir, index),
    }, null, 2) + "\n");
  }

  for (const [linkPath, target] of links) {
    const path = join(fixture, "oas-package", linkPath);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(join(fixture, "oas-package", target), path);
  }

  return spawnSync(process.execPath, [join(fixture, "scripts", "validate-manifests.mjs")], {
    cwd: fixture,
    encoding: "utf8",
  });
}

const canonicalTemplate = {
  manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml", default: true } } },
  files: { "config-templates/default/oas-config.yaml": PORTABLE_TEMPLATE },
};

test("a canonical single-capability package with one portable template passes", (t) => {
  const result = runFixture(t, canonicalTemplate);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 capability manifest\(s\), and 1 config template\(s\)/);
});

test("validator rejects a missing capability enumeration", (t) => {
  const result = runFixture(t, { omitCapabilities: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must enumerate exactly one capability directory \(found 0\)/);
});

test("validator rejects extra capability enumerations", (t) => {
  const result = runFixture(t, { capabilityDirs: ["capability-one", "capability-two"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must enumerate exactly one capability directory \(found 2\)/);
});

test('validator rejects the package root "." as a capability root', (t) => {
  // Released 0.20 rejects "." beside configTemplates outright; authoring must
  // never emit it at all, so the gate refuses it whether or not it ships one.
  const result = runFixture(t, { capabilityDirs: ["."] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a valid capability root for a newly authored package/);
});

test("validator rejects carrying both template spellings", (t) => {
  const result = runFixture(t, {
    ...canonicalTemplate,
    manifestExtras: {
      configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } },
      configs: { legacy: { path: "config-templates/default/oas-config.yaml" } },
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /declares both "configTemplates" and the deprecated "configs" spelling/);
});

test("validator rejects the deprecated configs spelling in new authoring", (t) => {
  const result = runFixture(t, {
    files: canonicalTemplate.files,
    manifestExtras: { configs: { default: { path: "config-templates/default/oas-config.yaml" } } },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /uses the DEPRECATED 0\.19 spelling/);
});

test("validator rejects a template outside the canonical config-templates root", (t) => {
  const result = runFixture(t, {
    manifestExtras: { configTemplates: { default: { path: "capabilities/one/oas-config.yaml" } } },
    files: { "capabilities/one/oas-config.yaml": PORTABLE_TEMPLATE },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must live under "config-templates\/"/);
});

test("validator rejects more than one default template", (t) => {
  const result = runFixture(t, {
    manifestExtras: {
      configTemplates: {
        default: { path: "config-templates/default/oas-config.yaml", default: true },
        other: { path: "config-templates/other/oas-config.yaml", default: true },
      },
    },
    files: {
      "config-templates/default/oas-config.yaml": PORTABLE_TEMPLATE,
      "config-templates/other/oas-config.yaml": PORTABLE_TEMPLATE,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at most one config template may be marked default/);
});

test("validator rejects a template that violates the config schema", (t) => {
  const result = runFixture(t, {
    manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
    files: { "config-templates/default/oas-config.yaml": "name: broken\ncapabilities:\n  layers:\n    chat:\n      capability: test.capability-1\n" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /capabilities\.layers\.chat: unknown property/);
});

test("validator rejects a template that is not portable", (t) => {
  const result = runFixture(t, {
    manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
    files: { "config-templates/default/oas-config.yaml": `${PORTABLE_TEMPLATE}skill-overrides:\n  aweb-messaging: /Users/someone/skills/aweb\n` },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not portable — it contains an absolute machine path/);
});

test("validator rejects a capability resource that escapes its own capability root", (t) => {
  // Package-only bytes are not installed bytes: a capability that reaches them
  // cannot be materialized as a self-contained artifact (contract §2.5).
  const result = runFixture(t, {
    ...canonicalTemplate,
    capabilityExtras: () => ({ inject: "shared/inject.md" }),
    files: { ...canonicalTemplate.files, "shared/inject.md": "# package-only\n" },
    links: [["capabilities/one/shared", "shared"]],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /escapes its capability root after symlink resolution/);
});

test("validator rejects a skill tree containing an escaping symlink", (t) => {
  const result = runFixture(t, {
    ...canonicalTemplate,
    capabilityExtras: () => ({ skills: ["skills/demo"] }),
    files: { ...canonicalTemplate.files, "skills/demo/SKILL.md": "---\nname: demo\n---\n", "shared/secret.md": "package-only\n" },
    links: [["capabilities/one/skills", "skills"], ["skills/demo/leak.md", "shared/secret.md"]],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /escap/);
});
