# Schema status

Both items that previously blocked publication are **resolved** by the released
`@oas-framework/oas@0.20.0` consumer contract (tag `v0.20.0`,
`1e73257da9ee03a9d9a18a93fe5f410f9d22bc18`). This package targets that contract
and declares the floor `>=0.20.0`.

## Vendored schemas — verified against the release

`schemas/oas-package.schema.json`, `schemas/capability-manifest.schema.json`,
`schemas/oas-lock.schema.json`, and `schemas/oas-config.schema.json` are
byte-identical to `docs/` in the published `@oas-framework/oas@0.20.0` tarball.
`npm run validate` checks both manifests and the shipped config template
against them; `npm run probe` re-checks the same payload with the released
kernel itself, so a drift between the vendored copies and the engine cannot
pass silently.

## Runtime channel resources — contract frozen (was: strict-curriculum block)

0.20 froze the runtime-resource contract, so the "development materialization"
this file used to describe is gone:

- the capability manifest declares the pi extension (`npm:@awebai/pi`) and the
  Claude plugin (`aweb-channel@awebai-marketplace`, marketplace
  `awebai/claude-plugins`) as **runtime package requirements**;
- consent is explicit and separate — `oas install --accept-requirement
  claude:aweb-channel@awebai-marketplace` — and the kernel verifies the package
  is really installed and enabled **before** a spawn on that runtime, failing
  closed otherwise;
- the `spawn` hook prepares identity only and returns **structured launch
  metadata** (`launch.claude`) for the kernel to place in the launch command. It
  never runs `claude plugin marketplace add` or `claude plugin install`, and the
  package test suite asserts that those strings appear nowhere in an executable
  entrypoint.

`npm run probe` exercises both halves against the released kernel: an
unsatisfied Claude or pi requirement fails the spawn with the exact
`--accept-requirement` remedy, and a satisfied one spawns, mints, and retires.

## Runtime closure

No runtime dependency manifest, npm lock, or `node_modules` exists in the
package, so there is no materialized closure and no `depsIntegrity` to record.
GHSA-mh99-v99m-4gvg remains outside this package's source and runtime closure.
The original `@awebai/pi` npm closure was superseded because its direct
`@awebai/aw` dependency carries an install script and platform-specific optional
binaries, which v1 platform-invariance forbids. The three required MIT skill
trees are reviewed, package-owned resources synchronized from
`https://github.com/awebai/aweb.git`, tag `pi-v0.2.3`, commit
`812bdeb1be8ed99dbd339a910a153e7b802501d4`;
`capabilities/oas-aweb/skills/VENDORED.md`, the upstream `LICENSE`, and
`scripts/sync-vendored-skills.mjs` preserve that provenance.

## Known kernel defect (no package workaround)

On released 0.20.0, `oas doctor` warns that the materialized capability
"is in installed/ but has no lock entry" even though the v2 lock records it
under `capabilities`. Per maintainer ruling this is a kernel defect: the package
adds no workaround, and `npm run probe` records the exact warning alongside the
lock entry that disproves it, under `KNOWN KERNEL DEFECTS`.
