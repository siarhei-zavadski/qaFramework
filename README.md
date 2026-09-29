# qaFramework

Give an AI agent a requirement; it models it as a spec and generates test
cases with boundary value analysis, equivalence partitioning, pairwise/t-wise
combination and decision-table rules, using this repo's CLI.

## Setup

Node 26 (runs `.ts` directly, no build), then:

```bash
npm ci
```

Open the repo in Cursor or any agent that reads `AGENTS.md`.

## Ask the agent

- `Design test cases for: <requirement text>`
- `Design test cases for <URL or ticket>`
- `Check coverage of existing-cases.json against this requirement: <text>`
- `Design tests for the system in /path/to/repo` (reads its stack and config,
  keeps per-technology skills in `projects/<project>/skills/`)

The agent follows `AGENTS.md` and the `generating-test-cases` skill: it writes
`generated/<feature>/spec.json`, runs the CLI, and has `test-spec-reviewer`
check the spec. Several requirements get one `test-case-designer` subagent
each.

You get back a table of cases with expected results, the spec and cases file
paths, and the assumptions and open questions to answer.

## Manual use

```bash
node src/pairwise.ts --spec spec.example.json
node src/bva.ts --name price --min 0.01 --max 999.99 --step 0.01
```

The spec format and full workflow are in
[`.cursor/skills/generating-test-cases/SKILL.md`](.cursor/skills/generating-test-cases/SKILL.md).

## Use in other projects (Cursor plugin)

The repo is also a Cursor plugin: the skills, the subagents and an MCP server
(`src/mcp.ts`) whose `bva`, `ep` and `pairwise` tools run the CLI in your
project. It needs Node 26 on `PATH` and no `npm ci`.

```bash
git clone <this repo> ~/.cursor/plugins/local/qa-framework
```

Then run **Developer: Reload Window**. A symlink to a checkout elsewhere is
not loaded.

## Development

```bash
npm test && npm run typecheck && npm run format:check
```

Not supported: see "Known limits" in [`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE) © Siarhei Zavadski

Exercises in `fixtures/` come from [test-design.org](https://test-design.org)
and are not covered by this license.
