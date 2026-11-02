# qaFramework

A zero-dependency TypeScript CLI (Node 26 runs `.ts` directly, no build) that turns a requirement into test cases with BVA, EP, pairwise/t-wise and decision-table rules.

## Routing

- **Design, generate or review test cases or test data** for a requirement (text, URL, ticket): follow `.cursor/skills/generating-test-cases/SKILL.md` from step 0. Never hand-write cases or invent a spec format. One `test-case-designer` subagent per requirement when there are several; run `test-spec-reviewer` before presenting cases.
- **A local repo path, tests for that system or its infrastructure**: `.cursor/skills/analysing-system-repo/SKILL.md`.
- **Validate, gate or score an agent-written change** (diff, branch, PR), or test selection, mutation testing, prompt flakiness, trajectory checks: `.cursor/skills/validating-agent-changes/SKILL.md` (runs target code only with consent, ends with `change-judge`).

Output goes to the caller's `generated/` (gitignored, disposable); old files there may use outdated formats, never copy them. The repo is project-agnostic: never write an analysed system's names, hosts, tickets, config or notes into tracked files. Reference spec: `fixtures/price-calculation.spec.json`.

## Layout

| Path | Purpose |
| --- | --- |
| `src/spec.ts` | Spec model, JSON validation, `FIELD_TYPES`, CLI helpers |
| `src/bva.ts`, `src/ep.ts` | Value techniques (one CLI each) |
| `src/pairwise.ts` | t-wise generation, negative cases, `--verify`, `--adapter` (CLI only: imports local JS, never add it to `src/mcp.ts`) |
| `src/rules.ts` | Decision-table outcomes and rule coverage |
| `src/formula.ts` | `=` formulas (no eval) |
| `src/mcp.ts` | Stdio MCP server (`bva`, `ep`, `pairwise`) |
| `src/check.ts` | Self-check (`npm test`) |
| `fixtures/` | Tracked acceptance data (test-design.org exercises) |
| `spec.example.json` | Minimal spec for the self-check |
| `.cursor/skills/`, `.cursor/agents/` | The three skills above; `test-case-designer`, `test-spec-reviewer`, `change-judge` |
| `.cursor/rules/typescript-style.mdc` | Code style for `src/**/*.ts` |
| `.cursor-plugin/plugin.json`, `mcp.json` | Cursor plugin manifest |

## Commands

Run `npm run format`, then `npm test`, `npm run typecheck` and `npm run format:check`; all three must pass before a change is done.

## Known limits

Modelling limits (relations, state, formulas, string lengths, negative masking) are in the `generating-test-cases` skill. Beyond them:

- Not supported at all: generated event sequences (an expected trace needs a second implementation), timing and races; list them as gaps.
- 12 significant digits: a result short of a half step by less than the 12th digit still rounds up (4,744 of 5,315,415,000 annuity rows).
- Regulated use: cases carry no requirement IDs (trace via the designer's requirement-to-spec mapping); the tool is not qualified or validated for any standard.
- At most 1,000,000 t-tuples (fails fast). 20 fields of 10 values: about 1 s at strength 2, over budget at 3; strength 3 at about 455,000 tuples takes 40 to 50 s.
- A huge `maxLength` (1048576) yields megabytes of JSON: pass `out`. MCP stdout and stderr each stop at 100,000 characters; runs over 120 s are killed.
