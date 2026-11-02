---
name: validating-agent-changes
description: Gates a code change written by an AI agent before merge. Builds an independent oracle from the requirement with generating-test-cases, runs a language-agnostic diff gate and the repo's own static analysis, selects affected tests, compares behaviour at base and head, mutation-tests the changed lines, checks the agent's claims against its transcript and its output across identical prompts, and has the read-only change-judge subagent score semantic correctness against the requirement, the stated intent and the observed behaviour change. Use when the user asks to validate, gate, verify or score agent-generated code (a diff, branch or PR an agent wrote), or asks for test selection, mutation testing, a static analysis gate, prompt flakiness or trajectory evaluation of an agent run.
---

# Validating agent-generated changes

Input: the requirement (text, URL, ticket), target repo path, the change (`<base>...<head>`, a branch or a patch) and, if available, the agent's intent (PR description, commit message, final message) and transcript. `<change>` is kebab-case (branch or PR number); output goes to `generated/<change>/`. Chains `analysing-system-repo` (stack and tools), `generating-test-cases` with `test-spec-reviewer` (oracle) and `change-judge` (verdict); elsewhere `node src/*.ts` means the `qa-framework` MCP tools.

## Rules

- **Evidence or unverified**: every finding cites `file:line`, a command with exit code, or a transcript line; no evidence is `unverified`, never a pass. A defect on a changed line that predates the change is reported as `pre-existing`, never dropped.
- **Oracle from requirement and base**: model it from the requirement plus unchanged contracts, schemas, types, configs and entry-point signatures at `<base>` (`git show <base>:<path>`), never from head or the diff, so cases match real inputs without inheriting the change's bugs.
- **Execution is opt-in**: running anything from the target repo (tests, linters, builds, installs; configs can run code) needs the user's yes for that repo; without it run read-only steps and mark the rest `not run`.
- **Sandboxed, scoped, redacted**: with consent, run only in disposable copies under `generated/<change>/`, never the user's tree; shell sandbox on (never request `all`), network only for installs. No real `.env`, cloud credentials or tokens; tests needing shared environments or external services are `not run`. Replace secrets and personal data with `<redacted:kind>` before writing logs or quoting output. Subagents get requirement, specs and evidence, never credentials.
- **Reuse before building**: use the repo's configured tools; a gate with no tool goes in the platform table (step 7), not built here, except step 5's targeted mutants.

## Workflow

### 1. Scope the change

- Run `analysing-system-repo` step 1 on `<base>` into `generated/<change>/components.md` (reuse it for the same base): languages, test framework, linters, type checkers, coverage and mutation tools, CI config, each with `file:line`.
- `git -C <repo> diff --name-only <base>...<head>`: group files as source, tests, build or CI config, dependency manifests, generated or lock files.
- Ask for execution consent now, once, defaulting to no.

### 2. Build the oracle

Run `generating-test-cases` with feature `<change>/oracle` (one `test-case-designer` per requirement if several), its context from `components.md` and base files: `oracle/context.md` cites no head-only line; its review step applies. `oracle/cases.json` is the expected behaviour; its open questions are the gate's. CLI gaps (sequences, timing) make those requirement lines `untested` unless repo tests cover them.

### 3. Diff gate and static analysis

Runs nothing, any language: read `git diff -U0 <base>...<head>` and `git diff --check <base>...<head>`, flag each hit with `file:line`:

| Signal (added or removed lines) | Severity |
| --- | --- |
| weakened tests: removed assertions or test files, added skips (`.skip`, `xit`, `@Disabled`, `pytest.mark.skip`, `t.Skip`, `#[ignore]`), loosened expectations, rewritten snapshots | critical unless a requirement line explains it |
| suppressed checks: `eslint-disable`, `@ts-ignore`, `# type: ignore`, `# noqa`, `//nolint`, `@SuppressWarnings`, lowered coverage or lint thresholds | critical unless explained |
| secrets: keys, tokens, passwords, credentialed URLs, private key headers | critical (redacted) |
| new dependencies (manifest or lock entries) | warning: name, version, reason |
| contract change: public record, type, schema, endpoint or message format changed in place; mixed-version readers and writers | warning: name both sides |
| CI, permissions, infra: workflows, Dockerfiles, IAM, RBAC, `.gitignore` | warning |
| out of scope: files no requirement line or intent claim explains | warning; the judge decides |
| hygiene: `--check` output, debug prints | info |

With consent, run the repo's own linters and type checkers on changed files via the commands its config or CI defines (cite them); only findings new at head count. A changed language with no checker is `add` in the platform table.

### 4. Select tests

Write the rule and list to `generated/<change>/selection.md` (same diff, same selection):

1. Tests the diff changes.
2. Tests depending on changed source: the framework's feature if found (`jest --findRelatedTests`, `vitest related`, `nx affected`, Bazel `rdeps`, importers of changed Go packages); else test files importing a changed module and their importers, two levels deep (grep misses reflection, DI and data-file coupling; say so).
3. All tests when the diff touches build files, manifests, shared fixtures, test setup or CI config.

Rank by co-change frequency with the changed files (`git log --name-only`); frequent co-changers not selected are added as `predicted`. CI-failure-history prediction is a `gap`.

### 5. Run base vs head, then mutants (opt-in)

`git clone --local <repo> generated/<change>/base` and `.../head`, check out the refs (apply the patch on head if uncommitted), install with the repo's lockfile command.

- **Behaviour change**: run the selection in both. Rerun each failure up to twice; a result that changes at the same ref is `flaky`, not a regression. Classify `regression` (pass to fail), `fixed`, `new`, `removed`, `still failing`, `unchanged`. With a coverage tool, report line and branch coverage of changed lines only.
- **Oracle**: add one table-driven test to head, in the repo's framework, feeding each case's `input` (from each spec's `<out>.system.json` with an adapter, else its cases file) to the unit and asserting `expected` plus the model's output invariants (`reported == before - after`, nothing written on refusal). For `outside the model` items (multi-pass sequences, non-happy terminal states, rendering or infra), add a small companion test or probe. If the entry point isn't obvious, ask. Run it at base too: fails at base and passes at head is what the change delivers.
- **Mutants** on changed lines only: the repo's mutation tool (Stryker, PIT, mutmut, cargo-mutants) scoped to changed files with its own option; else targeted mutants from the oracle spec per boundary and rule the change implements: flip the comparison (`>`/`>=`, `<`/`<=`), move the constant one `step`, drop a rule condition, swap two outcomes; one at a time, revert with `git checkout -- <file>`. Run against the selection, then with the oracle test. Killed only by the oracle = tests the repo lacks; killed by nothing = missing test or equivalent mutant (say why). Score = killed / (mutants - equivalent).

### 6. Agent signals

**Trajectory**, given a transcript (JSONL of messages, tool calls, results):

- **Claims** in the final message and intent ("tests pass", "nothing else changed"): `confirmed` (transcript line of call and result, or a gate result), `contradicted` (a non-zero exit) or `unverified`.
- **Edits**: transcript edits vs diff files; either without the other is a finding.
- **Skipped steps**: commands the task or followed skill required but never ran (`npm test` before "done").
- **Scope**: reads of secrets or real `.env`, unexpected network calls, writes outside the repo, sandbox escapes or `all` requests, `--no-verify` or force pushes, disabled tests or checks; critical unless the user asked.
- **Loops**: the same failing command repeated with nothing changed (cost, info).

**Prompt flakiness**, when asked or when the verdict hinges on one reading: run the identical prompt and context K times (default 3) in parallel, each in its own base copy (`best-of-n-runner` for the open workspace, else `generated/<change>/run-<n>` clones), or K `test-case-designer` runs with features `<change>/run-<n>`. Runs differ by sampling only (no seed). Compare behaviour, not text: code runs go through step 5, flaky if pass and fail sets or changed public interfaces differ; specs are diffed pairwise (fields, step, bounds, partitions, rules, `expected`) and cross-verified both ways, since `--verify` ignores `expected`:

```bash
node src/pairwise.ts --spec generated/<change>/run-1/spec.json --verify generated/<change>/run-2/cases.json
```

Agreement = runs matching the majority / K. A divergence usually marks an ambiguous requirement line: quote it as an open question.

### 7. Judge and report

Give `change-judge` the requirement, intent, repo and refs, and the evidence from steps 2 to 6, plus the claims table; never your reasoning or the authoring transcript. On `block` or doubt, rerun it in a fresh subagent; differing verdicts are both reported and the user asked. Without subagents, or as one, walk its rubric (`.cursor/agents/change-judge.md`) and say the verdict isn't independent.

Write and present `generated/<change>/gate.md`:

```markdown
**revise**: 2 of 9 requirement lines unmet, 1 claim contradicted, mutation score 71% on changed lines (5 survivors), no regressions.

<one paragraph a non-engineer can act on: what the change does, whether it does what was asked, what blocks the merge>

| Gate | Status | Evidence | Tool |
| --- | --- | --- | --- |
| diff gate | fail | added `.skip` at `src/cart.test.ts:42` | git diff |
| oracle | fail | TC-012, TC-047 fail at head | `generated/<change>/oracle/cases.json` |
| mutants | 71% | 5 survivors, 3 killed by the oracle only | targeted |
| trajectory | fail | "all tests pass" contradicted: exit 1, transcript line 214 | transcript |
```

One row per gate (diff gate, static analysis, selected tests, oracle, mutants, trajectory, flakiness; `not run` when skipped). Then the judge's findings by severity, tests to add (oracle cases and oracle-only mutant kills; offer the head copy's oracle test file), open questions and gaps. End with a platform table, one row per capability the gates needed (`| Capability | Status | Detail |`): `covered` (a configured tool does it), `extend` (tool present, not configured for it), `add` (no tool; say whether an established one covers it or it must be built, and why), `gap` (out of reach from a repo and transcript).
