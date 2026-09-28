/**
 * @fileoverview Computed rule outcomes (`"expected": "=0.9 * price"`):
 * arithmetic over field values, parsed once and evaluated per test case.
 */

import type {Value} from './spec.ts';

type Row = Record<string, Value>;
type Node = (row: Row) => number;

/** A parsed formula; `evaluate` throws when a field value isn't a number. */
export interface Formula {
  text: string;
  evaluate: (row: Row) => number;
}

// ponytail: results keep 12 significant digits to drop float noise such as
// 0.1 + 0.2; exact decimal arithmetic would need a decimal library.
function clean(value: number): number {
  return Number(value.toPrecision(12));
}

const OPERATORS: Record<string, (a: number, b: number) => number> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
};

interface Func {
  arity?: number;
  apply: (args: number[]) => number;
}

/** Rounds to a multiple of step; round(170.85, 0.1) is 170.9 (half up). */
function toStep(mode: (value: number) => number): Func {
  return {
    arity: 2,
    apply: ([value, step]) => clean(mode(clean(value / step)) * step),
  };
}

const FUNCTIONS: Record<string, Func> = {
  round: toStep(Math.round),
  floor: toStep(Math.floor),
  ceil: toStep(Math.ceil),
  min: {apply: args => Math.min(...args)},
  max: {apply: args => Math.max(...args)},
};

/**
 * Parses `text` (without the leading `=`): numbers, field names, `+ - * /`,
 * parentheses, unary minus, `round|floor|ceil(x, step)`, `min(...)`,
 * `max(...)`.
 * Errors are prefixed with `where`.
 */
export function parseFormula(
  text: string,
  names: string[],
  where: string,
): Formula {
  const tokens = text.match(/\d+(?:\.\d+)?|\.\d+|[A-Za-z_]\w*|\S/g) ?? [];
  let pos = 0;
  const fail = (reason: string): never => {
    throw new Error(`${where}: formula ${text}: ${reason}`);
  };
  const take = (token: string) => {
    if (tokens[pos] !== token) fail(`expected ${token}`);
    pos++;
  };

  function binary(next: () => Node, ops: string[]): Node {
    let left = next();
    while (ops.includes(tokens[pos] ?? '')) {
      const apply = OPERATORS[tokens[pos++]];
      const a = left;
      const b = next();
      left = row => apply(a(row), b(row));
    }
    return left;
  }
  function sum(): Node {
    return binary(product, ['+', '-']);
  }
  function product(): Node {
    return binary(unary, ['*', '/']);
  }
  function unary(): Node {
    if (tokens[pos] !== '-') return primary();
    pos++;
    const inner = unary();
    return row => -inner(row);
  }
  function call(name: string): Node {
    if (!Object.hasOwn(FUNCTIONS, name))
      return fail(`unknown function ${name}`);
    const func = FUNCTIONS[name];
    take('(');
    const args = [sum()];
    while (tokens[pos] === ',') {
      pos++;
      args.push(sum());
    }
    take(')');
    if (func.arity !== undefined && args.length !== func.arity) {
      fail(`${name} takes ${func.arity} arguments`);
    }
    return row => func.apply(args.map(arg => arg(row)));
  }
  function primary(): Node {
    const token = tokens[pos++];
    if (token === undefined) return fail('ends too early');
    if (token === '(') {
      const inner = sum();
      take(')');
      return inner;
    }
    if (/^[\d.]/.test(token)) {
      const number = Number(token);
      return () => number;
    }
    if (!/^[A-Za-z_]/.test(token)) return fail(`unexpected ${token}`);
    if (tokens[pos] === '(') return call(token);
    if (!names.includes(token)) return fail(`unknown name ${token}`);
    return row => {
      const value = row[token];
      if (typeof value !== 'number') {
        return fail(`${token} is ${JSON.stringify(value)}, not a number`);
      }
      return value;
    };
  }

  const root = sum();
  if (pos < tokens.length) fail(`unexpected ${tokens[pos]}`);
  return {
    text,
    evaluate: row => {
      const result = clean(root(row));
      if (!Number.isFinite(result)) fail('result is not a finite number');
      return result;
    },
  };
}
