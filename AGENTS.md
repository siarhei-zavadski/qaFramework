# qaFramework

A zero-dependency TypeScript CLI (Node 26 runs `.ts` directly, no build) that
turns a requirement into test cases with BVA, EP, pairwise/t-wise and
decision-table rules.

## Test design requests

When the user asks to design, generate or review test cases or test data for
a requirement (text, URL, ticket), follow the `generating-test-cases` skill
(`.cursor/skills/generating-test-cases/SKILL.md`). Don't hand-write cases or
invent a spec format; model the requirement as a spec and run the CLI.

- Delegate one requirement per `test-case-designer` subagent when there are
  several. Before presenting cases, run the `test-spec-reviewer` subagent on
  the spec; if you are yourself a subagent (or subagents are unavailable),
  walk its checklist in `.cursor/agents/test-spec-reviewer.md` instead.
- Output goes to `generated/<feature>/` (gitignored, disposable): the
  context, the spec and the cases. Old files there may use outdated formats;
  never copy them as examples.
- This repo is project-agnostic. Never write an analysed system's names,
  hosts, tickets, config or tech notes into tracked files; all task and
  system context lives under `generated/` in the caller's `cwd`.
- The reference spec is `fixtures/price-calculation.spec.json` (bands, open
  ranges, booleans, rules).

When the user gives a local repo path and asks for tests of that system or
its infrastructure, follow the `analysing-system-repo` skill
(`.cursor/skills/analysing-system-repo/SKILL.md`). It writes the inventory,
the documented failure modes and the configured values to the disposable
`generated/<project>/components.md`.

When the user asks to validate, gate or score a change an agent wrote (a
diff, branch or PR), or for test selection, mutation testing, prompt
flakiness or trajectory checks, follow the `validating-agent-changes` skill
(`.cursor/skills/validating-agent-changes/SKILL.md`). It runs the target
repo's code only with the user's consent, in disposable copies under
`generated/<change>/`, and ends with the read-only `change-judge` verdict.

## Layout

| Path | Purpose |
| --- | --- |
| `src/spec.ts` | Spec model, JSON validation, `FIELD_TYPES` table, CLI helpers |
| `src/bva.ts`, `src/ep.ts` | Value techniques (one CLI each) |
| `src/pairwise.ts` | t-wise generation, negative cases, `--verify` audit |
| `src/rules.ts` | Decision-table outcomes and rule coverage |
| `src/formula.ts` | Computed rule outcomes (`=` formulas, no eval) |
| `src/mcp.ts` | Stdio MCP server running the CLIs (`bva`, `ep`, `pairwise` tools) |
| `src/check.ts` | Self-check (`npm test`) |
| `fixtures/` | Tracked acceptance data (test-design.org exercises) |
| `spec.example.json` | Minimal spec, used by the self-check |
| `.cursor/skills/generating-test-cases/` | Test design workflow and spec format |
| `.cursor/skills/analysing-system-repo/` | Repo inventory and per-component test design |
| `.cursor/skills/validating-agent-changes/` | Gate for agent-written changes: oracle, diff gate, test selection, mutants, trajectory, flakiness |
| `.cursor/agents/` | `test-case-designer`, `test-spec-reviewer` and `change-judge` subagents |
| `.cursor/rules/typescript-style.mdc` | Code style for `src/**/*.ts` |
| `.cursor-plugin/plugin.json`, `mcp.json` | Cursor plugin manifest (skills, subagents, MCP server) |

## Commands

Run `npm run format`, then `npm test` (self-check), `npm run typecheck` and
`npm run format:check`. All three must pass before a change is done.

## Known limits

Not supported natively: conditions that combine fields, single state
transitions and constraints that exclude impossible combinations (model them
as a relation field or a configuration enum with an adapter, skill step 2),
and dates (map them to numbers). Not supported at all: generated sequences
of events (an expected trace would need a second implementation of the
system), timing and races. Say so and list them as gaps instead of inventing
partitions on the original fields.

- Formulas have no power, comparison or string functions, and results keep
  12 significant digits: `round(x, 0.01)` drops the cents of
  10,000,000,000.01, and a computed result that falls short of a half step
  by less than the 12th digit still rounds up (4,744 of 5,315,415,000
  annuity rows).
- Regulated use: cases carry no requirement IDs (trace them through the
  designer's requirement-to-spec mapping), and the tool is not qualified or
  validated for any standard.
- `valid: true` on a case means each value is valid on its own, not that the
  combination is possible; list impossible positive rows as gaps.
- A string field with `minLength`/`maxLength` can't hold a string as an
  `invalid` or set value, and its generated values are `x` repeated. Put
  format and injection classes on a separate string field, or a spec, without
  lengths.
- Every negative case is one base row with one value swapped (`--debug`
  prints the row and its outcome). If that row is rejected for another
  reason, every negative is masked: put the value that reaches the validators
  first in an enum's `values` or set partitions (a range field always starts
  from its lowest valid range), or use one spec per mode.
- At most 1,000,000 t-tuples; past that the CLI fails fast. 20 fields of 10
  values take about 1 s at strength 2 and exceed the budget at strength 3;
  strength 3 at about 455,000 tuples takes 40 to 50 s.
- A huge `maxLength` (1048576) yields megabytes of JSON: pass `out`. MCP
  stdout and stderr each stop at 100,000 characters, and a run over 120 s is
  killed.
