---
type: Lesson
title: Parity claims need asymmetric fixtures
description: When the kernel treats resource kinds differently, validator parity needs fixtures for both the rejecting and accepting branch.
tags: [oas, 0.20, validation, self-containment, parity]
timestamp: 2026-08-20
---

Released `@oas-framework/oas@0.20.0` self-containment treats `agents[]` and `skills[]` differently. In `assertCapabilitySelfContained`, a declared `agents[]` entry must be a directory, while a declared `skills[]` entry may be a single file and is simply not walked as a directory.

A validator that collapses both resource kinds to "walk it if it is a directory" wrongly accepts a file under `agents[]`. A validator that reacts by requiring both kinds to be directories breaks legitimate single-file skills. The asymmetry is the contract.

# Coverage rule

Pin both directions:

- `agents: ["thing.md"]` against a real file is rejected by the repo gate and by the released kernel.
- `skills: ["thing.md"]` against a real file is accepted by the repo gate and by the released kernel.

oas.aweb's validator already implemented the asymmetry, but initially had no fixture for either branch and the shipped capability declared no `agents[]`, so a future refactor could have collapsed the branches unnoticed. The hole was closed with manifest fixtures plus a consumer-probe parity check that runs the same cases through the released kernel. Mutation-proving by collapsing the branches made both the probe check and one manifest test fail.

The general lesson is that "parity" is not a single happy-path claim. When the consumer is asymmetric, coverage must preserve the asymmetry explicitly.
