/**
 * @fileoverview Decision-table rules: the expected outcome of a row, and extra
 * rows so that every rule is exercised at least once.
 */

import {partitionOf, type Rule, type Spec, type Value} from './spec.ts';

type Row = Record<string, Value>;
type Domains = Record<string, Value[]>;

function matches(spec: Spec, rule: Rule, row: Row): boolean {
  return Object.entries(rule.when).every(([name, label]) => {
    const field = spec.fields.find(f => f.name === name);
    return (
      field !== undefined && partitionOf(field, row[name])?.label === label
    );
  });
}

/** The first rule matching the row; undefined when the spec has no rules. */
export function matchRule(spec: Spec, row: Row): Rule | undefined {
  return spec.rules.find(rule => matches(spec, rule, row));
}

/** Expected result of a valid row, with the formula when it was computed. */
export interface Outcome {
  expected: string | number;
  formula?: string;
}

/** Outcome of the first matching rule; 'valid' when there are no rules. */
export function outcomeOf(spec: Spec | undefined, row: Row): Outcome {
  const rule = spec && matchRule(spec, row);
  if (!rule) return {expected: 'valid'};
  if (!rule.formula) return {expected: rule.expected};
  return {expected: rule.formula.evaluate(row), formula: rule.formula.text};
}

/** Rules that no row matches first. */
export function uncoveredRules(spec: Spec, rows: Row[]): Rule[] {
  const hit = new Set(rows.map(row => matchRule(spec, row)));
  return spec.rules.filter(rule => !hit.has(rule));
}

/** First value in the domain of each partition of a field. */
function partitionSamples(spec: Spec, domains: Domains, name: string): Value[] {
  const field = spec.fields.find(f => f.name === name);
  const byLabel = new Map<string | undefined, Value>();
  for (const value of domains[name]) {
    const label = field && partitionOf(field, value)?.label;
    if (!byLabel.has(label)) byLabel.set(label, value);
  }
  return [...byLabel.values()];
}

/**
 * Builds a row that `rule` matches first. Fields in the rule get a value from
 * the required partition; fields that only earlier rules mention are searched
 * so that no earlier rule matches.
 */
function rowForRule(spec: Spec, domains: Domains, rule: Rule): Row {
  // ponytail: exhaustive search over one sample per partition of the fields
  // earlier rules mention; exponential in that count, fine for real decision
  // tables (a handful of conditions), use a SAT solver if tables get huge.
  const index = spec.rules.indexOf(rule);
  const earlier = spec.rules.slice(0, index);
  const row: Row = {};
  for (const [name, values] of Object.entries(domains)) {
    const label = rule.when[name];
    const field = spec.fields.find(f => f.name === name);
    const fit = values.find(
      v => !label || (field && partitionOf(field, v)?.label === label),
    );
    if (fit === undefined) {
      throw new Error(
        `rule ${index + 1}: no generated value for ${name}=${label}`,
      );
    }
    row[name] = fit;
  }
  const free = [...new Set(earlier.flatMap(r => Object.keys(r.when)))].filter(
    name => !(name in rule.when) && name in domains,
  );
  const search = (depth: number): boolean => {
    if (depth === free.length) return matchRule(spec, row) === rule;
    for (const value of partitionSamples(spec, domains, free[depth])) {
      row[free[depth]] = value;
      if (search(depth + 1)) return true;
    }
    return false;
  };
  if (!search(0)) {
    throw new Error(
      `rule ${index + 1} (${rule.expected}) can never match: earlier rules cover it`,
    );
  }
  return row;
}

/**
 * Extra rows so every rule is exercised at its condition boundaries: for each
 * rule, a row it matches, plus that row with one condition field moved to
 * each of its values (BVA edges included) while the other conditions hold.
 * That catches `>` vs `>=` faults inside multi-field rules, which pairwise
 * and one case per rule both miss. Rows already in `rows` are skipped.
 */
export function rowsForRules(spec: Spec, domains: Domains, rows: Row[]): Row[] {
  const seen = new Set(rows.map(row => JSON.stringify(row)));
  const extra: Row[] = [];
  const add = (row: Row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return;
    seen.add(key);
    extra.push(row);
  };
  for (const rule of spec.rules) {
    const base = rowForRule(spec, domains, rule);
    add(base);
    for (const name of Object.keys(rule.when)) {
      for (const value of domains[name] ?? []) add({...base, [name]: value});
    }
  }
  return extra;
}
