---
name: validating-agent-changes
description: Gates a code change written by an AI agent before merge. Builds an independent oracle from the requirement with generating-test-cases, runs a language-agnostic diff gate and the repo's own static analysis, selects affected tests, compares behaviour at base and head, mutation-tests the changed lines, checks the agent's claims against its transcript and its output across identical prompts, and has the read-only change-judge subagent score semantic correctness against the requirement, the stated intent and the observed behaviour change. Use when the user asks to validate, gate, verify or score agent-generated code (a diff, branch or PR an agent wrote), or asks for test selection, mutation testing, a static analysis gate, prompt flakiness or trajectory evaluation of an agent run.
---

# Validating agent-generated changes

Input: the requirement (text, URL, ticket), the target repo path, the change
(`<base>...<head>` refs, a branch or a patch) and, when available, the
agent's stated intent (PR description, commit message, final message) and its
transcript. `<change>` is a kebab-case name (branch or PR number); output
goes to `generated/<change>/`.

This skill chains the others: `analysing-system-repo` gives the stack and its
tools, `generating-test-cases` (reviewed by `test-spec-reviewer`) gives the
oracle, and the `change-judge` subagent gives the verdict. In other projects
the `node src/*.ts` commands are the `qa-framework` MCP tools, as
`generating-test-cases` describes.

## Rules

- **Evidence or unverified.** Every finding cites a repo `file:line`, a
  command with its exit code, or a transcript line. A claim without evidence
  is `unverified`, never a pass.
- **The oracle comes from the requirement.** Model it from the requirement
  text only, without reading the changed implementation, so the cases can't
  inherit its bugs.
- **Execution is opt-in.** Running anything from the target repo (tests,
  linters, builds, installs; their configs can run code) needs the user's yes
  for that repo. Without it, run the read-only steps and mark the rest
  `not run`.
- **Sandboxed, scoped, redacted.** With consent, run only in disposable
  copies under `generated/<change>/`, never in the user's working tree. Keep
  the shell sandbox on (never request `all`); network only for dependency
  installs. No real `.env`, cloud credentials or tokens; tests that need
  shared environments or external services are `not run`. Before writing a
  log or quoting output, replace secrets and personal data with
  `<redacted:kind>`. Subagents get the requirement, specs and evidence, never
  credentials.
- **Reuse before building.** Use the tools the repo already configures. A
  gate it has no tool for is reported in the platform table (step 7), not
  built here, except the targeted mutants in step 5.

## Workflow

```
- [ ] 1. Scope the change
- [ ] 2. Build the oracle
- [ ] 3. Diff gate and static analysis
- [ ] 4. Select tests
- [ ] 5. Run base vs head, then mutants (opt-in)
- [ ] 6. Agent signals (transcript, identical prompts)
- [ ] 7. Judge and report
```

### 1. Scope the change

- Reuse `projects/<project>/project.md` if it exists; otherwise run step 1
  (Inventory) of `analysing-system-repo`. Take from it the languages, test
  framework, linters and type checkers, coverage and mutation tools and CI
  config, each with `file:line`.
- `git -C <repo> diff --name-only <base>...<head>`: group the changed files
  as source, tests, build or CI config, dependency manifests, generated or
  lock files.
- Ask for execution consent now, once, defaulting to no.

### 2. Build the oracle

Run `generating-test-cases` on the requirement with the feature name
`<change>/oracle` (one `test-case-designer` per requirement if there are
several). Its review step applies. `generated/<change>/oracle/cases.json` is
the expected behaviour; its open questions are the gate's open questions.
What the CLI can't model (sequences, timing) is a gap, and the judge marks
those requirement lines `untested` unless repo tests cover them.

### 3. Diff gate and static analysis

The diff gate runs nothing and works for any language. Read
`git diff -U0 <base>...<head>` and `git diff --check <base>...<head>`, and
flag each hit with `file:line`:

| Signal | In added or removed lines | Severity |
| --- | --- | --- |
| weakened tests | removed assertions or test files, added skips (`.skip`, `xit`, `@Disabled`, `pytest.mark.skip`, `t.Skip`, `#[ignore]`), loosened expectations, rewritten snapshots | critical unless a requirement line explains it |
| suppressed checks | added `eslint-disable`, `@ts-ignore`, `# type: ignore`, `# noqa`, `//nolint`, `@SuppressWarnings`; lowered coverage or lint thresholds | critical unless explained |
| secrets | keys, tokens, passwords, credentialed URLs, private key headers | critical (redacted in the report) |
| new dependencies | added manifest or lock file entries | warning: name, version, reason |
| CI, permissions, infra | CI workflows, Dockerfiles, IAM, RBAC, `.gitignore` | warning |
| out of scope | files no requirement line or intent claim explains | warning; the judge decides |
| hygiene | `--check` output (whitespace, conflict markers), debug prints | info |

With consent, run the repo's own linters and type checkers on the changed
files, using the commands its config or CI defines (cite them). Only findings
new at head count against the change. A changed language with no configured
checker goes in the platform table as `add`.

### 4. Select tests

Write the selection rule and the list to `generated/<change>/selection.md`, so
the same diff always selects the same tests:

1. Tests the diff changes.
2. Tests that depend on changed source: the framework's own feature when the
   inventory found one (`jest --findRelatedTests`, `vitest related`,
   `nx affected`, Bazel `rdeps` queries, importers of the changed Go
   packages); otherwise test files that import a changed module, and their
   importers, two levels deep. Grep selection misses reflection, dependency
   injection and data-file coupling; say so.
3. All tests when the diff touches build files, dependency manifests, shared
   fixtures, test setup or CI config.

Predictive ordering: rank the selection by how often each test file changed in
the same commits as the changed files (`git log --name-only`). Tests that
co-change often but weren't selected are added and marked `predicted`.
Prediction from CI failure history needs data the repo doesn't hold: `gap`.

### 5. Run base vs head, then mutants (opt-in)

`git clone --local <repo> generated/<change>/base` and `.../head`, check out
the refs (apply the patch on head if the change is uncommitted), and install
dependencies with the repo's lockfile command.

**Behaviour change.** Run the selected tests in both copies. Rerun each
failure up to twice; a test whose result changes at the same ref is `flaky`,
not a regression. Classify each test as `regression` (pass to fail), `fixed`,
`new`, `removed`, `still failing` or `unchanged`. If the repo has a coverage
tool, report line and branch coverage of the changed lines only.

**Oracle.** Add one table-driven test to the head copy, in the repo's
framework, that feeds each case's `input` to the unit under test and asserts
`expected`. If the entry point isn't obvious, ask; don't guess an API. Run it
at base too: cases that fail at base and pass at head are what the change
delivers.

**Mutants.** Mutate the changed lines only:

- With the repo's mutation tool (Stryker, PIT, mutmut, cargo-mutants, ...),
  scope it to the changed files with the tool's own option for the detected
  version.
- Without one, write targeted mutants in the head copy from the oracle spec:
  for each boundary and rule the change implements, flip the comparison
  (`>` and `>=`, `<` and `<=`), move the constant by one `step`, drop one rule
  condition, swap two rule outcomes. Apply one at a time, run, revert with
  `git checkout -- <file>`.

Run the mutants against the selected tests alone, then with the oracle test.
Mutants that only the oracle kills are tests the repo is missing. A mutant
nothing kills is a missing test or an equivalent mutant (say why it behaves
the same). Mutation score = killed / (mutants - equivalent).

### 6. Agent signals

**Trajectory against the trace**, when a transcript is given (a JSONL log of
messages, tool calls and results, like Cursor's agent transcripts):

- **Claims**: each claim in the final message and the intent ("tests pass",
  "validates X", "nothing else changed") is `confirmed` (the transcript line
  of the call and result, or a gate result), `contradicted` (for example a
  non-zero exit code) or `unverified`.
- **Edits**: files the transcript edited vs files in the diff. Either side
  without the other is a finding.
- **Skipped steps**: commands the task or the skill the agent followed
  required that the transcript never ran (`npm test` before "done").
- **Scope**: reads of secrets or real `.env` files, unexpected network calls,
  writes outside the repo, sandbox escapes or `all` permission requests,
  `--no-verify` or force pushes, disabled tests or checks. Critical unless
  the user asked for it.
- **Loops**: the same failing command repeated with nothing changed in between
  (cost, info).

**Prompt flakiness**, when asked or when a verdict hinges on one reading of
the requirement: run the identical prompt and context K times (default 3) in
parallel, each in its own copy at base (`best-of-n-runner` when the target is
the open workspace, else `generated/<change>/run-<n>` clones), or K
`test-case-designer` runs with features `<change>/run-<n>` for specs. Cursor
subagents expose no seed or temperature; the runs differ by sampling only.
Compare behaviour, not text:

- Code: run each run's head through step 5. Flaky if the pass and fail sets
  differ, or the runs change different public interfaces.
- Specs: diff each `spec.json` pair (fields, step, bounds, partitions, rules,
  `expected`) and cross-verify both ways. `--verify` checks tuples and rules,
  not `expected`, so compare those in the diff.

```bash
node src/pairwise.ts --spec generated/<change>/run-1/spec.json --verify generated/<change>/run-2/cases.json
```

Agreement = runs matching the majority / K. A divergence usually points at an
ambiguous requirement line (inclusive or exclusive bound, missing limit):
quote it as an open question.

### 7. Judge and report

Give the `change-judge` subagent the requirement, the intent, the repo path
and refs, and the evidence files from steps 2 to 6. Don't give it your own
reasoning or the authoring agent's transcript; it gets the claims table. For a
`block`, or when you doubt the verdict, run it once more in a fresh subagent;
if the verdicts differ, report both and ask the user. If subagents aren't
available, or you are a subagent, walk its rubric yourself
(`.cursor/agents/change-judge.md`) and say the verdict isn't independent.

Write `generated/<change>/gate.md` and present it:

```markdown
**revise**: 2 of 9 requirement lines unmet, 1 claim contradicted, mutation score 71% on changed lines (5 survivors), no regressions.

<one paragraph a non-engineer can act on: what the change does, whether it does what was asked, what blocks the merge>

| Gate | Status | Evidence | Tool |
| --- | --- | --- | --- |
| diff gate | fail | added `.skip` at `src/cart.test.ts:42` | git diff |
| static analysis | pass | 0 new findings | eslint (`eslint.config.js:1`) |
| selected tests | pass | 38 selected, 0 regressions, 1 flaky | jest |
| oracle | fail | TC-012, TC-047 fail at head | `generated/<change>/oracle/cases.json` |
| mutants | 71% | 5 survivors, 3 killed by the oracle only | targeted |
| trajectory | fail | "all tests pass" contradicted: exit 1, transcript line 214 | transcript |
| flakiness | not run | | |
```

Then the judge's findings by severity, the tests to add to the repo (oracle
cases and mutants only the oracle kills; offer the oracle test file from the
head copy), open questions and gaps.

End with the platform table: one row per capability the gates needed.

| Capability | Status | Detail |
| --- | --- | --- |
| static analysis for TypeScript | covered | eslint, `eslint.config.js:1` |
| changed-line coverage | extend | coverage runs, no diff threshold in `.github/workflows/ci.yml:30` |
| mutation testing | add | no tool; an established one exists for the stack, extend CI rather than build |
| predictive test selection | gap | needs CI failure history |

`covered`: a configured tool does it. `extend`: a tool is there but not
configured for it. `add`: no tool; say whether an established tool for the
stack covers it or it has to be built, and why. `gap`: out of reach from a
repo and a transcript.
