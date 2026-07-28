# Vendored aweb Agent Skills

These reviewed resources are vendored from the MIT-licensed aweb repository:

- Repository: <https://github.com/awebai/aweb.git>
- Upstream package: `@awebai/pi@0.2.3`
- Tag: `pi-v0.2.3`
- Commit: `812bdeb1be8ed99dbd339a910a153e7b802501d4`
- Registry integrity: `sha512-SnCT+5Ybh57G7+zwlfw6QRgAoyAVkyhcgRqIPPx47e+UcJdi5REXw9td806LveLEKAx0CwFTyxOInPH6mfs4EA==`
- License: MIT; see [`LICENSE`](LICENSE)

Vendored trees:

- `aweb-messaging/`
- `aweb-team-membership/`
- `aweb-identity/`

To update, check out the named upstream repository at the intended reviewed commit, update the constants in `scripts/sync-vendored-skills.mjs`, then run from this repository root:

```bash
node scripts/sync-vendored-skills.mjs --source /path/to/aweb
npm test
git diff -- capabilities/oas-aweb/skills
```

The sync command refuses a checkout whose `HEAD` differs from its pinned commit. Review the complete generated diff, upstream license, and triggering descriptions before changing the recorded version/ref. Runtime acquisition never fetches these resources.
