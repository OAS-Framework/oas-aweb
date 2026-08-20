---
type: Reference
title: Known released OAS 0.20.0 kernel defects
description: Two released-kernel diagnostic defects preserved as evidence, with the ruling to avoid package workarounds.
tags: [oas, 0.20, defect, doctor, config]
timestamp: 2026-08-20
---

These defects were observed against released `@oas-framework/oas@0.20.0` during oas.aweb package validation. The package-side ruling was to preserve exact evidence in the consumer probe and avoid package workarounds. A package gate may assert the artifact it owns and record the released kernel's defective diagnostic, but should not reshape a correct package to silence the defect.

# Doctor falsely reports a locked capability as orphaned

In a scope where the capability is materialized, `oas doctor` printed:

```text
WARNING: oas.aweb at <scope>/.agents/capabilities/installed/oas.aweb is in
installed/ but has no lock entry — reacquire it or move it to owned/
```

The same scope's `oas-lock.json` did contain `capabilities["oas.aweb"]` with version, package, path, integrity and trusted. The warning reproduced from a clean `oas init --package <path>` scope, so it was not adopted-state residue. The likely failure is that the orphan detector reads the legacy v1 capability-lock shape rather than the v2 `capabilities` map.

Handling in the probe: assert the lock entry is present, record the warning verbatim under `KNOWN KERNEL DEFECTS`, and separately assert that no other unexpected warning appears.

# Config key named after Object.prototype member garbles the error

In `lib/core.mjs`, `validateConfigShape` checks renamed keys with a prototype-chain lookup:

```js
if (RENAMED_CONFIG_KEYS[key]) throw new Error(`unsupported oas-config key "${key}" in ${file} — ${RENAMED_CONFIG_KEYS[key]}`);
```

A config containing `constructor: anything` is rejected, but the diagnostic includes the inherited function:

```text
Error: unsupported oas-config key "constructor" in <path> — function Object() { [native code] }
```

This is a diagnostic-quality defect rather than a config acceptance hole: the kernel exits 1. It is still useful evidence because the same prototype-chain class can recur in validators; see [config validators must mirror the kernel reader](/lessons/config-validator-kernel-reader.md).

Handling in the probe: record the released-kernel error text as known evidence while the package gate asserts the behavior the package owns, namely that the template is rejected before the defective downstream diagnostic matters.
