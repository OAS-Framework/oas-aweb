---
type: Lesson
title: Config validators must mirror the kernel reader
description: A package gate for `oas-config.yaml` should reproduce the released kernel reader and refuse constructs it silently misreads.
tags: [oas, validation, yaml, config-templates, review]
timestamp: 2026-08-20
---

When a package validates a shipped `oas-config.yaml`, faithfulness to the consumer's reader matters more than supporting more YAML. A stricter general YAML subset parser can still bless a template that the released OAS kernel reads differently.

Observed against released `@oas-framework/oas@0.20.0` (`parseYamlNested` / `yamlScalar`):

| source | kernel | general parser |
| --- | --- | --- |
| `agent-types:` + `  - developer` | `{}` | `["developer"]` |
| `agent-types: [developer]` | `["developer"]` | rejected |
| `name: "a # b"` | `"a"` | `"a # b"` |
| `knowledge:` | `{}` | `null` |

The dangerous case is a template that validates as populated while the kernel reads it as empty. In oas.aweb, the fix was to reproduce the kernel's parser semantics and add a refusal layer over constructs the kernel skips or reads as ordinary text: block sequences, block scalars, anchors, aliases, tags, document markers, directives, tabs, inconsistent indentation, duplicate keys and non-comment lines that are not `key: value`.

# Refusal and visibility holes

Parity alone was not enough. Review found cases where the gate and kernel agreed on the resulting object, but the validator could not see what mattered:

- Check for block sequence syntax before attempting the key regex; a line such as `- developer:` can otherwise become a literal key.
- Refuse `__proto__` in every assignment path, because assigning it mutates the object prototype instead of creating an own key.
- In schema evaluation, use `Object.hasOwn` for property dispatch and required-key checks. `key in obj` and bare property access make inherited names such as `constructor` visible when they were not supplied.

The `constructor` class also appeared in the released kernel diagnostic defect recorded in [known OAS 0.20.0 kernel defects](/references/kernel-defects-0.20.md). Do not confuse the fixes: refusing `__proto__` handles assignment semantics; `Object.hasOwn` handles lookup semantics.

# Rule

For a validator that protects someone else's consumer, reproduce the consumer's semantics and pin agreement by running both on the same corpus. Then separately ask what the validator can see of the parsed result. A validator more capable than its consumer creates false confidence; a validator that enumerates with prototype-chain lookups creates blind spots.
