#!/usr/bin/env node
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_REPOSITORY = "https://github.com/awebai/aweb.git";
const UPSTREAM_PACKAGE = "@awebai/pi";
const UPSTREAM_VERSION = "0.2.3";
const UPSTREAM_TAG = "pi-v0.2.3";
const UPSTREAM_COMMIT = "812bdeb1be8ed99dbd339a910a153e7b802501d4";
const UPSTREAM_INTEGRITY = "sha512-SnCT+5Ybh57G7+zwlfw6QRgAoyAVkyhcgRqIPPx47e+UcJdi5REXw9td806LveLEKAx0CwFTyxOInPH6mfs4EA==";
const SKILLS = ["aweb-messaging", "aweb-team-membership", "aweb-identity"];

const sourceIndex = process.argv.indexOf("--source");
if (sourceIndex === -1 || !process.argv[sourceIndex + 1]) {
  process.stderr.write("usage: node scripts/sync-vendored-skills.mjs --source /path/to/aweb\n");
  process.exit(2);
}

const source = resolve(process.argv[sourceIndex + 1]);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Vendored skills are DISTRIBUTED payload: they live under the package root
// (`oas-package/`), not the repo root that carries this dev-only sync tool.
const root = join(repoRoot, "oas-package");
const destination = join(root, "capabilities", "oas-aweb", "skills");
const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

if (!existsSync(join(source, ".git"))) throw new Error(`${source} is not an aweb git checkout`);
const head = git("rev-parse", "HEAD");
if (head !== UPSTREAM_COMMIT) throw new Error(`upstream HEAD ${head} does not match pinned ${UPSTREAM_COMMIT} (${UPSTREAM_TAG})`);
try { git("diff", "--quiet", "--", "LICENSE", "skills", "pi-extension/package.json"); }
catch { throw new Error("upstream checkout has uncommitted vendored-source changes"); }

const upstreamPackage = JSON.parse(readFileSync(join(source, "pi-extension", "package.json"), "utf8"));
if (upstreamPackage.name !== UPSTREAM_PACKAGE || upstreamPackage.version !== UPSTREAM_VERSION) {
  throw new Error(`expected ${UPSTREAM_PACKAGE}@${UPSTREAM_VERSION}, found ${upstreamPackage.name}@${upstreamPackage.version}`);
}

for (const skill of SKILLS) {
  const from = join(source, "skills", skill);
  if (!existsSync(join(from, "SKILL.md"))) throw new Error(`missing upstream skill ${skill}/SKILL.md`);
  rmSync(join(destination, skill), { recursive: true, force: true });
  cpSync(from, join(destination, skill), { recursive: true });
}
cpSync(join(source, "LICENSE"), join(destination, "LICENSE"));

const vendored = `# Vendored aweb Agent Skills

These reviewed resources are vendored from the MIT-licensed aweb repository:

- Repository: <${UPSTREAM_REPOSITORY}>
- Upstream package: \`${UPSTREAM_PACKAGE}@${UPSTREAM_VERSION}\`
- Tag: \`${UPSTREAM_TAG}\`
- Commit: \`${UPSTREAM_COMMIT}\`
- Registry integrity: \`${UPSTREAM_INTEGRITY}\`
- License: MIT; see [\`LICENSE\`](LICENSE)

Vendored trees:

${SKILLS.map((skill) => `- \`${skill}/\``).join("\n")}

To update, check out the named upstream repository at the intended reviewed commit, update the constants in \`scripts/sync-vendored-skills.mjs\`, then run from this repository root:

\`\`\`bash
node scripts/sync-vendored-skills.mjs --source /path/to/aweb
npm test
git diff -- oas-package/capabilities/oas-aweb/skills
\`\`\`

The sync command refuses a checkout whose \`HEAD\` differs from its pinned commit. Review the complete generated diff, upstream license, and triggering descriptions before changing the recorded version/ref. Runtime acquisition never fetches these resources.
`;
writeFileSync(join(destination, "VENDORED.md"), vendored);
process.stdout.write(`Synchronized ${SKILLS.length} skills from ${UPSTREAM_TAG} (${UPSTREAM_COMMIT}).\n`);
