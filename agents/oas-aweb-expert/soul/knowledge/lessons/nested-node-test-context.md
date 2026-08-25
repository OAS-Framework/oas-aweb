---
type: Lesson
title: Nested node test runners can become silent false greens
description: A `node --test` child spawned from inside a Node test must not inherit `NODE_TEST_CONTEXT`.
tags: [node, testing, gates, ci, false-green]
timestamp: 2026-08-20
---

Node sets `NODE_TEST_CONTEXT=child-v8` inside test processes. A child process spawned from such a test inherits the variable. If that child is itself `node --test`, it can report to a parent test runner that is not listening: observed on Node v22.21.1, a deliberately failing nested suite exited 0 with empty stdout when the variable was inherited.

Observed outcomes for a nested `node --test` child were:

```text
env inherited, FAILING suite : status=0  stdout=0 bytes
var deleted,   FAILING suite : status=1  stdout=1169 bytes
var deleted,   PASSING suite : status=0  stdout=222 bytes
env inherited, PASSING suite : status=0  stdout=0 bytes
```

Delete the variable before spawning a nested test runner:

```js
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
```

# Scope

The variable was inert for a plain Node child: a script setting a nonzero exit code still reported that status while `NODE_TEST_CONTEXT` was present. The audit question is therefore transitive: not just "does this test spawn `node --test`?" but "can any child of any test, at any depth, become a test runner?"

If a harness already has paired accept/reject fixtures that assert nonzero child exits, those assertions are useful regression coverage for this class. A proposed extra guard against future in-test `--test` spawning was deliberately left as follow-up in the source work because it protected a hypothetical refactor rather than a current release defect.
