# Ideas: review features (brainstorm, 2026-10-29)

Not planned yet. A list of features pr-tour could add, from our own ideas and from what
other review tools sell. ★ marks the ideas that fit pr-tour best.

Ground rule for every idea: the reviewer decides what gets sent. pr-tour never posts to
GitHub on its own.

## 1. Zoom levels

CodeRabbit's "levels" are review profiles (Chill, Assertive): how picky the bot is. Our
levels are about how deep the reviewer goes.

- **Level 0 · The PR in one screen** ★ What it does, an effort score (1-5) and reading
  time, counts (flows, read-closely steps, steps without tests, migrations), and what is new
  in the system (endpoints, tables, events, config keys).
- **Level 1 · Flow map** ★★ A diagram per flow: entry → steps → DB writes and outside calls.
  Changed steps coloured, unchanged grey, service hops and events as different arrows. A
  click opens the step. Built from the steps' `from` field, which is the call graph. In
  design now.
- **Level 2 · The tour.** What exists today.
- **Level 3 · Line level, with AI findings** ★ Claude reviews each step and suggests
  comments as drafts the reviewer accepts, edits or drops.

## 2. Features other tools offer

What CodeRabbit, Graphite, Greptile, Qodo, GitHub Copilot, Cursor Bugbot, Devin Review,
Sourcegraph, Bito, CodeAnt, Baz, Reviewable and Claude Code Review do, grouped by theme.
Sources are at the end. Some claims rest on third-party pages; those are marked.

### Understanding and overview
- **Reading-order regrouping.** The diff is cut into logical groups with a summary each.
  CodeRabbit Change Stack, Graphite Code Tours (unverified), Sourcegraph Diff Tour, Devin
  Review, Baz Topics, Copilot's grouped Files changed page. This is what pr-tour already
  does, and does deeper (flows in run order, not just groups).
- **Semantic and moved-code diff** ★ Changes grouped by function. Moved code is shown as
  moved, not as a delete plus an add. CodeRabbit, Devin Review, Amp. Cuts a lot of noise in
  refactor-heavy AI PRs.
- **Effort estimate, summary, labels, suggested reviewers.** CodeRabbit, Qodo, Bugbot,
  Greptile.
- **Merge-readiness score.** Greptile (1-5), CodeRabbit.

### Diagrams
- **Sequence diagrams** in the PR summary: CodeRabbit, Greptile, Qodo, Bito. Mostly Mermaid
  in a comment.
- **Runtime flow** from the entry point to databases and queues, cut to the happy path
  plus the riskiest branches: CodeAnt.
- **Component and blast-radius graphs** pinned to a commit: CodeRabbit (Advanced tier).
- **Deterministic call-graph diff without an LLM:** codiff (open source).
- **Known complaints:** diagrams that are noise, wrong edges (phantom services, reversed
  calls), too wide with long labels, and stale after a push. No independent accuracy study
  found.

### Review findings
- **Ranked findings with a verify step** ★ Several agents look for problems, then a verify
  step drops false positives, then the rest is ranked. Claude Code Review, Greptile, Devin,
  Bugbot.
- **One-click fix / hand off to an agent** ★ Bugbot Autofix, Greptile "Fix with your agent",
  Copilot. For us: send a draft comment to Claude Code with the file and line.
- **Deterministic tools mixed in:** CodeQL, linters, SAST. Copilot, CodeRabbit, Bito.
- **Ask about this range:** a chat about selected lines. Graphite, Baz, CodeRabbit, Devin.
  Overlaps with having Claude Code open next to pr-tour.

### Re-review after new commits
- **Review only what changed since last time** ★★ CodeRabbit, Bugbot, Bito.
- **Findings grouped as open, resolved since last review, or newly found:** Copilot,
  Claude Code Review.
- **Seen marks per file and per revision** ★ Reviewable's matrix: what you saw at which
  commit, any diff range, rebases stay diffable. Pre-AI, still the best at this. Our seen
  hashes are half of it.

### Context and history
- **Linked-ticket check** ★ Does the PR do what the ticket asks? CodeRabbit, Qodo. PR titles
  often carry ticket ids (e.g. ABC-123).
- **Related issues and PRs:** CodeRabbit.
- **Blast radius** ★ Callers outside the diff that a change affects. Greptile, Qodo,
  CodeRabbit (Advanced tier).
- **Recent committers per area:** Baz.

### Team rules and learning
- **A rules file in the repo** ★ REVIEW.md (Claude), BUGBOT.md (Cursor),
  copilot-instructions / AGENTS.md (Copilot), path instructions (CodeRabbit). For us: what
  counts as "read closely" per path, fed into the tour builder.
- **Learning from feedback** ★ "Remember this" from the reviewer's replies. Greptile,
  Bugbot, CodeRabbit, Qodo (Enterprise).
- **Custom pre-merge checks:** CodeRabbit.

### Workflow and metrics
- **Stacked PRs** (Graphite; GitHub native stacks in preview) and **merge queues**.
- **Keyboard-driven review** (Graphite, CodeRabbit). pr-tour has this.
- **Review-time and acceptance dashboards:** Graphite Insights, Greptile, Qodo, CodeRabbit.
  Low value for one reviewer.

### Skip
- Generating tests or docstrings: the author's job.
- Auto-posting bot comments: goes against "the reviewer decides what gets sent".

## 3. Best fits for pr-tour, in order

1. **Flow map** from the `from` call edges, with Claude only writing labels. Avoids the
   phantom and reversed edges other tools get. In design now.
2. **Incremental re-review.** Seen marks per step and per revision; after a push show only
   changed steps and mark stale ones.
3. **Verified AI findings on tour steps**, as drafts: find, verify, rank.
4. **Linked-ticket check** against the linked ticket.
5. **Blast-radius panel** per step: callers outside the diff.
6. **Repo rules file plus "remember this"**, so repeated Claude mistakes get flagged.
7. **Moved-code detection** inside steps.
8. **"Fix with Claude"** from a draft comment.

## Sources

- CodeRabbit Change Stack: https://www.coderabbit.ai/blog/introducing-change-stack-the-first-ai-native-code-review-interface
- CodeRabbit semantic diff: https://coderabbit.ai/blog/introducing-semantic-diff
- CodeRabbit configuration: https://docs.coderabbit.ai/reference/configuration
- CodeRabbit blast radius: https://docs.coderabbit.ai/security-agent/blast-radius
- CodeRabbit pricing: https://www.coderabbit.ai/pricing
- Graphite Code Tours (third-party, unverified): https://www.distillintelligence.com/news/graphite
- Graphite Insights: https://graphite.dev/docs/insights
- Sourcegraph Diff Tour: https://sourcegraph.com/docs/diff-tour.md
- Devin Review: https://docs.devin.ai/work-with-devin/devin-review
- Baz Topics: https://docs.baz.co/changes/overview/topics
- GitHub Files changed page: https://github.blog/changelog/2026-01-22-improved-pull-request-files-changed-page-on-by-default/
- GitHub Copilot code review: https://docs.github.com/en/copilot/concepts/agents/code-review
- Copilot re-review grouping: https://github.blog/changelog/2026-09-18-github-copilot-weekly-releases-september-14
- Greptile: https://www.greptile.com/docs and https://www.greptile.com/pricing
- Qodo describe: https://github.com/qodo-ai/pr-agent/blob/main/docs/docs/tools/describe.md
- Cursor Bugbot: https://cursor.com/docs/bugbot
- Claude Code Review: https://code.claude.com/docs/en/code-review
- Reviewable: https://docs.reviewable.io/files
- Bito interaction diagram: https://docs.bito.ai/ai-code-reviews-in-git/interaction-diagram
- CodeAnt runtime flow diagrams: https://www.codeant.ai/blogs/pr-sequence-diagrams-runtime-flow
- codiff: https://pypi.org/project/codiff/
- GitHub stacked PRs: https://infoq.com/news/2026/04/github-stacked-prs
