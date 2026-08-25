---
type: Lesson
title: A normalized value is not an input spelling
description: Normalized lock/state values may be rejected as user input, so documented commands must be parsed by the kernel contract they claim.
tags: [oas, docs, contract, acquisition, git, probe]
timestamp: 2026-08-20
---

A documented command is not proven by seeing the same string in a lockfile or state file. In the oas.aweb release work, the README documented:

```sh
oas install git:https://github.com/OAS-Framework/oas-aweb.git@v2.0.0
```

Released `@oas-framework/oas@0.20.0` rejected that spelling with `invalid-source`: `git shorthand must be git:host/org/repo[@ref][#<path>]`. The string looked authoritative because the kernel itself normalizes several accepted inputs to `git:https://github.com/ORG/REPO.git@v2.0.0` in the lock and `.oas-installation.json`, but that canonical output is not itself accepted input.

Accepted input spellings observed from `parsePackageSource` were:

```text
https://github.com/ORG/REPO.git@v2.0.0
git:github.com/ORG/REPO@v2.0.0
oas.aweb
```

Treat normalization as a one-way funnel: many accepted inputs can collapse to one canonical output, and the output need not belong to the accepted-input set. Do not copy a normalized value into user documentation as a command.

# Contract check

For every documented command, flag or config key that is part of the package contract, run the relevant released-kernel parser over the documented spelling. For install commands, extract the `oas install` spec from the README and call the kernel's parser; this is a cheap, network-free gate that fails on the drift itself instead of a downstream symptom.

# Pinned-Git checks

A local-path source locks `commit: "local"` and `path: "."`, so it cannot prove Git-source behavior. To prove a pinned Git install, acquire from a throwaway origin over `file://` at an exact commit, then advance the branch past the pin before asserting. The assertions that mattered were: install succeeds, selected path is the default `oas-package`, locked commit equals the pin and differs from the moved HEAD, and the normalized source is `git:` rather than `path:`.

The same payload acquired by path and by Git differs in `.oas-installation.json`, so the materialized integrity differs and executable trust does not transfer across acquisition sources. That is part of the [capability materialization contract](/references/capability-materialization-contract-0.20.md), not a defect.
