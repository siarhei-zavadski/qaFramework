# qaFramework

Give an AI agent a requirement; it models it as a spec and generates test
cases with boundary value analysis, equivalence partitioning, pairwise/t-wise
combination and decision-table rules, using this repo's CLI.

## Setup

Node 22.18 or later (runs `.ts` directly, no build), then:

```bash
npm ci
```

Open the repo in Claude Code, Cursor or any agent that reads `AGENTS.md`.
In Claude Code the skills and subagents load from `.claude/` (symlinks to
`.cursor/`).
- **Plugin also installed:** if you installed the plugin too, set
  `{"enabledPlugins": {"qa-framework@siarhei-zavadski": false}}` in `.claude/settings.local.json` here
  so both copies don't load.
- **Windows:** the symlinks need Developer Mode and
  `git config --global core.symlinks true` before cloning; otherwise use
  `claude --plugin-dir .`.

## Ask the agent

- `Design test cases for: <requirement text>`
- `Design test cases for <URL or ticket>`
- `Check coverage of existing-cases.json against this requirement: <text>`
- `Design tests for the system in /path/to/repo` (reads its stack, config and
  the official docs into `generated/<project>/components.md`, then designs
  tests per component)
- `Validate the agent's change in /path/to/repo (main...feature-x) against:
  <requirement>` (oracle cases, diff gate, selected tests and mutants at base
  vs head, transcript claims, and a `change-judge` verdict; runs the repo's
  code only if you agree)

## What to give the agent

The requirement alone works. Each of these lets the model reach more failure
domains:

- related requirements that set the same values;
- the code or config under test and its existing tests (for `--verify`);
- one hop out: what writes the inputs and what reads the outputs (schemas,
  migrations, API contracts, config layers);
- one real sample record or log line, with secrets and personal data removed.

Anything missing becomes an open question, never an invented value.

The agent follows `AGENTS.md` and the `generating-test-cases` skill: it
gathers the requirement's context in `generated/<feature>/context.md`, writes
`generated/<feature>/spec.json`, runs the CLI, and has `test-spec-reviewer`
check the spec. When a condition links fields (an end date after a start
date, a ratio, one step of a state machine), the spec replaces one input, and
the agent also writes `adapter.mjs` and `cases.system.json`: the same cases
with your system's real inputs, which your tests read. Several requirements
get one `test-case-designer` subagent each. Everything it writes stays under
`generated/` in your workspace; this repo stores nothing about the systems
you test.

You get back a table of cases with expected results, the context, spec and
cases file paths (plus the adapter and `cases.system.json` when there is
one), and the assumptions, open questions and gaps.

## Manual use

```bash
node src/pairwise.ts --spec spec.example.json
node src/bva.ts --name price --min 0.01 --max 999.99 --step 0.01
```

The spec format and full workflow are in
[`.cursor/skills/generating-test-cases/SKILL.md`](.cursor/skills/generating-test-cases/SKILL.md).

## Install in other projects

The repo is a Claude Code and Cursor plugin: the three skills, the three
subagents and the `qa-framework` MCP server (`bva`, `ep`, `pairwise`), which
runs the CLI in your project. It needs Node 22.18 or later and `git` on `PATH`,
and no `npm ci`.

```bash
npx github:siarhei-zavadski/qaFramework
```

It asks whether to install for Claude Code, Cursor or both, runs the steps
below, and checks that the MCP server answers. Other commands: `update`,
`uninstall`, `doctor` (`--smoke` adds one real Claude Code prompt). Flags:
`--claude`, `--cursor`, `--scope user|local|project`, `--cursor-mode config|plugin`,
`--yes`, `--dry-run`.

### Claude Code by hand

```
/plugin install qa-framework --marketplace siarhei-zavadski/qaFramework
```

or `/plugin marketplace add siarhei-zavadski/qaFramework`, then
`/plugin install qa-framework@siarhei-zavadski`. `--marketplace` needs Claude
Code 2.1.292 or later.

- **Scope:** the default `user` scope covers all your projects. Add `--scope local` to enable
  it only for you in one project.
- **Names:** skills and subagents are namespaced `qa-framework:`, for example
  `qa-framework:test-spec-reviewer`.
- **Desktop app:** start a new session to get the MCP tools.

To update, run `claude plugin marketplace update siarhei-zavadski` and
`claude plugin update qa-framework@siarhei-zavadski`, then `/reload-plugins`.
It picks up a new version only when `version` in `.claude-plugin/plugin.json`
changes.

For a team, commit this to the project's `.claude/settings.json` (each person
trusts the folder once; Claude Code then starts the plugin's MCP server
automatically):

```json
{
  "extraKnownMarketplaces": {
    "siarhei-zavadski": {
      "source": {"source": "github", "repo": "siarhei-zavadski/qaFramework"}
    }
  },
  "enabledPlugins": {"qa-framework@siarhei-zavadski": true}
}
```

### Cursor

Company-managed Cursor usually blocks local plugins (admin setting **Allow Local
Plugin Imports**). The installer therefore uses Cursor's user config by default:

- it adds a `qa-framework` server to `~/.cursor/mcp.json`;
- it links the skills into `~/.cursor/skills/` and the subagents into
  `~/.cursor/agents/`.

The links point at a clone in `~/.cursor/qa-framework`, which `update` pulls.

When your Cursor allows local plugins, the installer clones the repo into
`~/.cursor/plugins/local/qa-framework` as a plugin instead; `--cursor-mode`
picks either. Run **Developer: Reload Window** after installing.

Cursor can also import the Claude Code plugin ("Include Third-Party Plugins,
Skills, and Other Configs"). If qa-framework is then listed twice, turn that
setting off.

## Development

```bash
npm test && npm run typecheck && npm run format:check
npm run setup    # install from this checkout instead of GitHub
```

Installed from the checkout, Claude Code loads the plugin in place and Cursor's
links point at the checkout: edits apply after `/reload-plugins` or a window
reload. After changing `src/mcp.ts`, reconnect `qa-framework` in `/mcp` or
reload the window. For a one-off Claude Code session without installing:
`claude --plugin-dir .`.

Limits, and how conditions between fields and state transitions are modelled
instead: see "Known limits" in [`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE) © Siarhei Zavadski

Exercises in `fixtures/` come from [test-design.org](https://test-design.org)
and are not covered by this license.
