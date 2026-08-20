import assert from "node:assert/strict";
import test from "node:test";
import { parseYamlSubset } from "../scripts/lib/yaml-subset.mjs";

// The gate validates the shipped config template against the config schema with
// this parser. It must fail LOUDLY on anything it does not fully understand:
// silently mis-parsing a deployment config would let an invalid template ship
// as if it had been checked.

test("parses the block mappings, sequences, scalars and comments a config uses", () => {
  const parsed = parseYamlSubset(`# leading comment
name: demo            # trailing comment
team:
  name: my-team
capabilities:
  layers:
    messaging:
      capability: oas.aweb
      global: true
      agent-types:
        - developer
        - reviewer
`);
  assert.deepEqual(parsed, {
    name: "demo",
    team: { name: "my-team" },
    capabilities: { layers: { messaging: { capability: "oas.aweb", global: true, "agent-types": ["developer", "reviewer"] } } },
  });
});

test("keeps a '#' inside a quoted scalar", () => {
  assert.deepEqual(parseYamlSubset(`name: "a # b"`), { name: "a # b" });
});

test("reads booleans, null and numbers as their own types", () => {
  assert.deepEqual(parseYamlSubset("a: true\nb: false\nc: null\nd: ~\ne: 3\nf: 1.5\ng: text"), {
    a: true, b: false, c: null, d: null, e: 3, f: 1.5, g: "text",
  });
});

test("an empty key with no indented block is null, not an empty map", () => {
  assert.deepEqual(parseYamlSubset("knowledge:\n"), { knowledge: null });
});

for (const [label, source] of [
  ["flow collections", "a: [1, 2]"],
  ["flow mappings", "a: {b: 1}"],
  ["block scalars", "a: |\n  text"],
  ["anchors", "a: &anchor 1"],
  ["aliases", "a: *anchor"],
  ["tags", "a: !!str 1"],
  ["document markers", "---\na: 1"],
  ["directives", "%YAML 1.2\na: 1"],
  ["tab indentation", "a:\n\tb: 1"],
  ["duplicate keys", "a: 1\na: 2"],
  ["unterminated quotes", 'a: "open'],
  ["a line that is not a mapping", "just text"],
]) {
  test(`rejects ${label} rather than guessing`, () => {
    assert.throws(() => parseYamlSubset(source), /line \d+:/);
  });
}
