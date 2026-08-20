#!/usr/bin/env node
/**
 * Isolated CONSUMER probe: drive the RELEASED @oas-framework/oas kernel against
 * this repository's `oas-package/` payload exactly the way an adopter would.
 *
 * Everything happens in a throwaway directory outside the source tree, with a
 * synthetic HOME and a PATH that contains only what each step is supposed to
 * find. No real credential, no real `.aw` workspace, and no globally installed
 * `oas`, `aw`, `pi` or Claude configuration is read or written — the probe
 * deliberately shadows all of them so a green run cannot be an artifact of this
 * machine's state.
 *
 *   node scripts/consumer-probe.mjs
 *
 *   OAS_PROBE_CLI   path to an already-unpacked kernel bin (skips the download)
 *   OAS_PROBE_KEEP  keep the sandbox for inspection
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAYLOAD = join(REPO, "oas-package");
/** The floor this package declares is the version we must prove against. */
const KERNEL_VERSION = JSON.parse(readFileSync(join(PAYLOAD, "oas-package.json"), "utf8")).compatibility.oas.replace(/^>=/, "");
const TEAM = "my-team:probe.invalid";

const results = [];
let failures = 0;
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (error) { failures += 1; results.push(`  FAIL ${name}\n         ${String(error.message).split("\n").join("\n         ")}`); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
/** Kernel behaviour this package must NOT work around, recorded verbatim so the
 * evidence travels with the run. */
const defects = [];
function defect(title, evidence) { defects.push(`  ${title}\n${evidence.split("\n").map((l) => `    ${l}`).join("\n")}`); }
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}
function deepEqual(actual, expected, message) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`);
}

const sandbox = mkdtempSync(join(tmpdir(), "oas-aweb-probe-"));
process.on("exit", () => { if (!process.env.OAS_PROBE_KEEP) rmSync(sandbox, { recursive: true, force: true }); });
const HOME = join(sandbox, "home");
mkdirSync(HOME, { recursive: true });

// ---------------------------------------------------------------- the kernel
function resolveKernel() {
  if (process.env.OAS_PROBE_CLI) return process.env.OAS_PROBE_CLI;
  const dir = join(sandbox, "kernel");
  mkdirSync(dir, { recursive: true });
  execFileSync("npm", ["pack", `@oas-framework/oas@${KERNEL_VERSION}`, "--silent"], { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
  const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`npm pack produced no tarball for @oas-framework/oas@${KERNEL_VERSION}`);
  execFileSync("tar", ["xzf", tgz], { cwd: dir, stdio: "inherit" });
  return join(dir, "package", "bin", "oas.mjs");
}
const KERNEL = resolveKernel();

// A PATH holding node and nothing else this machine happens to have installed:
// the real `aw` lives beside node in nvm layouts, and finding it by accident
// would silently turn the "requirement is missing" probes green.
const NODE_ONLY = join(sandbox, "node-only");
mkdirSync(NODE_ONLY, { recursive: true });
symlinkSync(process.execPath, join(NODE_ONLY, "node"));
/** Every stub records an unexpected invocation here; the probe fails at the end
 * if the file exists. A stub that silently returns 0 for a call nobody planned
 * cannot fail a run it was never supposed to take part in. */
const UNEXPECTED = join(sandbox, "unexpected-invocations.log");

/** POSIX single-quoting for a value interpolated into a generated /bin/sh
 * script. The sandbox path comes from TMPDIR, which the environment controls,
 * so an unquoted path is a command-injection sink and not merely a
 * spaces-in-paths bug: a TMPDIR of `/tmp/x;touch OWNED;#` would otherwise be
 * pasted straight into a stub the probe then executes. Everything the probe
 * writes into shell — paths, markers, fixture values — goes through this. */
function shq(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** A stub that handles the calls named in `body` and REFUSES everything else. */
function shim(dir, name, body, marker = UNEXPECTED) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\nprintf '%s: %s\\n' ${shq(name)} "$*" >> ${shq(marker)}\nexit 90\n`);
  chmodSync(file, 0o755);
  return file;
}

/** Binaries the released kernel resolves that this probe must control rather
 * than inherit: the runtime binaries (resolved even for a scaffold-only spawn),
 * the aweb CLI, and tmux. They are controlled two different ways, because they
 * are not the same kind of dependency.
 *
 * For these, ABSENCE is the thing under test — several checks assert the kernel
 * refuses to spawn when the aweb CLI or a declared runtime cannot be resolved,
 * so a placeholder on PATH would quietly change what is being measured. */
const MUST_BE_ABSENT = ["aw", "pi", "claude"];
/** tmux is different: the kernel legitimately runs it (retire closes the
 * instance window), so the requirement is not that it be missing but that it
 * never be the HOST's. Shadow it with a refusing stub ahead of /usr/bin so the
 * guarantee holds by construction. Asserting its absence instead made the
 * probe's isolation a property of the machine: my laptop keeps tmux in
 * /opt/homebrew/bin so the check passed, and GitHub's ubuntu runners ship
 * /usr/bin/tmux so it aborted there — the preflight was right both times, and
 * the PATH was wrong. */
const MUST_BE_OURS = ["tmux"];

const DENY_BIN = join(sandbox, "deny-bin");
for (const bin of MUST_BE_OURS) shim(DENY_BIN, bin, "");
const BASE_PATH = `${NODE_ONLY}:${DENY_BIN}:/usr/bin:/bin`;

function oas(args, { cwd = sandbox, path = BASE_PATH, env = {}, expect = "ok" } = {}) {
  const run = spawnSync(process.execPath, [KERNEL, ...args], {
    cwd, encoding: "utf8",
    env: { PATH: path, HOME, TMPDIR: sandbox, NO_COLOR: "1", ...env },
  });
  const text = `${run.stdout || ""}${run.stderr || ""}`;
  if (expect === "ok" && run.status !== 0) throw new Error(`oas ${args.join(" ")} failed (${run.status}):\n${text}`);
  if (expect === "fail" && run.status === 0) throw new Error(`oas ${args.join(" ")} unexpectedly succeeded:\n${text}`);
  return { ...run, text };
}
/** Run a --json command and return the envelope, which may be an ok:false one.
 * Some commands print human notes before the envelope, and some envelopes are
 * pretty-printed across many lines, so the parser looks for the LAST suffix of
 * stdout that parses as one JSON object rather than assuming either shape. */
function oasJson(args, options = {}) {
  const run = oas([...args, "--json"], options);
  const lines = run.stdout.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trimStart().startsWith("{")) continue;
    try { return JSON.parse(lines.slice(i).join("\n")); } catch { /* not the envelope start */ }
  }
  throw new Error(`oas ${args.join(" ")} --json produced no envelope:\n${run.text}`);
}
function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, HOME } }).trim(); }
function newScope(name) {
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "."]);
  git(dir, ["-c", "user.email=probe@example.invalid", "-c", "user.name=probe", "commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const lockOf = (scope) => readJson(join(scope, "oas-lock.json"));
const installedDir = (scope) => join(scope, ".agents", "capabilities", "installed", "oas.aweb");

// The package is consumed from a COPY: the probe must never be able to mutate
// the payload it is validating, and an adopter never has our repo tooling.
const SOURCE = join(sandbox, "source");
cpSync(PAYLOAD, SOURCE, { recursive: true });

const PACKAGE_MANIFEST = readJson(join(SOURCE, "oas-package.json"));
const CAPABILITY_MANIFEST = readJson(join(SOURCE, "capabilities", "oas-aweb", "oas.json"));
const TEMPLATE = readFileSync(join(SOURCE, PACKAGE_MANIFEST.configTemplates.default.path), "utf8");

console.log(`consumer probe — kernel ${oas(["version"]).stdout.trim()}\n  payload: ${PAYLOAD}\n  sandbox: ${sandbox}\n`);
check(`kernel under test is the declared floor ${KERNEL_VERSION}`, () => {
  assert(oas(["version"]).stdout.includes(KERNEL_VERSION), `kernel is not ${KERNEL_VERSION}`);
});

// PREFLIGHT — fatal, and deliberately OUTSIDE check(). check() records a failure
// and carries on, which is right for a finding but wrong for a broken sandbox:
// continuing would let every later fails-closed and spawn assertion resolve the
// REAL binary and pass for the wrong reason. Every controlled executable is
// inspected (not just up to the first hit) and the run aborts if any is
// reachable.
{
  const resolves = (bin) =>
    spawnSync("sh", ["-c", `command -v ${bin}`], { env: { PATH: BASE_PATH }, encoding: "utf8" }).stdout.trim();
  const problems = [
    ...MUST_BE_ABSENT.map((bin) => [bin, resolves(bin)]).filter(([, found]) => found)
      .map(([bin, found]) => `  ${bin} is reachable at ${found} — its ABSENCE is what several checks measure`),
    ...MUST_BE_OURS.map((bin) => [bin, resolves(bin), join(DENY_BIN, bin)]).filter(([, found, stub]) => found !== stub)
      .map(([bin, found, stub]) => `  ${bin} resolves to ${found || "nothing"}, not the probe's refusing stub at ${stub}`),
    ...(resolves("node") ? [] : ["  node is NOT reachable from the probe PATH"]),
    ...(process.env.HOME === HOME ? ["  HOME was inherited rather than replaced"] : []),
  ];
  if (problems.length) {
    console.error(`PROBE ABORTED — the sandbox does not control what the kernel resolves:\n${problems.join("\n")}\n` +
      `Every verdict below would depend on this host rather than on the package.`);
    process.exit(1);
  }
}
results.push(`  ok   the probe PATH controls every executable the kernel may resolve (absent: ${MUST_BE_ABSENT.join(", ")}; shadowed by a refusing stub: ${MUST_BE_OURS.join(", ")})`);

// ======================================================= config-reader parity
// The repo gate schema-checks the shipped template with scripts/lib/kernel-yaml.mjs.
// That is only sound while it agrees with the reader the kernel ACTUALLY uses:
// a validator that understands more YAML than the kernel would bless a template
// the deployment then reads differently. Assert the agreement against the
// released kernel itself, over the template plus the shapes most likely to drift.
const kernelCore = await import(pathToFileURL(join(dirname(dirname(KERNEL)), "lib", "core.mjs")).href);
const { parseKernelYaml } = await import(pathToFileURL(join(REPO, "scripts", "lib", "kernel-yaml.mjs")).href);

check("the gate's config reader agrees with the released kernel's, value for value", () => {
  const corpus = {
    "the shipped template": TEMPLATE,
    "inline list": "agent-types: [developer, reviewer]\n",
    "inline map": "settings: {retries: 2, mode: fast}\n",
    "quoted value carrying a hash": 'name: "a # b"\n',
    "trailing comment": "name: a # b\n",
    "quoted value carrying a colon": 'name: "a: b"\n',
    "key with no value": "knowledge:\n",
    "booleans, numbers and null": "a: true\nb: FALSE\nc: null\nd: ~\ne: 3\nf: 1.5\n",
    "deep nesting": "a:\n  b:\n    c: 1\n  d: true\n",
  };
  for (const [label, source] of Object.entries(corpus)) {
    deepEqual(parseKernelYaml(source), kernelCore.parseYamlNested(source), `config-reader parity — ${label}`);
  }
});

check("the gate refuses YAML the released kernel silently drops or reinterprets", () => {
  // Each of these parses in the kernel WITHOUT error and means something other
  // than it looks like, so the gate must stop rather than validate the illusion.
  const misread = {
    "block sequence": ["agent-types:\n  - developer\n", (v) => deepEqual(v["agent-types"], {}, "the kernel drops block sequence items")],
    "anchor": ["a: &anchor 1\n", (v) => equal(v.a, "&anchor 1", "the kernel reads an anchor as literal text")],
    "block scalar": ["a: |\n  text\n", (v) => equal(v.a, "|", "the kernel reads a block scalar indicator as literal text")],
    "tag": ["a: !!str 1\n", (v) => equal(v.a, "!!str 1", "the kernel reads a tag as literal text")],
    "mapping-valued sequence item": ["agent-types:\n  - developer:\n",
      (v) => deepEqual(v["agent-types"], { "- developer": {} }, "the kernel turns it into a key literally named \"- developer\"")],
  };
  for (const [label, [source, kernelExpectation]] of Object.entries(misread)) {
    kernelExpectation(kernelCore.parseYamlNested(source));
    let threw = false;
    try { parseKernelYaml(source); } catch { threw = true; }
    assert(threw, `the gate must reject ${label}, which the kernel accepts with a different meaning`);
  }
});

check("the gate catches config keys the kernel would reject in the adopter's scope", () => {
  // The repo gate schema-checks the template; this proves the gate's verdict
  // and the kernel's agree, so a bad key fails HERE and not in someone else's
  // deployment. (The kernel rejects it, though its own message garbles the
  // inherited value — `RENAMED_CONFIG_KEYS["constructor"]` resolves through
  // Object.prototype. Recorded, not worked around.)
  const bad = newScope("bad-config");
  writeFileSync(join(bad, "oas-config.yaml"), "name: demo\nconstructor: anything\n");
  const run = oas(["doctor", bad], { expect: "fail" });
  assert(/constructor/.test(run.text), `the kernel must reject the key: ${run.text.slice(0, 300)}`);
  if (/function Object\(\)/.test(run.text)) {
    defect("released 0.20.0 config-key error resolves through Object.prototype (kernel defect — no package workaround)",
      `a rejected key named "constructor" is reported with an inherited value:\n${(run.text.split("\n").find((l) => l.trim().startsWith("Error: unsupported oas-config key")) || "").trim()}`);
  }
});

check("a __proto__ key cannot smuggle config past an enumerating validator", () => {
  // The sharpest case: the released kernel produces an object with NO own
  // properties — so any schema walk sees an empty config — while the settings
  // still resolve through the prototype and would be applied.
  const smuggled = "__proto__:\n  capabilities:\n    layers:\n      messaging: none\n";
  const parsed = kernelCore.parseYamlNested(smuggled);
  deepEqual(Object.keys(parsed), [], "the kernel leaves no own key for a validator to inspect");
  equal(parsed.capabilities?.layers?.messaging, "none", "yet the kernel still reads the smuggled layer");
  let threw = false;
  try { parseKernelYaml(smuggled); } catch { threw = true; }
  assert(threw, "the gate must refuse a __proto__ key outright");
});

// ================================================ self-containment parity
check("agents[]/skills[] kind rules match the released kernel exactly", () => {
  // The kernel rejects a non-directory under agents[] and accepts a file under
  // skills[]. The repo gate mirrors that; here BOTH are run over the same two
  // fixtures so the agreement is machine-checked per run rather than asserted.
  const bench = join(sandbox, "kind-parity");
  const gate = join(bench, "gate");
  mkdirSync(join(gate, "scripts", "lib"), { recursive: true });
  mkdirSync(join(gate, "schemas"), { recursive: true });
  for (const f of ["validate-manifests.mjs"]) cpSync(join(REPO, "scripts", f), join(gate, "scripts", f));
  cpSync(join(REPO, "scripts", "lib", "kernel-yaml.mjs"), join(gate, "scripts", "lib", "kernel-yaml.mjs"));
  for (const f of ["oas-package", "capability-manifest", "oas-config"]) {
    cpSync(join(REPO, "schemas", `${f}.schema.json`), join(gate, "schemas", `${f}.schema.json`));
  }

  for (const [key, expected] of [["agents", "reject"], ["skills", "accept"]]) {
    const capDir = join(gate, "oas-package", "capabilities", "one");
    rmSync(join(gate, "oas-package"), { recursive: true, force: true });
    mkdirSync(capDir, { recursive: true });
    writeFileSync(join(gate, "oas-package", "oas-package.json"), JSON.stringify({
      package: "test.kind", version: "1.0.0", description: "kind parity fixture",
      compatibility: { oas: `>=${KERNEL_VERSION}` }, capabilities: ["capabilities/one"],
    }) + "\n");
    writeFileSync(join(capDir, "thing.md"), "---\nname: thing\n---\n");
    const manifest = {
      capability: "test.kind", version: "1.0.0", compatibility: { oas: `>=${KERNEL_VERSION}` },
      description: "kind parity fixture", requires: [], [key]: ["thing.md"],
    };
    writeFileSync(join(capDir, "oas.json"), JSON.stringify(manifest) + "\n");

    const gateRun = spawnSync(process.execPath, [join(gate, "scripts", "validate-manifests.mjs")], { cwd: gate, encoding: "utf8" });
    const gateVerdict = gateRun.status === 0 ? "accept" : "reject";
    let kernelVerdict = "accept";
    try { kernelCore.assertCapabilitySelfContained(capDir, manifest); }
    catch { kernelVerdict = "reject"; }
    equal(kernelVerdict, expected, `released kernel verdict for a FILE under ${key}[]`);
    equal(gateVerdict, expected, `repo gate verdict for a FILE under ${key}[] (${gateRun.stderr.trim()})`);
  }
});

// =================================================== documented acquisition
// README tells adopters how to acquire this package. That prose is a contract
// the kernel enforces, and nothing here could falsify it: the local-path source
// below never exercises source PARSING, so a source spelling the released CLI
// rejects could ship in the README indefinitely. It did — the documented
// pinned-Git command was `git:https://github.com/...`, which is neither the
// `git:host/org/repo` shorthand nor a raw URL, and exits 1 with invalid-source.
// The trap is that `git:https://...` IS what the kernel writes into the lock as
// the NORMALIZED form; reading a normalized value back as an input spelling is
// how the wrong command got written down. Parse every documented spelling with
// the kernel's own parser so the README cannot drift from the released contract.
check("every `oas install <source>` spelling in README parses under the released kernel", () => {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const specs = [...readme.matchAll(/^\s*oas install\s+(\S+)/gm)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith("--"));
  assert(specs.length >= 2, `expected README to document acquisition, found ${specs.length} spelling(s)`);
  for (const spec of specs) {
    let parsed;
    try { parsed = kernelCore.parsePackageSource(spec); }
    catch (e) { throw new Error(`README documents "oas install ${spec}", which the released kernel rejects: ${e.code || ""} ${e.message}`); }
    assert(["git", "catalog", "path"].includes(parsed.kind), `"${spec}" parsed as unexpected kind ${parsed.kind}`);
  }
  // The pinned-Git line specifically must parse as Git and carry its ref.
  const pinned = specs.find((spec) => spec.includes("github.com"));
  assert(pinned, "README must document a pinned Git source");
  const parsed = kernelCore.parsePackageSource(pinned);
  equal(parsed.kind, "git", "the documented published source is a Git source");
  assert(parsed.ref, `the documented Git source must be pinned to a ref: "${pinned}"`);
});

// ============================================================ acquire + lock
const scope = newScope("consumer");
const install = oasJson(["install", SOURCE, "--dir", scope, "--no-requirements"]);

check("released kernel acquires the local package root and locks it", () => {
  assert(install.ok, `install failed: ${JSON.stringify(install.error)}`);
  equal(install.result.installed[0].package, "oas.aweb", "locked package identity");
  equal(install.result.installed[0].version, PACKAGE_MANIFEST.version, "locked package version");
  equal(install.result.installed[0].path, ".", "selected package root (a local path source is an exact directory)");
});

// ------------------------------------------- acquisition from a pinned Git ref
// The local-path source above locks commit="local" and path="." — it cannot
// show that the kernel picks the package root OUT of a repository, pins the
// exact commit rather than following the branch, or normalizes the source as
// Git. Build a throwaway origin carrying this payload at oas-package/, then
// move the branch on AFTER pinning so "locked the pinned commit" cannot pass by
// accidentally locking ambient HEAD.
//
// No "#<path>" fragment is passed, deliberately: oas-package IS the released
// kernel's default package path for a Git source, so the path assertion below
// pins the DEFAULT rather than an explicit selection. Confirmed against the
// released CLI by moving the payload to the repository root, which it refuses
// with invalid-package-manifest: "has an oas-package.json at the repository
// ROOT but no package at package path \"oas-package\" (the default) — select
// the root explicitly with ...#.".
const gitOrigin = join(sandbox, "git-origin");
const IDENT = ["-c", "user.email=probe@example.invalid", "-c", "user.name=probe"];
mkdirSync(join(gitOrigin, "oas-package"), { recursive: true });
cpSync(SOURCE, join(gitOrigin, "oas-package"), { recursive: true });
git(gitOrigin, ["init", "-q", "-b", "main", "."]);
git(gitOrigin, ["add", "-A"]);
git(gitOrigin, [...IDENT, "commit", "-q", "-m", "payload at the pinned ref"]);
const PINNED_COMMIT = git(gitOrigin, ["rev-parse", "HEAD"]);
writeFileSync(join(gitOrigin, "MOVED-AFTER-PIN"), "the branch advanced after the pin\n");
git(gitOrigin, ["add", "-A"]);
git(gitOrigin, [...IDENT, "commit", "-q", "-m", "advance the branch past the pin"]);
const HEAD_AFTER_PIN = git(gitOrigin, ["rev-parse", "HEAD"]);

const gitScope = newScope("git-consumer");
const GIT_SPEC = `file://${gitOrigin}@${PINNED_COMMIT}`;
const gitInstall = oasJson(["install", GIT_SPEC, "--dir", gitScope, "--no-requirements"]);

check("released kernel acquires this payload from a PINNED Git source", () => {
  assert(gitInstall.ok, `pinned Git install failed: ${JSON.stringify(gitInstall.error)}`);
  const row = gitInstall.result.installed[0];
  equal(row.package, "oas.aweb", "locked package identity");
  equal(row.version, PACKAGE_MANIFEST.version, "locked package version");
  equal(row.path, "oas-package", "selected package root inside the repository");
});

check("a pinned Git source locks the PINNED commit, not the branch's ambient HEAD", () => {
  const row = lockOf(gitScope).packages["oas.aweb"];
  assert(PINNED_COMMIT !== HEAD_AFTER_PIN, "the fixture must advance the branch past the pin");
  equal(row.commit, PINNED_COMMIT, "locked commit is the pinned one");
  assert(row.commit !== HEAD_AFTER_PIN, "the lock must not follow the branch past the pinned ref");
  equal(row.path, "oas-package", "locked package root");
});

check("a Git source is normalized as Git in the lock, never as a path", () => {
  const row = lockOf(gitScope).packages["oas.aweb"];
  assert(row.source.startsWith("git:"), `source must normalize as Git, got "${row.source}"`);
  assert(!row.source.startsWith("path:"), `a Git source must never lock as a path: "${row.source}"`);
  assert(row.source.includes(PINNED_COMMIT), `the normalized source must carry the pinned ref: "${row.source}"`);
});

check("the same payload acquired two ways materializes identical CONTENT", () => {
  // Everything except the provenance record must be byte-identical: acquisition
  // transport is not supposed to change what gets installed.
  const walk = (root, base = "") => readdirSync(join(root, base), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(root, join(base, e.name)) : [join(base, e.name)]));
  const RECORD = ".oas-installation.json";
  const fromGit = installedDir(gitScope);
  const fromPath = installedDir(scope);
  const gitFiles = walk(fromGit).sort();
  deepEqual(gitFiles, walk(fromPath).sort(), "materialized file lists");
  const differing = gitFiles.filter((rel) =>
    !readFileSync(join(fromGit, rel)).equals(readFileSync(join(fromPath, rel))));
  deepEqual(differing, [RECORD], "only the provenance record may differ between acquisitions");
  equal(lockOf(gitScope).capabilities["oas.aweb"].path, lockOf(scope).capabilities["oas.aweb"].path,
    "materialized capability path");
});

check("the installation record carries the Git provenance, and trust binds to it", () => {
  const record = readJson(join(installedDir(gitScope), ".oas-installation.json"));
  equal(record.commit, PINNED_COMMIT, "recorded commit is the pinned one");
  equal(record.packagePath, "oas-package", "recorded package root");
  assert(record.source.startsWith("git:"), `recorded source must be Git: "${record.source}"`);
  // Provenance is INSIDE the hashed artifact, so the same content acquired from
  // a different source is a different artifact. That is the trust boundary, not
  // a defect: an approval granted to the local-path build must not silently
  // carry over to one pulled from a repository.
  const gitIntegrity = lockOf(gitScope).capabilities["oas.aweb"].integrity;
  assert(gitIntegrity !== lockOf(scope).capabilities["oas.aweb"].integrity,
    "identical content from a different source must NOT hash the same — trust would transfer across provenance");
  equal(lockOf(gitScope).capabilities["oas.aweb"].trusted, false, "acquisition never confers trust");
});

check("lock is lockfileVersion 2 with BOTH the package and capability levels", () => {
  const lock = lockOf(scope);
  equal(lock.lockfileVersion, 2, "lockfileVersion");
  deepEqual(Object.keys(lock.packages), ["oas.aweb"], "locked packages");
  deepEqual(Object.keys(lock.capabilities), ["oas.aweb"], "locked capabilities");
});

check("package row locks transport only — no transitional keys", () => {
  const row = lockOf(scope).packages["oas.aweb"];
  deepEqual(Object.keys(row).sort(), ["commit", "dependencies", "integrity", "path", "source", "version"], "package row keys");
  equal(row.source, `path:${SOURCE}`, "normalized source spec");
  equal(row.commit, "local", "local path sources lock commit=local");
  deepEqual(row.dependencies, [], "dependencies are always recorded, empty when there are none");
  assert(/^sha256-[0-9a-f]{64}$/.test(row.integrity), "payload integrity digest");
  for (const forbidden of ["capabilities", "trustedCapabilities", "depsIntegrity"]) {
    assert(!Object.hasOwn(row, forbidden), `package row must not carry the transitional key "${forbidden}"`);
  }
});

check("capability row locks the materialized entity and its dedicated root", () => {
  const row = lockOf(scope).capabilities["oas.aweb"];
  deepEqual(Object.keys(row).sort(), ["integrity", "package", "path", "trusted", "version"], "capability row keys");
  equal(row.version, CAPABILITY_MANIFEST.version, "capability version is its own, not the package's");
  equal(row.package, "oas.aweb", "provider package back-reference");
  equal(row.path, "capabilities/oas-aweb", "dedicated capability root inside the package");
  assert(row.path !== ".", 'the capability root must never be the package root "."');
  assert(/^sha256-[0-9a-f]{64}$/.test(row.integrity), "artifact integrity digest");
});

// ====================================================== flat materialization
check("capability materializes FLAT into .agents/capabilities/installed/oas.aweb", () => {
  const dir = installedDir(scope);
  assert(existsSync(join(dir, "oas.json")), "oas.json must sit at the artifact root");
  for (const resource of ["bin/oas-aweb.mjs", "injects/aweb.md", ...CAPABILITY_MANIFEST.skills.map((s) => `${s}/SKILL.md`)]) {
    assert(existsSync(join(dir, resource)), `declared resource missing from the artifact: ${resource}`);
  }
  assert(!existsSync(join(dir, "capabilities")), "the package's capability nesting must be flattened away");
  assert(!existsSync(join(dir, "oas-package.json")), "package-only bytes must not be materialized");
  assert(!existsSync(join(dir, "config-templates")), "config templates are source material, never installed bytes");
});

check("the artifact carries its own provenance file", () => {
  const provenance = readJson(join(installedDir(scope), ".oas-installation.json"));
  equal(provenance.capability, "oas.aweb", "provenance capability");
  equal(provenance.package, "oas.aweb", "provenance package");
  equal(provenance.capabilityPath, "capabilities/oas-aweb", "provenance capability path");
  equal(provenance.packageVersion, PACKAGE_MANIFEST.version, "provenance package version");
});

check("installation applies no config and activates nothing", () => {
  assert(!existsSync(join(scope, "oas-config.yaml")), "`oas install` must never write a config");
  assert(!existsSync(join(scope, ".agents", "config-templates")), "`oas install` must never adopt a template");
  equal(lockOf(scope).capabilities["oas.aweb"].trusted, false, "nothing is trusted by installing");
});

// ============================================================ ignore behavior
check("generated artifacts are ignored before they can be committed", () => {
  const ignore = readFileSync(join(scope, ".agents", "capabilities", ".gitignore"), "utf8");
  assert(ignore.split("\n").some((l) => l.trim() === "installed/"), ".agents/capabilities/.gitignore must ignore installed/");
  const dirty = git(scope, ["status", "--porcelain", "-uall"]).split("\n").filter(Boolean);
  assert(!dirty.some((l) => l.includes("capabilities/installed/")), `materialized bytes are visible to git:\n${dirty.join("\n")}`);
  assert(dirty.some((l) => l.endsWith("oas-lock.json")), "the lock itself must stay committable");
  assert(dirty.some((l) => l.endsWith(".agents/capabilities/.gitignore")), "the ignore file itself must stay committable");
});

// ================================================================ exact restore
check("bare `oas install` restores the artifact EXACTLY from the lock", () => {
  const before = lockOf(scope);
  const integrity = before.capabilities["oas.aweb"].integrity;
  rmSync(installedDir(scope), { recursive: true, force: true });
  const restored = oasJson(["install", "--dir", scope, "--no-requirements"]);
  assert(restored.ok, `restore failed: ${JSON.stringify(restored.error)}`);
  const after = lockOf(scope);
  equal(after.capabilities["oas.aweb"].integrity, integrity, "restored artifact integrity must be identical");
  deepEqual(after, before, "a restore must not advance the lock");
  assert(existsSync(join(installedDir(scope), "oas.json")), "artifact reprojected");
});

// ================================================================ trust gates
check("executable surface is untrusted until explicitly approved", () => {
  const doctor = oasJson(["doctor", scope]);
  const pkg = doctor.packages.find((p) => p.id === "oas.aweb");
  equal(pkg.status, "broken", "an untrusted executable surface is reported, not assumed");
  assert(pkg.problems.some((p) => p.code === "untrusted-surface"), `expected untrusted-surface, got ${JSON.stringify(pkg.problems)}`);
  assert(install.result.capabilities[0].executableSurface.hooks.includes("spawn"), "the spawn hook is part of the declared executable surface");
});

check("`oas trust` binds approval to the exact artifact integrity", () => {
  const integrity = lockOf(scope).capabilities["oas.aweb"].integrity;
  const out = oas(["trust", "oas.aweb", "--dir", scope]);
  assert(out.text.includes(integrity), `trust output must name the artifact integrity it approved:\n${out.text}`);
  equal(lockOf(scope).capabilities["oas.aweb"].trusted, true, "trust is recorded in the lock");
});

check("artifact drift invalidates the approval until the artifact is restored", () => {
  writeFileSync(join(installedDir(scope), "bin", "oas-aweb.mjs"), "// tampered\n", { flag: "a" });
  const drifted = oasJson(["doctor", scope]).packages.find((p) => p.id === "oas.aweb");
  equal(drifted.status, "broken", "a tampered artifact is a broken package");
  const drift = drifted.problems.find((p) => p.code === "integrity-drift");
  assert(drift, `expected integrity-drift, got ${JSON.stringify(drifted.problems)}`);
  assert(drift.detail.includes("executable approval is invalid"), `drift must invalidate trust: ${drift.detail}`);
  // Restoring returns the artifact to the integrity the approval was given for,
  // so the approval is valid again — trust binds to bytes, not to a session.
  oasJson(["install", "--dir", scope, "--no-requirements"]);
  const healed = oasJson(["doctor", scope]).packages.find((p) => p.id === "oas.aweb");
  equal(healed.status, "ok", `restored artifact should be clean: ${JSON.stringify(healed.problems)}`);
  equal(lockOf(scope).capabilities["oas.aweb"].trusted, true, "an unchanged, restored artifact keeps its approval");
});

check("a source change invalidates the executable approval", () => {
  // Its own copy of the payload and its own scope: the approval-invalidation
  // path must be provable without disturbing the pristine source the rest of
  // the probe consumes.
  const mutable = join(sandbox, "source-mutable");
  cpSync(SOURCE, mutable, { recursive: true });
  const updating = newScope("updater");
  oasJson(["install", mutable, "--dir", updating, "--no-requirements"]);
  oas(["trust", "oas.aweb", "--dir", updating]);
  equal(lockOf(updating).capabilities["oas.aweb"].trusted, true, "approved at the installed integrity");
  writeFileSync(join(mutable, "capabilities", "oas-aweb", "bin", "oas-aweb.mjs"), "// upstream change\n", { flag: "a" });
  const updated = oas(["update", "oas.aweb", "--dir", updating]);
  assert(/APPROVALS INVALIDATED/.test(updated.text), `update must announce the invalidation:\n${updated.text}`);
  equal(lockOf(updating).capabilities["oas.aweb"].trusted, false, "a changed source is never silently re-trusted");
});

// ========================================================= explicit adoption
const adopted = newScope("adopter");
const init = oasJson(["init", "--package", SOURCE, "--dir", adopted]);

check("`oas init --package` adopts the template verbatim as local policy", () => {
  assert(init.ok, `init failed: ${JSON.stringify(init.error)}`);
  equal(init.result.template, "default", "the manifest's default template needs no --config");
  equal(readFileSync(join(adopted, "oas-config.yaml"), "utf8"), TEMPLATE, "the adopted config must be the shipped template byte for byte");
});

check("adoption records an adopted BASE that diff/sync compare against", () => {
  const base = join(adopted, ".agents", "config-templates", "adopted", "oas.aweb", "default");
  equal(readFileSync(join(base, "oas-config.yaml"), "utf8"), TEMPLATE, "recorded base content");
  const metadata = readJson(join(base, "adoption.json"));
  equal(metadata.package, "oas.aweb", "adoption metadata package");
  equal(metadata.template, "default", "adoption metadata template");
  equal(metadata.templatePath, PACKAGE_MANIFEST.configTemplates.default.path, "adoption metadata template path");
  equal(metadata.version, PACKAGE_MANIFEST.version, "adoption metadata version");
  const diff = oasJson(["config", "diff", "--dir", adopted]);
  equal(diff.result.clean, true, "a freshly adopted config has no drift from its base");
});

check("the adopted deployment resolves aweb as the messaging layer", () => {
  const doctor = oasJson(["doctor", adopted]);
  equal(doctor.layers.messaging.integration, "oas.aweb", "messaging layer binding");
  equal(doctor.team.name, "my-team", "the template's team block drives the deployment boundary");
  assert(doctor.layers.messaging.inject.includes("installed/oas.aweb/injects/aweb.md"), "the injection resolves inside the materialized artifact");
  equal(doctor.layers.messaging.skills.length, CAPABILITY_MANIFEST.skills.length, "all vendored skills resolve from the artifact");
});

// ============================================ known released-0.20 kernel defect
check("the orphan warning is a kernel defect, not a missing lock entry", () => {
  // MAINTAINER RULING: `oas doctor` on 0.20.0 warns that the materialized
  // capability "has no lock entry" even though the v2 lock records it. It is a
  // confirmed kernel defect; the package must add NO workaround, and the exact
  // warning is preserved here as evidence.
  const locked = lockOf(adopted).capabilities["oas.aweb"];
  assert(locked, "the lock MUST carry the capability entry — that part is ours");
  equal(locked.package, "oas.aweb", "locked provider package");
  const human = oas(["doctor", adopted]).text;
  const orphan = human.split("\n").map((l) => l.trim()).find((l) => l.includes("is in installed/ but has no lock entry"));
  if (orphan) defect("released 0.20.0 `oas doctor` orphan warning (kernel defect — no package workaround)", `lock entry present: ${JSON.stringify(locked)}\nwarning emitted:  ${orphan}`);
  const unexpected = human.split("\n").map((l) => l.trim())
    .filter((l) => l.startsWith("WARNING") && !l.includes("has no lock entry") && !l.includes("version skew"));
  deepEqual(unexpected, [], "no warning other than the known kernel defect and the local kernel/bridge skew");
});

// ===================================================== host/runtime requirements
check("the `aw` host requirement is reported, never silently installed", () => {
  assert(!spawnSync("sh", ["-c", "command -v aw"], { env: { PATH: BASE_PATH } }).stdout.toString().trim(), "probe PATH must not contain a real aw");
  const doctor = oasJson(["doctor", adopted]);
  const missing = doctor.missingHostRequirements.find((r) => r.command === "aw");
  assert(missing, `expected aw among missingHostRequirements: ${JSON.stringify(doctor.missingHostRequirements)}`);
  equal(missing.why, CAPABILITY_MANIFEST.requires.find((r) => r.command === "aw").why, "the manifest's reason is surfaced verbatim");
  assert(doctor.layers.messaging.missingRequires.some((r) => r.command === "aw"), "the active layer reports it too");
  assert(!spawnSync("sh", ["-c", "command -v aw"], { env: { PATH: BASE_PATH } }).stdout.toString().trim(), "install/doctor must not have installed aw");
});

oas(["trust", "oas.aweb", "--dir", adopted]);
oas(["create", "probe-claude", "--local", "--description", "probe", "--work", "checkout", "--runtime", "claude"], { cwd: adopted });
oas(["create", "probe-pi", "--local", "--description", "probe", "--work", "checkout", "--runtime", "pi"], { cwd: adopted });

check("a Claude instance fails closed when the channel plugin is not installed", () => {
  const spawned = oasJson(["spawn", "probe-claude", "--task", "probe", "--no-launch"], { cwd: adopted, expect: "fail" });
  equal(spawned.ok, false, "spawn must not succeed");
  assert(spawned.error.message.includes(CAPABILITY_MANIFEST.requires.find((r) => r.runtime === "claude").package),
    `error must name the required Claude plugin: ${spawned.error.message}`);
  assert(spawned.error.message.includes("--accept-requirement claude:"), "the remedy is explicit consent, not an automatic install");
});

check("a pi instance fails closed when the pi channel extension is not installed", () => {
  const spawned = oasJson(["spawn", "probe-pi", "--task", "probe", "--no-launch"], { cwd: adopted, expect: "fail" });
  equal(spawned.ok, false, "spawn must not succeed");
  assert(spawned.error.message.includes(CAPABILITY_MANIFEST.requires.find((r) => r.runtime === "pi").package),
    `error must name the required pi package: ${spawned.error.message}`);
});

// ============================================================ spawn / retire
// From here the sandbox pretends the consented requirements are satisfied: a
// fake `pi` reports the channel extension installed, and a fake `aw` answers
// the identity calls. Both live inside the sandbox, so no real aweb workspace,
// team or credential is ever touched.
const FAKE_BIN = join(sandbox, "fake-bin");
const AW_STATE = join(sandbox, "aw-calls.log");
const PI_EXT = join(sandbox, "pi-packages", "awebai-pi");
mkdirSync(PI_EXT, { recursive: true });
shim(FAKE_BIN, "pi", `if [ "$1" = "list" ]; then printf '  npm:@awebai/pi\\n      %s\\n' ${shq(PI_EXT)}; exit 0; fi`);
// tmux is MUST_BE_OURS, not forbidden: retire legitimately closes the instance's
// window. What --no-launch must never do is CREATE one, so the stub answers the
// teardown calls and refuses everything else — a `new-session`, `new-window` or
// `send-keys` fails the probe rather than silently starting a session.
shim(FAKE_BIN, "tmux", `case "$1" in
  kill-window|has-session|list-windows|list-sessions) exit 0 ;;
esac`);
// Each handled call exits 0 HERE; anything unmatched falls through to the
// shared recorder in shim(), so no branch can silently swallow a call the probe
// never planned for.
shim(FAKE_BIN, "aw", `echo "$@" >> ${shq(AW_STATE)}
case "$1 $2" in
  "team list") printf '{"active_team":"${TEAM}","memberships":[{"team_id":"${TEAM}"}]}\\n'; exit 0 ;;
  "team invite") printf '{"token":"probe-invite-token"}\\n'; exit 0 ;;
  "team join") printf '{"alias":"%s","team_id":"${TEAM}"}\\n' "$5"; exit 0 ;;
  "init "*|"init") mkdir -p .aw; exit 0 ;;
  "workspace delete") exit 0 ;;
esac`);
const FAKE_PATH = `${FAKE_BIN}:${BASE_PATH}`;

check("a generated stub quotes its paths, so a hostile sandbox path cannot execute", () => {
  // The sandbox lives under TMPDIR, which the ENVIRONMENT controls, and its
  // path is pasted into /bin/sh text the probe then runs. Unquoted, that is a
  // command-injection sink, not merely a spaces-in-paths bug. Exercise the real
  // shim() — a self-test with its own copy of the generator would drift from
  // the thing it is supposed to protect.
  const home = join(sandbox, "hostile-path-test");
  const bin = join(home, "bin ;touch SIDE_EFFECT; #");
  const marker = join(home, "marker ;touch SIDE_EFFECT; #.log");
  const stub = shim(bin, "victim", "", marker);
  const run = spawnSync(stub, ["an arg ;touch SIDE_EFFECT; #"], { cwd: home, encoding: "utf8", env: { PATH: BASE_PATH, HOME } });

  equal(run.status, 90, `the stub must still refuse; stderr: ${run.stderr}`);
  assert(existsSync(marker), `the marker must be written to the EXACT hostile path, not a split prefix (${marker})`);
  equal(readFileSync(marker, "utf8").trim(), "victim: an arg ;touch SIDE_EFFECT; #", "recorded line");
  // Injection would land a file in the stub's working directory.
  deepEqual(readdirSync(home).filter((e) => e.startsWith("SIDE_EFFECT")), [], "no side-effect file may be created");
  deepEqual(readdirSync(bin).filter((e) => e.startsWith("SIDE_EFFECT")), [], "no side-effect file beside the stub");
  assert(!existsSync(join(REPO, "SIDE_EFFECT")), "no side-effect file in the repository");
});

check("every stub refuses and records a call the probe did not plan for", () => {
  // Runs before the stubs are used in anger, and resets the marker afterwards.
  // Without this, a stub whose allowed branch swallowed the fall-through would
  // look identical to one that was simply never called wrongly — which is how
  // the aw catch-all and the pi-only stub previously hid unplanned calls.
  for (const bin of ["aw", "pi", "tmux"]) {
    const run = spawnSync(join(FAKE_BIN, bin), ["unplanned-subcommand"], { encoding: "utf8", env: { PATH: BASE_PATH, HOME } });
    assert(run.status !== 0, `${bin} stub must fail an unplanned call, got exit ${run.status}`);
  }
  const recorded = existsSync(UNEXPECTED) ? readFileSync(UNEXPECTED, "utf8") : "";
  for (const bin of ["aw", "pi", "tmux"]) {
    assert(recorded.includes(`${bin}: unplanned-subcommand`), `${bin} stub must RECORD the unplanned call, log was:\n${recorded}`);
  }
  for (const bin of MUST_BE_OURS) {
    // The shadowing stub is load-bearing on hosts that ship the real binary:
    // if it ever stopped refusing, BASE_PATH would fall through to the host's.
    const run = spawnSync(join(DENY_BIN, bin), ["deny-probe-call"], { encoding: "utf8", env: { PATH: BASE_PATH, HOME } });
    assert(run.status !== 0, `the shadowing ${bin} stub must fail every call, got exit ${run.status}`);
    const log = existsSync(UNEXPECTED) ? readFileSync(UNEXPECTED, "utf8") : "";
    assert(log.includes(`${bin}: deny-probe-call`), `the shadowing ${bin} stub must RECORD the call, log was:\n${log}`);
  }
  rmSync(UNEXPECTED, { force: true });
});
mkdirSync(join(adopted, ".aw"), { recursive: true });

check("required spawn hook fails the spawn and rolls it back when aw is absent", () => {
  // pi is satisfied, aw is not: the identity cannot be minted, and an instance
  // that believes it is reachable by mail but is not must never start.
  const piOnly = shim(join(sandbox, "pi-only"), "pi", `if [ "$1" = "list" ]; then printf '  npm:@awebai/pi\\n      %s\\n' ${shq(PI_EXT)}; exit 0; fi`);
  const spawned = oasJson(["spawn", "probe-pi", "--purpose", "norequire", "--task", "probe", "--no-launch"],
    { cwd: adopted, path: `${dirname(piOnly)}:${BASE_PATH}`, expect: "fail" });
  equal(spawned.ok, false, "spawn must fail");
  assert(/aw CLI not on PATH|identity/i.test(spawned.error.message), `error must explain the identity failure: ${spawned.error.message}`);
  assert(!existsSync(join(adopted, "local-agents", "probe-pi", "instances", "probe-pi-norequire")),
    "a failed required hook must roll the instance home back");
});

let instanceHome;
check("spawn mints a team identity through the required hook", () => {
  const spawned = oasJson(["spawn", "probe-pi", "--purpose", "live", "--task", "probe", "--no-launch"], { cwd: adopted, path: FAKE_PATH });
  assert(spawned.ok, `spawn failed: ${JSON.stringify(spawned.error)}`);
  instanceHome = spawned.result.home || spawned.result.instanceHome || join(adopted, "local-agents", "probe-pi", "instances", "probe-pi-live");
  equal(spawned.result.launched, false, "a --no-launch spawn must scaffold only");
  const instance = readJson(join(instanceHome, "instance.json"));
  const meta = JSON.stringify(instance);
  assert(meta.includes(TEAM), `the minted team must be recorded in instance.json: ${meta.slice(0, 400)}`);
  assert(meta.includes("probe-pi-live"), "the alias is the instance name");
  assert(readFileSync(join(instanceHome, "TASK.md"), "utf8").includes("aweb identity"), "the spawn brief tells the instance it has messaging");
  const calls = readFileSync(AW_STATE, "utf8");
  assert(calls.includes("team join probe-invite-token --name probe-pi-live"), `the hook joins the team as the instance: ${calls}`);
  assert(!/claude plugin (install|marketplace)/.test(calls), "the hook must never install a runtime package itself");
});

check("retire self-deletes the identity and cleans the instance home", () => {
  // `oas retire --json` reports the retirement itself, not an ok/result envelope.
  const retired = oasJson(["retire", "probe-pi-live", "--force"], { cwd: adopted, path: FAKE_PATH });
  equal(retired.retired, "probe-pi-live", `retire did not run: ${JSON.stringify(retired)}`);
  deepEqual(retired.capabilityMeta["oas.aweb"], { retired: true }, "the retire hook reports a completed self-delete");
  assert(readFileSync(AW_STATE, "utf8").includes("workspace delete probe-pi-live"), "retire must self-delete the aweb workspace");
  equal(retired.removedDir, true, "the instance home is removed");
  assert(!existsSync(instanceHome), "the instance home is gone from disk");
});

check("no real credential store was read or written", () => {
  assert(!existsSync(join(HOME, ".aw")), "the probe HOME must stay free of aweb state");
  for (const dir of [sandbox]) assert(existsSync(dir), `${dir} vanished`);
});

check("no stub was invoked in a way the probe did not plan for", () => {
  // Runs last on purpose: any stub call outside the handled set appended here.
  const seen = existsSync(UNEXPECTED) ? readFileSync(UNEXPECTED, "utf8").trim() : "";
  equal(seen, "", `unexpected stub invocations:\n${seen}`);
});

console.log(results.join("\n"));
if (defects.length) console.log(`\nKNOWN KERNEL DEFECTS (recorded, not worked around):\n${defects.join("\n")}`);
console.log(`\n${failures ? `PROBE FAILED — ${failures} check(s)` : `probe passed — ${results.length} checks against kernel ${KERNEL_VERSION}`}`);
process.exit(failures ? 1 : 0);
