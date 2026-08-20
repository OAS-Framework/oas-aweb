---
type: Lesson
title: A silent reviewer is not an approval
description: A spawned reviewer that never reports must be checked for liveness before its silence is treated as a gate result.
tags: [oas, review, process, delivery, gates]
timestamp: 2026-08-20
---

A successful reviewer spawn is not a review result. During one delivery, four post-commit reviewers (`reviewer-895d25f`, `reviewer-d1016ff`, `reviewer-baa5437`, `reviewer-24982bd`) were reported as spawned by the CLI and then produced no verdict. In the last case, no instance home or tmux window remained afterwards.

The failure mode is quiet: waiting is normally the correct behavior for a live reviewer because the messaging layer should wake the source agent. A reviewer that died can look the same as one still working, and it is tempting to treat no red signal as consent.

# Checks before treating silence as anything

Confirm all available evidence:

```sh
oas status
ls <deployment>/local-agents/reviewer/instances
tmux list-windows -t pi-agents
aw mail inbox --show-all
```

`aw mail inbox` without `--show-all` lists unread mail only, so a delivered verdict that is already marked read can otherwise look absent.

# Recovery

Spawn a new reviewer on the same commit with a distinct purpose suffix, for example `--purpose <sha>-r2`. A vanished reviewer has nothing to resume or query. The task text for the replacement should state that the verdict must be mailed even when nothing is found, and that a prior reviewer on the commit went silent.

The general gate lesson matches test harness false-greens: absence of a red signal is not a green signal. See [nested node test runners can become silent false greens](/lessons/nested-node-test-context.md).
