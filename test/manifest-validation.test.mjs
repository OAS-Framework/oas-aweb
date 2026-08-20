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

// A template is adopted VERBATIM into someone else's deployment, so a value
// that IS a machine path cannot travel — in ANY spelling a host might produce.
// Enumerating known roots (/Users, /home, ...) missed /tmp, every Windows form
// and tilde-home, so these fixtures pin the classes rather than the roots.
for (const [label, value] of [
  ["a POSIX absolute path under a known home", "/Users/someone/skills/aweb"],
  ["a POSIX absolute path under any other root", "/tmp/local-machine/instructions.md"],
  ["a POSIX absolute system path", "/etc/oas/instructions.md"],
  ["a Windows drive-letter path with backslashes", "C:\\Users\\local\\instructions.md"],
  ["a Windows drive-letter path with forward slashes", "C:/Users/local/instructions.md"],
  ["a Windows UNC network path", "\\\\server\\share\\instructions.md"],
  ["a Windows root-relative path", "\\rooted\\instructions.md"],
  ["a tilde-home path", "~/machine-local/instructions.md"],
  ["a tilde-user path", "~someone/instructions.md"],
  ["a $HOME reference", "$HOME/instructions.md"],
  ["a ${HOME} reference", "${HOME}/instructions.md"],
  ["a %USERPROFILE% reference", "%USERPROFILE%\\instructions.md"],
  ["a file:// URL", "file:///Users/me/instructions.md"],
  // `file:` is legal with ONE slash too, so matching "file://" missed it.
  ["a single-slash file: URI", "file:/etc/oas/instructions.md"],
  ["a file: URI with a drive letter", "file:///C:/Users/me/instructions.md"],
]) {
  test(`validator rejects a template value that is ${label}`, (t) => {
    const result = runFixture(t, {
      manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
      files: { "config-templates/default/oas-config.yaml": `${PORTABLE_TEMPLATE}agents-md-injection: "${value}"\n` },
    });
    assert.equal(result.status, 1, `${label} must not travel to another machine`);
    assert.match(result.stderr, /is not portable/);
  });
}

// The mirror risk: a rule broad enough to catch every path spelling must not
// start rejecting the portable references a template legitimately carries.
for (const [label, value] of [
  ["an https URL", "https://aweb.ai/docs"],
  ["a git https remote", "https://github.com/OAS-Framework/oas-aweb.git"],
  ["an scp-style git remote", "git@github.com:OAS-Framework/oas-aweb.git"],
  ["a scope-relative path", ".agents/injections/aweb.md"],
  ["a bare relative path", "injections/aweb.md"],
  ["the literal none", "none"],
  // Scalars are classified structurally, so a URL stays portable no matter what
  // its PATH spells. Scanning the whole file for home-directory markers used to
  // override that and reject these.
  ["an https URL whose path contains /home/", "https://docs.example.test/home/getting-started"],
  ["an https URL whose path contains /Users/", "https://example.test/Users/guide"],
]) {
  test(`validator accepts ${label}, which is portable`, (t) => {
    const result = runFixture(t, {
      manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
      files: { "config-templates/default/oas-config.yaml": `${PORTABLE_TEMPLATE}agents-md-injection: "${value}"\n` },
    });
    assert.equal(result.status, 0, `${label} must not be mistaken for a machine path: ${result.stderr}`);
  });
}

test("validator rejects a credential-shaped setting key anywhere in a template", (t) => {
  const result = runFixture(t, {
    manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
    // Nested under the template's existing capabilities block, so this fixture
    // fails for the credential key and nothing else.
    files: { "config-templates/default/oas-config.yaml": `${PORTABLE_TEMPLATE}  additive:\n    x.y:\n      settings:\n        api_key: abc\n` },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credential-shaped setting/);
  assert.doesNotMatch(result.stderr, /duplicate mapping key|unknown property/, "the fixture must fail for the credential key alone");
});

test("validator rejects a machine path leaked in a template COMMENT", (t) => {
  // Comments are adopted verbatim too, so a username in one travels just as far.
  const result = runFixture(t, {
    manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
    files: { "config-templates/default/oas-config.yaml": `# see /Users/someone/notes.md\n${PORTABLE_TEMPLATE}` },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /user home directory/);
});

test("validator does not flag an illustrative placeholder path in prose", (t) => {
  // "/path/to/scope" identifies no person or machine; flagging it would make the
  // rule unusable for the documentation a good template carries.
  const result = runFixture(t, {
    manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
    files: { "config-templates/default/oas-config.yaml": `# adopt it into /path/to/scope\n${PORTABLE_TEMPLATE}` },
  });
  assert.equal(result.status, 0, result.stderr);
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

test("validator rejects a template whose list is a block sequence", (t) => {
  // The OAS config reader drops those lines, so the adopter would get an EMPTY
  // agent-types map from a template that validated as a populated one.
  const result = runFixture(t, {
    manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
    files: { "config-templates/default/oas-config.yaml": `${PORTABLE_TEMPLATE}agent-types:\n  - developer\n` },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /block sequences are dropped/);
});

test("validator rejects a sequence item that is itself a mapping", (t) => {
  const result = runFixture(t, {
    manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
    files: { "config-templates/default/oas-config.yaml": `${PORTABLE_TEMPLATE}agent-types:\n  - developer:\n` },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /block sequences are dropped/);
});

test("validator rejects a template smuggling config behind __proto__", (t) => {
  // Without the refusal this PASSES: the schema walk enumerates own properties
  // and sees nothing, while the kernel reads the settings off the prototype.
  const result = runFixture(t, {
    manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
    files: { "config-templates/default/oas-config.yaml": "__proto__:\n  capabilities:\n    layers:\n      messaging: none\n" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a usable config key/);
});

test("validator rejects template keys the config schema does not define", (t) => {
  // `"constructor" in {}` is true — so is toString, valueOf and six more — and
  // an `in`-based schema dispatch would hand back Object.prototype.constructor
  // as if it were a subschema, letting the key through additionalProperties:
  // false. The released kernel then rejects the adopted config, in someone
  // else's deployment rather than here.
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    const result = runFixture(t, {
      manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
      files: { "config-templates/default/oas-config.yaml": `${PORTABLE_TEMPLATE}${key}: anything\n` },
    });
    assert.equal(result.status, 1, `a root ${key} key must be rejected`);
    assert.match(result.stderr, new RegExp(`${key}: unknown property`));
  }
});

test("validator still reports a genuinely missing required property", (t) => {
  // The `required` check moved to own-property semantics too: `"constructor" in
  // value` is true for EVERY object, so an inherited name could satisfy a
  // required key that is not actually there.
  const result = runFixture(t, {
    manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
    files: { "config-templates/default/oas-config.yaml": "name: demo\ncapabilities:\n  layers:\n    messaging:\n      from: installed\n" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing required property capability/);
});

// A credential can hide in three places, and checking only key NAMES catches
// just one of them. All three are copied to the adopter verbatim.
for (const [label, template] of [
  ["a value", `${PORTABLE_TEMPLATE}agents-md-injection: "--api-key=sk-live-leaked"\n`],
  ["a whole-line comment", `# api_key: sk-live-leaked\n${PORTABLE_TEMPLATE}`],
  ["an inline comment", PORTABLE_TEMPLATE.replace("name: fixture-deployment", "name: fixture-deployment # token: sk-live-leaked")],
]) {
  test(`validator rejects a credential assigned in ${label}`, (t) => {
    const result = runFixture(t, {
      manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
      files: { "config-templates/default/oas-config.yaml": template },
    });
    assert.equal(result.status, 1, `a credential in ${label} must not reach an adopter`);
    assert.match(result.stderr, /credential-shaped value/);
  });
}

test("the word credential in ordinary prose is not a leak", (t) => {
  // The shipped template's own comment says "no credential, account, machine
  // path" — a rule that flagged the word rather than an assignment would make
  // the template unable to document its own portability promise.
  const result = runFixture(t, {
    manifestExtras: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
    files: { "config-templates/default/oas-config.yaml": `# no credential, account, or machine path\n${PORTABLE_TEMPLATE}` },
  });
  assert.equal(result.status, 0, result.stderr);
});
