@AGENTS.md

# Nod marketing fork

This repo is `levlmethod/nod`, a fork of `n8n-io/nod` that is being turned into a multi-agent marketing system. `AGENTS.md` above is upstream's file and its rules still apply. Do not edit it; put fork-only rules here.

## Agent skills

The skills live in `.claude/skills/`. Many are marked user-invoked, so when a step below names a skill, read `.claude/skills/<name>/SKILL.md` and follow it, even if no one typed the slash command. If this file and a skill disagree, this file wins.

### Issue tracker

GitHub Issues on `levlmethod/nod`, never upstream. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the root and ADRs in `docs/adr/`. See `docs/agents/domain.md`.

## How work gets done here

Every change follows these steps in order. Skipping one is a bug in the process, not a shortcut.

1. **No code without a ticket.** Before you change code, there is an open issue on `levlmethod/nod` that the change implements. If there isn't one, stop and make one through steps 2 and 3. The only exceptions are typo fixes and merges from upstream.
2. **Shape it.** For anything bigger than one ticket, grill the idea with `grill-with-docs` until the open questions are answered, then write it up with `to-spec`. The spec is a GitHub issue. Doug signs off on the spec before tickets are cut.
3. **Cut tickets.** Break the spec into tracer-bullet tickets with `to-tickets`, each with blocking edges and a done-when line. Label each `ready-for-agent` or `ready-for-human`. Estimate in agent time (minutes or hours of agent work), not human days. For work too big for one session, use `wayfinder`.
4. **Build one ticket at a time.** Use `implement`, driving `tdd` at the seams the ticket names. Tests for fork code are kept, as the regression net for each ticket. In upstream areas, the Tests section of `AGENTS.md` decides which tests to keep. Hard bugs go through `diagnosing-bugs`.
5. **Review before the PR.** Run this repo's `code-review` skill (in `.claude/skills/code-review`) against the ticket and fix what it finds.
6. **Open the PR.** Write the body with `pr`. It must say `Closes #<ticket>`; the `require-ticket` check fails without it. Open it against `main` on `levlmethod/nod`. One ticket per PR unless the ticket says otherwise.
7. **Doug merges.** Pushing feature branches and opening PRs on `levlmethod/nod` is authorized. Merging to `main`, deleting branches, and anything at all on `n8n-io/nod` need Doug.

When you don't know which skill fits, read `ask-matt`.

## Keeping the fork mergeable

Upstream changes daily, so every fork change should be easy to carry across a merge.

- Put new behaviour in new files and folders. Touch upstream files only where you have to hook in, and keep those edits small.
- Record each upstream file you change, and why, in an ADR under `docs/adr/`.
- Specs, plans and research belong in GitHub issues, not in the repo, which matches the upstream rule. `prototype` and `research` output goes outside the repo or into an issue comment.
