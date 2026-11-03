/**
 * @fileoverview MCP server (stdio, newline-delimited JSON-RPC 2.0) that runs
 * the technique CLIs, so agents in other projects can use them without a
 * checkout of this repo. Tool arguments are the CLI flags plus `cwd`.
 */

import {spawnSync} from 'node:child_process';
import {existsSync, lstatSync, realpathSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {inputOptions, isRecord} from './spec.ts';

interface InputSchema {
  type: 'object';
  properties: Record<string, object>;
  required: string[];
  additionalProperties: false;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: InputSchema;
}

interface ToolResult {
  content: Array<{type: 'text'; text: string}>;
  isError: boolean;
}

const REFERENCE_SPEC = resolve(
  import.meta.dirname,
  '../fixtures/price-calculation.spec.json',
);

// Output over MAX_BUFFER_BYTES still fails with ENOBUFS. spawnSync blocks the
// server, so a stuck CLI is killed after TIMEOUT_MS. stdout and stderr each
// stop at MAX_RESPONSE_CHARS to keep an agent's context small; `out` writes
// the full JSON to a file.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const MAX_RESPONSE_CHARS = 100_000;

const FLAGS: Record<string, string> = {
  spec: 'Spec file inside cwd (or the reference spec).',
  out: 'Output .json file under generated/ in cwd; omit to get the JSON back.',
  name: 'Single-field shorthand without a spec: field name.',
  type: 'Single-field shorthand: number, string or enum.',
  min: 'Single-field shorthand: minimum (minLength for strings).',
  max: 'Single-field shorthand: maximum (maxLength for strings).',
  step: 'Single-field shorthand: smallest increment.',
  values: 'Single-field shorthand: comma-separated valid values.',
  invalid: 'Single-field shorthand: comma-separated invalid values.',
  bva: 'Edited bva.json inside cwd, used instead of derived values.',
  ep: 'Edited ep.json inside cwd, used instead of derived values.',
  verify: 'Suite file inside cwd to audit instead of generating cases.',
  strength: 'Combination strength t, overrides the spec.',
  debug: 'Append the coverage report.',
};

function schema(flags: string[]): InputSchema {
  const properties: Record<string, object> = {
    cwd: {
      type: 'string',
      description: 'Absolute workspace root; relative paths resolve from it.',
    },
  };
  for (const flag of flags) {
    const type = flag === 'debug' ? 'boolean' : ['string', 'number'];
    properties[flag] = {type, description: FLAGS[flag]};
  }
  return {
    type: 'object',
    properties,
    required: ['cwd'],
    additionalProperties: false,
  };
}

const SPEC_FLAGS = Object.keys(inputOptions);

// Plugin users never see AGENTS.md, so the tool descriptions carry the limits.
const LIMITS =
  ` Runs over ${TIMEOUT_MS / 1000} s are killed; stdout and stderr each stop ` +
  `at ${MAX_RESPONSE_CHARS.toLocaleString('en-US')} characters, so pass ` +
  '`out` for large results.';

const TOOLS: Tool[] = [
  {
    name: 'bva',
    description:
      'Boundary value analysis: both edges of every range partition. ' +
      'Same flags as `node src/bva.ts`.' +
      LIMITS,
    inputSchema: schema(SPEC_FLAGS),
  },
  {
    name: 'ep',
    description:
      'Equivalence partitioning: one representative per partition. ' +
      'Same flags as `node src/ep.ts`.' +
      LIMITS,
    inputSchema: schema(SPEC_FLAGS),
  },
  {
    name: 'pairwise',
    description:
      't-wise positive cases with rule outcomes, plus one negative case per ' +
      'invalid value; with `verify`, audits an existing suite. Same flags as ' +
      `\`node src/pairwise.ts\`. Reference spec: ${REFERENCE_SPEC}.` +
      LIMITS +
      ' Strength 3 near 455,000 tuples takes 40 to 50 s. With `verify`, a ' +
      'suite with gaps is not an error: the text starts with ' +
      '`uncovered (exit 1)`.',
    inputSchema: schema([
      ...SPEC_FLAGS,
      'bva',
      'ep',
      'verify',
      'strength',
      'debug',
    ]),
  },
];

function textResult(text: string, isError: boolean): ToolResult {
  return {content: [{type: 'text', text}], isError};
}

/** `--flag=value` keeps a value that starts with `--` from becoming a flag. */
function toArgv(flags: Record<string, unknown>): string[] {
  return Object.entries(flags).flatMap(([flag, value]) => {
    if (value === false || value === undefined) return [];
    if (value === true) return [`--${flag}`];
    return [`--${flag}=${String(value)}`];
  });
}

function truncate(text: string, hint = ''): string {
  return text.length > MAX_RESPONSE_CHARS
    ? `${text.slice(0, MAX_RESPONSE_CHARS)}\n... truncated${hint}`
    : text;
}

const READ_FLAGS = ['spec', 'bva', 'ep', 'verify'];
const FIXTURES = realpathSync(resolve(import.meta.dirname, '../fixtures'));

function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Tool arguments come from an agent that may be prompt-injected, so reads
 * stay inside cwd (or fixtures/, for the reference spec) and `out` only
 * writes a .json under <cwd>/generated/, never through a symlink.
 */
function pathError(flags: Record<string, unknown>, cwd: string): string {
  const root = realpathSync(cwd);
  for (const flag of READ_FLAGS) {
    if (flags[flag] === undefined) continue;
    const path = resolve(root, String(flags[flag]));
    const real = existsSync(path) ? realpathSync(path) : path;
    if (!inside(real, root) && !inside(real, FIXTURES)) {
      return `${flag} must be inside cwd`;
    }
  }
  if (flags.out === undefined) return '';
  const out = resolve(root, String(flags.out));
  const parent = dirname(out);
  if (
    !out.endsWith('.json') ||
    !inside(out, join(root, 'generated')) ||
    (existsSync(out) && lstatSync(out).isSymbolicLink()) ||
    (existsSync(parent) && !inside(realpathSync(parent), root))
  ) {
    return 'out must be a .json file under generated/ in cwd';
  }
  return '';
}

function callTool(params: Record<string, unknown>): ToolResult {
  const tool = TOOLS.find(t => t.name === params.name);
  if (!tool) return textResult(`error: unknown tool ${params.name}`, true);
  const {cwd, ...flags} = isRecord(params.arguments) ? params.arguments : {};
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || !existsSync(cwd)) {
    return textResult('error: cwd must be an existing absolute path', true);
  }
  const unknown = Object.keys(flags).find(
    f => !Object.hasOwn(tool.inputSchema.properties, f),
  );
  if (unknown !== undefined) {
    return textResult(`error: unknown argument ${unknown}`, true);
  }
  const confined = pathError(flags, cwd);
  if (confined) return textResult(`error: ${confined}`, true);
  // ponytail: one node process per call (~50 ms) keeps the CLI's exit codes
  // and messages; import the modules directly if latency ever matters.
  const child = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, `${tool.name}.ts`), ...toArgv(flags)],
    {cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES, timeout: TIMEOUT_MS},
  );
  if (child.error) return textResult(`error: ${child.error.message}`, true);
  const text = [
    truncate(child.stdout, '; pass out to write a file'),
    truncate(child.stderr),
  ]
    .filter(Boolean)
    .join('\n');
  // `--verify` exits 1 with a report on stdout when tuples or rules are
  // uncovered. That is a finding, not a failure, and clients cut long error
  // text (Claude Code keeps the first and last 5,000 characters).
  const coverageGap =
    flags.verify !== undefined &&
    child.status === 1 &&
    !/^error: /m.test(child.stderr);
  if (coverageGap) return textResult(`uncovered (exit 1)\n${text}`, false);
  return textResult(text || 'done', child.status !== 0);
}

/** The result for a request, or undefined for an unknown method. */
function handle(method: unknown, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'initialize':
      // ponytail: echoes the client's version; only the tools basics are
      // used, unchanged across versions. Negotiate if a client rejects it.
      return {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: {tools: {}},
        serverInfo: {name: 'qa-framework', version: '0.1.0'},
      };
    case 'ping':
      return {};
    case 'tools/list':
      return {tools: TOOLS};
    case 'tools/call':
      return callTool(params);
    default:
      return undefined;
  }
}

function send(message: object): void {
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\n');
}

function respond(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    send({id: null, error: {code: -32700, message: 'parse error'}});
    return;
  }
  if (!isRecord(message) || message.id === undefined) return;
  const {id, method} = message;
  try {
    const params = isRecord(message.params) ? message.params : {};
    const result = handle(method, params);
    if (result === undefined) {
      send({id, error: {code: -32601, message: `unknown method ${method}`}});
    } else {
      send({id, result});
    }
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    send({id, error: {code: -32603, message: text}});
  }
}

if (import.meta.main) {
  for await (const line of createInterface({input: process.stdin})) {
    if (line.trim()) respond(line);
  }
}
