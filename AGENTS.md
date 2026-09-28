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
- Output goes to `generated/<feature>/` (gitignored, disposable). Old files
  there may use outdated formats; never copy them as examples.
- The reference spec is `fixtures/price-calculation.spec.json` (bands, open
  ranges, booleans, rules).

## Layout

| Path | Purpose |
| --- | --- |
| `src/spec.ts` | Spec model, JSON validation, `FIELD_TYPES` table, CLI helpers |
| `src/bva.ts`, `src/ep.ts` | Value techniques (one CLI each) |
| `src/pairwise.ts` | t-wise generation, negative cases, `--verify` audit |
| `src/rules.ts` | Decision-table outcomes and rule coverage |
| `src/formula.ts` | Computed rule outcomes (`=` formulas, no eval) |
| `src/check.ts` | Self-check (`npm test`) |
| `fixtures/` | Tracked acceptance data (test-design.org exercises) |
| `spec.example.json` | Minimal spec, used by the self-check |
| `.cursor/skills/generating-test-cases/` | Test design workflow and spec format |
| `.cursor/agents/` | `test-case-designer` and `test-spec-reviewer` subagents |
| `.cursor/rules/typescript-style.mdc` | Code style for `src/**/*.ts` |

## Commands

Run `npm run format`, then `npm test` (self-check), `npm run typecheck` and
`npm run format:check`. All three must pass before a change is done.

## Known limits

Not supported: state transitions and workflows, constraints that exclude
impossible combinations, conditions that combine fields (a sum, a difference,
one field compared to another), dates as a native type (map them to numbers).
Say so instead of working around it in the spec.
