---
name: next session prompt
description: update context and give a copy-paste prompt for new/fresh claude code session.
---

I want to start a new Claude Code session.
Update this project's context files, then give me a detailed copy-paste prompt for the next session.

Two halves. Do both.

## A. Update the context files

Update `CLAUDE.md` and any per-context `CONTEXT.md` / `CONTEXT-MAP.md` that the work has invalidated.

**Reference, do not restate.**
If something is already captured in an ADR, a spec, a runbook, an issue, a commit or a diff, link to it by path and write one line of hook.
Do not copy its content into `CLAUDE.md`.
This file is an index and a set of warnings, not a mirror of `docs/`.

**Prune as much as you add.**
This is the half that gets skipped, and it is why the file grows without bound.
Before appending anything, find what the session made obsolete and delete or collapse it.
Superseded addresses, closed decisions, resolved blockers and finished tickets become one line or disappear.
A decision that is settled needs its outcome, not its argument.
If the file got longer, say by how much and why it was worth it.

**Never copy a secret into a tracked file.**
`contracts/.env` holds live keys.
Redact any endpoint URL, API key, private key or personal data, and prefer naming the variable (`RPC_TESTNET_ARCHIVE_URL`) over showing a value.
Mask with `sed -E 's#(/v2/)[A-Za-z0-9_-]+#\1<key>#g'` if a URL has to appear at all.

**Write what was surprising, not what was done.**
Git history already records what was done.
The things worth persisting are the traps, the measurements that contradicted an assumption, and the decisions someone would otherwise re-litigate.

## B. Emit the prompt

A single fenced block I can paste into a fresh session, containing:

1. **One line on what this project is**, and the read-first list: which files, in what order, and why each one matters.
2. **State to verify, with the exact commands to verify it.**
   Never assert branch, sync status or test counts as fact.
   Give the command and the expected answer so a stale claim is caught in the first thirty seconds.
3. **The job**, stated as the next concrete step rather than a theme.
4. **Settled decisions** that must not be re-litigated, one line each.
5. **Corrections**: anything previously recorded that turned out to be wrong, so it does not get reintroduced.
6. **Constraints that must survive into the work**, especially ones discovered the hard way.
7. **Decisions waiting on me**, phrased as questions to ask rather than assumptions to make.
8. **Setup**: the commands to run the suites, start and stop services, and anything with a cost I should know about.
9. **Hard constraints**: what to ask before doing, and what never to do.

Apply the same redaction rule to the prompt itself.
Prefer a stale-but-verifiable claim over a confident unverifiable one.
