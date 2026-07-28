import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = join(REPO, "oas-package");
const CAPABILITY = join(ROOT, "capabilities", "oas-aweb");
const HOOK = join(CAPABILITY, "bin", "oas-aweb.mjs");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "oas-aweb-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakePath(t, body = "exit 97") {
  const bin = join(tempDir(t), "bin");
  mkdirSync(bin);
  const aw = join(bin, "aw");
  writeFileSync(aw, `#!/bin/sh\n${body}\n`);
  chmodSync(aw, 0o755);
  return bin;
}

function run(args = [], env = {}, cwd = ROOT) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [HOOK, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

test("manifest resolves the three vendored Agent Skills by expected names", () => {
  const manifest = JSON.parse(readFileSync(join(CAPABILITY, "oas.json"), "utf8"));
  const expected = ["aweb-messaging", "aweb-team-membership", "aweb-identity"];
  assert.deepEqual(manifest.skills, expected.map((name) => `skills/${name}`));
  for (const name of expected) {
    const skill = readFileSync(join(CAPABILITY, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(skill, /description:/);
  }
});

test("manifest declares the aligned requirements and a required spawn hook", () => {
  const manifest = JSON.parse(readFileSync(join(CAPABILITY, "oas.json"), "utf8"));
  // Host CLI requirement plus the two runtime-scoped channel requirements —
  // pi (npm) and Claude (marketplace plugin) — never installed at spawn.
  const aw = manifest.requires.find((r) => r.command === "aw");
  assert.ok(aw, "the aw host CLI stays a consented requirement");
  const pi = manifest.requires.find((r) => r.runtime === "pi");
  assert.equal(pi?.package, "npm:@awebai/pi");
  const claude = manifest.requires.find((r) => r.runtime === "claude");
  assert.equal(claude?.package, "aweb-channel@awebai-marketplace");
  assert.equal(claude?.marketplace, "awebai/claude-plugins");
  // Only the spawn hook is required (messaging is the whole point); retire is a
  // plain string. The schema forbids `required` on retire.
  assert.equal(manifest.hooks.spawn.required, true);
  assert.equal(typeof manifest.hooks.retire, "string");
});

test("package has no npm runtime dependency closure", () => {
  const foundLocks = [];
  const foundModules = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === "package-lock.json") foundLocks.push(path);
      if (entry.name === "node_modules") foundModules.push(path);
      if (entry.isDirectory()) walk(path);
      if (entry.name === "package.json") {
        const pkg = JSON.parse(readFileSync(path, "utf8"));
        for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
          assert.equal(pkg[field], undefined, `${path} contains ${field}`);
        }
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(foundLocks, []);
  assert.deepEqual(foundModules, []);
});

test("vendored skills carry exact upstream provenance and MIT license", () => {
  const vendored = readFileSync(join(CAPABILITY, "skills", "VENDORED.md"), "utf8");
  const license = readFileSync(join(CAPABILITY, "skills", "LICENSE"), "utf8");
  const sync = readFileSync(join(REPO, "scripts", "sync-vendored-skills.mjs"), "utf8");
  for (const value of ["pi-v0.2.3", "812bdeb1be8ed99dbd339a910a153e7b802501d4", "https://github.com/awebai/aweb.git"]) {
    assert.ok(vendored.includes(value));
    assert.ok(sync.includes(value));
  }
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2025 Juan Reyero/);
});

test("declared commands and hooks have no npm package imports", () => {
  const manifest = JSON.parse(readFileSync(join(CAPABILITY, "oas.json"), "utf8"));
  const entrypointOf = (spec) => (typeof spec === "string" ? spec : spec.command);
  const commands = [
    ...Object.values(manifest.commands || {}),
    ...Object.values(manifest.hooks || {}).map(entrypointOf),
  ];
  const entrypoints = new Set(commands.map((command) => command.trim().split(/\s+/)[0]));
  assert.ok(entrypoints.size > 0);
  for (const entrypoint of entrypoints) {
    const source = readFileSync(join(CAPABILITY, entrypoint), "utf8");
    assert.doesNotMatch(source, /node_modules|from ["']@awebai|require\(["']@awebai/);
    // Host CLI calls go through execFile/argv, never a shell string (no
    // execSync, no `command -v`), so hostile team names, aliases, or tokens can
    // never be interpolated into a command.
    assert.match(source, /execFileSync/);
    assert.doesNotMatch(source, /\bexecSync\b/);
    assert.match(source, /aw team|aw workspace|aw id team/);
    // The Claude channel plugin is a DECLARED, consented runtime requirement —
    // the hook must never imperatively install it (or add a marketplace) at spawn.
    assert.doesNotMatch(source, /claude plugin (install|marketplace)/);
  }
});

test("spawn is fatal when aw is absent (required-hook contract)", async (t) => {
  const home = tempDir(t);
  const result = await run(["spawn"], {
    PATH: tempDir(t),
    OAS_EVENT: "spawn",
    OAS_HOME: home,
    OAS_INSTANCE: "developer-api-1",
  }, home);
  // A required spawn hook that cannot mint an identity must fail the spawn:
  // an instance that believes it can be woken by mail and cannot is worse than
  // one that never started.
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(JSON.parse(result.stdout).warning, /aw CLI not on PATH/);
});

test("authority discovery does not walk above the workspace", async (t) => {
  const outer = tempDir(t);
  const workspace = join(outer, "workspace");
  const home = join(workspace, "agents", "example", "instances", "example-1");
  mkdirSync(join(outer, ".aw"));
  mkdirSync(home, { recursive: true });
  const result = await run(["spawn"], {
    PATH: fakePath(t),
    OAS_EVENT: "spawn",
    OAS_HOME: home,
    OAS_INSTANCE: "example-1",
    OAS_CONTEXT: workspace,
    OAS_WORKSPACE: workspace,
    OAS_TEAM_SCOPE: workspace,
  }, home);
  // Bounded discovery finds no `.aw` within the workspace, so no identity can be
  // minted — fatal for a required spawn hook.
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(JSON.parse(result.stdout).warning, /no initialized aweb root/);
});

test("roster guidance uses the required --to recipient flag", async (t) => {
  const root = tempDir(t);
  mkdirSync(join(root, ".aw"));
  const result = await run(["roster"], {
    PATH: fakePath(t, `printf '%s\\n' '{"team_id":"default:test","members":[]}'`),
    OAS_EVENT: "roster",
    OAS_HOME: root,
    OAS_TEAM_SCOPE: root,
    OAS_TEAM_ID: "default:test",
  }, root);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /aw mail send --to <alias>/);
  assert.doesNotMatch(result.stdout, /aw mail send <alias>/);
});

test("retire without persisted identity is an idempotent no-op", async (t) => {
  const home = tempDir(t);
  const result = await run(["retire"], {
    PATH: fakePath(t),
    OAS_EVENT: "retire",
    OAS_HOME: home,
    OAS_META: "{}",
  }, home);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { meta: { retired: false, reason: "nothing-to-delete" } });
});
