/**
 * @fileoverview MCP server (stdio, newline-delimited JSON-RPC 2.0) that runs
 * the technique CLIs, so agents in other projects can use them without a
 * checkout of this repo. Tool arguments are the CLI flags plus `cwd`.
 */

import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {inputOptions, isRecord} from './spec.ts';

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
}

interface ToolResult {
  content: Array<{type: 'text'; text: string}>;
  isError: boolean;
}

const REFERENCE_SPEC = resolve(
  import.meta.dirname,
  '../fixtures/price-calculation.spec.json',
);

const FLAGS: Record<string, string> = {
  spec: 'Spec file, relative to cwd.',
  out: 'Output file, relative to cwd; omit to get the JSON back.',
  name: 'Single-field shorthand without a spec: field name.',
  type: 'Single-field shorthand: number, string or enum.',
  min: 'Single-field shorthand: minimum (minLength for strings).',
  max: 'Single-field shorthand: maximum (maxLength for strings).',
  step: 'Single-field shorthand: smallest increment.',
  values: 'Single-field shorthand: comma-separated valid values.',
  invalid: 'Single-field shorthand: comma-separated invalid values.',
  bva: 'Edited bva.json to use instead of values derived from the spec.',
  ep: 'Edited ep.json to use instead of values derived from the spec.',
  verify: 'Suite file to audit instead of generating cases.',
  strength: 'Combination strength t, overrides the spec.',
  debug: 'Append the coverage report.',
};

function schema(flags: string[]): object {
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

const TOOLS: Tool[] = [
  {
    name: 'bva',
    description:
      'Boundary value analysis: both edges of every range partition. ' +
      'Same flags as `node src/bva.ts`.',
    inputSchema: schema(SPEC_FLAGS),
  },
  {
    name: 'ep',
    description:
      'Equivalence partitioning: one representative per partition. ' +
      'Same flags as `node src/ep.ts`.',
    inputSchema: schema(SPEC_FLAGS),
  },
  {
    name: 'pairwise',
    description:
      't-wise positive cases with rule outcomes, plus one negative case per ' +
      'invalid value; with `verify`, audits an existing suite. Same flags as ' +
      `\`node src/pairwise.ts\`. Reference spec: ${REFERENCE_SPEC}`,
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

function callTool(params: Record<string, unknown>): ToolResult {
  const tool = TOOLS.find(t => t.name === params.name);
  if (!tool) return textResult(`error: unknown tool ${params.name}`, true);
  const {cwd, ...flags} = isRecord(params.arguments) ? params.arguments : {};
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || !existsSync(cwd)) {
    return textResult('error: cwd must be an existing absolute path', true);
  }
  // ponytail: one node process per call (~50 ms) keeps the CLI's exit codes
  // and messages; import the modules directly if latency ever matters.
  const child = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, `${tool.name}.ts`), ...toArgv(flags)],
    {cwd, encoding: 'utf8'},
  );
  if (child.error) return textResult(`error: ${child.error.message}`, true);
  const text = [child.stdout, child.stderr].filter(Boolean).join('\n');
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
