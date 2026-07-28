#!/usr/bin/env node
/**
 * oas-aweb — OAS messaging-provider hooks for aweb.
 *
 * Invoked by the OAS kernel at instance lifecycle events (hook contract):
 *   oas-aweb spawn    mint a team-scoped aweb identity for the instance
 *   oas-aweb retire   gracefully self-delete it (BEFORE the home dir is removed)
 *   oas-aweb roster   list the aweb team's members — the cross-machine directory
 *                     of live instances (alias = instance name) and humans
 *   oas-aweb setup    guided onboarding: check the aw CLI, initialize the team
 *                     scope's aweb workspace, create/join the team
 *
 * Env contract (set by the kernel):
 *   OAS_EVENT     spawn|retire
 *   OAS_INSTANCE  instance name (used as the aweb alias)
 *   OAS_HOME      instance home dir (cwd is also set to it)
 *   OAS_CONTEXT   resolution context dir (the soul's repo / agents root parent)
 *   OAS_WORKSPACE the agents root's parent — the team boundary
 *   OAS_SETTINGS  JSON of the provider's `settings:` block
 *   OAS_TEAM_NAME/OAS_TEAM_ID/OAS_TEAM_SCOPE  resolved config `team:` block (may be empty)
 *   OAS_META      JSON persisted from this hook's previous spawn output (retire only)
 *
 * Output (spawn, stdout JSON):
 *   { "meta": {...persisted to instance.json + OAS_META at retire},
 *     "brief": "one-line TASK.md briefing line", "warning": "non-fatal problem" }
 *
 * EXIT CODE IS THE CONTRACT for the spawn hook. This capability declares
 * `spawn` as required (oas.json), so a nonzero exit fails the spawn and rolls it
 * back. Messaging is the whole point of the capability: an instance whose
 * identity was never minted believes it can be woken by mail and cannot, which
 * is worse than not starting. So identity failures exit nonzero, while genuinely
 * advisory problems (the Claude channel plugin, a team-name mismatch) stay
 * warnings on exit 0.
 *
 * On a fatal path, ALWAYS emit any metadata gathered so far before exiting: the
 * kernel feeds it to the retire hook to compensate partial state, and an
 * identity joined moments before the failure must still be deletable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, dirname, resolve, delimiter } from "node:path";

/** Run a command as ARGV — never a shell string. Team ids, aliases, instance
 * names and invite tokens all flow through here; quoting them correctly is a
 * property of one helper staying correct forever, while argv removes the class.
 * This hook is a REQUIRED spawn hook, so it gates every spawn, which is reason
 * enough not to rely on quoting. */
const run = (argv, cwd, timeout = 45000, { secrets = [], secretSafe = false } = {}) => {
  try {
    return execFileSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim();
  } catch (e) {
    // execFileSync puts the WHOLE ARGV in e.message ("Command failed: aw team
    // join <token> …"). This hook's failures are reported by the kernel and land
    // in CLI/Desktop logs, so a failed join disclosed a still-valid team invite
    // token to anyone reading them (reviewer-aggregate2). Rebuild the error from
    // the command name and the status — never the argv.
    //
    // secretSafe drops the child's OUTPUT as well. Scrubbing known strings is not
    // enough for a command that MINTS a secret: `aw team invite` can print a
    // freshly-created token to stderr while failing, and at that point the caller
    // has no value to scrub because the token is exactly what it never received
    // (reviewer-1a6e82e). For those commands, status plus fixed context is all
    // the diagnosis anyone gets.
    const scrub = (t) => secrets.filter(Boolean).reduce((acc, sec) => acc.split(sec).join("<redacted>"), String(t ?? ""));
    const where = [argv[0], argv[1], argv[2]].filter((a) => a && !secrets.includes(a) && !a.startsWith("-")).join(" ");
    const why = secretSafe ? "" : (scrub(e.stderr).trim() || (e.status === undefined ? String(e.code || "failed") : ""));
    const err = new Error(`${where} failed${e.status === undefined ? "" : ` (exit ${e.status})`}${why ? `: ${why}` : ""}${secretSafe ? " (output withheld: this command handles credentials)" : ""}`);
    err.status = e.status;
    throw err;
  }
};
/** JSON.parse whose failure never quotes the input. Node includes an excerpt of
 * the malformed text in a SyntaxError, which for these commands IS the credential
 * (reviewer-1a6e82e). */
const parseSecretJson = (text, what) => {
  try { return JSON.parse(text); }
  catch { throw new Error(`${what} returned output that is not valid JSON (withheld: this command handles credentials)`); }
};
/** Is a command on PATH? Resolved in-process rather than by running
 * `command -v`, which is a SHELL BUILTIN — spawning it as a program depends on
 * a /usr/bin/command binary that many systems do not ship, and its absence
 * would read as "aw is missing" on every such host. */
function onPath(cmd) {
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    try { const st = statSync(join(dir, cmd)); if (st.isFile() && (st.mode & 0o111)) return true; } catch { /* keep looking */ }
  }
  return false;
}
const out = (o, code = 0) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(code); };
const warn = (m) => out({ warning: `oas-aweb: ${String(m).slice(0, 300)}` });
/** Fatal for a REQUIRED spawn hook: emit metadata for compensation, then exit
 * nonzero so the kernel rolls the spawn back. `meta` carries whatever external
 * state already exists (e.g. a joined identity) so retire can undo it. */
const fatal = (m, meta) => out({ ...(meta ? { meta } : {}), warning: `oas-aweb: ${String(m).slice(0, 300)}` }, 1);

const event = process.env.OAS_EVENT || process.argv[2];
const instance = process.env.OAS_INSTANCE;
const home = process.env.OAS_HOME || process.cwd();

/**
 * The aweb root (minting authority). BOUNDED candidates — the deployment's team
 * scope (from config `team:`) is the natural home; we never walk past the
 * workspace to the laptop root (a `.aw` there would be a different team;
 * minting into it would be a silent cross-team leak):
 *   1. the declared team scope (OAS_TEAM_SCOPE)
 *   2. the instance home itself
 *   3. the git repo root containing the home (if any)
 *   4. the resolution context (the soul's target repo) and its git repo root
 *   5. the workspace root (OAS_WORKSPACE — e.g. ~/lfx)
 * First candidate with a `.aw` wins; none → no minting.
 */
function gitRootOf(startDir) {
  let d = resolve(startDir);
  while (true) {
    if (existsSync(join(d, ".git"))) return d;
    const parent = dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}
function awebRoot() {
  const candidates = [];
  const push = (p) => { if (p && !candidates.includes(resolve(p))) candidates.push(resolve(p)); };
  push(process.env.OAS_TEAM_SCOPE);
  push(home);
  push(gitRootOf(home));
  push(process.env.OAS_CONTEXT);
  if (process.env.OAS_CONTEXT) push(gitRootOf(process.env.OAS_CONTEXT));
  push(process.env.OAS_WORKSPACE);
  for (const c of candidates) if (existsSync(join(c, ".aw"))) return c;
  return undefined;
}

/** Team memberships from `aw team list --json`. The current CLI returns
 * `memberships`; older output used `teams`. Spawn resolution and `oas aweb
 * setup` MUST read this the same way — they drifted once, and because spawn
 * treats "no matching membership" as fatal, the stale reader turned every
 * name-only team config into a blocked spawn (reviewer-602627c). */
const teamMemberships = (listed) => listed?.memberships || listed?.teams || [];
const teamIdsOf = (listed) => teamMemberships(listed).map((m) => m.team_id || m.id || m);

const AW_INSTALL = "install the aw CLI first — see https://aweb.ai/docs (or `oas aweb setup` for guided onboarding)";
const isCommand = ["roster", "setup"].includes(event);
if (!onPath("aw")) {
  if (isCommand) { console.error(`oas aweb ${event}: aw CLI not on PATH — ${AW_INSTALL}`); process.exit(1); }
  if (event === "spawn") fatal(`aw CLI not on PATH, so no identity could be minted and this instance would have no messaging — ${AW_INSTALL}`);
  warn(`aw CLI not on PATH — no identity minted; ${AW_INSTALL}`);
}

if (event === "spawn") {
  let minted;                 // external identity, once `aw team join` succeeds
  const root = awebRoot();
  if (!root) fatal(`no initialized aweb root (.aw) among the bounded candidates (home, its git repo, context repo, workspace ${process.env.OAS_WORKSPACE || "?"}), so no identity could be minted and this instance would have no messaging — run \`oas aweb setup\` for guided onboarding`);
  try {
    // Team correctness: the config's `team:` block wins (id, then name), else the
    // root's active team. ALWAYS pass --team-id explicitly — never inherit whatever
    // team happens to be active at mint time — and verify the joined cert matches.
    // The instance name IS the discoverable alias (the team roster doubles as the
    // cross-machine instance directory).
    let team = process.env.OAS_TEAM_ID || process.env.OAS_TEAM_NAME;
    if (!team) team = JSON.parse(run(["aw", "team", "list", "--json"], root)).active_team;
    if (!team) fatal("cannot determine target team (no config team block, no active team at root), so no identity could be minted — set a team: block in oas-config.yaml, or activate a team at the aweb root");
    // A bare team name (no namespace) resolves against the root's memberships.
    if (!team.includes(":")) {
      const teams = JSON.parse(run(["aw", "team", "list", "--json"], root));
      const match = teamIdsOf(teams).filter((tid) => String(tid).startsWith(`${team}:`));
      if (match.length === 1) team = match[0];
      else if (match.length > 1) fatal(`team name "${team}" is ambiguous at ${root}: ${match.join(", ")}, so no identity could be minted — set team.id in oas-config.yaml`);
      else fatal(`no membership matching team "${team}" at ${root}, so no identity could be minted — join or create it first (aweb-team-membership skill), or set team.id`);
    }
    // Both of these carry the invite token — one mints it, the other spends it —
    // so neither their output nor their diagnostics may reach a log.
    const inv = parseSecretJson(run(["aw", "team", "invite", "--team-id", team, "--json"], root, 45000, { secretSafe: true }), "aw team invite");
    if (!inv?.token || typeof inv.token !== "string") fatal("aw team invite returned no usable token, so no identity could be minted");
    const raw = parseSecretJson(run(["aw", "team", "join", inv.token, "--name", instance, "--json"], home, 45000, { secrets: [inv.token], secretSafe: true }), "aw team join");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fatal("aw team join returned no usable result, so no identity could be minted", minted);
    // The RESPONSE is not a safe place to take strings from. Suppressing the
    // failure paths does nothing if a successful reply is copied into meta and
    // the briefing verbatim: a response echoing the invite token back as the
    // alias would print it twice, on exit 0 (reviewer-a6aa1c5). Accept a field
    // only if it is a plausible value of its own kind and is not carrying the
    // token; otherwise fall back to what WE asked for, which is always known.
    const clean = (v) => (typeof v === "string" && v.trim() && !v.includes(inv.token) ? v.trim() : undefined);
    const joined = {
      alias: (() => { const a = clean(raw.alias); return a && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(a) ? a : instance; })(),
      // Team ids are "<name>:<domain>"; anything else is not one, and the
      // requested team is the honest fallback.
      team_id: (() => { const t = clean(raw.team_id); return t && /^[^\s:]+:[^\s:]+$/.test(t) ? t : team; })(),
    };
    // External state now exists. Record it immediately so any later failure can
    // still report it for compensation.
    minted = { team: joined.team_id, alias: joined.alias };
    run(["aw", "init", "--do-not-touch-agents-md"], home);
    const alias = joined.alias;
    const mismatch = joined.team_id !== team
      ? ` [WARNING: joined ${joined.team_id}, expected ${team}]` : "";
    // Runtime integration: for Claude Code sessions the aweb-channel plugin
    // carries real-time push events. This hook does NOT install it. The plugin
    // is a DECLARED runtime requirement (oas.json), consented once at
    // `oas install` and verified by the kernel before spawn — installing it here
    // would mutate the operator's Claude configuration without asking, inside a
    // spawn, which is exactly the silent host mutation the consent gate exists
    // to prevent. By the time this runs the kernel has already proven the plugin
    // is present and enabled, so contributing the flag is safe.
    const launch = (process.env.OAS_RUNTIME || "") === "claude"
      ? { claude: "--dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace" }
      : undefined;
    const channelWarning = undefined;
    out({
      meta: { team: joined.team_id, alias },
      brief: `Comms: you have an aweb identity — alias "${alias}" on team ${joined.team_id}.${mismatch} Use \`aw mail\`/\`aw chat\` for messaging (see the aweb-messaging skill); coordination stays in your deployment's task layer.`,
      ...(launch ? { launch } : {}),
      ...(mismatch ? { warning: `oas-aweb: team mismatch — joined ${joined.team_id}, expected ${team}` } : channelWarning ? { warning: channelWarning } : {}),
    });
  } catch (e) {
    // A join may already have created a REMOTE identity before the failure.
    // Hand it back as meta so the kernel's compensation can delete it — losing
    // it here would strand a roster entry no one owns.
    fatal(`identity minting failed: ${e.message || e}`, minted);
  }
} else if (event === "retire") {
  const meta = JSON.parse(process.env.OAS_META || "{}");
  // No alias means the spawn hook never reported an identity: nothing exists to
  // undo, which is completion. An alias WITH no local `.aw` is the opposite —
  // the remote record exists and its key is gone, so the self-delete cannot be
  // authenticated and the cleanup is incomplete, not vacuous (reviewer-602627c).
  if (!meta.alias) out({ meta: { retired: false, reason: "nothing-to-delete" } });
  if (!existsSync(join(home, ".aw"))) {
    out({ meta: { retired: false, reason: "no-local-identity-key" }, warning: `oas-aweb: alias "${meta.alias}" was minted but ${join(home, ".aw")} is gone, so the remote record cannot be self-deleted and will linger until stale` }, 1);
  }
  try {
    // Self-delete from inside the home, authenticated by its own key — a remote
    // delete would 409 until the server marks the workspace stale.
    run(["aw", "workspace", "delete", meta.alias], home);
    out({ meta: { retired: true } });
  } catch (e) {
    // Exit nonzero: during a required-hook rollback this is the signal that
    // compensation did NOT complete, so the spawn is not reported as cleanly
    // rolled back while a remote identity still exists.
    out({ meta: { retired: false, reason: "self-delete-failed" }, warning: `oas-aweb: self-delete failed (the remote record will linger until stale): ${e.message || e}` }, 1);
  }
} else if (event === "roster") {
  // Cross-machine directory: every OAS-spawned instance joins the team with
  // alias = instance name, so the team's member roster lists live instances
  // wherever they run (plus human members). Local liveness comes from
  // `oas status --team`; this is the network view.
  const root = awebRoot();
  if (!root) { console.error("oas aweb roster: no initialized aweb root (.aw) found"); process.exit(1); }
  const team = process.env.OAS_TEAM_ID || process.env.OAS_TEAM_NAME || JSON.parse(run(["aw", "team", "list", "--json"], root)).active_team;
  if (!team) { console.error("oas aweb roster: cannot determine team (no config team block, no active team)"); process.exit(1); }
  const teamFlag = team.includes(":") ? ["--team-id", team] : ["--team", team];
  const r = JSON.parse(run(["aw", "id", "team", "members", ...teamFlag, "--json"], root, 60000));
  if (process.argv.includes("--json")) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  console.log(`aweb team ${r.team_id || team} — member roster (cross-machine):`);
  const members = r.members || [];
  if (!members.length) console.log("  (no member certificates visible from this workspace)");
  for (const m of members) console.log(`  ${m.alias || m.name || m.did || JSON.stringify(m)}`);
  console.log("\nAliases minted by OAS are instance names; message one with `aw mail send --to <alias> --subject \"...\" --body \"...\"`.");
  process.exit(0);
} else if (event === "setup") {
  // Guided onboarding — idempotent, prints what it finds and the one next step.
  const scope = process.env.OAS_TEAM_SCOPE || process.cwd();
  const teamName = process.env.OAS_TEAM_NAME;
  const teamId = process.env.OAS_TEAM_ID;
  console.log(`aweb onboarding — team scope: ${scope}${teamName ? `, config team: ${teamName}${teamId ? ` (${teamId})` : ""}` : ""}\n`);
  if (!teamName) {
    console.log("1. Declare your team in the deployment scope's oas-config.yaml first:");
    console.log("     team:\n       name: <your-team>\n   then re-run `oas aweb setup` from there.");
    process.exit(0);
  }
  if (!existsSync(join(scope, ".aw"))) {
    console.log(`No aweb workspace at the team scope yet. Initialize it (interactive — creates or connects an aweb account):`);
    console.log(`     cd ${scope} && aw init`);
    console.log("   First time on aweb? `aw init` walks you through creating a hosted aweb.ai account.");
    console.log("   Own your domain? Use `aw init --byod` (see the aweb-team-membership skill).");
    process.exit(0);
  }
  let teams = { memberships: [] };
  try { teams = JSON.parse(run(["aw", "team", "list", "--json"], scope)); } catch { /* fall through */ }
  const want = teamId || teamName;
  const match = teamIdsOf(teams).find((tid) => String(tid) === want || String(tid).startsWith(`${want}:`));
  if (match) {
    console.log(`✓ aweb workspace initialized and member of ${match}.`);
    if (teams.active_team && teams.active_team !== match) console.log(`  Note: active team is ${teams.active_team}; instances join ${match} explicitly, but consider \`aw team switch ${match}\`.`);
    console.log("  Done — spawned instances will join this team automatically (alias = instance name).");
    console.log("  Roster: `oas aweb roster`  ·  local: `oas status --team`");
  } else {
    console.log(`Workspace initialized, but no membership matching "${want}".`);
    console.log(`  Create the team:   cd ${scope} && aw team create ${teamName}`);
    console.log("  Or join an existing one: get an invite token from a member, then `aw team join <token>`");
    console.log("  (details: aweb-team-membership skill)");
  }
  process.exit(0);
} else {
  warn(`unknown event "${event}" (expected spawn|retire)`);
}
