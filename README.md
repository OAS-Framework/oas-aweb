# oas-aweb

Official [OAS](https://github.com/OAS-Framework/oas) messaging-layer integration for [aweb](https://aweb.ai). It provides:

- per-instance, team-scoped aweb identity minting at spawn and self-deletion at retire;
- bounded authority discovery that never walks above the deployment workspace;
- `oas aweb roster` and guided `oas aweb setup` commands;
- reviewed, MIT-licensed `aweb-messaging`, `aweb-team-membership`, and `aweb-identity` skill trees synchronized from `@awebai/pi@0.2.3`; and
- a Claude Code channel-plugin launch integration for real-time events.

Messaging is deliberately separate from durable task tracking. The selected tasks integration owns task state.

## Requirements

Install the `aw` CLI and initialize an aweb workspace at the deployment's team scope. `oas aweb setup` reports the next onboarding step without authenticating or creating a team silently.

The three Agent Skills are vendored package-owned resources under `capabilities/oas-aweb/skills/`; acquisition performs no npm install or runtime fetch. [`VENDORED.md`](capabilities/oas-aweb/skills/VENDORED.md) records the exact upstream repository, `pi-v0.2.3` tag, commit, registry integrity, MIT license, and deterministic local-checkout sync procedure.

The `aw` binary remains a separately consented host requirement. Vendoring the skills does not install, authenticate, or bundle that CLI. The package requires OAS `>=0.19.0`; see [`SCHEMA-STATUS.md`](SCHEMA-STATUS.md) for the remaining released-kernel fixture gate.

## Acquire and activate

Acquisition does not activate the capability. After an official release exists:

```bash
oas install oas.aweb --dir /path/to/scope
oas trust oas.aweb --dir /path/to/scope
oas use oas.aweb --global --dir /path/to/scope
oas aweb setup
oas doctor /path/to/scope --soul <soul-name>
```

A pinned Git source may be used after publication:

```bash
oas install git:https://github.com/OAS-Framework/oas-aweb.git@v1.8.0 --dir /path/to/scope
```

Commands and identity lifecycle hooks are executable, so they require explicit per-capability trust tied to the exact package integrity. Targeting and team identity are deployment-owned. A typical config scope declares the team boundary and activates the messaging layer:

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
npm test

# Maintainer-only vendored update from an exact clean upstream checkout:
node scripts/sync-vendored-skills.mjs --source /path/to/aweb
npm test
git diff -- oas-package/capabilities/oas-aweb/skills
```

Tests validate both manifests, skill frontmatter/provenance/licenses, absence of runtime dependency closures, executable independence from omitted npm packages, and missing-CLI/bounded-root/retire hook behavior. The full acquire → lock → trust → activate → spawn probe remains pending released OAS 0.19.0 consumer fixtures.
