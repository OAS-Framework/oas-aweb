---
type: Lesson
title: Portability lints must classify path classes, not remembered roots
description: Template portability checks need structural path classification across values, keys and comments rather than a list of familiar roots.
tags: [oas, config-templates, portability, validation, review]
timestamp: 2026-08-20
---

A distributed `config-templates/*/oas-config.yaml` is adopted verbatim into another deployment, so it must not carry author-local machine paths or credentials. A lint that enumerated familiar roots such as `/Users`, `/home`, `/var`, `/opt` and `/private` missed `/tmp`, Windows spellings, UNC paths and tilde-home forms. Enumerating roots only chases the spellings someone already remembered.

# Classify structurally

On parsed scalar values, decide whether the value is or contains an absolute or home-relative path in any relevant host spelling:

- `file:` URIs that plausibly name local paths, checked before generic URL exemptions
- `$HOME`, `${HOME}`, `$USER`, `$PWD`, `%USERPROFILE%`
- `~`, `~/...`, `~user/...`
- `C:\...` or `C:/...`
- `\\server\share` and `\rooted`
- `/...`

Other `scheme://` URLs can be portable, but an exemption belongs to the URL span, not the whole scalar. Remove complete non-file URL spans before scanning the rest, so `https://example.test/Users/guide` remains portable while `https://example.test/guide --config=/Users/alice/private.yaml` is rejected.

# Keep surfaces separate

Values, keys and comments are separate surfaces. Moving a raw regex into a parsed-key check can drop credentials embedded in a value or sitting in a comment. A raw-text scan over the whole file can reject portable prose such as a documentation URL containing `/home/`. Extract comment text with the kernel's own comment semantics, and scan comments only for markers that identify a person or machine; values are configuration and need the broader path-class rules, including embedded paths.

Credential detection belongs on parsed keys and assignment-shaped appearances in values/comments, not on a broad prose regex that flags the template's own explanatory text.

# Fixtures in both directions

For a rule that decides whether a secret or username reaches another machine, enumerate surfaces and spellings explicitly and write accept-side fixtures at the same time as reject-side fixtures. Include portable forms such as HTTPS URLs, scp-style Git remotes (including an absolute remote path), relative paths and literal `none`, because a rule broad enough to catch every local path spelling can also start rejecting legitimate references.

The repeated review pattern was consistent: each fix was right in shape and wrong at a boundary. Confidence was weaker evidence than fixtures, especially fixtures seen to fail under deliberate mutation.
