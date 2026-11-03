/**
 * @fileoverview Self-check for the CLI; run with `npm test` after any change.
 */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {analyzeBoundaries, boundaryValues} from './bva.ts';
import {analyzePartitions, partitionValues} from './ep.ts';
import {
  coveringRows,
  generateCases,
  maskWarnings,
  merge,
  report,
  validDomains,
  type Case,
} from './pairwise.ts';
import {parseFormula} from './formula.ts';
import {matchRule, rowsForRules, uncoveredRules} from './rules.ts';
import {isRecord, parseSpec, readJson, type Spec} from './spec.ts';
import {
  choose,
  doctor,
  handshake,
  parseArgs,
  parseJsonc,
  parseResult,
  planSteps,
  pluginRoot,
  resolveSource,
  type Env,
} from '../installer/setup.mjs';

process.chdir(`${import.meta.dirname}/..`);

function load(file: string): Spec {
  return parseSpec(readJson(file));
}

function valuesOf(spec: Spec) {
  return merge([analyzePartitions(spec), analyzeBoundaries(spec)]);
}

function cli(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [`src/${script}.ts`, ...args], {
    encoding: 'utf8',
  });
}

function field(raw: object) {
  return parseSpec({fields: [{name: 'f', ...raw}]}).fields[0];
}

// BVA shorthand: outer edges on a decimal step, no float noise.
assert.deepEqual(
  boundaryValues(
    field({type: 'number', min: 0.01, max: 999.99, step: 0.01}),
  ).map(i => [i.value, i.valid]),
  [
    [0, false],
    [0.01, true],
    [999.99, true],
    [1000, false],
  ],
);

// BVA on bands: internal edges on both sides, the auto-filled negative edge,
// nothing past an open side; no `below` with autoInvalid: false.
const priceCalc = load('fixtures/price-calculation.spec.json');
assert.deepEqual(
  boundaryValues(priceCalc.fields[0]).map(i => [i.value, i.valid]),
  [
    [-0.1, false],
    [0, true],
    [100, true],
    [100.1, true],
    [199.9, true],
    [200, true],
  ],
);
assert.deepEqual(
  boundaryValues(
    field({type: 'number', min: 0, max: 5, autoInvalid: false}),
  ).map(i => i.value),
  [0, 5],
);

// One-sided range: `price >= 200` is below-invalid, valid from 200 up.
assert.deepEqual(
  partitionValues(field({type: 'number', min: 200, invalid: []})).map(i => [
    i.value,
    i.valid,
  ]),
  [
    [189, false],
    [210, true],
  ],
);

// String lengths: BVA values are strings of the boundary lengths.
assert.deepEqual(
  boundaryValues(field({type: 'string', minLength: 1, maxLength: 8})).map(i => [
    typeof i.value === 'string' ? i.value.length : i.value,
    i.valid,
  ]),
  [
    [0, false],
    [1, true],
    [8, true],
    [9, false],
  ],
);

// EP on an enum keeps value types and adds the invalid class.
assert.deepEqual(
  partitionValues(
    field({type: 'enum', values: [1, 'BY'], invalid: ['XX']}),
  ).map(i => [i.value, i.valid]),
  [
    [1, true],
    ['BY', true],
    ['XX', false],
  ],
);
const cliEnum = cli('ep', '--name', 'n', '--values', '1,007,true');
assert.deepEqual(
  JSON.parse(cliEnum.stdout)
    .fields.n.slice(0, 3)
    .map((i: {value: unknown}) => i.value),
  [1, '007', true],
);

// Spec validation.
const rejects = (raw: object, message: RegExp) =>
  assert.throws(() => parseSpec(raw), message);
rejects(
  {fields: [{name: 'x', type: 'number', min: 5, max: 4}]},
  /min must be <= max/,
);
rejects(
  {fields: [{name: 'x', type: 'number', min: 0.15, step: 0.1}]},
  /multiple of step/,
);
rejects(
  {
    fields: [
      {
        name: 'x',
        type: 'number',
        partitions: [
          {label: 'a', min: 0, max: 5},
          {label: 'b', min: 5},
        ],
      },
    ],
  },
  /overlap/,
);
rejects(
  {fields: [{name: 'x', type: 'number', min: 0, invalid: [3]}]},
  /more than one partition/,
);
// An off-step value is in no range, so it can be an invalid value.
assert.deepEqual(
  partitionValues(field({type: 'number', min: 1, max: 9, invalid: [1.5]})).at(
    -1,
  ),
  {label: 'invalid:1.5', value: 1.5, valid: false, partition: 'invalid:1.5'},
);
rejects(
  {
    fields: [
      {
        name: 'email',
        type: 'string',
        minLength: 5,
        maxLength: 50,
        invalid: ['abcdef'],
      },
    ],
  },
  /is in more than one partition, valid and invalid:abcdef/,
);
rejects(
  {
    fields: [
      {name: 'x', type: 'enum', partitions: [{label: 'a', values: ['p', 'p']}]},
    ],
  },
  /listed twice in a/,
);
for (const name of ['__proto__', 'constructor']) {
  rejects(
    {fields: [{name, type: 'number', min: 0, max: 1}]},
    /reserved field name/,
  );
}
// A misspelt key fails at every level instead of being ignored.
const goodField = {name: 'x', type: 'number', min: 0};
for (const [raw, message] of [
  [
    {fields: [goodField], strenght: 3},
    /spec: unknown key strenght \(allowed: fields, rules, strength\)/,
  ],
  [{fields: [{...goodField, autoinvalid: false}]}, /x: .* autoinvalid/],
  [
    {
      fields: [
        {name: 'x', type: 'number', partitions: [{label: 'a', minn: 0}]},
      ],
    },
    /x\.a: .* minn/,
  ],
  [
    {fields: [{...goodField, partitions: [{label: 'a', min: 0}]}]},
    /x: unknown key min/,
  ],
  [
    {fields: [goodField], rules: [{wehn: {}, expected: 'e'}]},
    /rule 1: .* wehn/,
  ],
] as const) {
  rejects(raw, message);
}
rejects(
  {
    fields: [{name: 'x', type: 'enum', values: ['a']}],
    rules: [{when: {x: 'b'}, expected: 'e'}],
  },
  /not a valid partition/,
);
rejects(
  {
    fields: [{name: 'x', type: 'enum', values: ['a', 'b']}],
    rules: [{when: {x: 'a'}, expected: 'e'}],
  },
  /no rule matches x=b/,
);

// A complete decision table needs no catch-all.
const complete = parseSpec({
  fields: [{name: 'plan', type: 'enum', values: ['basic', 'pro']}],
  rules: [
    {when: {plan: 'basic'}, expected: '=10'},
    {when: {plan: 'pro'}, expected: 'twenty'},
  ],
});
assert.deepEqual(
  generateCases(valuesOf(complete), complete)
    .filter(c => c.valid)
    .map(c => [c.input.plan, c.expected, c.formula]),
  [
    ['basic', 10, '10'],
    ['pro', 'twenty', undefined],
  ],
);

// Formulas: precedence, unary signs, exponents, functions, ties rounded toward
// +infinity like Math.round, no float noise; names are checked when parsed,
// values when evaluated.
const calc = (text: string, row = {}) =>
  parseFormula(text, ['price', 'code'], 'r').evaluate(row);
assert.equal(calc('2 + 3 * -(1 - 5) / 2'), 8);
assert.equal(calc('+5 - +2'), 3);
assert.equal(calc('1e-5 * 2E6'), 20);
assert.equal(calc('min(3, 1, 2) + max(4, 5)'), 6);
assert.equal(calc('0.1 + 0.2'), 0.3);
assert.equal(calc('round(0.85 * price, 0.1)', {price: 201}), 170.9);
assert.equal(calc('round(price, 5)', {price: 12.5}), 15);
assert.equal(calc('round(price, 1)', {price: -2.5}), -2);
assert.equal(calc('floor(price, 0.1)', {price: 0.3}), 0.3);
assert.equal(calc('ceil(price, 0.5)', {price: 1.01}), 1.5);
for (const [text, message] of [
  ['0.9 * pric', /unknown name pric/],
  ['round(price)', /takes 2 arguments/],
  ['price +', /ends too early/],
  ['price )', /unexpected \)/],
  ['sqrt(price)', /unknown function sqrt/],
] as const) {
  assert.throws(() => calc(text), message);
}
assert.throws(() => calc('code * 2', {code: 'abc'}), /"abc", not a number/);
assert.throws(() => calc('1 / price', {price: 0}), /not a finite number/);
// `order-size` is refused whether or not `order - size` would also parse.
for (const names of [['order-size'], ['order', 'size', 'order-size']]) {
  assert.throws(
    () => parseFormula('order-size', names, 'r'),
    /field order-size is not an identifier/,
  );
}
// A field named like an operator doesn't trip that guard.
assert.equal(
  parseFormula('price - 1', ['price', '-'], 'r').evaluate({price: 5}),
  4,
);

// Merge refuses a value that one technique calls valid and another invalid.
assert.throws(
  () =>
    merge([
      {
        technique: 'ep',
        fields: {x: [{label: 'a', value: 0, valid: true, partition: 'a'}]},
      },
      {
        technique: 'bva',
        fields: {x: [{label: 'b', value: 0, valid: false, partition: 'b'}]},
      },
    ]),
  /valid in one/,
);

// Pairwise: 3x3x2 fully covered in fewer cases than the 18-case product.
const small = {a: ['1', '2', '3'], b: ['x', 'y', 'z'], c: ['on', 'off']};
const smallRows = coveringRows(small, 2);
assert.deepEqual(report(small, smallRows, 2).uncovered, []);
assert.ok(smallRows.length < 18, `3x3x2 took ${smallRows.length} cases`);
// A real '-' value is covered, not taken for the --verify don't-care marker.
const dash = {op: ['+', '-'], mode: ['a', 'b']};
assert.deepEqual(report(dash, coveringRows(dash, 2), 2).uncovered, []);

// 3-wise: every triple of a 3x2x2x2 domain.
const triple = {a: [1, 2, 3], b: [1, 2], c: [1, 2], d: [1, 2]};
const tripleRows = coveringRows(triple, 3);
assert.deepEqual(report(triple, tripleRows, 3).uncovered, []);
assert.ok(tripleRows.length < 24, `3-wise took ${tripleRows.length} cases`);

// The tuple budget refuses 30 fields x 10 values at 4-wise (274M tuples)
// before building them, instead of running out of memory.
const tenValues = [...Array.from({length: 10}).keys()];
const wide = Object.fromEntries(
  [...Array.from({length: 30}).keys()].map(i => [`f${i}`, tenValues]),
);
assert.throws(
  () => coveringRows(wide, 4),
  /lower the strength or reduce values/,
);

// Negative cases: exactly one invalid value each, one per invalid value.
const example = valuesOf(load('spec.example.json'));
const negative = generateCases(example).filter(c => !c.valid);
assert.equal(
  negative.length,
  Object.values(example)
    .flat()
    .filter(i => !i.valid).length,
);
for (const c of negative) {
  const faults = Object.entries(c.input).filter(
    ([name, value]) =>
      example[name].find(i => i.value === value)?.valid === false,
  );
  assert.equal(faults.length, 1, `${c.id} has ${faults.length} invalid values`);
}

// Rules: every rule is covered, and the cases kill boundary mutants of the
// test-design.org price calculation, including those inside the 3-field R5
// that plain pairwise misses.
const priceCases = generateCases(valuesOf(priceCalc), priceCalc);
assert.deepEqual(
  uncoveredRules(
    priceCalc,
    priceCases.map(c => c.input),
  ),
  [],
);
// A value in no valid partition decides no rule that names it, so an
// off-step price can't credit `{card: yes}`, while a `-` weight still
// credits the catch-all for a mid price without a card.
assert.equal(
  uncoveredRules(priceCalc, [{price: 250.05, weight: 2.5, card: true}]).length,
  priceCalc.rules.length,
);
assert.deepEqual(
  uncoveredRules(priceCalc, [{price: 150, weight: '-', card: false}]),
  priceCalc.rules.slice(0, -1),
);
interface PriceLogic {
  high: (price: number) => boolean;
  cheap: (price: number) => boolean;
  heavy: (weight: number) => boolean;
  r5High: (price: number) => boolean;
  r5Light: (weight: number) => boolean;
}
const correct: PriceLogic = {
  high: p => p >= 200,
  cheap: p => p <= 100,
  heavy: w => w >= 5,
  r5High: p => p >= 200,
  r5Light: w => w < 5,
};
function pricePaid(
  logic: PriceLogic,
  price: number,
  weight: number,
  card: boolean,
) {
  let goods = logic.high(price) ? 0.9 * price : price;
  if (card) goods *= 0.97;
  const delivery = logic.heavy(weight) && logic.cheap(price) ? weight : 0;
  const total =
    card && logic.r5High(price) && logic.r5Light(weight)
      ? 0.85 * price
      : goods + delivery;
  // toPrecision drops float noise so 170.85 rounds up, like formula round().
  return Math.round(Number((total * 10).toPrecision(12))) / 10;
}
const mutants: Record<string, Partial<PriceLogic>> = {
  'R1 price > 200': {high: p => p > 200},
  'R3 price < 100': {cheap: p => p < 100},
  'R2 weight > 5': {heavy: w => w > 5},
  'R5 price > 200': {r5High: p => p > 200},
  'R5 weight <= 5': {r5Light: w => w <= 5},
  'R5 weight < 6': {r5Light: w => w < 6},
  'R5 weight < 4': {r5Light: w => w < 4},
};
for (const [name, change] of Object.entries(mutants)) {
  const mutant = {...correct, ...change};
  const killed = priceCases.some(({valid, input: {price, weight, card}}) => {
    if (!valid || typeof price !== 'number' || typeof weight !== 'number') {
      return false;
    }
    const paysByCard = card === true;
    return (
      pricePaid(mutant, price, weight, paysByCard) !==
      pricePaid(correct, price, weight, paysByCard)
    );
  });
  assert.ok(killed, `mutant "${name}" survives the price-calculation cases`);
}
// The fixture's formulas compute what the price logic pays.
for (const {valid, expected, input} of priceCases) {
  const {price, weight, card} = input;
  if (!valid || typeof price !== 'number' || typeof weight !== 'number') {
    continue;
  }
  assert.equal(
    expected,
    pricePaid(correct, price, weight, card === true),
    JSON.stringify(input),
  );
}
const shadowed = parseSpec({
  fields: [{name: 'x', type: 'enum', values: ['a']}],
  rules: [{expected: 'first'}, {expected: 'never'}],
});
assert.throws(
  () => generateCases(valuesOf(shadowed), shadowed),
  /can never match/,
);
// Rule 1 captures rule 2's probes at low prices; switching tier frees them,
// so rule 2 keeps the probe at price=100 that kills the mutant `price >= 100`.
const claim = parseSpec({
  fields: [
    {
      name: 'price',
      type: 'number',
      step: 0.1,
      partitions: [
        {label: 'low', min: 0, max: 100},
        {label: 'high', min: 200, max: 300},
      ],
    },
    {name: 'tier', type: 'enum', values: ['vip', 'std']},
    {name: 'card', type: 'enum', values: ['yes', 'no']},
  ],
  rules: [
    {when: {price: 'low', tier: 'vip'}, expected: 'R1'},
    {when: {price: 'high', card: 'yes'}, expected: 'R2'},
    {when: {}, expected: 'R3'},
  ],
});
assert.ok(
  rowsForRules(claim, validDomains(valuesOf(claim)), []).some(
    row => row.price === 100 && row.tier === 'std' && row.card === 'yes',
  ),
  'rule 2 has no probe at price=100 outside rule 1',
);
assert.throws(
  () => rowsForRules(claim, {tier: ['vip', 'std'], card: ['yes', 'no']}, []),
  /rule 1: price has no generated values/,
);

// Acceptance: test-design.org configuration exercise (A:4, B:3, C:2, D:4).
const exerciseSpec = 'fixtures/config-testing.spec.json';
const gen = cli('pairwise', '--spec', exerciseSpec);
assert.equal(gen.status, 0, gen.stderr);
assert.equal(
  gen.stdout,
  cli('pairwise', '--spec', exerciseSpec).stdout,
  'output is not deterministic',
);
const generated = JSON.parse(gen.stdout).cases.map((c: Case) => c.input);
const exercise = report(
  validDomains(valuesOf(load(exerciseSpec))),
  generated,
  2,
);
assert.equal(exercise.totalTuples, 62);
assert.deepEqual(exercise.uncovered, []);
assert.ok(generated.length <= 18, `exercise took ${generated.length} cases`);

const verify = (file: string) =>
  cli('pairwise', '--spec', exerciseSpec, '--verify', file);
const reference = verify('fixtures/config-testing.reference.json');
assert.equal(reference.status, 0, reference.stderr);
assert.doesNotMatch(reference.stderr, /warning/);
const diffPair = verify('fixtures/config-testing.diffpair.json');
assert.equal(diffPair.status, 1, 'diff-pair table should not satisfy pairwise');
assert.match(diffPair.stderr, /uncovered:\n/);
const badSuite = verify('package.json');
assert.equal(badSuite.status, 1);
assert.match(badSuite.stderr, /expected an array of rows/);
// A suite cell in no domain warns; uncovered rules are listed by number.
const strayCell = spawnSync(
  process.execPath,
  [
    'src/pairwise.ts',
    '--spec',
    'fixtures/price-calculation.spec.json',
    '--verify',
    '/dev/stdin',
  ],
  {
    encoding: 'utf8',
    input: JSON.stringify([
      {price: 42, weight: 0, card: false, expected: 42},
      {price: 42, weight: 0, card: false},
    ]),
  },
);
// One warning per distinct cell; columns that aren't spec fields are ignored.
assert.match(strayCell.stderr, /^warning: price=42 is in no domain\n2-tuples/);
assert.match(strayCell.stderr, /uncovered rules:\n {2}rule 1 \(=/);
// --debug shows the row every negative case starts from, with its outcome.
const debug = cli(
  'pairwise',
  '--spec',
  'fixtures/price-calculation.spec.json',
  '--debug',
);
assert.match(debug.stderr, /positive cases: 62 \(lower bound 40\)/);
assert.match(debug.stderr, /negative cases: 8/);
assert.match(
  debug.stderr,
  /negative base row: \{"price":50,"weight":2\.5,"card":false\} \(expected 50\)/,
);
assert.doesNotMatch(debug.stderr, /warning/);

// `when` takes a label list: it matches either label, escapes an earlier rule
// through its other label, and still reports shadowing and gaps.
const plans = (rules: object[]) =>
  parseSpec({
    fields: [
      {name: 'plan', type: 'enum', values: ['basic', 'pro', 'free']},
      {name: 'n', type: 'number', min: 0, max: 9, step: 1},
    ],
    rules,
  });
const anyPlan = plans([
  {when: {plan: 'basic'}, expected: 'b'},
  {when: {plan: ['basic', 'pro']}, expected: 'paid'},
  {when: {}, expected: 'free'},
]);
assert.equal(matchRule(anyPlan, {plan: 'pro', n: 1})?.expected, 'paid');
assert.equal(matchRule(anyPlan, {plan: 'free', n: 1})?.expected, 'free');
const anyPlanCases = generateCases(valuesOf(anyPlan), anyPlan);
assert.ok(
  anyPlanCases.some(c => c.valid && c.expected === 'paid'),
  'rule 2 escapes rule 1 through plan=pro',
);
const proShadowed = plans([
  {when: {plan: ['basic', 'pro']}, expected: 'paid'},
  {when: {plan: 'pro'}, expected: 'never'},
  {when: {}, expected: 'free'},
]);
assert.throws(
  () => generateCases(valuesOf(proShadowed), proShadowed),
  /rule 2 \(never\) can never match/,
);
assert.throws(
  () => plans([{when: {plan: ['basic', 'pro']}, expected: 'paid'}]),
  /no rule matches .*plan=free/,
);
assert.throws(
  () =>
    plans([
      {when: {plan: []}, expected: 'e'},
      {when: {}, expected: 'f'},
    ]),
  /plan needs a label or a non-empty list/,
);

// Negatives start from the first declared valid partition, not the lowest.
const highFirst = parseSpec({
  fields: [
    {
      name: 'n',
      type: 'number',
      step: 1,
      partitions: [
        {label: 'high', min: 100, max: 200},
        {label: 'low', min: 0, max: 99},
      ],
    },
    {name: 'm', type: 'enum', values: ['a', 'b'], invalid: ['zz']},
  ],
});
for (const c of generateCases(valuesOf(highFirst), highFirst)) {
  if (!c.valid && c.fault?.startsWith('m:')) {
    assert.ok(Number(c.input.n) >= 100, JSON.stringify(c.input));
  }
}

// Masking warnings: a valid partition no earlier rule names that never
// reaches the catch-all, and a base row decided by another rule.
const masked = parseSpec({
  fields: [
    {name: 'm', type: 'enum', values: ['a', 'b']},
    {name: 'c', type: 'enum', values: ['x', 'y']},
  ],
  rules: [
    {when: {m: 'a'}, expected: 'A'},
    {when: {}, expected: 'D'},
  ],
});
assert.deepEqual(
  maskWarnings(
    masked,
    [
      {m: 'a', c: 'x'},
      {m: 'a', c: 'y'},
      {m: 'b', c: 'x'},
    ],
    {m: 'a', c: 'x'},
  ),
  [
    'warning: negative base row matches rule 1 (A), not the catch-all',
    'warning: c=y never reaches the catch-all (D)',
  ],
);
// A complete table has no catch-all, so its last rule is no reference.
assert.deepEqual(
  maskWarnings(complete, [{plan: 'basic'}], {plan: 'basic'}),
  [],
);

// --adapter writes <out>.system.json through toInput, nested values included,
// and refuses a non-JSON object or an adapter that maps a negative onto a
// valid row (base row or another positive row).
const dir = mkdtempSync(join(tmpdir(), 'qaf-check-'));
const adapterSpec = join(dir, 'spec.json');
writeFileSync(
  adapterSpec,
  JSON.stringify({fields: [{name: 'n', type: 'number', min: 1, max: 9}]}),
);
writeFileSync(
  join(dir, 'good.mjs'),
  'export const toInput = row => ({qty: row.n, events: [{qty: row.n}]});',
);
writeFileSync(join(dir, 'drop.mjs'), 'export const toInput = () => ({});');
writeFileSync(
  join(dir, 'clamp.mjs'),
  'export const toInput = row => ({qty: typeof row.n === "number" ? Math.min(9, Math.max(1, row.n)) : row.n});',
);
writeFileSync(
  join(dir, 'nan.mjs'),
  'export const toInput = () => ({qty: 1, events: [{qty: NaN}]});',
);
writeFileSync(
  join(dir, 'map.mjs'),
  'export const toInput = () => ({qty: new Map()});',
);
writeFileSync(
  join(dir, 'boom.mjs'),
  'export const toInput = row => { if (row.n === 9) throw new Error("bad 9"); return {qty: row.n}; };',
);
const adapted = (adapter: string) =>
  cli(
    'pairwise',
    '--spec',
    adapterSpec,
    '--out',
    join(dir, 'cases.mode.json'),
    '--adapter',
    join(dir, adapter),
  );
const good = adapted('good.mjs');
assert.equal(good.status, 0, good.stderr);
const system = JSON.parse(
  readFileSync(join(dir, 'cases.mode.system.json'), 'utf8'),
);
assert.ok(system.cases.length > 0);
assert.ok(
  system.cases.every(
    (c: {input: Record<string, unknown>}) =>
      'qty' in c.input && !('n' in c.input),
  ),
);
assert.deepEqual(system.cases[0].input.events, [
  {qty: system.cases[0].input.qty},
]);
const drop = adapted('drop.mjs');
assert.equal(drop.status, 1);
assert.match(drop.stderr, /onto a valid row \(base row\), masking its fault/);
const clamp = adapted('clamp.mjs');
assert.equal(clamp.status, 1);
assert.match(clamp.stderr, /onto a valid row \(TC-00\d\), masking its fault/);
const nan = adapted('nan.mjs');
assert.equal(nan.status, 1);
assert.match(nan.stderr, /toInput must return a JSON object/);
const mapOut = adapted('map.mjs');
assert.equal(mapOut.status, 1);
assert.match(mapOut.stderr, /toInput must return a JSON object/);
const boom = adapted('boom.mjs');
assert.equal(boom.status, 1);
assert.match(boom.stderr, /TC-00\d: bad 9/);
const verifyAdapter = cli(
  'pairwise',
  '--spec',
  adapterSpec,
  '--verify',
  join(dir, 'cases.mode.json'),
  '--adapter',
  join(dir, 'good.mjs'),
);
assert.equal(verifyAdapter.status, 1);
assert.match(verifyAdapter.stderr, /--verify does not take --adapter/);
// Re-running without --adapter removes a stale <out>.system.json.
const noAdapter = cli(
  'pairwise',
  '--spec',
  adapterSpec,
  '--out',
  join(dir, 'cases.mode.json'),
);
assert.equal(noAdapter.status, 0, noAdapter.stderr);
assert.throws(() => readFileSync(join(dir, 'cases.mode.system.json')));
rmSync(dir, {recursive: true});

// --bva alone has no enum, set or invalid-type values, so it is refused.
const bvaOnly = spawnSync(
  process.execPath,
  ['src/pairwise.ts', '--spec', 'spec.example.json', '--bva', '/dev/stdin'],
  {
    encoding: 'utf8',
    input: JSON.stringify(analyzeBoundaries(load('spec.example.json'))),
  },
);
assert.match(
  bvaOnly.stderr,
  /age: partition invalid:abc has no value in --bva\/--ep files/,
);

// MCP server: lists the tools, runs the CLI in `cwd`, reports a bad `cwd` as
// a tool error; notifications get no response.
const rpc = (id: number, method: string, params: object) =>
  JSON.stringify({jsonrpc: '2.0', id, method, params});
const pairwiseCall = (id: number, args: object) =>
  rpc(id, 'tools/call', {name: 'pairwise', arguments: args});
const mcpDir = realpathSync(mkdtempSync(join(tmpdir(), 'qaf-mcp-')));
writeFileSync(join(mcpDir, 'empty-suite.json'), '[]');
writeFileSync(join(mcpDir, 'spec.json'), readFileSync('spec.example.json'));
mkdirSync(join(mcpDir, 'generated'));
symlinkSync('/etc', join(mcpDir, 'generated', 'escape'));
const mcp = spawnSync(process.execPath, ['src/mcp.ts'], {
  encoding: 'utf8',
  input: [
    rpc(1, 'initialize', {protocolVersion: '2025-06-18'}),
    JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}),
    rpc(2, 'tools/list', {}),
    pairwiseCall(3, {cwd: process.cwd(), spec: 'spec.example.json'}),
    pairwiseCall(4, {spec: 'spec.example.json'}),
    pairwiseCall(5, {
      cwd: process.cwd(),
      name: 'body',
      type: 'string',
      min: 1,
      max: 1024 * 1024,
      debug: true,
    }),
    pairwiseCall(6, {
      cwd: process.cwd(),
      spec: 'spec.example.json',
      adapter: 'x.mjs',
    }),
    pairwiseCall(7, {
      cwd: mcpDir,
      spec: 'spec.json',
      verify: 'empty-suite.json',
    }),
    pairwiseCall(8, {
      cwd: process.cwd(),
      spec: 'spec.example.json',
      verify: 'spec.example.json',
    }),
    ...[
      {spec: 'spec.json', out: '/tmp/qaf-escape.json'},
      {spec: 'spec.json', out: '../escape.json'},
      {spec: 'spec.json', out: 'generated/cases.txt'},
      {spec: 'spec.json', out: 'generated/escape/cases.json'},
      {spec: '/etc/hosts'},
      {spec: 'spec.json', verify: '../../etc/hosts'},
      {spec: 'spec.json', out: 'generated/cases.json'},
      {spec: resolve('fixtures/price-calculation.spec.json')},
    ].map((args, i) => pairwiseCall(9 + i, {cwd: mcpDir, ...args})),
  ].join('\n'),
});
const [
  init,
  list,
  call,
  noCwd,
  big,
  mcpAdapter,
  gaps,
  mcpBadSuite,
  ...confined
] = mcp.stdout
  .trim()
  .split('\n')
  .map(line => JSON.parse(line));
assert.equal(init.result.serverInfo.name, 'qa-framework');
assert.deepEqual(
  list.result.tools.map((t: {name: string}) => t.name),
  ['bva', 'ep', 'pairwise'],
);
assert.equal(call.result.isError, false, call.result.content[0].text);
assert.match(call.result.content[0].text, /"cases"/);
assert.equal(noCwd.result.isError, true);
assert.equal(mcpAdapter.result.isError, true);
assert.match(mcpAdapter.result.content[0].text, /unknown argument adapter/);
// Coverage gaps from `verify` are a report, not an error; a bad suite still is.
assert.equal(gaps.result.isError, false);
assert.match(gaps.result.content[0].text, /^uncovered \(exit 1\)\n2-tuples/);
assert.equal(mcpBadSuite.result.isError, true);
assert.match(mcpBadSuite.result.content[0].text, /^error: /m);
// Prompt-injected arguments can't write outside <cwd>/generated or read
// outside cwd; the reference spec in fixtures/ stays readable.
const confinedText = confined.map(r => r.result.content[0].text);
assert.deepEqual(confinedText.slice(0, 6), [
  'error: out must be a .json file under generated/ in cwd',
  'error: out must be a .json file under generated/ in cwd',
  'error: out must be a .json file under generated/ in cwd',
  'error: out must be a .json file under generated/ in cwd',
  'error: spec must be inside cwd',
  'error: verify must be inside cwd',
]);
assert.equal(confined[6].result.isError, false, confinedText[6]);
assert.ok(existsSync(join(mcpDir, 'generated', 'cases.json')));
assert.equal(confined[7].result.isError, false, confinedText[7]);
assert.ok(!existsSync('/tmp/qaf-escape.json'));
rmSync(mcpDir, {recursive: true});
// Cases on stdout and the debug report on stderr each pass spawnSync's default
// 1 MiB buffer; each is cut to 100k, only the stdout cut hints at `out`
// (which redirects stdout alone), and the two are joined by '\n'.
const bigText = big.result.content[0].text;
const cut = '\n... truncated';
const hint = '; pass out to write a file';
assert.equal(big.result.isError, false, bigText.slice(0, 200));
assert.match(bigText, /tuples covered/);
assert.equal(bigText.indexOf(`${cut}${hint}\n`), 100_000);
assert.ok(bigText.endsWith(cut), bigText.slice(-80));
assert.equal(bigText.length, 2 * (100_000 + cut.length) + hint.length + 1);

// Plugin manifests: Claude Code and Cursor ship the same skills, agents and
// version; Claude Code needs every agent listed by file.
const record = (x: unknown): Record<string, unknown> => {
  assert.ok(isRecord(x), JSON.stringify(x));
  return x;
};
const claudePlugin = record(readJson('.claude-plugin/plugin.json'));
const cursorPlugin = record(readJson('.cursor-plugin/plugin.json'));
const marketplace = record(readJson('.claude-plugin/marketplace.json'));
for (const key of ['name', 'description', 'version', 'repository']) {
  assert.equal(claudePlugin[key], cursorPlugin[key], key);
}
assert.equal(claudePlugin.homepage, cursorPlugin.homepage);
assert.equal(init.result.serverInfo.version, claudePlugin.version);
// The marketplace has its own name; its single entry is the plugin, and the
// version lives only in the plugin manifests (Claude Code warns otherwise).
assert.equal(marketplace.name, 'siarhei-zavadski');
assert.equal(marketplace.description, claudePlugin.description);
assert.ok(Array.isArray(marketplace.plugins));
assert.equal(marketplace.plugins.length, 1);
const listing = record(marketplace.plugins[0]);
assert.equal(listing.name, claudePlugin.name);
assert.equal(listing.description, claudePlugin.description);
assert.equal(listing.source, './');
assert.ok(!Object.hasOwn(listing, 'version'));
const agentFiles = readdirSync('.cursor/agents')
  .filter(file => file.endsWith('.md'))
  .sort()
  .map(file => `./.cursor/agents/${file}`);
assert.deepEqual(claudePlugin.agents, agentFiles);
for (const path of [claudePlugin.skills, ...agentFiles]) {
  assert.ok(typeof path === 'string' && path.startsWith('./'), String(path));
  assert.ok(existsSync(path), path);
}
const mcpServers = record(claudePlugin.mcpServers);
assert.deepEqual(record(mcpServers['qa-framework']).args, [
  '${CLAUDE_PLUGIN_ROOT}/src/mcp.ts',
]);
// Cursor reads its own manifest (component paths replace folder discovery)
// and the root mcp.json.
for (const path of [cursorPlugin.skills, cursorPlugin.agents]) {
  assert.ok(typeof path === 'string' && existsSync(path), String(path));
}
const cursorMcp = record(record(readJson('mcp.json')).mcpServers);
assert.deepEqual(record(cursorMcp['qa-framework']).args, [
  '${CURSOR_PLUGIN_ROOT}/src/mcp.ts',
]);

// Installer: package rules npx depends on, both manifests' MCP commands, and
// the step planner against fake machines.
assert.ok(!existsSync('bin'), 'a top-level bin/ goes on the Bash PATH');
const pkg = record(readJson('package.json'));
const scripts = record(pkg.scripts);
for (const hook of [
  'build',
  'prepare',
  'prepack',
  'preinstall',
  'install',
  'postinstall',
]) {
  assert.ok(!Object.hasOwn(scripts, hook), `package.json script ${hook}`);
}
assert.ok(!Object.hasOwn(pkg, 'dependencies'));
const entry = String(record(pkg.bin)['qa-framework']);
const entryText = readFileSync(entry, 'utf8');
assert.ok(entryText.startsWith('#!/usr/bin/env node\n'));
assert.doesNotMatch(entryText, /^import\b/m);
assert.match(entryText, /await import\('\.\/setup\.mjs'\)/);
const help = spawnSync(process.execPath, [entry, '--help'], {encoding: 'utf8'});
assert.equal(help.status, 0);
assert.match(help.stdout, /^Usage: npx github:siarhei-zavadski\/qaFramework/);
for (const harness of ['claude', 'cursor'] as const) {
  const shake = handshake(process.cwd(), harness);
  assert.ok(shake.ok, `${harness}: ${shake.message}`);
}

const repo = process.cwd();
const home = '/home/u/.cursor';
const pluginDir = `${home}/plugins/local/qa-framework`;
const copyDir = `${home}/qa-framework`;
const absent = (path: string) => ({
  path,
  state: 'absent' as const,
  origin: undefined,
  dirty: false,
});
type LinkState = Env['cursor']['links'][number]['state'];
const links = (root: string, state: LinkState = 'missing') => [
  {
    path: `${home}/skills/generating-test-cases`,
    target: `${root}/.cursor/skills/generating-test-cases`,
    state,
    otherRoot: state === 'other-root' ? '/old/qaFramework' : undefined,
  },
  {
    path: `${home}/agents/change-judge.md`,
    target: `${root}/.cursor/agents/change-judge.md`,
    state,
    otherRoot: state === 'other-root' ? '/old/qaFramework' : undefined,
  },
];
const cursorEnv = (root = repo): Env['cursor'] => ({
  home: true,
  cli: 'agent',
  cliVersion: '2026.10.22',
  localPlugins: false,
  plugin: absent(pluginDir),
  copy: absent(copyDir),
  root,
  mcpFile: `${home}/mcp.json`,
  mcpState: 'missing',
  mcpServer: undefined,
  mcpOtherRoot: undefined,
  mcpError: undefined,
  mcpComments: false,
  links: links(root),
  extraLinks: [],
  marketplaceCopies: [],
});
const fakeEnv = (over: Partial<Env> = {}): Env => ({
  root: repo,
  mode: 'checkout',
  hasManifests: true,
  source: repo,
  cloneUrl: repo,
  sourceDirty: false,
  git: true,
  tty: false,
  cwd: '/work/app',
  node: '/usr/bin/node',
  claude: {version: '2.1.317', marketplaces: [], plugins: []},
  cursor: cursorEnv(),
  ...over,
});
const withCursor = (over: Partial<Env['cursor']>) =>
  fakeEnv({cursor: {...cursorEnv(), ...over}});
const userPlugin = {
  id: 'qa-framework@siarhei-zavadski',
  scope: 'user',
  enabled: true,
  installPath: '/cache/qa-framework',
  readFromFolder: undefined,
  projectPath: undefined,
};
const ourMarket = {name: 'siarhei-zavadski', source: 'directory', path: repo};
const withClaude = (
  plugins: Env['claude']['plugins'],
  marketplaces: Env['claude']['marketplaces'] = [ourMarket],
) => fakeEnv({claude: {version: '2.1.317', marketplaces, plugins}});
type Steps = ReturnType<typeof planSteps>;
const plan = (argv: string[], env: Env) => planSteps(parseArgs(argv), env);
const kinds = (steps: Steps) => steps.map(s => s.kind);
const runs = (steps: Steps) =>
  steps.flatMap(s => (s.kind === 'run' ? [[s.cmd, ...s.args].join(' ')] : []));
const edits = (steps: Steps) =>
  steps.flatMap(s => {
    if (s.kind === 'link') return [`link ${s.path} ${s.target}`];
    if (s.kind === 'unlink') return [`unlink ${s.path}`];
    if (s.kind === 'mcp-set')
      return [`mcp ${s.server.command} ${s.server.args}`];
    if (s.kind === 'mcp-remove' || s.kind === 'remove') return [s.kind];
    return [];
  });
const texts = (steps: Steps) =>
  steps.map(s => ('text' in s ? s.text : '')).join('\n');
const stops = (steps: Steps) => kinds(steps).filter(k => k === 'stop').length;

// Checkout, admin blocks local plugins: Claude installs in place, Cursor gets
// the user config pointing at the checkout.
const both = plan(['--claude', '--cursor'], fakeEnv());
assert.deepEqual(runs(both), [
  `claude plugin install qa-framework --marketplace ${repo} --scope user -y --json`,
]);
assert.deepEqual(edits(both), [
  `mcp /usr/bin/node ${repo}/src/mcp.ts`,
  `link ${home}/skills/generating-test-cases ${repo}/.cursor/skills/generating-test-cases`,
  `link ${home}/agents/change-judge.md ${repo}/.cursor/agents/change-judge.md`,
]);
// Local plugins allowed: the plugin clone instead.
const allowed = withCursor({localPlugins: true});
assert.deepEqual(runs(plan(['--cursor'], allowed)), [
  `git clone --quiet ${repo} ${pluginDir}`,
]);
assert.deepEqual(edits(plan(['--cursor'], allowed)), []);
assert.match(
  texts(plan(['--cursor', '--cursor-mode', 'plugin'], fakeEnv())),
  /admin blocks local plugins/,
);
assert.match(
  texts(
    plan(
      ['--cursor'],
      withCursor({localPlugins: true, links: links(repo, 'ours')}),
    ),
  ),
  /still link qa-framework/,
);
// GitHub: Claude from owner/repo; Cursor config from a stable clone.
const github = fakeEnv({
  mode: 'package',
  source: 'siarhei-zavadski/qaFramework',
  cloneUrl: 'https://github.com/siarhei-zavadski/qaFramework.git',
  cursor: cursorEnv(copyDir),
});
const fromGithub = plan(['--claude', '--cursor'], github);
assert.deepEqual(runs(fromGithub), [
  'claude plugin install qa-framework --marketplace siarhei-zavadski/qaFramework --scope user -y --json',
  `git clone --quiet https://github.com/siarhei-zavadski/qaFramework.git ${copyDir}`,
]);
assert.equal(edits(fromGithub)[0], `mcp /usr/bin/node ${copyDir}/src/mcp.ts`);
assert.deepEqual(
  runs(plan(['--claude', '--scope', 'project'], github)).map(r =>
    r.split(' ').slice(1, 4).join(' '),
  ),
  ['plugin marketplace add', 'plugin install qa-framework@siarhei-zavadski'],
);
// An insteadOf rewrite turns the clone's origin into ssh://: still ours.
const sshCopy = {
  ...absent(copyDir),
  state: 'clone' as const,
  origin: 'ssh://git@github.com/siarhei-zavadski/qaFramework.git',
};
assert.equal(
  stops(
    plan(['--cursor'], {
      ...github,
      cursor: {...cursorEnv(copyDir), copy: sshCopy},
    }),
  ),
  0,
);
assert.equal(stops(plan(['--claude'], {...github, hasManifests: false})), 1);
assert.equal(stops(plan(['--cursor'], {...github, hasManifests: false})), 1);
assert.equal(stops(plan(['--claude', '--scope', 'project'], fakeEnv())), 1);
const foreign = withClaude(
  [],
  [{name: 'siarhei-zavadski', source: 'github', repo: 'x/y'}],
);
assert.deepEqual(kinds(plan(['--claude'], foreign)), ['stop']);
assert.equal(
  stops(
    plan(
      ['--claude'],
      fakeEnv({claude: {version: '2.1.200', marketplaces: [], plugins: []}}),
    ),
  ),
  1,
);

// Claude: installed is a no-op, disabled gets enabled, uninstall cleans up.
const installed = withClaude([userPlugin]);
assert.deepEqual(runs(plan(['--claude'], installed)), []);
assert.deepEqual(
  runs(plan(['--claude'], withClaude([{...userPlugin, enabled: false}]))),
  ['claude plugin enable qa-framework@siarhei-zavadski --scope user --json'],
);
assert.deepEqual(runs(plan(['uninstall', '--claude'], installed)), [
  'claude plugin uninstall qa-framework@siarhei-zavadski --scope user --json',
  'claude plugin marketplace remove siarhei-zavadski --json',
]);
// Plugin already gone, marketplace left over: still removed.
assert.deepEqual(runs(plan(['uninstall', '--claude'], withClaude([]))), [
  'claude plugin marketplace remove siarhei-zavadski --json',
]);
// Someone else's marketplace of that name is never removed.
assert.deepEqual(
  runs(
    plan(
      ['uninstall', '--claude'],
      withClaude(
        [userPlugin],
        [{name: 'siarhei-zavadski', source: 'github', repo: 'x/y'}],
      ),
    ),
  ),
  ['claude plugin uninstall qa-framework@siarhei-zavadski --scope user --json'],
);
assert.deepEqual(kinds(plan(['uninstall', '--claude'], fakeEnv())), ['skip']);
// Another project's local install: update and uninstall leave it alone.
const elsewhere = {
  ...userPlugin,
  scope: 'local',
  installPath: '/cache/qa-framework',
  projectPath: '/work/other',
};
const copiedUser = {...userPlugin};
assert.deepEqual(
  runs(plan(['update', '--claude'], withClaude([elsewhere, copiedUser]))),
  [
    'claude plugin marketplace update siarhei-zavadski --json',
    'claude plugin update qa-framework@siarhei-zavadski --scope user --json',
  ],
);
assert.deepEqual(
  runs(plan(['uninstall', '--claude'], withClaude([elsewhere, copiedUser]))),
  ['claude plugin uninstall qa-framework@siarhei-zavadski --scope user --json'],
);
const inPlace = {...userPlugin, readFromFolder: repo};
assert.equal(pluginRoot(inPlace), repo);
assert.deepEqual(runs(plan(['update', '--claude'], withClaude([inPlace]))), []);

// Cursor config in place: install skips, uninstall removes only ours.
const ourServer = {command: '/opt/node', args: [`${repo}/src/mcp.ts`]};
const configured = withCursor({
  mcpState: 'ours',
  mcpServer: ourServer,
  links: links(repo, 'ours'),
});
assert.deepEqual(edits(plan(['--cursor'], configured)), []);
assert.deepEqual(edits(plan(['uninstall', '--cursor'], configured)), [
  'mcp-remove',
  `unlink ${home}/skills/generating-test-cases`,
  `unlink ${home}/agents/change-judge.md`,
]);
// A Node upgrade left a dead command: install and update rewrite it.
const staleNode = withCursor({
  mcpState: 'stale-node',
  mcpServer: {command: '/gone/node', args: [`${repo}/src/mcp.ts`]},
  links: links(repo, 'ours'),
});
assert.deepEqual(edits(plan(['--cursor'], staleNode)), [
  `mcp /usr/bin/node ${repo}/src/mcp.ts`,
]);
assert.deepEqual(edits(plan(['update', '--cursor'], staleNode)), [
  `mcp /usr/bin/node ${repo}/src/mcp.ts`,
]);
// The checkout moved: dangling entries are replaced, then removed on uninstall.
const moved = withCursor({
  mcpState: 'dangling',
  mcpServer: {command: '/opt/node', args: ['/old/qaFramework/src/mcp.ts']},
  links: links(repo, 'dangling'),
});
assert.deepEqual(edits(plan(['--cursor'], moved)), [
  `mcp /usr/bin/node ${repo}/src/mcp.ts`,
  `unlink ${home}/skills/generating-test-cases`,
  `link ${home}/skills/generating-test-cases ${repo}/.cursor/skills/generating-test-cases`,
  `unlink ${home}/agents/change-judge.md`,
  `link ${home}/agents/change-judge.md ${repo}/.cursor/agents/change-judge.md`,
]);
assert.deepEqual(edits(plan(['uninstall', '--cursor'], moved)), [
  'mcp-remove',
  `unlink ${home}/skills/generating-test-cases`,
  `unlink ${home}/agents/change-judge.md`,
]);
// Installed from another live checkout: install stops naming its --source.
const otherRoot = withCursor({
  mcpState: 'other-root',
  mcpServer: {command: '/opt/node', args: ['/old/qaFramework/src/mcp.ts']},
  mcpOtherRoot: '/old/qaFramework',
  links: links(repo, 'other-root'),
});
assert.equal(stops(plan(['--cursor'], otherRoot)), 1);
assert.match(
  texts(plan(['--cursor'], otherRoot)),
  /--source \/old\/qaFramework/,
);
assert.deepEqual(edits(plan(['uninstall', '--cursor'], otherRoot)), []);
assert.match(
  texts(plan(['uninstall', '--cursor'], otherRoot)),
  /--source \/old\/qaFramework/,
);
// Doctor warns once about the other install instead of failing on its links.
const doctorLines: string[] = [];
const log = console.log;
console.log = (line: string) => doctorLines.push(line);
const otherRootOk = doctor(parseArgs(['doctor', '--cursor']), {
  ...otherRoot,
  cursor: {...otherRoot.cursor, cli: undefined},
});
console.log = log;
assert.ok(otherRootOk, doctorLines.join('\n'));
assert.equal(doctorLines.filter(line => line.includes('--source')).length, 1);
// Update adds links for new skills and drops links for removed ones.
const grown = withCursor({
  mcpState: 'ours',
  mcpServer: ourServer,
  links: [
    ...links(repo, 'ours'),
    {
      ...links(repo)[0]!,
      path: `${home}/skills/new`,
      target: `${repo}/.cursor/skills/new`,
    },
  ],
  extraLinks: [
    {
      path: `${home}/skills/renamed`,
      target: `${home}/skills/renamed`,
      state: 'dangling',
      otherRoot: undefined,
    },
  ],
});
assert.deepEqual(edits(plan(['update', '--cursor'], grown)), [
  `link ${home}/skills/new ${repo}/.cursor/skills/new`,
  `unlink ${home}/skills/renamed`,
]);
assert.ok(
  edits(plan(['uninstall', '--cursor'], grown)).includes(
    `unlink ${home}/skills/renamed`,
  ),
);
// A foreign clone no longer blocks updating ours.
const foreignPlugin = {
  ...absent(pluginDir),
  state: 'clone' as const,
  origin: '/elsewhere/qaFramework',
};
const oursCopy = {
  ...absent(copyDir),
  state: 'clone' as const,
  origin: 'https://github.com/siarhei-zavadski/qaFramework.git',
};
const mixed = {
  ...github,
  cursor: {...cursorEnv(copyDir), plugin: foreignPlugin, copy: oursCopy},
};
assert.equal(stops(plan(['update', '--cursor'], mixed)), 0);
assert.deepEqual(runs(plan(['update', '--cursor'], mixed)), [
  `git -C ${copyDir} pull --ff-only --quiet`,
]);
const otherServer = withCursor({
  mcpState: 'foreign',
  mcpServer: {command: 'node', args: ['/x/mcp.ts']},
});
assert.equal(stops(plan(['--cursor'], otherServer)), 1);
assert.deepEqual(edits(plan(['uninstall', '--cursor'], otherServer)), []);
assert.equal(stops(plan(['--cursor'], withCursor({mcpComments: true}))), 1);
assert.equal(
  stops(plan(['--cursor'], withCursor({mcpState: 'invalid', mcpError: 'x'}))),
  1,
);
// An unreadable mcp.json doesn't block removing the links.
assert.deepEqual(
  edits(
    plan(
      ['uninstall', '--cursor'],
      withCursor({mcpState: 'invalid', links: links(repo, 'ours')}),
    ),
  ),
  [
    `unlink ${home}/skills/generating-test-cases`,
    `unlink ${home}/agents/change-judge.md`,
  ],
);
assert.equal(
  stops(plan(['--cursor'], withCursor({links: links(repo, 'foreign')}))),
  1,
);
assert.deepEqual(kinds(plan(['uninstall', '--cursor'], fakeEnv())), ['skip']);
// A plugin clone: unpublished work is refused, clean is removed.
const clone = {...absent(pluginDir), state: 'clone' as const, origin: repo};
assert.equal(
  stops(
    plan(
      ['uninstall', '--cursor'],
      withCursor({plugin: {...clone, dirty: true}}),
    ),
  ),
  1,
);
assert.deepEqual(
  edits(plan(['uninstall', '--cursor'], withCursor({plugin: clone}))),
  ['remove'],
);
assert.deepEqual(
  parseJsonc('{"a": "x,}//", // note\n "b": [1, 2,], /* c */}'),
  {value: {a: 'x,}//', b: [1, 2]}, comments: true, error: undefined},
);
assert.deepEqual(parseJsonc('﻿{"a": 1,\n}').value, {a: 1});
assert.deepEqual(parseJsonc('  \n').value, {});
assert.match(String(parseJsonc('{"a": 1}}').error), /position 8/);
await assert.rejects(
  choose(parseArgs([]), fakeEnv()),
  /pass --claude, --cursor/,
);
assert.equal(parseResult('').ok, false);
assert.equal(parseResult('warning\nnot json').ok, false);
assert.deepEqual(
  parseResult('x\n{"command":"install","outcome":"ok","message":"Installed"}'),
  {ok: true, message: 'Installed'},
);
assert.equal(
  parseResult('{"command":"install","outcome":"failed","message":"m"}').ok,
  false,
);
assert.throws(() => parseArgs(['--scope', 'team']), /--scope must be one of/);
assert.throws(() => parseArgs(['--nope']), /unknown argument --nope/);
// --source: owner/repo is always GitHub, paths need /, ./ or ~, and
// option-like values are refused.
assert.deepEqual(resolveSource(repo, 'checkout', 'src/x', {}), {
  source: 'src/x',
  cloneUrl: 'https://github.com/src/x.git',
});
assert.equal(
  resolveSource(repo, 'checkout', 'github:a/b', {}).cloneUrl,
  'https://github.com/a/b.git',
);
assert.equal(
  resolveSource(repo, 'checkout', './src', {}).source,
  `${repo}/src`,
);
assert.throws(
  () => resolveSource(repo, 'checkout', './missing', {}),
  /no such/,
);
assert.throws(
  () => resolveSource(repo, 'checkout', '--upload-pack=x', {}),
  /unsafe/,
);
assert.throws(
  () => resolveSource(repo, 'checkout', 'ext::sh', {}),
  /use a path/,
);
assert.match(
  texts(plan(['--cursor'], fakeEnv())),
  /whatever it has checked out is live/,
);

console.log(
  `all checks passed (exercise: ${generated.length} cases, ` +
    `lower bound ${exercise.lowerBound}; price-calculation: ${priceCases.length} cases)`,
);
