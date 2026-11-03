/**
 * @fileoverview Installer for Claude Code and Cursor. Plain JS: `npx` runs it
 * from node_modules, where Node won't strip TypeScript types.
 */

import {spawnSync} from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {createRequire} from 'node:module';
import {homedir, tmpdir} from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';

export const PLUGIN = 'qa-framework';
export const MARKETPLACE = 'siarhei-zavadski';
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
const OWN_REPO = 'siarhei-zavadski/qaFramework';
const MIN_CLAUDE = '2.1.292';
const MIN_AGENT = '2026.08.11';
const TOOLS = ['bva', 'ep', 'pairwise'];
const COMMANDS = ['install', 'update', 'uninstall', 'doctor', 'help'];
const SCOPES = ['user', 'local', 'project'];
const CURSOR_MODES = ['config', 'plugin'];
const WINDOWS = process.platform === 'win32';

export const USAGE = `Usage: npx github:siarhei-zavadski/qaFramework [command] [options]

Commands:
  install    Install for Claude Code and/or Cursor (default)
  update     Update what is installed
  uninstall  Remove it
  doctor     Check the installation, read-only
  help       Show this text

Options:
  --claude               Claude Code
  --cursor               Cursor (desktop and the agent CLI)
  --scope <scope>        Claude Code scope: user (default), local or project
  --cursor-mode <mode>   config: ~/.cursor/mcp.json + skill and agent links
                         (default); plugin: local plugin, if your Cursor
                         admin allows local plugins (picked automatically then)
  --source <source>      A local checkout path or owner/repo
  --yes, -y              Don't ask before uninstalling
  --dry-run              Print the steps without running them
  --smoke                With doctor: one real Claude Code prompt that calls bva

Without --claude or --cursor, it asks which tools to set up.`;

/**
 * @typedef {'install' | 'update' | 'uninstall' | 'doctor' | 'help'} Command
 * @typedef {'user' | 'local' | 'project'} Scope
 * @typedef {'config' | 'plugin'} CursorMode
 * @typedef {'claude' | 'cursor'} Harness
 */

/**
 * @typedef {object} Options
 * @property {Command} command
 * @property {boolean} claude
 * @property {boolean} cursor
 * @property {Scope | undefined} scope
 * @property {CursorMode | undefined} cursorMode
 * @property {string | undefined} source
 * @property {boolean} yes
 * @property {boolean} dryRun
 * @property {boolean} smoke
 */

/**
 * @typedef {object} ClaudePlugin
 * @property {string} id
 * @property {string} scope
 * @property {boolean} enabled
 * @property {string | undefined} installPath
 * @property {string | undefined} readFromFolder
 * @property {string | undefined} projectPath
 */

/**
 * @typedef {object} ClaudeEnv
 * @property {string | undefined} version
 * @property {Array<Record<string, unknown>>} marketplaces
 * @property {ClaudePlugin[]} plugins
 */

/**
 * @typedef {object} Clone
 * @property {string} path
 * @property {'absent' | 'clone' | 'other'} state
 * @property {string | undefined} origin
 * @property {boolean} dirty
 */

/**
 * @typedef {object} McpServer
 * @property {string} command
 * @property {string[]} args
 */

/**
 * Relative to the Cursor root this run installs from. `dangling` and
 * `other-root` point at a qaFramework tree that is gone or elsewhere.
 * @typedef {'missing' | 'ours' | 'dangling' | 'other-root' | 'foreign'} EntryState
 */

/**
 * @typedef {object} Link
 * @property {string} path
 * @property {string} target
 * @property {EntryState} state
 * @property {string | undefined} otherRoot
 */

/**
 * @typedef {object} CursorEnv
 * @property {boolean} home
 * @property {string | undefined} cli
 * @property {string | undefined} cliVersion
 * @property {boolean | undefined} localPlugins
 * @property {Clone} plugin
 * @property {Clone} copy
 * @property {string} root
 * @property {string} mcpFile
 * @property {EntryState | 'stale-node' | 'invalid'} mcpState
 * @property {McpServer | undefined} mcpServer
 * @property {string | undefined} mcpOtherRoot
 * @property {string | undefined} mcpError
 * @property {boolean} mcpComments
 * @property {Link[]} links
 * @property {Link[]} extraLinks
 * @property {string[]} marketplaceCopies
 */

/**
 * @typedef {object} Env
 * @property {string} root
 * @property {'checkout' | 'package'} mode
 * @property {boolean} hasManifests
 * @property {string} source
 * @property {string} cloneUrl
 * @property {boolean} sourceDirty
 * @property {boolean} git
 * @property {boolean} tty
 * @property {string} cwd
 * @property {string} node
 * @property {ClaudeEnv} claude
 * @property {CursorEnv} cursor
 */

/**
 * @typedef {{kind: 'run', harness: Harness, cmd: string, args: string[],
 *   cwd?: string, json?: boolean}} RunStep
 * @typedef {RunStep
 *   | {kind: 'remove', harness: Harness, path: string}
 *   | {kind: 'link', harness: Harness, path: string, target: string}
 *   | {kind: 'unlink', harness: Harness, path: string}
 *   | {kind: 'mcp-set', harness: Harness, file: string, server: McpServer}
 *   | {kind: 'mcp-remove', harness: Harness, file: string}
 *   | {kind: 'verify', harness: Harness, mode?: CursorMode, scope?: string}
 *   | {kind: 'note' | 'skip' | 'stop', harness: Harness, text: string}} Step
 */

/**
 * @typedef {object} Result
 * @property {boolean} ok
 * @property {string} message
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = {
    command: 'install',
    claude: false,
    cursor: false,
    scope: undefined,
    cursorMode: undefined,
    source: undefined,
    yes: false,
    dryRun: false,
    smoke: false,
  };
  let commandSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s) : [arg];
    const value = () => {
      const next = inline ?? argv[++i];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${flag} needs a value`);
      }
      return next;
    };
    if (flag === '--claude') options.claude = true;
    else if (flag === '--cursor') options.cursor = true;
    else if (flag === '--yes' || flag === '-y') options.yes = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--smoke') options.smoke = true;
    else if (flag === '--help' || flag === '-h') options.command = 'help';
    else if (flag === '--source') options.source = value();
    else if (flag === '--scope') {
      const scope = value();
      if (!isScope(scope)) {
        throw new Error(`--scope must be one of ${SCOPES.join(', ')}`);
      }
      options.scope = scope;
    } else if (flag === '--cursor-mode') {
      const mode = value();
      if (!isCursorMode(mode)) {
        throw new Error(
          `--cursor-mode must be one of ${CURSOR_MODES.join(', ')}`,
        );
      }
      options.cursorMode = mode;
    } else if (!commandSeen && isCommand(arg)) {
      options.command = options.command === 'help' ? 'help' : arg;
      commandSeen = true;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

/**
 * @param {string} value
 * @returns {value is Command}
 */
function isCommand(value) {
  return COMMANDS.includes(value);
}

/**
 * @param {string} value
 * @returns {value is Scope}
 */
function isScope(value) {
  return SCOPES.includes(value);
}

/**
 * @param {string} value
 * @returns {value is CursorMode}
 */
function isCursorMode(value) {
  return CURSOR_MODES.includes(value);
}

/** @param {string} source */
export function isRemote(source) {
  if (isAbsolute(source)) return false;
  return (
    /^(https?:\/\/|git@|ssh:\/\/)/.test(source) ||
    /^[\w.-]+\/[\w.-]+$/.test(source)
  );
}

/**
 * @param {string} root
 * @param {'checkout' | 'package'} mode
 * @param {string | undefined} flag
 * @param {unknown} pkg
 * @returns {{source: string, cloneUrl: string}}
 */
export function resolveSource(root, mode, flag, pkg) {
  if (
    flag !== undefined &&
    (flag.startsWith('-') || (WINDOWS && /[&|<>^%"`]/.test(flag)))
  ) {
    throw new Error(`--source ${flag}: unsafe characters`);
  }
  if (flag !== undefined && /^(\/|\.|~)/.test(flag)) {
    const local = resolve(flag.replace(/^~(?=$|[/\\])/, homedir()));
    if (!existsSync(local))
      throw new Error(`--source ${flag}: no such directory`);
    const path = realpathSync(local);
    return {source: path, cloneUrl: path};
  }
  if (flag !== undefined) {
    const repo = flag.replace(/^github:/, '');
    if (/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return {source: repo, cloneUrl: `https://github.com/${repo}.git`};
    }
    if (/^(https:\/\/|git@|ssh:\/\/)/.test(flag))
      return {source: flag, cloneUrl: flag};
    throw new Error(
      `--source ${flag}: use a path (/…, ./…, ~/…), owner/repo or an https/ssh URL`,
    );
  }
  if (mode === 'checkout') return {source: root, cloneUrl: root};
  const repository = isRecord(pkg) ? pkg.repository : undefined;
  const spec = isRecord(repository) ? repository.url : repository;
  const match =
    typeof spec === 'string'
      ? /(?:github:|github\.com[/:])([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(spec)
      : null;
  if (!match?.[1]) {
    throw new Error('package.json has no GitHub repository; pass --source');
  }
  return {source: match[1], cloneUrl: `https://github.com/${match[1]}.git`};
}

/**
 * In-place plugins report their folder as readFromFolder, not installPath.
 * @param {ClaudePlugin} plugin
 */
export function pluginRoot(plugin) {
  return plugin.readFromFolder ?? plugin.installPath;
}

/**
 * Last line of `claude plugin … --json`; usage errors print none.
 * @param {string} stdout
 * @returns {Result}
 */
export function parseResult(stdout) {
  const last = stdout.trim().split('\n').at(-1) ?? '';
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch {
    return {ok: false, message: 'no result line'};
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.command !== 'string' ||
    typeof parsed.outcome !== 'string' ||
    typeof parsed.message !== 'string'
  ) {
    return {ok: false, message: 'no result line'};
  }
  const code =
    typeof parsed.failureCode === 'string' ? ` (${parsed.failureCode})` : '';
  return {ok: parsed.outcome === 'ok', message: `${parsed.message}${code}`};
}

/**
 * Plugin mode only when the Cursor admin settings allow local plugins.
 * @param {Options} options
 * @param {Env} env
 * @returns {CursorMode}
 */
export function cursorMode(options, env) {
  return options.cursorMode ?? (env.cursor.localPlugins ? 'plugin' : 'config');
}

/**
 * Pure, so src/check.ts can test it.
 * @param {Options} options
 * @param {Env} env
 * @returns {Step[]}
 */
export function planSteps(options, env) {
  /** @type {Step[]} */
  const steps = [];
  for (const harness of /** @type {Harness[]} */ (['claude', 'cursor'])) {
    if (!options[harness]) continue;
    const planner = PLANNERS[options.command]?.[harness];
    if (planner) planner(options, env, steps);
  }
  if (
    options.command === 'install' &&
    !isRemote(env.source) &&
    !steps.some(step => step.kind === 'stop')
  ) {
    steps.push(
      note(
        options.claude ? 'claude' : 'cursor',
        `Installed from ${env.source}: whatever it has checked out is live in every project.`,
      ),
    );
  }
  if (options.command === 'install' && options.claude && options.cursor) {
    steps.push(
      note(
        'cursor',
        'Cursor can also import the Claude Code plugin ("Include Third-Party ' +
          'Plugins, Skills, and Other Configs"), listing qa-framework twice: ' +
          'turn that setting off if it does.',
      ),
    );
  }
  return steps;
}

/** @typedef {(options: Options, env: Env, steps: Step[]) => void} Planner */

/** @type {Record<string, Record<Harness, Planner>>} */
const PLANNERS = {
  install: {claude: planClaudeInstall, cursor: planCursorInstall},
  update: {claude: planClaudeUpdate, cursor: planCursorUpdate},
  uninstall: {claude: planClaudeUninstall, cursor: planCursorUninstall},
};

/** @type {Planner} */
function planClaudeInstall(options, env, steps) {
  if (!claudeUsable(env, steps)) return;
  const scope = options.scope ?? 'user';
  const remote = isRemote(env.source);
  if (scope === 'project' && !remote) {
    steps.push(
      stop(
        'claude',
        '--scope project commits the plugin for everyone in this repo, and a ' +
          'local path would not resolve for them: use --scope local, or ' +
          '--source siarhei-zavadski/qaFramework',
      ),
    );
    return;
  }
  if (!marketplaceFree(env, steps)) return;
  const here = installedAt(env, scope);
  if (here.some(p => p.enabled)) {
    steps.push(skip('claude', `already installed at ${scope} scope`));
  } else if (here.length) {
    steps.push(
      claudeRun(env, [
        'plugin',
        'enable',
        PLUGIN_ID,
        '--scope',
        scope,
        '--json',
      ]),
    );
  } else if (scope === 'project') {
    steps.push(
      claudeRun(env, [
        'plugin',
        'marketplace',
        'add',
        env.source,
        '--scope',
        'project',
        '--json',
      ]),
      claudeRun(env, [
        'plugin',
        'install',
        PLUGIN_ID,
        '--scope',
        'project',
        '--json',
      ]),
      note(
        'claude',
        'Each person who opens this project trusts the folder once; Claude ' +
          'Code then starts the qa-framework MCP server automatically.',
      ),
    );
  } else {
    steps.push(
      claudeRun(env, [
        'plugin',
        'install',
        PLUGIN,
        '--marketplace',
        env.source,
        '--scope',
        scope,
        '-y',
        '--json',
      ]),
    );
  }
  steps.push(
    {kind: 'verify', harness: 'claude', scope},
    note(
      'claude',
      'Run /reload-plugins in open sessions or start a new one (the desktop ' +
        'app needs a new session for MCP tools). Skills and subagents are ' +
        'named qa-framework:<name>.',
    ),
  );
}

/** @type {Planner} */
function planCursorInstall(options, env, steps) {
  const cursor = env.cursor;
  if (!cursor.home && !cursor.cli) {
    steps.push(
      stop('cursor', 'Cursor not found (no ~/.cursor and no `agent` CLI)'),
    );
    return;
  }
  if (!env.hasManifests) {
    steps.push(stop('cursor', noManifests(env)));
    return;
  }
  if (cursorMode(options, env) === 'plugin') {
    planPluginInstall(env, steps);
  } else {
    planConfigInstall(env, steps);
  }
  cursorWarnings(options, env).forEach(text =>
    steps.push(note('cursor', text)),
  );
}

/**
 * @param {Env} env
 * @param {Step[]} steps
 */
function planPluginInstall(env, steps) {
  const plugin = env.cursor.plugin;
  if (!needsGit(env, steps)) return;
  if (plugin.state === 'absent') {
    steps.push(cloneStep(env, plugin.path));
    if (env.sourceDirty) {
      steps.push(
        note(
          'cursor',
          'The checkout has uncommitted changes; the clone gets committed ' +
            'changes only.',
        ),
      );
    }
  } else if (!ours(env, plugin)) {
    steps.push(notOurs(env, plugin));
    return;
  } else {
    steps.push(skip('cursor', `plugin already at ${plugin.path}`));
  }
  steps.push(
    {kind: 'verify', harness: 'cursor', mode: 'plugin'},
    note(
      'cursor',
      'Run "Developer: Reload Window" in Cursor. The CLI loads it with ' +
        `\`agent --plugin-dir ${plugin.path}\`.`,
    ),
  );
}

/**
 * @param {Env} env
 * @param {Step[]} steps
 */
function planConfigInstall(env, steps) {
  const cursor = env.cursor;
  /** @type {Step[]} */
  const planned = [];
  if (isRemote(env.source)) {
    if (!needsGit(env, steps)) return;
    if (cursor.copy.state === 'absent') {
      planned.push(cloneStep(env, cursor.copy.path));
    } else if (!ours(env, cursor.copy)) {
      steps.push(notOurs(env, cursor.copy));
      return;
    }
  }
  if (!configRepairs(env, planned, steps, true)) return;
  if (!planned.length) {
    steps.push(skip('cursor', `already set up from ${cursor.root}`));
  }
  steps.push(
    ...planned,
    {kind: 'verify', harness: 'cursor', mode: 'config'},
    note(
      'cursor',
      `Cursor reads ${cursor.mcpFile}, ~/.cursor/skills and ~/.cursor/agents; ` +
        'reload the window if qa-framework does not appear.',
    ),
  );
}

/**
 * Plans what brings the server entry and links in line with cursor.root.
 * Install stops on conflicts; update notes them and carries on.
 * @param {Env} env
 * @param {Step[]} planned
 * @param {Step[]} steps
 * @param {boolean} strict
 * @returns {boolean} false when a stop was planned
 */
function configRepairs(env, planned, steps, strict) {
  const cursor = env.cursor;
  /** @type {(text: string) => boolean} */
  const conflict = text => {
    if (strict) {
      steps.push(stop('cursor', text));
      return false;
    }
    if (!planned.some(step => 'text' in step && step.text === text)) {
      planned.push(note('cursor', text));
    }
    return true;
  };
  const server = mcpServerFor(env);
  const state = cursor.mcpState;
  if (state === 'invalid') {
    return conflict(invalidMcp(cursor));
  }
  if (state === 'missing' || state === 'stale-node' || state === 'dangling') {
    if (cursor.mcpComments) {
      if (!conflict(byHand(cursor, server))) return false;
    } else {
      planned.push({
        kind: 'mcp-set',
        harness: 'cursor',
        file: cursor.mcpFile,
        server,
      });
    }
  } else if (state === 'other-root') {
    if (!conflict(otherRootHint(cursor.mcpOtherRoot))) return false;
  } else if (state === 'foreign') {
    const args = cursor.mcpServer?.args.join(' ') ?? '';
    if (
      !conflict(
        `${cursor.mcpFile} already has a ${PLUGIN} server (${args}): remove it first`,
      )
    ) {
      return false;
    }
  }
  for (const link of cursor.links) {
    if (link.state === 'missing') {
      planned.push(linkStep(link));
    } else if (link.state === 'dangling') {
      planned.push(
        {kind: 'unlink', harness: 'cursor', path: link.path},
        linkStep(link),
      );
    } else if (link.state === 'other-root') {
      if (!conflict(otherRootHint(link.otherRoot))) return false;
    } else if (link.state === 'foreign') {
      if (!conflict(`${link.path} already exists: move it away first`))
        return false;
    }
  }
  for (const link of cursor.extraLinks) {
    if (link.state === 'ours' || link.state === 'dangling') {
      planned.push({kind: 'unlink', harness: 'cursor', path: link.path});
    }
  }
  return true;
}

/** @type {Planner} */
function planClaudeUpdate(options, env, steps) {
  if (!claudeUsable(env, steps)) return;
  const installed = relevantPlugins(env).filter(
    p => options.scope === undefined || p.scope === options.scope,
  );
  if (!installed.length) {
    steps.push(skip('claude', 'not installed'));
    return;
  }
  const scopes = [
    ...new Set(
      installed.filter(p => p.readFromFolder === undefined).map(p => p.scope),
    ),
  ];
  for (const plugin of installed) {
    if (plugin.readFromFolder === undefined) continue;
    steps.push(
      skip(
        'claude',
        `${plugin.scope} scope loads in place from ${plugin.readFromFolder}: ` +
          'run /reload-plugins; after editing src/mcp.ts, reconnect ' +
          'qa-framework in /mcp',
      ),
    );
  }
  if (!scopes.length) return;
  steps.push(
    claudeRun(env, ['plugin', 'marketplace', 'update', MARKETPLACE, '--json']),
  );
  for (const scope of scopes) {
    steps.push(
      claudeRun(env, [
        'plugin',
        'update',
        PLUGIN_ID,
        '--scope',
        scope,
        '--json',
      ]),
    );
  }
  steps.push(
    note(
      'claude',
      'Restart Claude Code if a new version was installed; a GitHub install ' +
        'only updates when `version` in plugin.json changes.',
    ),
  );
}

/** @type {Planner} */
function planCursorUpdate(_options, env, steps) {
  const cursor = env.cursor;
  /** @type {Step[]} */
  const planned = [];
  const clones = [cursor.plugin, cursor.copy].filter(c => c.state !== 'absent');
  for (const clone of clones) {
    if (!ours(env, clone)) {
      planned.push(
        note('cursor', `kept ${clone.path}: not installed from here`),
      );
    } else if (clone.dirty) {
      steps.push(dirty(clone));
      return;
    } else {
      planned.push(pullStep(clone));
    }
  }
  const configured =
    ['ours', 'stale-node', 'dangling'].includes(cursor.mcpState) ||
    cursor.links.some(link => link.state === 'ours');
  if (configured) {
    configRepairs(env, planned, steps, false);
    if (!isRemote(env.source)) {
      planned.push(
        skip(
          'cursor',
          `links point at ${cursor.root}: edits apply after Reload Window`,
        ),
      );
    }
    planned.push({kind: 'verify', harness: 'cursor', mode: 'config'});
  }
  if (ours(env, cursor.plugin)) {
    planned.push({kind: 'verify', harness: 'cursor', mode: 'plugin'});
  }
  if (!planned.some(step => step.kind !== 'note')) {
    steps.push(skip('cursor', 'not installed'), ...planned);
    return;
  }
  steps.push(
    ...planned,
    note('cursor', 'Run "Developer: Reload Window" in Cursor.'),
  );
}

/** @type {Planner} */
function planClaudeUninstall(options, env, steps) {
  if (!env.claude.version) {
    steps.push(skip('claude', 'Claude Code (`claude`) is not on PATH'));
    return;
  }
  const scope = options.scope ?? 'user';
  const all = relevantPlugins(env);
  const here = installedAt(env, scope);
  const market = env.claude.marketplaces.find(m => m.name === MARKETPLACE);
  if (!here.length) {
    const elsewhere = [...new Set(all.map(p => p.scope))];
    const hint = elsewhere.length
      ? ` (installed at ${elsewhere.join(', ')} scope: pass --scope)`
      : '';
    steps.push(skip('claude', `not installed at ${scope} scope${hint}`));
  } else {
    steps.push(
      claudeRun(env, [
        'plugin',
        'uninstall',
        PLUGIN_ID,
        '--scope',
        scope,
        '--json',
      ]),
    );
  }
  const others = env.claude.plugins.filter(
    p => p.id === PLUGIN_ID && !here.includes(p),
  );
  if (!market) return;
  if (!sameSource(market, env.source)) {
    steps.push(
      note(
        'claude',
        `Kept the ${MARKETPLACE} marketplace: added from ${describeSource(market)}.`,
      ),
    );
  } else if (others.length) {
    const scopes = [...new Set(others.map(p => p.scope))].join(', ');
    steps.push(
      note('claude', `Marketplace kept: still installed at ${scopes} scope.`),
    );
  } else {
    steps.push(
      claudeRun(env, [
        'plugin',
        'marketplace',
        'remove',
        MARKETPLACE,
        '--json',
      ]),
    );
  }
}

/** @type {Planner} */
function planCursorUninstall(_options, env, steps) {
  const cursor = env.cursor;
  /** @type {Step[]} */
  const planned = [];
  for (const clone of [cursor.plugin, cursor.copy]) {
    if (clone.state === 'absent') continue;
    if (!ours(env, clone)) {
      planned.push(
        note('cursor', `kept ${clone.path}: not installed from here`),
      );
    } else if (clone.dirty) {
      steps.push(dirty(clone));
      return;
    } else {
      planned.push({kind: 'remove', harness: 'cursor', path: clone.path});
    }
  }
  const state = cursor.mcpState;
  if (state === 'invalid') {
    planned.push(
      note('cursor', `${invalidMcp(cursor)}; remove "${PLUGIN}" by hand`),
    );
  } else if (
    state === 'ours' ||
    state === 'stale-node' ||
    state === 'dangling'
  ) {
    planned.push(
      cursor.mcpComments
        ? note(
            'cursor',
            `remove "${PLUGIN}" from ${cursor.mcpFile} by hand (it has comments)`,
          )
        : {kind: 'mcp-remove', harness: 'cursor', file: cursor.mcpFile},
    );
  } else if (state === 'other-root') {
    planned.push(note('cursor', otherRootHint(cursor.mcpOtherRoot)));
  } else if (state === 'foreign') {
    planned.push(
      note(
        'cursor',
        `kept the ${PLUGIN} server in ${cursor.mcpFile}: not ours`,
      ),
    );
  }
  for (const link of [...cursor.links, ...cursor.extraLinks]) {
    if (link.state === 'ours' || link.state === 'dangling') {
      planned.push({kind: 'unlink', harness: 'cursor', path: link.path});
    } else if (link.state === 'other-root') {
      const text = otherRootHint(link.otherRoot);
      if (!planned.some(step => 'text' in step && step.text === text)) {
        planned.push(note('cursor', text));
      }
    }
  }
  if (!planned.some(step => step.kind !== 'note')) {
    steps.push(skip('cursor', 'not installed'), ...planned);
    return;
  }
  steps.push(
    ...planned,
    note('cursor', 'Run "Developer: Reload Window" in Cursor.'),
  );
}

/**
 * @param {Env} env
 * @param {Step[]} steps
 */
function claudeUsable(env, steps) {
  const version = env.claude.version;
  if (!version) {
    steps.push(
      stop(
        'claude',
        'Claude Code (`claude`) is not on PATH: install it or leave out Claude Code',
      ),
    );
    return false;
  }
  if (compareVersions(version, MIN_CLAUDE) < 0) {
    steps.push(
      stop(
        'claude',
        `Claude Code ${version} found; this needs ${MIN_CLAUDE} or later ` +
          '(run `claude update`)',
      ),
    );
    return false;
  }
  if (!env.hasManifests) {
    steps.push(stop('claude', noManifests(env)));
    return false;
  }
  return true;
}

/**
 * @param {Env} env
 * @param {Step[]} steps
 */
function needsGit(env, steps) {
  if (env.git) return true;
  steps.push(stop('cursor', '`git` is not on PATH; this needs a clone'));
  return false;
}

/** @param {Env} env */
function noManifests(env) {
  return env.mode === 'package'
    ? 'the downloaded package has no plugin manifests (.claude-plugin/, ' +
        '.cursor-plugin/)'
    : `${env.root} has no .claude-plugin/ or .cursor-plugin/ manifests`;
}

/**
 * @param {Env} env
 * @param {Step[]} steps
 */
function marketplaceFree(env, steps) {
  const market = env.claude.marketplaces.find(m => m.name === MARKETPLACE);
  if (!market || sameSource(market, env.source)) return true;
  steps.push(
    stop(
      'claude',
      `a marketplace named ${MARKETPLACE} is already added from another ` +
        `source (${describeSource(market)}). Remove it with ` +
        `\`claude plugin marketplace remove ${MARKETPLACE}\` (this also ` +
        'uninstalls its plugins), or pass the same --source',
    ),
  );
  return false;
}

/** @param {CursorEnv} cursor */
function invalidMcp(cursor) {
  return (
    `${cursor.mcpFile} is not valid JSON (${cursor.mcpError ?? 'unreadable'}); ` +
    'Cursor tolerates some errors, but the installer will not rewrite it: fix it first'
  );
}

/**
 * @param {CursorEnv} cursor
 * @param {McpServer} server
 */
function byHand(cursor, server) {
  return (
    `${cursor.mcpFile} has comments, which a rewrite would drop. Set this ` +
    `under "mcpServers" by hand, then rerun: "${PLUGIN}": ${JSON.stringify(server)}`
  );
}

/** @param {string | undefined} root */
function otherRootHint(root) {
  return (
    `qa-framework entries come from the install at ${root}: rerun with ` +
    `--source ${root}, or uninstall with that --source first`
  );
}

/** @param {Env} env */
function mcpServerFor(env) {
  return {command: env.node, args: [join(env.cursor.root, 'src', 'mcp.ts')]};
}

/**
 * @param {Link} link
 * @returns {Step}
 */
function linkStep(link) {
  return {
    kind: 'link',
    harness: 'cursor',
    path: link.path,
    target: link.target,
  };
}

/**
 * Plugin installs Claude Code lists for this directory: local and project
 * entries of other projects are left alone.
 * @param {Env} env
 */
function relevantPlugins(env) {
  return env.claude.plugins.filter(
    p =>
      p.id === PLUGIN_ID &&
      (p.scope === 'user' ||
        p.projectPath === undefined ||
        samePath(p.projectPath, env.cwd)),
  );
}

/**
 * @param {Env} env
 * @param {string} scope
 */
function installedAt(env, scope) {
  return relevantPlugins(env).filter(p => p.scope === scope);
}

/**
 * @param {Env} env
 * @param {Clone} clone
 */
function ours(env, clone) {
  return (
    clone.state === 'clone' &&
    clone.origin !== undefined &&
    sameSource({origin: clone.origin}, env.cloneUrl)
  );
}

/**
 * @param {Env} env
 * @param {Clone} clone
 * @returns {Step}
 */
function notOurs(env, clone) {
  const what =
    clone.state === 'clone'
      ? `a clone of ${clone.origin ?? 'an unknown origin'}`
      : 'not a git clone';
  return stop(
    'cursor',
    `${clone.path} is ${what}, not of ${env.cloneUrl}: move it away first`,
  );
}

/**
 * @param {Clone} clone
 * @returns {Step}
 */
function dirty(clone) {
  return stop(
    'cursor',
    `${clone.path} has local changes, unpushed commits or stashes: ` +
      'push or remove them first',
  );
}

/**
 * @param {Env} env
 * @param {string} path
 * @returns {Step}
 */
function cloneStep(env, path) {
  return {
    kind: 'run',
    harness: 'cursor',
    cmd: 'git',
    args: ['clone', '--quiet', env.cloneUrl, path],
  };
}

/**
 * @param {Clone} clone
 * @returns {Step}
 */
function pullStep(clone) {
  return {
    kind: 'run',
    harness: 'cursor',
    cmd: 'git',
    args: ['-C', clone.path, 'pull', '--ff-only', '--quiet'],
  };
}

/**
 * @param {Options} options
 * @param {Env} env
 * @returns {string[]}
 */
export function cursorWarnings(options, env) {
  const cursor = env.cursor;
  const mode = cursorMode(options, env);
  /** @type {string[]} */
  const warnings = [];
  if (mode === 'plugin' && cursor.localPlugins === false) {
    warnings.push(
      'Your Cursor admin blocks local plugins (Allow Local Plugin Imports), ' +
        'so the plugin will not load: use --cursor-mode config.',
    );
  }
  if (mode === 'config' && cursor.plugin.state !== 'absent') {
    warnings.push(
      `${cursor.plugin.path} is a local plugin ` +
        (cursor.localPlugins === false
          ? 'that Cursor ignores under your admin settings.'
          : 'and loads next to the user config: remove one.'),
    );
  }
  if (mode === 'plugin' && cursor.mcpServer) {
    warnings.push(
      `${cursor.mcpFile} also defines a ${PLUGIN} server, which runs next ` +
        "to the plugin's own: remove it from that file.",
    );
  }
  if (mode === 'plugin' && cursor.links.some(link => link.state === 'ours')) {
    warnings.push(
      '~/.cursor/skills and ~/.cursor/agents still link qa-framework and load ' +
        'next to the plugin: run uninstall --cursor first.',
    );
  }
  for (const copy of cursor.marketplaceCopies) {
    warnings.push(
      `A marketplace copy at ${copy} takes precedence over a local one.`,
    );
  }
  return warnings;
}

/**
 * @param {Env} env
 * @param {string[]} args
 * @returns {RunStep}
 */
function claudeRun(env, args) {
  return {
    kind: 'run',
    harness: 'claude',
    cmd: 'claude',
    args,
    cwd: env.cwd,
    json: true,
  };
}

/**
 * @param {Harness} harness
 * @param {string} text
 * @returns {Step}
 */
function note(harness, text) {
  return {kind: 'note', harness, text};
}

/**
 * @param {Harness} harness
 * @param {string} text
 * @returns {Step}
 */
function skip(harness, text) {
  return {kind: 'skip', harness, text};
}

/**
 * @param {Harness} harness
 * @param {string} text
 * @returns {Step}
 */
function stop(harness, text) {
  return {kind: 'stop', harness, text};
}

/**
 * @param {Record<string, unknown>} entry
 * @param {string} source
 */
function sameSource(entry, source) {
  const wanted = normalizeSource(source);
  return Object.entries(entry).some(
    ([key, value]) =>
      key !== 'name' &&
      typeof value === 'string' &&
      normalizeSource(value) === wanted,
  );
}

/** @param {string} source */
function normalizeSource(source) {
  const trimmed = source
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/^(https:\/\/|git@|ssh:\/\/git@)github\.com(:\d+)?[/:]/, '');
  if (isAbsolute(trimmed) && existsSync(trimmed)) return realpathSync(trimmed);
  return trimmed.toLowerCase();
}

/** @param {Record<string, unknown>} entry */
function describeSource(entry) {
  const fields = ['repo', 'url', 'path', 'source']
    .map(key => entry[key])
    .filter(value => typeof value === 'string');
  return fields.join(' ') || JSON.stringify(entry);
}

/**
 * @param {string} a
 * @param {string} b
 */
function samePath(a, b) {
  const real = (/** @type {string} */ path) =>
    existsSync(path) ? realpathSync(path) : resolve(path);
  return real(a) === real(b);
}

/**
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const left = a.split(/[.-]/).map(Number);
  const right = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/**
 * @param {unknown} x
 * @returns {x is Record<string, unknown>}
 */
function isRecord(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * @param {string} path
 * @returns {unknown}
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * ponytail: on Windows `shell` resolves claude.cmd but doesn't quote args;
 * quote them if a path with spaces must pass.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, timeout?: number, input?: string}} [options]
 */
function exec(cmd, args, options = {}) {
  const child = spawnSync(cmd, args, {
    cwd: options.cwd ?? (WINDOWS ? homedir() : undefined),
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    shell: WINDOWS,
    env: WINDOWS
      ? {...process.env, NoDefaultCurrentDirectoryInExePath: '1'}
      : process.env,
  });
  return {
    ok: !child.error && child.status === 0,
    status: child.status,
    stdout: child.stdout ?? '',
    stderr: child.stderr || child.error?.message || '',
  };
}

/**
 * @param {Options} options
 * @returns {Env}
 */
export function detect(options) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const mode = existsSync(join(root, '.git')) ? 'checkout' : 'package';
  const {source, cloneUrl} = resolveSource(
    root,
    mode,
    options.source,
    readJson(join(root, 'package.json')),
  );
  const git = exec('git', ['--version']).ok;
  const sourceDirty =
    mode === 'checkout' &&
    git &&
    exec('git', ['-C', root, 'status', '--porcelain']).stdout.trim() !== '';
  const node = stableNode();
  return {
    root,
    mode,
    hasManifests: [root, ...(isRemote(source) ? [] : [source])].every(
      dir =>
        existsSync(join(dir, '.claude-plugin', 'marketplace.json')) &&
        existsSync(join(dir, '.cursor-plugin', 'plugin.json')) &&
        existsSync(join(dir, 'src', 'mcp.ts')),
    ),
    source,
    cloneUrl,
    sourceDirty,
    git,
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    cwd: process.cwd(),
    node,
    claude: detectClaude(),
    cursor: detectCursor(root, source, git, node),
  };
}

/**
 * The `node` on PATH when it is this Node (often a stable symlink such as
 * /opt/homebrew/bin/node), else this Node's own path.
 */
function stableNode() {
  const name = WINDOWS ? 'node.exe' : 'node';
  const own = realpathSync(process.execPath);
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    if (dir && existsSync(candidate) && realpathSync(candidate) === own) {
      return candidate;
    }
  }
  return process.execPath;
}

/** @returns {ClaudeEnv} */
function detectClaude() {
  const version = /\d+\.\d+\.\d+/.exec(
    exec('claude', ['--version']).stdout,
  )?.[0];
  if (!version) return {version: undefined, marketplaces: [], plugins: []};
  const list = (/** @type {string[]} */ args) => {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(exec('claude', args).stdout);
    } catch {
      parsed = [];
    }
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  };
  const text = (/** @type {unknown} */ value) =>
    typeof value === 'string' ? value : undefined;
  return {
    version,
    marketplaces: list(['plugin', 'marketplace', 'list', '--json']),
    plugins: list(['plugin', 'list', '--json']).map(p => ({
      id: text(p.id) ?? '',
      scope: text(p.scope) ?? '',
      enabled: p.enabled !== false,
      installPath: text(p.installPath),
      readFromFolder: text(p.readFromFolder),
      projectPath: text(p.projectPath),
    })),
  };
}

/**
 * @param {string} root
 * @param {string} source
 * @param {boolean} git
 * @param {string} node
 * @returns {CursorEnv}
 */
function detectCursor(root, source, git, node) {
  const home = join(homedir(), '.cursor');
  let cli;
  let cliVersion;
  for (const name of ['agent', 'cursor-agent']) {
    const version = /^\d{4}\.\d{2}\.\d{2}\S*/.exec(
      exec(name, ['--version']).stdout.trim(),
    )?.[0];
    if (version) {
      cli = name;
      cliVersion = version;
      break;
    }
  }
  const copy = join(home, PLUGIN);
  const cursorRoot = isRemote(source) ? copy : source;
  const mcpFile = join(home, 'mcp.json');
  const cache = join(home, 'plugins', 'cache');
  /** @type {Link[]} */
  const links = [];
  for (const [kind, files] of /** @type {const} */ ([
    ['skills', false],
    ['agents', true],
  ])) {
    for (const name of listNames(join(root, '.cursor', kind), files)) {
      const path = join(home, kind, name);
      const target = join(cursorRoot, '.cursor', kind, name);
      links.push({path, target, ...classifyLink(path, cursorRoot, undefined)});
    }
  }
  const wanted = new Set(links.map(link => link.path));
  const mcp = readMcpFile(mcpFile, cursorRoot, node);
  const mcpScript = mcp.mcpServer?.args[0];
  const known = [cursorRoot, copy];
  if (mcpScript) known.push(dirname(dirname(resolve(mcpScript))));
  /** @type {Link[]} */
  const extraLinks = [];
  for (const kind of ['skills', 'agents']) {
    const dir = join(home, kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (wanted.has(path)) continue;
      const found = classifyLink(path, cursorRoot, known);
      if (found.state !== 'foreign') {
        extraLinks.push({path, target: path, ...found});
      }
    }
  }
  return {
    home: existsSync(home),
    cli,
    cliVersion,
    localPlugins: readLocalPluginPolicy(),
    plugin: detectClone(join(home, 'plugins', 'local', PLUGIN), git),
    copy: detectClone(copy, git),
    root: cursorRoot,
    mcpFile,
    ...mcp,
    links,
    extraLinks,
    marketplaceCopies: existsSync(cache)
      ? readdirSync(cache)
          .map(market => join(cache, market, PLUGIN))
          .filter(path => existsSync(path))
      : [],
  };
}

/**
 * A link is ours when it points at `<root>/.cursor/{skills,agents}/<its own
 * name>`; `dangling` when such a target is gone; `other-root` when it points
 * into another qaFramework tree.
 * A dangling link counts as ours only with one of this repo's names, or when
 * it points into a known qaFramework root (`known`).
 * @param {string} path
 * @param {string} cursorRoot
 * @param {string[] | undefined} known
 * @returns {{state: EntryState, otherRoot: string | undefined}}
 */
function classifyLink(path, cursorRoot, known) {
  let current;
  try {
    if (!lstatSync(path).isSymbolicLink()) {
      return {state: 'foreign', otherRoot: undefined};
    }
    current = resolve(dirname(path), readlinkSync(path));
  } catch {
    return {state: 'missing', otherRoot: undefined};
  }
  const match = /^(.*)[/\\]\.cursor[/\\](skills|agents)[/\\]([^/\\]+)$/.exec(
    current,
  );
  if (!match || match[3] !== basename(path)) {
    return {state: 'foreign', otherRoot: undefined};
  }
  const root = match[1] ?? '';
  if (
    known &&
    !existsSync(current) &&
    !known.some(dir => samePath(dir, root))
  ) {
    return {state: 'foreign', otherRoot: undefined};
  }
  return classifyRoot(root, current, cursorRoot);
}

/**
 * @param {string} root
 * @param {string} target
 * @param {string} cursorRoot
 * @returns {{state: EntryState, otherRoot: string | undefined}}
 */
function classifyRoot(root, target, cursorRoot) {
  if (!existsSync(target)) return {state: 'dangling', otherRoot: undefined};
  if (samePath(root, cursorRoot)) return {state: 'ours', otherRoot: undefined};
  return existsSync(join(root, '.cursor-plugin', 'plugin.json'))
    ? {state: 'other-root', otherRoot: root}
    : {state: 'foreign', otherRoot: undefined};
}

/**
 * @param {string} dir
 * @param {boolean} files
 */
function listNames(dir, files) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, {withFileTypes: true})
    .filter(entry => (files ? entry.name.endsWith('.md') : entry.isDirectory()))
    .map(entry => entry.name)
    .sort();
}

/**
 * Dirty also covers unpushed commits, a missing upstream and stashes, so
 * uninstall never deletes work that exists only there.
 * @param {string} path
 * @param {boolean} git
 * @returns {Clone}
 */
function detectClone(path, git) {
  if (!existsSync(join(path, '.git'))) {
    return {
      path,
      state: existsSync(path) ? 'other' : 'absent',
      origin: undefined,
      dirty: false,
    };
  }
  if (!git) return {path, state: 'clone', origin: undefined, dirty: true};
  const origin = exec('git', ['-C', path, 'remote', 'get-url', 'origin']);
  const status = exec('git', ['-C', path, 'status', '--porcelain', '--branch']);
  const lines = status.stdout.split('\n').filter(Boolean);
  const branch = lines[0] ?? '';
  const stash = exec('git', ['-C', path, 'stash', 'list']).stdout.trim();
  return {
    path,
    state: 'clone',
    origin: origin.stdout.trim() || undefined,
    dirty:
      !status.ok ||
      lines.length > 1 ||
      !branch.includes('...') ||
      /\[ahead /.test(branch) ||
      stash !== '',
  };
}

/**
 * @param {string} file
 * @param {string} cursorRoot
 * @param {string} node
 * @returns {Pick<CursorEnv, 'mcpState' | 'mcpServer' | 'mcpOtherRoot' |
 *   'mcpError' | 'mcpComments'>}
 */
function readMcpFile(file, cursorRoot, node) {
  const none = {
    mcpServer: undefined,
    mcpOtherRoot: undefined,
    mcpError: undefined,
  };
  if (!existsSync(file)) {
    return {...none, mcpState: 'missing', mcpComments: false};
  }
  const {value, comments, error} = parseJsonc(readFileSync(file, 'utf8'));
  if (!isRecord(value)) {
    return {
      ...none,
      mcpState: 'invalid',
      mcpError: error,
      mcpComments: comments,
    };
  }
  const servers = value.mcpServers;
  const entry = isRecord(servers) ? servers[PLUGIN] : undefined;
  if (!isRecord(entry)) {
    return {...none, mcpState: 'missing', mcpComments: comments};
  }
  const server = {
    command: String(entry.command ?? ''),
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
  };
  const script = server.args[0] ?? '';
  const match =
    server.args.length === 1
      ? /^(.*)[/\\]src[/\\]mcp\.ts$/.exec(resolve(script))
      : null;
  /** @type {{state: EntryState | 'stale-node', otherRoot: string | undefined}} */
  let found = {state: 'foreign', otherRoot: undefined};
  if (match) found = classifyRoot(match[1] ?? '', script, cursorRoot);
  if (
    found.state === 'ours' &&
    server.command !== node &&
    !existsSync(server.command)
  ) {
    found = {state: 'stale-node', otherRoot: undefined};
  }
  return {
    mcpState: found.state,
    mcpServer: server,
    mcpOtherRoot: found.otherRoot,
    mcpError: undefined,
    mcpComments: comments,
  };
}

/**
 * JSON with comments and trailing commas, which Cursor accepts.
 * @param {string} text
 * @returns {{value: unknown, comments: boolean, error: string | undefined}}
 */
export function parseJsonc(text) {
  const source = text.replace(/^﻿/, '');
  if (!source.trim()) return {value: {}, comments: false, error: undefined};
  let comments = false;
  let clean = '';
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '"') {
      const end = stringEnd(source, i);
      clean += source.slice(i, end);
      i = end - 1;
    } else if (source.startsWith('//', i)) {
      comments = true;
      const newline = source.indexOf('\n', i);
      i = newline < 0 ? source.length : newline - 1;
    } else if (source.startsWith('/*', i)) {
      comments = true;
      const close = source.indexOf('*/', i + 2);
      i = close < 0 ? source.length : close + 1;
    } else {
      clean += source[i];
    }
  }
  let json = '';
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '"') {
      const end = stringEnd(clean, i);
      json += clean.slice(i, end);
      i = end - 1;
    } else if (clean[i] !== ',' || !/^\s*[}\]]/.test(clean.slice(i + 1))) {
      json += clean[i];
    }
  }
  try {
    return {value: JSON.parse(json), comments, error: undefined};
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return {value: undefined, comments, error};
  }
}

/**
 * @param {string} text
 * @param {number} start index of the opening quote
 */
function stringEnd(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

/**
 * `allowUserLocalPluginImports` from Cursor's cached admin settings;
 * undefined when it can't be read.
 * ponytail: reads Cursor's internal state.vscdb; if its layout changes this
 * returns undefined and the installer falls back to config mode.
 * @returns {boolean | undefined}
 */
function readLocalPluginPolicy() {
  const appData =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : WINDOWS
        ? (process.env.APPDATA ?? '')
        : join(homedir(), '.config');
  const db = join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (!existsSync(db)) return undefined;
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    const sqlite = createRequire(import.meta.url)('node:sqlite');
    const database = new sqlite.DatabaseSync(db, {readOnly: true});
    try {
      const row = database
        .prepare(
          "select value from ItemTable where key = 'adminSettings.cached'",
        )
        .get();
      /** @type {unknown} */
      const settings = JSON.parse(String(row?.value ?? 'null'));
      const allowed = isRecord(settings)
        ? settings.allowUserLocalPluginImports
        : undefined;
      return typeof allowed === 'boolean' ? allowed : undefined;
    } finally {
      database.close();
    }
  } catch {
    return undefined;
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * Lists the server's tools; ok when bva, ep and pairwise answer.
 * @param {McpServer} server
 * @returns {Result}
 */
export function probe(server) {
  const rpc = (/** @type {number} */ id, /** @type {string} */ method) =>
    JSON.stringify({jsonrpc: '2.0', id, method, params: {}});
  const child = spawnSync(server.command, server.args, {
    encoding: 'utf8',
    timeout: 30_000,
    input: [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {protocolVersion: '2025-06-18'},
      }),
      JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}),
      rpc(2, 'tools/list'),
    ].join('\n'),
  });
  if (child.error) return {ok: false, message: child.error.message};
  /** @type {string[]} */
  let names = [];
  for (const line of (child.stdout ?? '').split('\n')) {
    /** @type {unknown} */
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const result =
      isRecord(message) && message.id === 2 ? message.result : undefined;
    const tools = isRecord(result) ? result.tools : undefined;
    if (Array.isArray(tools)) {
      names = tools.map(t => (isRecord(t) ? String(t.name) : ''));
    }
  }
  const missing = TOOLS.filter(tool => !names.includes(tool));
  return missing.length
    ? {
        ok: false,
        message: `missing ${missing.join(', ')}; ${child.stderr.trim() || 'no output'}`,
      }
    : {ok: true, message: `MCP server answers: ${names.join(', ')}`};
}

/**
 * Starts the server as the plugin manifest declares it. Checks command and
 * path only; the harness's own variable expansion is checked by doctor.
 * @param {string} root
 * @param {Harness} harness
 * @returns {Result}
 */
export function handshake(root, harness) {
  const manifest =
    harness === 'claude'
      ? readJson(join(root, '.claude-plugin', 'plugin.json'))
      : readJson(join(root, 'mcp.json'));
  const servers = isRecord(manifest) ? manifest.mcpServers : undefined;
  const server = isRecord(servers) ? servers[PLUGIN] : undefined;
  if (
    !isRecord(server) ||
    typeof server.command !== 'string' ||
    !Array.isArray(server.args)
  ) {
    return {
      ok: false,
      message: `no ${PLUGIN} server in the ${harness} manifest`,
    };
  }
  const variable =
    harness === 'claude' ? '${CLAUDE_PLUGIN_ROOT}' : '${CURSOR_PLUGIN_ROOT}';
  const expand = (/** @type {unknown} */ value) =>
    String(value).split(variable).join(root);
  return probe({
    command: expand(server.command),
    args: server.args.map(expand),
  });
}

/**
 * @param {Step[]} steps
 * @param {Options} options
 * @param {Env} env
 * @returns {boolean}
 */
export function runSteps(steps, options, env) {
  if (steps.some(step => step.kind === 'stop')) {
    for (const step of steps) {
      if (step.kind === 'stop') print('✖', step.harness, step.text);
    }
    console.log('Nothing was changed.');
    return false;
  }
  for (const step of steps) {
    if (!runStep(step, options.dryRun, env)) return false;
  }
  return true;
}

/**
 * @param {Step} step
 * @returns {string | undefined} what a changing step does
 */
function describe(step) {
  switch (step.kind) {
    case 'run':
      return [step.cmd, ...step.args].join(' ');
    case 'remove':
      return `delete ${step.path}`;
    case 'link':
      return `link ${step.path} -> ${step.target}`;
    case 'unlink':
      return `unlink ${step.path}`;
    case 'mcp-set':
      return `add ${PLUGIN} to ${step.file}: ${step.server.command} ${step.server.args.join(' ')}`;
    case 'mcp-remove':
      return `remove ${PLUGIN} from ${step.file}`;
    default:
      return undefined;
  }
}

/**
 * @param {Step} step
 * @param {boolean} dryRun
 * @param {Env} env
 */
function runStep(step, dryRun, env) {
  if (step.kind === 'note') {
    print('i', step.harness, step.text);
    return true;
  }
  if (step.kind === 'skip') {
    print('·', step.harness, step.text);
    return true;
  }
  if (step.kind === 'stop') return false;
  if (step.kind === 'verify') return verify(step, dryRun, env);
  if (step.kind === 'run') return runCommand(step, dryRun);
  print('→', step.harness, describe(step) ?? '');
  if (dryRun) return true;
  if (step.kind === 'remove') {
    rmSync(step.path, {recursive: true, force: true});
  } else if (step.kind === 'link') {
    mkdirSync(dirname(step.path), {recursive: true});
    // ponytail: Windows file symlinks need Developer Mode; dirs use junctions.
    const type = WINDOWS && !step.path.endsWith('.md') ? 'junction' : undefined;
    symlinkSync(step.target, step.path, type);
  } else if (step.kind === 'unlink') {
    unlinkSync(step.path);
  } else if (step.kind === 'mcp-set') {
    editMcpFile(step.file, step.server);
  } else if (step.kind === 'mcp-remove') {
    editMcpFile(step.file, undefined);
  }
  return true;
}

/**
 * Sets or removes the qa-framework server, keeping everything else.
 * @param {string} file
 * @param {McpServer | undefined} server
 */
function editMcpFile(file, server) {
  const config = existsSync(file)
    ? parseJsonc(readFileSync(file, 'utf8')).value
    : {};
  if (!isRecord(config)) throw new Error(`${file} is not valid JSON`);
  const servers = isRecord(config.mcpServers) ? {...config.mcpServers} : {};
  if (server) servers[PLUGIN] = server;
  else delete servers[PLUGIN];
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(
    file,
    `${JSON.stringify({...config, mcpServers: servers}, null, 2)}\n`,
  );
}

/**
 * @param {RunStep} step
 * @param {boolean} dryRun
 */
function runCommand(step, dryRun) {
  print('→', step.harness, describe(step) ?? '');
  if (dryRun) return true;
  const child = exec(step.cmd, step.args, {cwd: step.cwd, timeout: 300_000});
  const result = step.json
    ? parseResult(child.stdout)
    : {ok: child.ok, message: child.stderr.trim()};
  if (result.ok && child.ok) {
    if (step.json) print(' ', step.harness, result.message);
    return true;
  }
  print('✖', step.harness, `exit ${child.status}: ${result.message}`);
  if (child.stderr.trim()) console.error(child.stderr.trim());
  return false;
}

/**
 * @param {Extract<Step, {kind: 'verify'}>} step
 * @param {boolean} dryRun
 * @param {Env} env
 */
function verify(step, dryRun, env) {
  if (dryRun) {
    print('→', step.harness, 'check that the installed MCP server answers');
    return true;
  }
  const result = verifyResult(step, env);
  print(result.ok ? '✔' : '✖', step.harness, result.message);
  return result.ok;
}

/**
 * @param {Extract<Step, {kind: 'verify'}>} step
 * @param {Env} env
 * @returns {Result}
 */
function verifyResult(step, env) {
  const home = join(homedir(), '.cursor');
  if (step.harness === 'cursor' && step.mode === 'config') {
    const {mcpServer, mcpState} = readMcpFile(
      join(home, 'mcp.json'),
      env.cursor.root,
      env.node,
    );
    if (mcpServer && mcpState === 'ours') return probe(mcpServer);
    return {
      ok: false,
      message: `the ${PLUGIN} server in ~/.cursor/mcp.json is ${mcpState}, not started`,
    };
  }
  if (step.harness === 'cursor') {
    const clone = detectClone(join(home, 'plugins', 'local', PLUGIN), env.git);
    return ours(env, clone)
      ? handshake(clone.path, 'cursor')
      : {ok: false, message: `${clone.path} is not this install, not started`};
  }
  const fresh = {...env, claude: detectClaude()};
  const plugin =
    installedAt(fresh, step.scope ?? 'user')[0] ?? relevantPlugins(fresh)[0];
  const root = plugin ? pluginRoot(plugin) : undefined;
  return root
    ? handshake(root, 'claude')
    : {
        ok: false,
        message: `${PLUGIN_ID} is not listed by \`claude plugin list\``,
      };
}

/**
 * @param {string} mark
 * @param {Harness} harness
 * @param {string} text
 */
function print(mark, harness, text) {
  const name = harness === 'claude' ? 'Claude Code' : 'Cursor';
  console.log(`${mark} ${name}: ${text}`);
}

/**
 * @typedef {object} Check
 * @property {'ok' | 'warn' | 'fail' | 'skip'} status
 * @property {Harness | 'node'} harness
 * @property {string} text
 */

/**
 * @param {Options} options
 * @param {Env} env
 */
export function doctor(options, env) {
  /** @type {Check[]} */
  const checks = [
    {status: 'ok', harness: 'node', text: `Node ${process.versions.node}`},
  ];
  if (options.claude) checks.push(...claudeChecks(options, env));
  if (options.cursor) checks.push(...cursorChecks(options, env));
  const marks = {ok: '✔', warn: '⚠', fail: '✖', skip: '·'};
  for (const check of checks) {
    const name = {node: 'Node', claude: 'Claude Code', cursor: 'Cursor'}[
      check.harness
    ];
    console.log(`${marks[check.status]} ${name}: ${check.text}`);
  }
  return !checks.some(check => check.status === 'fail');
}

/**
 * @param {Options} options
 * @param {Env} env
 * @returns {Check[]}
 */
function claudeChecks(options, env) {
  const version = env.claude.version;
  if (!version) {
    return [
      {status: 'skip', harness: 'claude', text: '`claude` is not on PATH'},
    ];
  }
  /** @type {Check[]} */
  const checks = [
    {
      status: compareVersions(version, MIN_CLAUDE) < 0 ? 'warn' : 'ok',
      harness: 'claude',
      text: `Claude Code ${version} (installer needs ${MIN_CLAUDE}+)`,
    },
  ];
  const plugins = relevantPlugins(env);
  if (!plugins.length) {
    checks.push({
      status: 'skip',
      harness: 'claude',
      text: `${PLUGIN_ID} not installed`,
    });
    return checks;
  }
  const details = exec('claude', ['plugin', 'details', PLUGIN_ID], {
    cwd: env.cwd,
  });
  const count = (/** @type {string} */ label) =>
    Number(new RegExp(`${label} \\((\\d+)\\)`).exec(details.stdout)?.[1] ?? -1);
  // `plugin details` doesn't count agents listed by file; check those below.
  const skills = count('Skills');
  const servers = count('MCP servers');
  checks.push({
    status: skills === 3 && servers === 1 ? 'ok' : 'fail',
    harness: 'claude',
    text: `${skills} skills, ${servers} MCP server (expected 3, 1)`,
  });
  for (const plugin of plugins) {
    const root = pluginRoot(plugin);
    if (root) checks.push(claudeAgentsCheck(root));
    const where = plugin.readFromFolder
      ? 'in place (edits apply after /reload-plugins)'
      : 'copied (run update after changes)';
    checks.push({
      status: plugin.enabled ? 'ok' : 'warn',
      harness: 'claude',
      text: `${plugin.scope} scope, ${plugin.enabled ? 'enabled' : 'disabled'}, ${where}`,
    });
    if (!root) continue;
    checks.push(asCheck('claude', handshake(root, 'claude')));
    if (options.smoke) checks.push(claudeSmoke(plugin));
  }
  return checks;
}

/**
 * @param {string} root
 * @returns {Check}
 */
function claudeAgentsCheck(root) {
  const manifest = readJson(join(root, '.claude-plugin', 'plugin.json'));
  const agents = isRecord(manifest) ? manifest.agents : undefined;
  const files = Array.isArray(agents) ? agents.map(String) : [];
  const missing = files.filter(file => !existsSync(join(root, file)));
  return {
    status: files.length === 3 && !missing.length ? 'ok' : 'fail',
    harness: 'claude',
    text: missing.length
      ? `agent files missing: ${missing.join(', ')}`
      : `${files.length} agents (expected 3)`,
  };
}

/**
 * @param {Options} options
 * @param {Env} env
 * @returns {Check[]}
 */
function cursorChecks(options, env) {
  const cursor = env.cursor;
  if (!cursor.home && !cursor.cli) {
    return [{status: 'skip', harness: 'cursor', text: 'Cursor not found'}];
  }
  /** @type {Check[]} */
  const checks = [];
  if (cursor.cli && cursor.cliVersion) {
    checks.push({
      status: compareVersions(cursor.cliVersion, MIN_AGENT) < 0 ? 'warn' : 'ok',
      harness: 'cursor',
      text: `${cursor.cli} ${cursor.cliVersion} (checks need ${MIN_AGENT}+)`,
    });
  }
  /** @type {Record<string, string>} */
  const policy = {
    true: 'admin settings allow local plugins',
    false: 'admin settings block local plugins: using the user config',
    undefined: 'admin settings unknown: using the user config',
  };
  checks.push({
    status: 'ok',
    harness: 'cursor',
    text: `${policy[String(cursor.localPlugins)]} (mode: ${cursorMode(options, env)})`,
  });
  for (const text of cursorWarnings(options, env)) {
    checks.push({status: 'warn', harness: 'cursor', text});
  }
  const configured =
    ['ours', 'stale-node', 'dangling', 'other-root'].includes(
      cursor.mcpState,
    ) ||
    [...cursor.links, ...cursor.extraLinks].some(
      link => link.state !== 'missing' && link.state !== 'foreign',
    );
  if (configured) checks.push(...configChecks(env));
  if (cursor.plugin.state !== 'absent') checks.push(...pluginChecks(env));
  if (!configured && cursor.plugin.state === 'absent') {
    checks.push({status: 'skip', harness: 'cursor', text: 'not installed'});
  }
  return checks;
}

/**
 * @param {Env} env
 * @returns {Check[]}
 */
function configChecks(env) {
  const cursor = env.cursor;
  /** @type {Check[]} */
  const checks = [];
  /** @type {Record<string, string>} */
  const problems = {
    missing: `no ${PLUGIN} server in ${cursor.mcpFile}: run install`,
    invalid: invalidMcp(cursor),
    'stale-node': `${cursor.mcpServer?.command} is gone: run install to repair`,
    dangling: `${cursor.mcpServer?.args[0]} is gone: run install to repair`,
    'other-root': otherRootHint(cursor.mcpOtherRoot),
    foreign: `${cursor.mcpFile} has a ${PLUGIN} server that is not ours`,
  };
  if (cursor.mcpState === 'ours' && cursor.mcpServer) {
    checks.push(asCheck('cursor', probe(cursor.mcpServer)));
  } else {
    checks.push({
      status: cursor.mcpState === 'other-root' ? 'warn' : 'fail',
      harness: 'cursor',
      text: problems[cursor.mcpState] ?? cursor.mcpState,
    });
  }
  const elsewhere = cursor.links.filter(link => link.state === 'other-root');
  const broken = cursor.links.filter(
    link => link.state !== 'ours' && link.state !== 'other-root',
  );
  const stale = cursor.extraLinks.filter(
    link => link.state === 'ours' || link.state === 'dangling',
  );
  const hints = new Set(elsewhere.map(link => otherRootHint(link.otherRoot)));
  hints.delete(problems['other-root'] ?? '');
  for (const text of hints)
    checks.push({status: 'warn', harness: 'cursor', text});
  if (broken.length || stale.length) {
    checks.push({
      status: 'fail',
      harness: 'cursor',
      text: `links to fix (run install): ${[...broken, ...stale].map(link => link.path).join(', ')}`,
    });
  } else if (!elsewhere.length) {
    checks.push({
      status: 'ok',
      harness: 'cursor',
      text: `${cursor.links.length} skills and agents linked to ${cursor.root}`,
    });
  }
  if (isRemote(env.source) && cursor.copy.state === 'clone') {
    checks.push(upToDate(cursor.copy));
  }
  if (cursor.cli) checks.push(cliCheck(cursor.cli));
  return checks;
}

/**
 * @param {Env} env
 * @returns {Check[]}
 */
function pluginChecks(env) {
  const plugin = env.cursor.plugin;
  if (plugin.state === 'other' || !plugin.origin) {
    return [
      {
        status: 'fail',
        harness: 'cursor',
        text: `${plugin.path} is not a git clone`,
      },
    ];
  }
  const manifest = readJson(join(plugin.path, '.cursor-plugin', 'plugin.json'));
  const paths = isRecord(manifest) ? [manifest.skills, manifest.agents] : [];
  const missing = paths.filter(
    path => typeof path !== 'string' || !existsSync(join(plugin.path, path)),
  );
  return [
    {
      status: ours(env, plugin) ? 'ok' : 'warn',
      harness: 'cursor',
      text: `plugin clone of ${plugin.origin}${plugin.dirty ? ' with unpublished work' : ''}`,
    },
    upToDate(plugin),
    {
      status: paths.length && !missing.length ? 'ok' : 'fail',
      harness: 'cursor',
      text: missing.length
        ? `manifest paths missing: ${missing.join(', ')}`
        : 'manifest skills and agents paths exist',
    },
    ours(env, plugin)
      ? asCheck('cursor', handshake(plugin.path, 'cursor'))
      : {
          status: 'warn',
          harness: 'cursor',
          text: 'not starting its MCP server: the clone is not this install',
        },
  ];
}

/**
 * @param {Clone} clone
 * @returns {Check}
 */
function upToDate(clone) {
  const origin = clone.origin ?? '';
  const head = exec('git', [
    '-C',
    clone.path,
    'rev-parse',
    'HEAD',
  ]).stdout.trim();
  const upstream = isRemote(origin)
    ? exec('git', ['ls-remote', origin, 'HEAD']).stdout.split(/\s/)[0]
    : exec('git', ['-C', origin, 'rev-parse', 'HEAD']).stdout.trim();
  const current = Boolean(upstream) && upstream === head;
  return {
    status: current ? 'ok' : 'warn',
    harness: 'cursor',
    text: current
      ? `${clone.path} is up to date`
      : `${clone.path} differs from its source: run update`,
  };
}

/**
 * The `mcp` commands read ~/.cursor/mcp.json only, never plugins.
 * @param {string} cli
 * @returns {Check}
 */
function cliCheck(cli) {
  const listed = exec(cli, ['mcp', 'list'], {timeout: 60_000});
  const line = listed.stdout
    .split('\n')
    .find(row => row.startsWith(`${PLUGIN}:`));
  if (!line) {
    return {
      status: 'warn',
      harness: 'cursor',
      text: `\`${cli} mcp list\` doesn't show ${PLUGIN}: check Customize in Cursor`,
    };
  }
  const tools = exec(cli, ['mcp', 'list-tools', PLUGIN], {timeout: 60_000});
  const missing = TOOLS.filter(tool => !tools.stdout.includes(tool));
  return {
    status: missing.length ? 'fail' : 'ok',
    harness: 'cursor',
    text: missing.length
      ? `${cli}: ${line.trim()}; tools missing: ${missing.join(', ')}`
      : `${cli} connects to ${PLUGIN}: ${TOOLS.join(', ')}`,
  };
}

/**
 * @param {Harness} harness
 * @param {Result} result
 * @returns {Check}
 */
function asCheck(harness, result) {
  return {status: result.ok ? 'ok' : 'fail', harness, text: result.message};
}

/** @param {string} dir */
function smokePrompt(dir) {
  return (
    'Call the bva tool of the qa-framework MCP server with ' +
    `cwd=${dir}, name=price, min=0.01, max=999.99, step=0.01. ` +
    'Reply with the "value" fields of the result, comma-separated. ' +
    'Do nothing else.'
  );
}

/** @param {string} output */
function smokePassed(output) {
  return ['0.01', '999.99', '1000'].every(value => output.includes(value));
}

/**
 * @param {Harness} harness
 * @param {{ok: boolean, stdout: string, stderr: string}} run
 * @returns {Check}
 */
function smokeCheck(harness, run) {
  return {
    status: run.ok && smokePassed(run.stdout) ? 'ok' : 'fail',
    harness,
    text: run.ok
      ? `smoke: ${run.stdout.trim().split('\n').at(-1) ?? ''}`
      : `smoke failed: ${run.stderr.trim()}`,
  };
}

/**
 * Runs in an empty temp folder, so no project settings or hooks load; the
 * model may call only the bva tool. Local and project installs don't load
 * there, and Windows would split the prompt (see exec), so both are skipped.
 * @param {ClaudePlugin} plugin
 * @returns {Check}
 */
function claudeSmoke(plugin) {
  if (plugin.scope !== 'user' || WINDOWS) {
    return {
      status: 'skip',
      harness: 'claude',
      text: `smoke skipped: ${WINDOWS ? 'not on Windows' : 'user scope only'}`,
    };
  }
  const dir = mkdtempSync(join(tmpdir(), 'qaf-smoke-'));
  const run = exec(
    'claude',
    [
      '-p',
      smokePrompt(dir),
      '--allowedTools=mcp__plugin_qa-framework_qa-framework__bva,ToolSearch',
    ],
    {cwd: dir, timeout: 300_000, input: ''},
  );
  rmSync(dir, {recursive: true, force: true});
  return smokeCheck('claude', run);
}

/**
 * @param {Options} options
 * @param {Env} env
 */
export async function choose(options, env) {
  if (options.claude || options.cursor) return;
  if (options.command === 'doctor') {
    options.claude = true;
    options.cursor = true;
    return;
  }
  if (!env.tty) {
    throw new Error(
      `choose the tools: pass --claude, --cursor or both\n\n${USAGE}`,
    );
  }
  const found = (/** @type {boolean} */ yes) => (yes ? 'found' : 'not found');
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    console.log(
      `${options.command} qaFramework for:\n` +
        `  1) Claude Code (${found(Boolean(env.claude.version))})\n` +
        `  2) Cursor (${found(env.cursor.home || Boolean(env.cursor.cli))})\n` +
        '  3) Both',
    );
    const tools = await ask(rl, ['1', '2', '3']);
    options.claude = tools !== '2';
    options.cursor = tools !== '1';
    if (options.command !== 'install' || !options.claude || options.scope) {
      return;
    }
    const remote = isRemote(env.source);
    console.log(
      'Claude Code scope:\n' +
        '  1) user: all your projects [Enter]\n' +
        `  2) local: only you, in ${env.cwd}` +
        (remote
          ? `\n  3) project: everyone in ${env.cwd} (committed .claude/settings.json)`
          : ''),
    );
    const answer = await ask(rl, remote ? ['', '1', '2', '3'] : ['', '1', '2']);
    /** @type {Record<string, Scope>} */
    const scopes = {'': 'user', 1: 'user', 2: 'local', 3: 'project'};
    options.scope = scopes[answer];
  } finally {
    rl.close();
  }
}

/**
 * @param {import('node:readline/promises').Interface} rl
 * @param {string[]} valid
 */
async function ask(rl, valid) {
  for (;;) {
    const answer = (await rl.question('> ')).trim();
    if (valid.includes(answer)) return answer;
  }
}

/**
 * Lists what uninstall would change, then asks.
 * @param {Options} options
 * @param {Env} env
 * @param {Step[]} steps
 */
async function confirm(options, env, steps) {
  if (options.dryRun || steps.some(step => step.kind === 'stop')) return true;
  const changes = steps.flatMap(step => {
    const text = describe(step);
    return text ? [text] : [];
  });
  if (!changes.length || options.yes) return true;
  if (!env.tty) throw new Error('pass --yes to uninstall without a terminal');
  console.log(`This will:\n${changes.map(text => `  - ${text}`).join('\n')}`);
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = await rl.question('Uninstall qaFramework? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Code from a GitHub repo other than this one runs on the machine (as a
 * plugin and an MCP server), so it needs an explicit yes.
 * @param {Options} options
 * @param {Env} env
 * @param {Step[]} steps
 */
async function trustSource(options, env, steps) {
  const remote = isRemote(env.source);
  if (!remote || normalizeSource(env.source) === normalizeSource(OWN_REPO)) {
    return true;
  }
  if (
    options.yes ||
    options.dryRun ||
    !steps.some(step => step.kind === 'run')
  ) {
    return true;
  }
  if (!env.tty) {
    throw new Error(`pass --yes to install from ${env.cloneUrl}`);
  }
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = await rl.question(
      `Install from ${env.cloneUrl}? Its code will run on this machine. [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** @param {string[]} argv */
export async function main(argv) {
  try {
    const options = parseArgs(argv);
    if (options.command === 'help') {
      console.log(USAGE);
      return;
    }
    const env = detect(options);
    await choose(options, env);
    console.log(
      `qaFramework ${options.command} (${env.mode} mode, source ${env.source})`,
    );
    if (options.command === 'doctor') {
      if (!doctor(options, env)) process.exitCode = 1;
      return;
    }
    const steps = planSteps(options, env);
    if (!(await trustSource(options, env, steps))) {
      console.log('Nothing was changed.');
      return;
    }
    if (
      options.command === 'uninstall' &&
      !(await confirm(options, env, steps))
    ) {
      console.log('Nothing was changed.');
      return;
    }
    if (!runSteps(steps, options, env)) process.exitCode = 1;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
