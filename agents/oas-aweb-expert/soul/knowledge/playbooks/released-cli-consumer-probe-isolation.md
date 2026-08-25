---
type: Playbook
title: Released-CLI consumer probe isolation
description: How to prove a capability package against a released OAS CLI in a sandbox whose verdicts do not depend on the developer machine.
tags: [oas, testing, probe, isolation, ci]
timestamp: 2026-08-20
---

Use this shape when a capability package must be proven against a released OAS CLI rather than the checkout under development. oas.aweb implemented the pattern in `scripts/consumer-probe.mjs`; the details below are the durable isolation rules, not a transcript of that file.

# Build isolation by construction

- Create one temporary sandbox and copy the package payload into it. The probe must not mutate the tree it validates.
- Use a synthetic `HOME`, so no real pi settings, Claude config or `.aw` workspace is read or written.
- Use a node-only executable directory rather than the real Node directory from nvm. In nvm layouts, host CLIs such as `aw`, `pi` and `claude` can live beside `node`, so adding that directory to `PATH` keeps them findable. Symlink only `node` into an empty dir.
- Split controlled executables by requirement:
  - **Must be absent** when absence is what the check measures, such as missing messaging CLI or runtime requirements.
  - **Must be ours** when the kernel legitimately runs the executable, such as `tmux` during retire. Shadow these with refusing stubs placed before system directories and assert `command -v` resolves to the stub.
- Aggregate any PATH-control failures and abort before the first package check. An isolation failure is not a test result.

For released OAS 0.20, executables observed as relevant included `git`, `cp`, `npm`, `pi`, the Claude binary, the declared runtime resolved by `which(runtime)`, `tmux` and `sh` because the kernel's `which()` uses `execSync("command -v …")`.

# Stubs fail closed

A stub must explicitly handle the calls the probe plans, then record and fail every other invocation. Avoid both a catch-all branch that exits before the recorder and an unconditional `exit 0` after a narrow `if`; either shape can turn unplanned calls into silence.

Self-test each stub before use by invoking it with an argument the probe never plans for, asserting nonzero status and checking the unexpected-call marker names that stub. Reset the marker afterwards. Keep the final marker-empty assertion as the last check.

Fake host CLIs can still satisfy planned calls. In oas.aweb, a fake `aw` answering `team list/invite/join`, `init` and `workspace delete`, plus call logging, was enough to drive real spawn and retire behavior without touching the host identity.

# Parse released CLI JSON defensively

`oas <cmd> --json` output shapes are not uniform in 0.20. `install`, `init` and `spawn` emit a one-line `{schemaVersion, ok, result|error}` envelope; `doctor` emits a pretty-printed object without `ok`; `retire` emits a bare object. Parse stdout by scanning for the last suffix that parses as JSON, not by assuming a last line or a shared envelope.

# Assert the positive fact

Do not infer scaffold-only behavior from missing tmux launch calls. Assert the direct spawn result, for example `launched: false`, and let the tmux stub separately prove no forbidden session creation occurred.

# Generated shell is an injection surface

If the harness writes `/bin/sh` stubs, every dynamic value interpolated into shell text must be POSIX single-quoted, including marker paths, call logs and fixture paths. Sandbox paths descend from `TMPDIR`, which is environment-controlled; with an unquoted path, `TMPDIR=/tmp/x;touch OWNED;#` can turn the generated stub into a command injection.

Test the real generator, not a parallel copy: build hostile stubs through the same factory used by the probe, put an apostrophe in hostile paths, and assert both that the marker exists at the exact path and that no side-effect file appears. Mutate per sink and per spelling; "the quoting is tested" is only true for covered sinks. This has the same fixture discipline as [portability lints](/lessons/portability-lint-by-class.md).

# Probe-specific OAS observations

- `doctor` lists a capability under `capabilities` only when a config activates it. In an install-only scope, integrity drift appears under `packages[].problems` with code `integrity-drift`.
- A bare `oas install` restore returns the artifact to the locked integrity, so trust can survive tamper-then-restore. Trust resets on update/source change.
- Fake `pi list --no-approve` output needs a two-space-indented `source` followed by a four-or-more-space-indented install path; a missing path line means configured but not installed.
- Run the released-kernel probe as its own CI job if it needs network access to fetch the published kernel while the ordinary package test suite must remain offline-clean.

Break each guard deliberately before trusting it: plant a stray binary on the probe PATH, flip the `launched` expectation, remove a handled stub case, and turn shell quoting into a no-op. A guard not seen to fail is not evidence.
