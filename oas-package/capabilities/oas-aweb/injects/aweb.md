## Messaging: aweb

Your messaging layer is **aweb**. You have (or will be minted) a team-scoped
aweb identity — alias = your instance name — on your deployment's team (see
`instance.json` / your TASK.md briefing for the team).

**Load the skills at the right moments — do not work from memory:**

- **Before your first `aw mail`/`aw chat` of a session**, load the
  **aweb-messaging** skill. It is the
  playbook for sending, replying, and chat etiquette.
- **When an aweb channel event awakens you**, read the injected event
  metadata first, then load the **aweb-messaging** skill ("Read the event
  first" section) before responding — continue the existing conversation,
  never
  start a new thread when a `message_id`/`conversation_id` is provided.
- For team/roster/certificate questions, load **aweb-team-membership**; for
  identity/key questions, load **aweb-identity**.
- If a command errors or a flag looks wrong, re-read the skill or run
  `aw <cmd> --help` — never invent flags.

Quick crib (the skill has the full craft; run from your instance home):

```bash
aw mail inbox                                   # UNREAD mail only
aw mail inbox --show-all                        # full history (read mail is not lost)
aw mail send --to <alias> --subject "..." --body "..."    # recipient needs --to
aw mail send --to <alias> --subject "..." --body-file <f> # markdown/backticks
aw mail reply <message-id> --body "..."         # reply on an existing thread
aw chat send --to <alias> --body "..."          # synchronous back-and-forth
```

Flags are exactly these — there is no positional recipient and no
`--reply-to`; when unsure run `aw mail send --help`, don't guess. For any
body longer than a sentence (or containing quotes/backticks/newlines),
write it to a temp file and use `--body-file` — inline `--body` shell
escaping is a recurring failure.

Aliases are instance names (e.g. `dev-coordinator-1`). Discovery:
`oas status --team` lists this machine's live instances; `oas aweb roster`
lists the aweb team across machines.

**Never sleep, poll, or busy-wait for another agent's reply.** Send your
message, finish your turn, and go idle — the aweb channel awakens your
session the moment mail or chat arrives (you saw `✓ aweb connected` at
startup). A `sleep N; aw mail inbox` loop burns tokens, delays the reply,
and adds nothing. An empty `aw mail inbox` means no UNREAD mail — not that
messages were lost.

If messaging fails or your identity is missing, `oas aweb setup` diagnoses
the deployment's aweb state and prints the next step (report it to your
human rather than re-onboarding yourself).

Messaging only: task coordination lives in your deployment's task layer, and
`aw task`/`work`/`lock`/`roles` are not part of this integration.
