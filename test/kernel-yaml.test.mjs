import assert from "node:assert/strict";
import test from "node:test";
import { parseKernelYaml } from "../scripts/lib/kernel-yaml.mjs";

// The gate validates the shipped config template against the config schema with
// this parser, so it must agree with the kernel's reader on everything it
// accepts and refuse everything the kernel would silently drop or reinterpret.
// Parity against the RELEASED kernel is asserted for real in
// scripts/consumer-probe.mjs; these are the offline expectations.

test("parses the nested block mappings and comments a config uses", () => {
  assert.deepEqual(parseKernelYaml(`# leading comment
name: demo            # trailing comment
team:
  name: my-team
capabilities:
  layers:
    messaging:
      capability: oas.aweb
      global: true
`), {
    name: "demo",
    team: { name: "my-team" },
    capabilities: { layers: { messaging: { capability: "oas.aweb", global: true } } },
  });
});

test("lists are the kernel's inline form, which parses identically", () => {
  assert.deepEqual(parseKernelYaml("agent-types: [developer, reviewer]"), { "agent-types": ["developer", "reviewer"] });
  assert.deepEqual(parseKernelYaml("settings: {retries: 2, mode: fast}"), { settings: { retries: 2, mode: "fast" } });
});

test("a key with no value is an empty MAP, matching the kernel", () => {
  // Not null: the kernel opens a block and leaves {} behind when nothing nests
  // under it, and the schema sees that difference.
  assert.deepEqual(parseKernelYaml("knowledge:\n"), { knowledge: {} });
});

test("scalars coerce exactly as the kernel coerces them", () => {
  assert.deepEqual(parseKernelYaml("a: true\nb: FALSE\nc: null\nd: ~\ne: 3\nf: 1.5\ng: text\nh: 'quoted'"), {
    a: true, b: false, c: null, d: null, e: 3, f: 1.5, g: "text", h: "quoted",
  });
});

test("an inline '#' is stripped even inside quotes, as the kernel strips it", () => {
  // Faithfulness beats correctness here: a validator that preserved "a # b"
  // would bless a value the deployment never sees.
  assert.deepEqual(parseKernelYaml('name: "a # b"'), { name: "a" });
  assert.deepEqual(parseKernelYaml("name: a # b"), { name: "a" });
  assert.deepEqual(parseKernelYaml('name: "a: b"'), { name: "a: b" });
});

for (const [label, source, pattern] of [
  ["block sequences", "agent-types:\n  - developer\n", /block sequences are dropped/],
  ["bare sequence items", "- developer\n", /block sequences are dropped/],
  // `- developer:` satisfies the kernel's key regex, so checking for a sequence
  // only after that match let it through as a key named "- developer".
  ["mapping-valued sequence items", "agent-types:\n  - developer:\n", /block sequences are dropped/],
  ["empty sequence items", "agent-types:\n  -\n", /block sequences are dropped/],
  ["__proto__ keys", "__proto__:\n  capabilities: x\n", /not a usable config key/],
  ["quoted __proto__ keys", '"__proto__": 1', /not a usable config key/],
  ["nested __proto__ keys", "team:\n  __proto__: x\n", /not a usable config key/],
  ["__proto__ inside a flow map", "settings: {__proto__: x}", /not a usable config key/],
  ["block scalars", "a: |\n  text", /block scalars/],
  ["anchors", "a: &anchor 1", /anchors/],
  ["aliases", "a: *anchor", /aliases/],
  ["tags", "a: !!str 1", /tags/],
  ["document markers", "---\na: 1", /document markers/],
  ["directives", "%YAML 1.2\na: 1", /directives/],
  ["tab indentation", "a:\n\tb: 1", /tabs/],
  ["duplicate keys", "a: 1\na: 2", /duplicate mapping key/],
  ["stray lines", "just text", /not a "key: value" pair/],
  ["inconsistent indentation", "a:\n  b: 1\n   c: 2\n", /inconsistent indentation/],
]) {
  test(`rejects ${label} rather than blessing what the kernel drops`, () => {
    assert.throws(() => parseKernelYaml(source), pattern);
  });
}

test("a __proto__ key would hide an entire config from an enumerating validator", () => {
  // The reason it is refused rather than parsed: both readers produce an object
  // with NO own properties, so a schema walk sees an empty document — while
  // `cfg.capabilities` still resolves, off the prototype.
  const smuggled = "__proto__:\n  capabilities:\n    layers:\n      messaging: none\n";
  assert.throws(() => parseKernelYaml(smuggled), /not a usable config key/);
  const naive = {};
  naive.__proto__ = { capabilities: { layers: { messaging: "none" } } };
  assert.deepEqual(Object.keys(naive), [], "own keys are empty, which is what fooled the gate");
  assert.equal(naive.capabilities.layers.messaging, "none", "yet the value reads back through the prototype");
});

test("keys that merely look dangerous become ordinary OWN properties", () => {
  // Only __proto__ has the setter behaviour. Assigning these creates own
  // properties, so the parser keeps them (kernel parity) and it is the schema
  // layer's job to reject the ones the config schema does not define — see the
  // manifest-gate regression for a root `constructor` key.
  const parsed = parseKernelYaml("constructor: a\nprototype: b");
  assert.deepEqual(Object.keys(parsed), ["constructor", "prototype"], "visible to any own-property walk");
  assert.equal(parsed.constructor, "a");
  assert.deepEqual(parseKernelYaml("a: -3"), { a: -3 }, "a negative scalar is not a sequence item");
});
