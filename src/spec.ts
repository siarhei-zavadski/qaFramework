/**
 * @fileoverview Spec model shared by every technique: parsing untrusted JSON,
 * expanding shorthand fields into partitions, and CLI helpers.
 */

import {readFileSync, writeFileSync} from 'node:fs';
import {parseFormula, type Formula} from './formula.ts';

/** A test input value as it appears in generated JSON. */
export type Value = string | number | boolean | null;

/** Supported field types; see FIELD_TYPES for how each one is modelled. */
export type FieldType = 'number' | 'string' | 'enum';

/**
 * One equivalence class of a field. Range partitions have `min` and/or `max`
 * (inclusive, on the field's scale; a missing side is open). Set partitions
 * have explicit `values` instead.
 */
export interface Partition {
  label: string;
  valid: boolean;
  min?: number;
  max?: number;
  values?: Value[];
}

/** A normalized input field. */
export interface Field {
  name: string;
  type: FieldType;
  /** Smallest meaningful increment of the scale; always 1 for non-numbers. */
  step: number;
  /** Range partitions sorted low to high, then set partitions. */
  partitions: Partition[];
}

/** A decision-table column. The first rule whose `when` matches a row wins. */
export interface Rule {
  /** Field name to valid partition label; empty for the catch-all rule. */
  when: Record<string, string>;
  /** Literal outcome, or `=` followed by a formula. */
  expected: string;
  formula?: Formula;
}

/** A normalized spec. */
export interface Spec {
  fields: Field[];
  rules: Rule[];
  /** Interaction strength for combinatorial coverage (2 means pairwise). */
  strength: number;
}

/** A concrete test value picked from a partition by one technique. */
export interface Item {
  label: string;
  value: Value;
  valid: boolean;
  partition: string;
}

/** Output of a value technique (BVA or EP): items per field name. */
export interface Result {
  technique: string;
  fields: Record<string, Item[]>;
}

/** An ordered scale that range partitions are defined on. */
interface Scale {
  /** Spec keys that hold the range bounds. */
  minKey: string;
  maxKey: string;
  /** Lowest point on the scale; an open lower side is closed here. */
  floor: number;
  toValue: (point: number) => Value;
  /** Inverse of toValue; undefined when the value is not on this scale. */
  toPoint: (value: Value) => number | undefined;
}

interface FieldTypeInfo {
  /** Present for types that support range partitions. */
  scale?: Scale;
  /** Invalid-type values added unless the field sets `invalid`. */
  defaultInvalid: Value[];
}

// ponytail: string values are 'x' repeated to the target length, so a huge
// maxLength produces a huge JSON value; add a format generator if needed.
const FIELD_TYPES: Record<FieldType, FieldTypeInfo> = {
  number: {
    scale: {
      minKey: 'min',
      maxKey: 'max',
      floor: -Infinity,
      toValue: point => point,
      toPoint: value => (typeof value === 'number' ? value : undefined),
    },
    defaultInvalid: ['abc', null],
  },
  string: {
    scale: {
      minKey: 'minLength',
      maxKey: 'maxLength',
      floor: 0,
      toValue: point => 'x'.repeat(point),
      toPoint: value => (typeof value === 'string' ? value.length : undefined),
    },
    defaultInvalid: [null],
  },
  enum: {defaultInvalid: ['__invalid__']},
};

const USAGE =
  'use --spec file.json, or --name with --min/--max[/--step] or --values a,b,c';

/** CLI options shared by every technique script. */
export const inputOptions = {
  spec: {type: 'string'},
  out: {type: 'string'},
  name: {type: 'string'},
  type: {type: 'string'},
  min: {type: 'string'},
  max: {type: 'string'},
  step: {type: 'string'},
  values: {type: 'string'},
  invalid: {type: 'string'},
} as const;

type SpecFlags = Partial<Record<keyof typeof inputOptions, string>>;

function decimals(step: number): number {
  const [mantissa, exponent] = String(step).split('e-');
  return (mantissa.split('.')[1] ?? '').length + Number(exponent ?? 0);
}

/** Rounds away float noise such as 0.1 + 0.2, to the precision of `step`. */
export function round(value: number, step: number): number {
  return Number(value.toFixed(decimals(step)));
}

/** Test value for a point on the field's scale. */
export function pointToValue(field: Field, point: number): Value {
  const scale = FIELD_TYPES[field.type].scale;
  return scale ? scale.toValue(point) : point;
}

/** Partition that a value falls into, or undefined if it is in none. */
export function partitionOf(field: Field, value: Value): Partition | undefined {
  const point = FIELD_TYPES[field.type].scale?.toPoint(value);
  return field.partitions.find(p =>
    p.values
      ? p.values.some(v => sameValue(v, value))
      : point !== undefined &&
        (p.min === undefined || point >= p.min) &&
        (p.max === undefined || point <= p.max),
  );
}

/** Value equality that tells 1 from '1'. */
export function sameValue(a: Value, b: Value): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** True for plain JSON objects. */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** True for strings, finite numbers, booleans and null. */
export function isValue(x: unknown): x is Value {
  return (
    x === null ||
    typeof x === 'string' ||
    typeof x === 'boolean' ||
    (typeof x === 'number' && Number.isFinite(x))
  );
}

function isFieldType(x: unknown): x is FieldType {
  return typeof x === 'string' && Object.hasOwn(FIELD_TYPES, x);
}

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  where: string,
): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${where}: ${key} must be a finite number`);
  }
  return value;
}

function valueList(x: unknown, where: string): Value[] {
  if (!Array.isArray(x) || !x.length || !x.every(isValue)) {
    throw new Error(`${where} must be a non-empty array of values`);
  }
  return x;
}

function parsePartition(
  raw: unknown,
  type: FieldType,
  where: string,
): Partition {
  if (!isRecord(raw) || typeof raw.label !== 'string' || !raw.label) {
    throw new Error(`${where}: every partition needs a label`);
  }
  const at = `${where}.${raw.label}`;
  if (raw.valid !== undefined && typeof raw.valid !== 'boolean') {
    throw new Error(`${at}: valid must be a boolean`);
  }
  const valid = raw.valid ?? true;
  const scale = FIELD_TYPES[type].scale;
  const min = scale && optionalNumber(raw, scale.minKey, at);
  const max = scale && optionalNumber(raw, scale.maxKey, at);
  if (raw.values !== undefined) {
    if (min !== undefined || max !== undefined) {
      throw new Error(`${at}: use either values or a range, not both`);
    }
    return {label: raw.label, valid, values: valueList(raw.values, at)};
  }
  if (min === undefined && max === undefined) {
    const keys = scale
      ? `${scale.minKey}, ${scale.maxKey} or values`
      : 'values';
    throw new Error(`${at}: needs ${keys}`);
  }
  return {label: raw.label, valid, min, max};
}

/** Expands `min`/`max` or `values` into partitions. */
function shorthandPartitions(
  raw: Record<string, unknown>,
  type: FieldType,
  name: string,
): Partition[] {
  if (type === 'enum') {
    return valueList(raw.values, `${name}.values`).map(value => ({
      label: String(value),
      valid: true,
      values: [value],
    }));
  }
  return [parsePartition({...raw, label: 'valid', valid: true}, type, name)];
}

/**
 * Sorts range partitions, checks them against the step grid, and fills the
 * space below, between and above them with invalid partitions.
 */
function completeRanges(
  ranges: Partition[],
  field: Field,
  scale: Scale,
): Partition[] {
  const {name, step} = field;
  const units = (bound: number) => Math.round(bound / step);
  for (const p of ranges) {
    if (p.min === undefined && scale.floor > -Infinity) p.min = scale.floor;
    for (const bound of [p.min, p.max]) {
      if (bound === undefined) continue;
      if (round(units(bound) * step, step) !== bound) {
        throw new Error(`${name}: ${bound} is not a multiple of step ${step}`);
      }
      if (bound < scale.floor) {
        throw new Error(`${name}: ${bound} is below ${scale.floor}`);
      }
    }
    if (p.min !== undefined && p.max !== undefined && p.min > p.max) {
      throw new Error(`${name}.${p.label}: min must be <= max`);
    }
  }
  const sorted = [...ranges].sort(
    (a, b) => (a.min ?? -Infinity) - (b.min ?? -Infinity),
  );
  const complete: Partition[] = [];
  const first = sorted[0];
  if (first?.min !== undefined && first.min - step >= scale.floor) {
    const min = scale.floor > -Infinity ? scale.floor : undefined;
    complete.push({
      label: 'below',
      valid: false,
      min,
      max: round(first.min - step, step),
    });
  }
  sorted.forEach((p, i) => {
    const next = sorted[i + 1];
    complete.push(p);
    if (!next) return;
    if (
      p.max === undefined ||
      next.min === undefined ||
      units(next.min) <= units(p.max)
    ) {
      throw new Error(
        `${name}: partitions ${p.label} and ${next.label} overlap`,
      );
    }
    if (units(next.min) - units(p.max) > 1) {
      complete.push({
        label: `gap:${p.label}:${next.label}`,
        valid: false,
        min: round(p.max + step, step),
        max: round(next.min - step, step),
      });
    }
  });
  const last = sorted.at(-1);
  if (last?.max !== undefined) {
    complete.push({
      label: 'above',
      valid: false,
      min: round(last.max + step, step),
    });
  }
  return complete;
}

function parseField(raw: unknown): Field {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name) {
    throw new Error('every field needs a name');
  }
  const name = raw.name;
  if (!isFieldType(raw.type)) {
    throw new Error(`${name}: unknown type ${String(raw.type)}`);
  }
  const type = raw.type;
  const info = FIELD_TYPES[type];
  const step = optionalNumber(raw, 'step', name) ?? 1;
  if (!(step > 0)) throw new Error(`${name}: step must be > 0`);
  if (type !== 'number' && step !== 1) {
    throw new Error(`${name}: step only applies to number fields`);
  }

  let declared: Partition[];
  if (raw.partitions === undefined) {
    declared = shorthandPartitions(raw, type, name);
  } else if (Array.isArray(raw.partitions) && raw.partitions.length) {
    if (raw.values !== undefined) {
      throw new Error(`${name}: use either values or partitions, not both`);
    }
    declared = raw.partitions.map(p => parsePartition(p, type, name));
  } else {
    throw new Error(`${name}: partitions must be a non-empty array`);
  }

  const field: Field = {name, type, step, partitions: []};
  const ranges = declared.filter(p => !p.values);
  const sets = declared.filter(p => p.values);
  const invalid = raw.invalid ?? info.defaultInvalid;
  if (!Array.isArray(invalid) || !invalid.every(isValue)) {
    throw new Error(`${name}.invalid must be an array of values`);
  }
  const autoInvalid = raw.autoInvalid ?? true;
  if (typeof autoInvalid !== 'boolean') {
    throw new Error(`${name}.autoInvalid must be a boolean`);
  }
  field.partitions = [
    ...(info.scale && ranges.length
      ? completeRanges(ranges, field, info.scale).filter(
          p => autoInvalid || ranges.includes(p),
        )
      : []),
    ...sets,
    ...invalid.map(value => ({
      label: `invalid:${String(value)}`,
      valid: false,
      values: [value],
    })),
  ];

  const labels = new Set<string>();
  const seenValues = new Set<string>();
  for (const p of field.partitions) {
    if (labels.has(p.label)) {
      throw new Error(`${name}: duplicate partition label ${p.label}`);
    }
    labels.add(p.label);
    for (const value of p.values ?? []) {
      const key = JSON.stringify(value);
      if (seenValues.has(key) || partitionOf(field, value) !== p) {
        throw new Error(`${name}: value ${key} is in more than one partition`);
      }
      seenValues.add(key);
    }
  }
  if (!field.partitions.some(p => p.valid)) {
    throw new Error(`${name}: needs at least one valid partition`);
  }
  return field;
}

function parseRules(raw: unknown, fields: Field[]): Rule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error('rules must be a non-empty array');
  }
  const rules = raw.map((rule: unknown, i): Rule => {
    const where = `rule ${i + 1}`;
    if (
      !isRecord(rule) ||
      typeof rule.expected !== 'string' ||
      !rule.expected
    ) {
      throw new Error(`${where}: needs an expected string`);
    }
    const when = rule.when ?? {};
    if (!isRecord(when)) throw new Error(`${where}: when must be an object`);
    const conditions: Record<string, string> = {};
    for (const [name, label] of Object.entries(when)) {
      const partition = fields
        .find(f => f.name === name)
        ?.partitions.find(p => p.label === label);
      if (!partition?.valid) {
        throw new Error(
          `${where}: ${name}=${String(label)} is not a valid partition`,
        );
      }
      conditions[name] = partition.label;
    }
    const parsed: Rule = {when: conditions, expected: rule.expected};
    if (rule.expected.startsWith('=')) {
      parsed.formula = parseFormula(
        rule.expected.slice(1).trim(),
        fields.map(f => f.name),
        where,
      );
    }
    return parsed;
  });
  if (Object.keys(rules[rules.length - 1].when).length) {
    const gap = unmatchedCombination(rules, fields);
    if (gap) {
      throw new Error(
        `no rule matches ${gap}; add a rule or a catch-all {"when": {}}`,
      );
    }
  }
  return rules;
}

/**
 * First combination of valid partitions, over the fields the rules mention,
 * that no rule matches; undefined when the rules cover every combination.
 */
function unmatchedCombination(
  rules: Rule[],
  fields: Field[],
): string | undefined {
  // ponytail: tries every combination, exponential in the number of fields
  // the rules mention; it only runs for tables without a catch-all.
  const names = new Set(rules.flatMap(rule => Object.keys(rule.when)));
  const mentioned = fields.filter(f => names.has(f.name));
  const combination: Record<string, string> = {};
  const search = (depth: number): string | undefined => {
    if (depth === mentioned.length) {
      const hit = rules.some(rule =>
        Object.entries(rule.when).every(
          ([name, label]) => combination[name] === label,
        ),
      );
      if (hit) return undefined;
      return Object.entries(combination)
        .map(([name, label]) => `${name}=${label}`)
        .join(', ');
    }
    const {name, partitions} = mentioned[depth];
    for (const p of partitions.filter(p => p.valid)) {
      combination[name] = p.label;
      const gap = search(depth + 1);
      if (gap) return gap;
    }
    return undefined;
  };
  return search(0);
}

/** Validates untrusted spec JSON and normalizes it. */
export function parseSpec(raw: unknown): Spec {
  if (!isRecord(raw) || !Array.isArray(raw.fields) || !raw.fields.length) {
    throw new Error('spec.fields must be a non-empty array');
  }
  const fields = raw.fields.map(parseField);
  const names = new Set<string>();
  for (const {name} of fields) {
    if (names.has(name)) throw new Error(`duplicate field name: ${name}`);
    names.add(name);
  }
  const strength = raw.strength ?? 2;
  if (
    typeof strength !== 'number' ||
    !Number.isInteger(strength) ||
    strength < 1
  ) {
    throw new Error('strength must be a positive integer');
  }
  return {fields, rules: parseRules(raw.rules, fields), strength};
}

/** Parses a comma-separated CLI list, keeping numbers, booleans and null typed. */
function parseList(list: string): Value[] {
  return list
    .split(',')
    .filter(Boolean)
    .map(item => {
      if (item === 'null') return null;
      if (item === 'true' || item === 'false') return item === 'true';
      return String(Number(item)) === item ? Number(item) : item;
    });
}

/** Loads a spec file, or builds a one-field spec from CLI flags. */
export function loadSpec(flags: SpecFlags): Spec {
  if (flags.spec) return parseSpec(readJson(flags.spec));
  if (!flags.name) throw new Error(USAGE);
  const type = flags.type ?? (flags.values === undefined ? 'number' : 'enum');
  const [minKey, maxKey] =
    type === 'string' ? ['minLength', 'maxLength'] : ['min', 'max'];
  const field: Record<string, unknown> = {name: flags.name, type};
  if (flags.values !== undefined) field.values = parseList(flags.values);
  if (flags.invalid !== undefined) field.invalid = parseList(flags.invalid);
  if (flags.step !== undefined) field.step = Number(flags.step);
  if (flags.min !== undefined) field[minKey] = Number(flags.min);
  if (flags.max !== undefined) field[maxKey] = Number(flags.max);
  return parseSpec({fields: [field]});
}

/** Reads and parses a JSON file; the result is untrusted. */
export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function isItem(x: unknown): x is Item {
  return (
    isRecord(x) &&
    typeof x.label === 'string' &&
    isValue(x.value) &&
    typeof x.valid === 'boolean' &&
    typeof x.partition === 'string'
  );
}

/** Validates a BVA or EP output file. */
export function parseResult(raw: unknown, file: string): Result {
  const error = new Error(`${file}: not a bva/ep output file`);
  if (
    !isRecord(raw) ||
    typeof raw.technique !== 'string' ||
    !isRecord(raw.fields)
  ) {
    throw error;
  }
  const fields: Record<string, Item[]> = {};
  for (const [name, items] of Object.entries(raw.fields)) {
    if (!Array.isArray(items) || !items.every(isItem)) throw error;
    fields[name] = items;
  }
  return {technique: raw.technique, fields};
}

/** Writes JSON to `out`, or to stdout when `out` is not set. */
export function write(out: string | undefined, data: unknown): void {
  const json = JSON.stringify(data, null, 2) + '\n';
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
}

/** Runs a CLI entry point, printing errors as `error: <message>`. */
export function run(main: () => void): void {
  try {
    main();
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
