---
type: Reference
title: Capability materialization contract in released OAS 0.20.0
description: The package, capability-root, lock, trust and runtime rules observed in the published 0.20.0 kernel.
tags: [oas, packages, 0.20, contract, materialization]
timestamp: 2026-08-20
---

Verified in the oas.aweb release work by reading `lib/core.mjs` in the published `@oas-framework/oas@0.20.0` tarball and by driving the released CLI with the [released-CLI consumer probe](/playbooks/released-cli-consumer-probe-isolation.md).

# Rules observed

- Packages are transport. Acquisition stages the payload, materializes each capability flat into `.agents/capabilities/installed/<id>/`, writes the lock and discards staging; there is no persistent package store.
- A package must export at least one capability. Config-only and empty packages are rejected.
- A `"."` capability root is read compatibility only. The relevant discriminator is `configTemplates`, not deprecated `configs`: a manifest with `configTemplates` plus `"."` is rejected, while old packages with `"."` and no template spelling remain readable. Authoring should not emit `"."`.
- Canonical template paths are enforced as `config-templates/<contained path>` with no traversal, backslash or empty remainder. The deprecated `configs` spelling is exempt for old immutable tags; carrying both spellings is invalid.
- Self-containment is per capability root. Declared skills, agents, injections, commands and hooks must exist and realpath-resolve inside the capability's own root. Declared directory resources are walked so descendant symlinks cannot escape.
- Lock v2 requires both maps: `packages` for transport (`source`, `path`, `version`, `commit`, `integrity`, `dependencies`) and `capabilities` for materialized entities (`version`, `package`, `path`, `integrity`, `trusted`). The transitional package-root spelling is rejected, not converted.
- Trust binds to materialized artifact integrity. The artifact includes generated `.oas-installation.json` and any `node_modules` closure, which is why no capability-level dependency digest exists.
- Generated artifacts are ignored inside the transaction. In a Git scope, the kernel writes `.agents/capabilities/.gitignore` with `installed/` before touching artifacts or locks, and fails the operation if it cannot. `.agents/config-templates/adopted/` is not ignored because it is meant to be committed.
- Runtime package requirements are consented once and verified before spawn. The kernel raises `E_RUNTIME_RESOURCE_MISSING` at spawn and prints an `oas install --accept-requirement <runtime>:<spec>` remedy; a hook must not install one itself.
- Launch metadata is the frozen integration point. A spawn hook may return `{ launch: { claude: "<args>" } }`; the kernel splices it into the launch command in `instance.json`. For Claude, the kernel inserts `--` before task text because those flags can be variadic.

# Provenance is part of the artifact

Acquiring identical payload bytes by path and by Git can still produce different capability integrity because `.oas-installation.json` records source, commit and package path. Executable trust therefore does not transfer across acquisition sources. Treat content equality plus integrity inequality as the expected trust boundary, not as a defect.
