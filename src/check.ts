/**
 * @fileoverview Self-check for the CLI; run with `npm test` after any change.
 */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {analyzeBoundaries, boundaryValues} from './bva.ts';
import {analyzePartitions, partitionValues} from './ep.ts';
import {
  coveringRows,
  generateCases,
  merge,
  report,
  validDomains,
  type Case,
} from './pairwise.ts';
import {parseFormula} from './formula.ts';
import {rowsForRules, uncoveredRules} from './rules.ts';
import {parseSpec, readJson, type Spec} from './spec.ts';

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
  [{fields: [goodField], strenght: 3}, /spec: unknown key strenght/],
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
assert.match(
  debug.stderr,
  /negative base row: \{"price":50,"weight":2\.5,"card":false\} \(expected 50\)/,
);
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
  ].join('\n'),
});
const [init, list, call, noCwd, big] = mcp.stdout
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

console.log(
  `all checks passed (exercise: ${generated.length} cases, ` +
    `lower bound ${exercise.lowerBound}; price-calculation: ${priceCases.length} cases)`,
);
