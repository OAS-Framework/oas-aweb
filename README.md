# oas-aweb

Official [OAS](https://github.com/OAS-Framework/oas) messaging-layer integration for [aweb](https://aweb.ai). It provides:

- per-instance, team-scoped aweb identity minting at spawn and self-deletion at retire;
- bounded authority discovery that never walks above the deployment workspace;
- `oas aweb roster` and guided `oas aweb setup` commands;
- reviewed, MIT-licensed `aweb-messaging`, `aweb-team-membership`, and `aweb-identity` skill trees synchronized from `@awebai/pi@0.2.3`;
- declared pi/Claude channel resources with explicit consent and structured launch metadata; and
- a portable reference deployment config you may adopt.

Messaging is deliberately separate from durable task tracking. The selected tasks integration owns task state.

The package requires OAS `>=0.20.0` — the release that froze the capability-materialization contract. See [`SCHEMA-STATUS.md`](SCHEMA-STATUS.md).

## What ships

`oas-package/` is the exact distributed payload; everything else in this repository is development tooling and is never installed.

```
oas-package/
  oas-package.json                       package manifest (capabilities + configTemplates)
  capabilities/oas-aweb/                 the DEDICATED capability root — materialized as-is
    oas.json  bin/  injects/  skills/
  config-templates/default/oas-config.yaml   portable reference deployment config
```

The capability root is self-contained: every declared skill, injection, command, and hook resolves inside it, so `oas install` can materialize it flat into `.agents/capabilities/installed/oas.aweb/` as an independently hashable, restorable, trustable artifact.

## Requirements

Install the `aw` CLI and initialize an aweb workspace at the deployment's team scope. `oas aweb setup` reports the next onboarding step without authenticating or creating a team silently.

`aw` is a separately consented **host** requirement. The per-runtime channel adapters are separately consented **runtime** requirements — `npm:@awebai/pi` for pi, `aweb-channel@awebai-marketplace` (marketplace `awebai/claude-plugins`) for Claude Code. Nothing installs them for you: the spawn hook only returns launch metadata, and the kernel verifies the runtime package is installed and enabled before a spawn, failing closed with the exact consent command otherwise.

The three Agent Skills are vendored package-owned resources under `capabilities/oas-aweb/skills/`; acquisition performs no npm install or runtime fetch. [`VENDORED.md`](oas-package/capabilities/oas-aweb/skills/VENDORED.md) records the exact upstream repository, `pi-v0.2.3` tag, commit, registry integrity, MIT license, and deterministic local-checkout sync procedure.

## Acquire and activate

Acquisition never activates the capability and never applies a config.

```bash
oas install oas.aweb --dir /path/to/scope        # acquire + materialize + lock
oas trust oas.aweb --dir /path/to/scope          # approve the executable surface
oas use oas.aweb --global --dir /path/to/scope   # bind the messaging layer
oas aweb setup
oas doctor /path/to/scope --soul <soul-name>
```

A pinned Git source may be used after publication:

```bash
oas install https://github.com/OAS-Framework/oas-aweb.git@v2.0.0 --dir /path/to/scope
```

Commands and identity lifecycle hooks are executable, so they require explicit per-capability trust bound to the exact materialized-artifact integrity. Re-projecting a changed source invalidates that approval.

### Or adopt the reference config

`config-templates/default/oas-config.yaml` is a complete, portable deployment config — no credential, account, machine path, or aweb team id. Adopt it explicitly:

```bash
oas init --package oas.aweb --dir /path/to/scope   # new scope (this is the default template)
oas config adopt oas.aweb --dir /path/to/scope     # switch an existing scope to this base
```

Adoption copies it to your `oas-config.yaml` and records the adopted base under `.agents/config-templates/adopted/` — commit that; `oas config diff` and `oas config sync` compare against it. Once adopted it is ordinary local policy: change anything, and package updates never rewrite it. Set `team.name` to your own team before spawning.

Targeting and team identity stay deployment-owned:

```yaml
team:
  name: example-team
  id: example-team:aweb.ai
capabilities:
  layers:
    messaging:
      capability: oas.aweb
      from: installed
      global: true
```

## Development

```bash
npm test    # manifest/template validation + unit tests
npm run probe   # isolated consumer probe against the RELEASED kernel

# Maintainer-only vendored update from an exact clean upstream checkout:
node scripts/sync-vendored-skills.mjs --source /path/to/aweb
npm test
git diff -- oas-package/capabilities/oas-aweb/skills
```

`npm test` validates both manifests and the config template against the vendored 0.20.0 schemas (canonical `configTemplates` spelling, canonical template path, dedicated capability root, per-capability self-containment, template portability), plus skill frontmatter/provenance/licenses, absence of runtime dependency closures, executable independence from omitted npm packages, and missing-CLI/bounded-root/retire hook behavior.

The template is read by `scripts/lib/kernel-yaml.mjs`, which deliberately mirrors the kernel's own config reader rather than being a general YAML parser — including where that reader is narrow. A validator that understood *more* YAML than the kernel would bless a template the deployment then reads differently (a block sequence, for instance, reaches the kernel as an empty map), so anything the kernel silently drops or reinterprets is rejected outright. `npm run probe` asserts that agreement against the released kernel's parser directly.

`npm run probe` downloads the released `@oas-framework/oas` at this package's declared floor and drives it in a throwaway sandbox with a synthetic `HOME` and a `PATH` that shadows any locally installed `oas`, `aw`, or `pi`: acquire → flat materialization → lock shape → git-ignore of generated artifacts → exact restore → trust, drift, and update invalidation → explicit template adoption and adopted base → host/runtime requirement reporting → spawn identity minting and retire self-deletion. Point `OAS_PROBE_CLI` at an unpacked kernel to skip the download, and set `OAS_PROBE_KEEP=1` to inspect the sandbox.
