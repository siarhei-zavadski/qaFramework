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

/**
 * Applies `mode` on multiples of step: round(170.85, 0.1) is 170.9, and with
 * Math.round ties go toward +infinity, so round(-2.5, 1) is -2.
 */
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

const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/;

// The lexer reads a field `order-size` as `order - size`, so such a name is
// refused instead of misread. Names without a word character, such as `-`,
// are skipped: they would match the operators of every formula.
// ponytail: a substring test, so a field `a-b` also refuses `data-b`; lexing
// field names as whole tokens, longest first, would lift that.
function findUnlexableName(text: string, names: string[]): string | undefined {
  return names.find(
    name =>
      /\w/.test(name) && !IDENTIFIER_PATTERN.test(name) && text.includes(name),
  );
}

/**
 * Parses `text` (without the leading `=`): numbers (`1.5`, `.5`, `1e-5`),
 * field names, `+ - * /`, parentheses, unary `+` and `-`,
 * `round|floor|ceil(x, step)`, `min(...)`, `max(...)`.
 * Errors are prefixed with `where`. A field whose name is not an identifier
 * fails as soon as `text` contains it.
 */
export function parseFormula(
  text: string,
  names: string[],
  where: string,
): Formula {
  const fail = (reason: string): never => {
    throw new Error(`${where}: formula ${text}: ${reason}`);
  };
  const unlexableName = findUnlexableName(text, names);
  if (unlexableName !== undefined) {
    fail(
      `field ${unlexableName} is not an identifier (letters, digits and _, not starting with a digit), so formulas cannot use it`,
    );
  }
  const tokens =
    text.match(/(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|\S/g) ??
    [];
  let pos = 0;
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
    const sign = tokens[pos];
    if (sign !== '-' && sign !== '+') return primary();
    pos++;
    const inner = unary();
    return sign === '+' ? inner : row => -inner(row);
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
