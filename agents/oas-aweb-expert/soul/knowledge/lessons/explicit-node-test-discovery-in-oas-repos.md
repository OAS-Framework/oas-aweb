---
type: Lesson
title: Bare node test discovery is unsafe in OAS repo roots
description: Recursive `node --test` discovery can sweep agent worktrees into a package suite unless test files are listed and guarded explicitly.
tags: [oas, testing, ci, discovery]
timestamp: 2026-08-20
---

`node --test` with no file list discovers tests recursively from the repository root. In an OAS development checkout, the root can also contain `agents/<soul>/instances/<id>/work/test/**` from live agent worktrees. If those paths are not ignored, the package suite depends on which agent worktrees exist on the machine running it.

This was demonstrated in oas.aweb by planting `agents/oas-aweb-expert/instances/sentinel-instance/work/test/sentinel.test.mjs`: the suite count increased by one, and `git check-ignore` confirmed the sentinel file was not ignored.

# Rule

List every suite explicitly in `package.json`, for example:

```json
"test": "npm run validate && node --test test/a.test.mjs test/b.test.mjs"
```

Then pin the rule with a regression that fails if any script invokes bare `node --test`, and separately asserts that the named set equals the `test/*.test.mjs` files on disk. The second assertion prevents explicit listing from silently omitting a newly added suite.

Verify the guard by deliberately reverting to a bare runner and by adding an unregistered test file; both mutations must fail.
