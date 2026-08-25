# Lessons

Durable lessons learned while shipping and reviewing OAS/aweb packages.

* [A normalized value is not an input spelling](normalized-value-is-not-input-spelling.md) - Normalized lock/state values may be rejected as user input, so documented commands must be parsed by the kernel contract they claim.
* [A silent reviewer is not an approval](silent-reviewer-is-not-approval.md) - A spawned reviewer that never reports must be checked for liveness before its silence is treated as a gate result.
* [Bare node test discovery is unsafe in OAS repo roots](explicit-node-test-discovery-in-oas-repos.md) - Recursive `node --test` discovery can sweep agent worktrees into a package suite unless test files are listed and guarded explicitly.
* [Nested node test runners can become silent false greens](nested-node-test-context.md) - A `node --test` child spawned from inside a Node test must not inherit `NODE_TEST_CONTEXT`.
* [Portability lints must classify path classes, not remembered roots](portability-lint-by-class.md) - Template portability checks need structural path classification across values, keys and comments rather than a list of familiar roots.
* [Config validators must mirror the kernel reader](config-validator-kernel-reader.md) - A package gate for `oas-config.yaml` should reproduce the released kernel reader and refuse constructs it silently misreads.
* [Parity claims need asymmetric fixtures](validator-parity-asymmetric-fixtures.md) - When the kernel treats resource kinds differently, validator parity needs fixtures for both the rejecting and accepting branch.
