import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Bare `node --test` DISCOVERS recursively from the repository root. In a real
// OAS development checkout that root also holds `agents/<soul>/instances/<id>/
// work/test/**` — other agents' worktrees, which are not this package's tests
// and are not even gitignored here. A green suite would then depend on which
// agent worktrees happen to exist on the machine that ran it, and a clean
// clone's count would prove nothing about the live repository.
//
// So every runner names its files explicitly, and this suite pins that: the
// script cannot regress to bare discovery, and the named set must be exactly
// the suites on disk — otherwise adding a test file would silently not run it.

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scripts = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts;

/** Every `node --test ...` invocation in a script, with the arguments it names. */
function testInvocations(script) {
  return String(script).split("&&").map((s) => s.trim()).filter((s) => /(^|\s)node\s+--test(\s|$)/.test(s))
    .map((s) => s.replace(/^.*?node\s+--test\s*/, "").trim())
    .map((args) => (args ? args.split(/\s+/) : []));
}

test("no script invokes bare `node --test` recursive discovery", () => {
  for (const [name, script] of Object.entries(scripts)) {
    for (const args of testInvocations(script)) {
      assert.notDeepEqual(args, [], `script "${name}" runs bare \`node --test\`, which would sweep in other agents' worktrees`);
      for (const arg of args) {
        assert.match(arg, /^test\/[\w-]+\.test\.mjs$/, `script "${name}" must name explicit test files, got ${JSON.stringify(arg)}`);
      }
    }
  }
});

test("the aggregate test script runs exactly the suites present on disk", () => {
  const named = testInvocations(scripts.test).flat().sort();
  const onDisk = readdirSync(join(REPO, "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => `test/${f}`).sort();
  assert.deepEqual(named, onDisk, "a new suite must be registered in the test script, and a removed one dropped from it");
  assert.ok(named.length > 0, "there must be suites to run");
});
