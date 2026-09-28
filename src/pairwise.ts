/**
 * @fileoverview Combinatorial (t-wise) test generation from BVA and EP values:
 * positive cases cover every t-tuple of valid values and every rule, negative
 * cases carry exactly one invalid value each.
 */

import {parseArgs} from 'node:util';
import {analyzeBoundaries} from './bva.ts';
import {analyzePartitions} from './ep.ts';
import {outcomeOf, rowsForRules, uncoveredRules} from './rules.ts';
import {
  inputOptions,
  isRecord,
  isValue,
  loadSpec,
  parseResult,
  readJson,
  run,
  sameValue,
  write,
  type Item,
  type Result,
  type Spec,
  type Value,
} from './spec.ts';

type Params = Record<string, Item[]>;
type Domains = Record<string, Value[]>;
type Row = Record<string, Value>;

/** One generated test case. */
export interface Case {
  id: string;
  valid: boolean;
  /**
   * Rule outcome for valid cases ('valid' without rules, a number for `=`
   * rules), else 'invalid'.
   */
  expected: string | number;
  /** The formula a numeric `expected` was computed from. */
  formula?: string;
  input: Row;
  /** The single invalid value of a negative case. */
  fault?: string;
}

/** Coverage of a set of rows against all t-tuples of the valid values. */
export interface Report {
  strength: number;
  totalTuples: number;
  newTuplesPerCase: number[];
  lowerBound: number;
  uncovered: string[];
}

/** Marks a cell as "any value" in a hand-written suite passed to --verify. */
const DONT_CARE = '-';
/** Candidate rows tried per generated row; more is smaller but slower. */
const CANDIDATES = 8;

function cell(name: string, value: Value): string {
  return `${name}=${JSON.stringify(value)}`;
}

function keyOfCells(cells: string[]): string {
  return cells.sort().join(' & ');
}

function tupleKey(row: Row, names: string[]): string {
  return keyOfCells(names.map(name => cell(name, row[name])));
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  return items.flatMap((item, i) =>
    combinations(items.slice(i + 1), size - 1).map(rest => [item, ...rest]),
  );
}

function namesBySizeDesc(domains: Domains): string[] {
  return Object.keys(domains).sort(
    (a, b) => domains[b].length - domains[a].length,
  );
}

/** Deterministic PRNG (mulberry32) so the same spec yields the same cases. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Merges technique results per field, dropping duplicate values. */
export function merge(results: Result[]): Params {
  const params: Params = {};
  for (const result of results) {
    for (const [name, items] of Object.entries(result.fields)) {
      const list = (params[name] ??= []);
      for (const item of items) {
        const label = `${result.technique} ${item.label}`;
        const existing = list.find(x => sameValue(x.value, item.value));
        if (!existing) {
          list.push({...item, label});
        } else if (existing.valid !== item.valid) {
          throw new Error(
            `${name}: ${JSON.stringify(item.value)} is valid in one of ` +
              `"${existing.label}", "${label}" and invalid in the other`,
          );
        }
      }
    }
  }
  return params;
}

/** Valid values per field. */
export function validDomains(params: Params): Domains {
  const domains: Domains = {};
  for (const [name, items] of Object.entries(params)) {
    const values = items.filter(i => i.valid).map(i => i.value);
    if (!values.length) throw new Error(`${name}: no valid values to combine`);
    domains[name] = values;
  }
  return domains;
}

/** All t-tuples of the domains, keyed by tupleKey. */
function allTuples(domains: Domains, strength: number): Map<string, Row> {
  const tuples = new Map<string, Row>();
  for (const names of combinations(namesBySizeDesc(domains), strength)) {
    const rows = names.reduce<Row[]>(
      (partial, name) =>
        partial.flatMap(row => domains[name].map(v => ({...row, [name]: v}))),
      [{}],
    );
    for (const row of rows) tuples.set(tupleKey(row, names), row);
  }
  return tuples;
}

function rowTuples(
  row: Partial<Row>,
  names: string[],
  strength: number,
): string[] {
  const known: Row = {};
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== DONT_CARE) known[name] = value;
  }
  return combinations(Object.keys(known), strength).map(combo =>
    tupleKey(known, combo),
  );
}

/**
 * One greedy candidate row: start from an uncovered tuple, then give each
 * remaining field the value that covers the most uncovered tuples.
 */
function candidateRow(
  domains: Domains,
  order: string[],
  seed: Row,
  uncovered: Map<string, Row>,
  strength: number,
): Row {
  const row: Row = {...seed};
  for (const name of order) {
    if (name in row) continue;
    const partnerCells = combinations(Object.keys(row), strength - 1).map(p =>
      p.map(n => cell(n, row[n])),
    );
    let best = domains[name][0];
    let bestScore = -1;
    for (const value of domains[name]) {
      const own = cell(name, value);
      const score = partnerCells.filter(p =>
        uncovered.has(keyOfCells([...p, own])),
      ).length;
      if (score > bestScore) {
        best = value;
        bestScore = score;
      }
    }
    row[name] = best;
  }
  return row;
}

/** Rows of valid values that cover every t-tuple at least once. */
export function coveringRows(domains: Domains, strength: number): Row[] {
  // ponytail: greedy AETG, best of CANDIDATES random field orders per row;
  // each row costs O(candidates * fields * values * C(fields, t-1)) key
  // builds (20 fields x 10 values at t=2 takes ~2.5s). Switch to IPOG if
  // suites get larger or need to be closer to the lower bound.
  const names = namesBySizeDesc(domains);
  const size = Math.min(strength, names.length);
  if (size < 1) return [];
  const uncovered = allTuples(domains, size);
  const random = seededRandom(1);
  const rows: Row[] = [];
  for (const [, seed] of uncovered) {
    let best: Row = seed;
    let bestGain = -1;
    for (let i = 0; i < CANDIDATES; i++) {
      const order = i === 0 ? names : shuffle(names, random);
      const row = candidateRow(domains, order, seed, uncovered, size);
      const gain = rowTuples(row, names, size).filter(k =>
        uncovered.has(k),
      ).length;
      if (gain > bestGain) {
        best = row;
        bestGain = gain;
      }
    }
    for (const key of rowTuples(best, names, size)) uncovered.delete(key);
    rows.push(Object.fromEntries(Object.keys(domains).map(n => [n, best[n]])));
  }
  return rows;
}

/** How well `rows` cover the t-tuples of `domains`. */
export function report(
  domains: Domains,
  rows: Partial<Row>[],
  strength: number,
): Report {
  const names = Object.keys(domains);
  const size = Math.min(strength, names.length);
  const all = allTuples(domains, size);
  const seen = new Set<string>();
  const newTuplesPerCase = rows.map(row => {
    let fresh = 0;
    for (const key of rowTuples(row, names, size)) {
      if (all.has(key) && !seen.has(key)) {
        seen.add(key);
        fresh++;
      }
    }
    return fresh;
  });
  const sizes = names.map(n => domains[n].length).sort((a, b) => b - a);
  return {
    strength: size,
    totalTuples: all.size,
    newTuplesPerCase,
    lowerBound: sizes.slice(0, size).reduce((a, b) => a * b, 1),
    uncovered: [...all.keys()].filter(k => !seen.has(k)),
  };
}

function printReport(
  coverage: Report,
  spec: Spec | undefined,
  rows: Row[],
): void {
  const {strength, totalTuples, uncovered, newTuplesPerCase, lowerBound} =
    coverage;
  const list = (keys: string[]) =>
    keys.length ? keys.map(k => `\n  ${k}`).join('') : ' none';
  const lines = [
    `${strength}-tuples covered: ${totalTuples - uncovered.length}/${totalTuples}`,
    `cases: ${newTuplesPerCase.length} (lower bound ${lowerBound})`,
    `new tuples per case: ${newTuplesPerCase.join(' ')}`,
    `uncovered:${list(uncovered)}`,
  ];
  if (spec?.rules.length) {
    const missed = uncoveredRules(spec, rows).map(r => r.expected);
    lines.push(
      `rules covered: ${spec.rules.length - missed.length}/${spec.rules.length}`,
    );
    lines.push(`uncovered rules:${list(missed)}`);
  }
  console.error(lines.join('\n'));
}

/**
 * Positive cases cover every t-tuple and rule; each negative case has exactly
 * one invalid value so a first rejection can't mask a second fault.
 */
export function generateCases(
  params: Params,
  spec?: Spec,
  strength = spec?.strength ?? 2,
): Case[] {
  const domains = validDomains(params);
  const rows = coveringRows(domains, strength);
  if (spec) rows.push(...rowsForRules(spec, domains, rows));
  const positive = rows.map(input => ({
    valid: true,
    ...outcomeOf(spec, input),
    input,
  }));
  const base: Row = {};
  for (const [name, values] of Object.entries(domains)) base[name] = values[0];
  const negative = Object.entries(params).flatMap(([name, items]) =>
    items
      .filter(i => !i.valid)
      .map(i => ({
        valid: false,
        expected: 'invalid',
        input: {...base, [name]: i.value},
        fault: `${name}: ${i.label}`,
      })),
  );
  return [...positive, ...negative].map((c, i) => ({
    id: `TC-${String(i + 1).padStart(3, '0')}`,
    ...c,
  }));
}

function isRow(x: unknown): x is Row {
  return isRecord(x) && Object.values(x).every(isValue);
}

function isCase(x: unknown): x is {valid?: unknown; input: Row} {
  return isRecord(x) && isRow(x.input);
}

/** Positive rows of a suite: a JSON array of rows, or a pairwise output file. */
function parseSuite(raw: unknown, file: string): Row[] {
  if (Array.isArray(raw) && raw.every(isRow)) return raw;
  const cases = isRecord(raw) ? raw.cases : undefined;
  if (Array.isArray(cases) && cases.every(isCase)) {
    return cases.filter(c => c.valid !== false).map(c => c.input);
  }
  throw new Error(
    `${file}: expected an array of rows or a pairwise output file`,
  );
}

if (import.meta.main) {
  run(() => {
    const {values: flags} = parseArgs({
      options: {
        ...inputOptions,
        bva: {type: 'string'},
        ep: {type: 'string'},
        verify: {type: 'string'},
        strength: {type: 'string'},
        debug: {type: 'boolean'},
      },
    });
    const spec = flags.spec || flags.name ? loadSpec(flags) : undefined;
    const files = [flags.ep, flags.bva].filter(f => f !== undefined);
    let params: Params;
    if (files.length) {
      params = merge(files.map(f => parseResult(readJson(f), f)));
    } else if (spec) {
      params = merge([analyzePartitions(spec), analyzeBoundaries(spec)]);
    } else {
      throw new Error('use --spec, or --bva/--ep output files');
    }
    const strength =
      flags.strength === undefined
        ? (spec?.strength ?? 2)
        : Number(flags.strength);
    if (!Number.isInteger(strength) || strength < 1) {
      throw new Error('--strength must be a positive integer');
    }
    const domains = validDomains(params);

    if (flags.verify) {
      const rows = parseSuite(readJson(flags.verify), flags.verify);
      const coverage = report(domains, rows, strength);
      printReport(coverage, spec, rows);
      const missedRules = spec ? uncoveredRules(spec, rows).length : 0;
      if (coverage.uncovered.length || missedRules) process.exitCode = 1;
      return;
    }

    const cases = generateCases(params, spec, strength);
    if (flags.debug) {
      const rows = cases.filter(c => c.valid).map(c => c.input);
      printReport(report(domains, rows, strength), spec, rows);
    }
    write(flags.out, {technique: `${strength}-wise`, strength, cases});
  });
}
