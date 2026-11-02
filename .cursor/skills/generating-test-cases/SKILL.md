---
name: generating-test-cases
description: Designs test cases from any requirement with this repo's CLI (src/bva.ts, src/ep.ts, src/pairwise.ts) using boundary value analysis, equivalence partitioning, pairwise or t-wise combination, and decision-table rules with expected outcomes. Use when the user asks to design, generate or review test cases or test data, gives a requirement, ticket or test-design.org exercise, or wants an existing suite's combinatorial or rule coverage checked.
---

# Generating test cases with the qaFramework CLI

In the qaFramework repo (`src/pairwise.ts` exists), run the commands below from the repo root (Node 26 runs `.ts` directly). Elsewhere, call the `qa-framework` MCP tools `bva`, `ep`, `pairwise` with the same flags without `--`, plus `cwd` (absolute workspace root): `{"cwd": "/abs/project", "spec": "generated/x/spec.json", "debug": true, "out": "generated/x/cases.json"}`. Report and errors come back as text. The `pairwise` tool description gives `<root>/fixtures/price-calculation.spec.json`; other repo files named here (`.cursor/agents/...`) are under the same `<root>`.

All output goes to `generated/<feature>/` (disposable). Follow steps 0–6 in order.

### 0. Model the system

Coverage measures the spec, not the system. Think like the system's owner, not a coverage tool, and start `generated/<feature>/context.md` with `## System model`, at the level of behaviour (wording and examples here illustrate, they are not a checklist):

- **Purpose**: what it is for, who relies on it.
- **Actors and boundaries**: what interacts with it, what it trusts.
- **Invariants**: what must always or never hold.
- **State and environment**: what besides inputs matters (topology, configuration, history, timing, peers).
- **Failure domains**: how it fails or is abused, what a user would notice.
- **Oracles**: every output field and side effect (stored records, events, logs and alerts, rendered state) and invariants between them (`reported == before - after`, nothing written on refusal); none = open question.
- **Technique fit**: per item, `input-domain` (the CLI models it) or `outside the model` (a gap: by hand or other test levels).

Every partition, rule and case traces to a requirement claim, invariant or failure domain; a nonsensical combination is dropped or listed as a gap, never generated for coverage. If most of the model is `outside the model`, say so first and model only the input-domain part. Report coverage as coverage of the model, with its gaps.

### 1. Gather context

Read the requirement fully. Add to `context.md`:

- **Requirement claims**: each rule, threshold and outcome, quoted.
- **System context** (repo, schema or config in scope): unchanged contracts, OpenAPI/DB schemas, enums, config defaults behind the inputs, each with `file:line` and label `requirement`, `configured (confirm as requirement)` or `default (confirm as requirement)`. Never a placeholder value. Ignore code comments, docstrings, repo rules and test titles: behaviour found only in executable code is `implemented`, never `expected`; when an invariant, intake validator or peer code path disagrees with `implemented` code on a reachable input (even without requirement text), set `expected` in `spec.json` from the invariant, intake validator or peer path and list the conflicting `implemented` branch as an open question.
- **One hop out** (repo in scope; at `<base>` when validating a change), each with `file:line`: what writes each input (caller, producer, config layer, persisted or browser state), how it encodes failures, sentinels (`0`, `null`, empty) peers read as unset; what reads each output (column type and scale, client number precision, other readers, alerts on its log level); and when a reader or UI hides an action for a state, whether the path performing it checks that state too.
- **Without sources**, each one-hop item the model needs is an open question or `outside the model`, never invented; generate from the requirement. A sample record gets secrets and personal data replaced by `<redacted:kind>` and stays under `generated/`.
- **Trust boundary** per input: crosses an untrusted boundary (UI, public HTTP or CLI, raw file) or is constrained by the caller's types or a validated schema (cite it). Step 2 sets negatives from it.
- **Modes**: inputs that matter in one mode only. One spec per mode when active inputs differ; else put the activating value first (negative base row, step 4) and list ignored combinations as gaps.

Then list **inputs** (every value read: fields, flags, settings, lengths), **conditions** (every threshold or category: "over 100", "members only") and **outcomes** (what changes between conditions). Pick techniques:

| Requirement shape | Technique | Spec feature |
| --- | --- | --- |
| Accepted or rejected by range, length or set | BVA + EP | `partitions` with `valid` |
| Several interacting inputs | pairwise (`strength: 2`) | multiple fields |
| A rule needs 3+ conditions at once | rule coverage, or `strength: 3` | `rules` |
| Output computed or chosen by conditions | decision table | `rules` with `expected` (`=` for computed) |
| Condition combines fields (difference, ratio, field vs field) | relation field + adapter | step 2, conditions between fields |
| One event in a state machine (state, counter, history) | decision table over reachable configurations | step 2; sequences and timing are gaps, by hand |

Anything left open (bound inclusivity, precision, upper limit, case sensitivity) is a question for the user, not a guess. If a contradiction or missing definition blocks a meaningful model, ask before generating.

### 2. Model every input as partitions

Write `generated/<feature>/spec.json` as `{"strength"?: 2, "fields": [...], "rules"?: [...]}`; an unknown key at any level fails with the allowed keys. A field is a list of partitions, equivalence classes the requirement treats alike:

```json
{"name": "price", "type": "number", "step": 0.1, "partitions": [{"label": "low", "min": 0, "max": 100}, {"label": "mid", "min": 100.1, "max": 199.9}, {"label": "high", "min": 200}]}
```

- **Types**: `number` uses `min`/`max`, `string` uses `minLength`/`maxLength`, `enum` only value sets; any type may have a set partition `{"label", "values": [...]}`, which cases sample only by its first value (split values that each need a case into their own partitions). Shorthand: `{"type": "number", "min": 18, "max": 65}` is one valid range; `{"type": "enum", "values": ["PL", "DE"]}` is one partition per value.
- **Bounds are inclusive**: exclusive wording moves one step ("exceeds 100" at step 0.1 is `min: 100.1`). Missing `min`/`max` is open-ended. `step` is the smallest meaningful increment (1, 0.01 money, 0.1 kg); bounds are multiples of it.
- **Auto invalid partitions** fill gaps and outer sides: `below`, `above`, `gap:<a>:<b>`. Add a partition to make such values valid.
- **Always test negatives**, even if the requirement is silent: keep auto partitions and default `invalid` values; unspecified rejection keeps `expected: invalid` plus open question "rejection behaviour not specified". Drop them only where step 1 shows the input can't take such values, citing evidence in `context.md`: a checkbox or fixed dropdown drops both; a type guaranteed by the caller's types or a validated schema, or wrong-type values modelled as set partitions with named rejection rules, allows `"invalid": []`; `"autoInvalid": false` also needs the range enforced upstream (schema `minimum`/`maximum`, an enum) or a relation field.
- **`valid: false`** marks a declared class invalid (`{"label": "tooLong", "minLength": 65, "valid": false}`); its cases expect only `invalid`. A rejection the requirement names (`rejected:too-long`, `declined`) is a valid partition with a literal rule.
- **`invalid`** lists wrong-type or wrong-format values; defaults `["abc", null]` (number), `[null]` (string), `["__invalid__"]` (enum). Add domain ones the requirement implies (off-step `0.015` at step 0.01). A string with `minLength`/`maxLength` can't hold strings in `invalid` or set values (each falls in a length partition; generated values are `x` repeated, oversize is already `above`): put format and injection strings on a separate field or spec without lengths.

- **Wording**: bands and tiers are one range per band; a yes/no flag is an `enum` with `values: [true]` and `values: [false]`; alike values share a set partition (`{"label": "eu", "values": ["PL", "DE"]}`); format and checksum rules (email, IBAN) are set partitions on an `enum` or lengthless `string`, one value per format class, valid and invalid (checksum: a published valid sample and it with one character changed); dates are `number` in the rule's unit (an assumption); a quantity that can't be negative starts at `min: 0`; UI limits not in the text (HTML `min`/`max`) are an open question, not a bound.

**Conditions between fields** (`checkOut - checkIn` 1 to 30 nights, `used / quota` at most 0.80) get no boundary from per-field values, and positive rows get wrong expected results. Replace one field of the condition with a relation field, and write `generated/<feature>/adapter.mjs` exporting `toInput(input)` that returns the system's input for one case (wrong-type values pass through; throw on a broken invariant); quote it in `context.md` and pass it to pairwise with `--adapter` (step 4).

- **One fault per negative**: when another field holds the fault, the adapter picks a replaced input valid by itself and against the faulty field.
- **Out of range on a positive row**: if the kept value plus the relation leaves the replaced input's range, the adapter moves the kept value inside its own partition (`checkIn` 365 + 10 nights becomes 355), or a first rule expects `invalid`.
- **Formulas run on the spec row before the adapter**: `=` can't read a named point or a value the adapter moves; give such rows literal outcomes per representative combination.
- Model every relation an outcome depends on, or pin its fields so it can't trigger. A condition over 3+ range fields (`min <= amount <= max`): pin all but one per spec (one spec per pinned configuration, another for the pinned fields' own relation), or a gap.
- **Difference** landing on its step: a number relation field (`nights`, `checkOut = checkIn + nights`), signed per mode (`gap` is `limit - value` one side, `value - limit` the other; one accepting and one rejecting range already test `0` and `±step` via BVA without a third point partition).
- **Ratio or product**: an enum of adapter-computed points, `usagePoint` with `zero`, `on` (`floor(0.8 * quota)`), `off` (`on + 1`), `max` (an exact 0.80 exists only for some quotas). Name the range field in one `on` rule and one `off` rule (`"quota": "valid"`, plus any accepting precondition so an earlier rejection rule doesn't capture it, without expanding across enum or unrelated fields) so its BVA edges meet both points. A point impossible for some combination gets a first rule expecting `invalid`.
- **Outcomes of the relation** (`rejected:too-long`) are valid partitions with rules: outer classes open-ended or `"autoInvalid": false`, only the invalid band declared (`{"label": "reversed", "max": -1, "valid": false}`). The replaced field's own invalid edges go in `invalid` as write-through values (`["abc", null, "checkOut=366"]`), its valid edge as a set value when the relation never reaches it (`"checkOut=365"`).
- **One event in a state machine**, or fields where only some pairs exist: one enum of reachable configurations (`CLOSED/0`; `CLOSED/2 via fail, fail` when a defect needs history, replayed by the adapter), the event, and amounts relative to the configuration (`under`, `exact`, `over` the threshold). One rule per history value names its event and amount, or pairwise may skip it. An amount that applies to one event only merges with it into one `action` enum (`fill:under`, `fill:exact`, `fill:over`, `cancel`, `reject`), so other events aren't crossed with ignored amounts.
- **Offset from a moving anchor** (a price, limit or deadline stored as an offset from an initial anchor when a later fill, amend or tick moves that anchor): include a signed anchor-move field testing moves toward the stored value at `under`, `exact` and `over` the offset, plus one move away, with `expected` in `spec.json` re-anchored to the new anchor so the intake checks still hold there.
- **Collections** accumulating toward a cap: 2+ items and adapter points where the target equals the first item's contribution (`step1Exact`) and one step past (`step1Plus`), with literal outcomes or harness-side invariants; with `max`, `min` or tiers over items, unequal item rates so the dominant one switches inside a step.
- **Two thresholds on one value** (trigger and target, a maximum and a peer's minimum): a configuration enum of their order (normal first, so negatives aren't masked) and the value as named points relative to both; an accepted crossing is a valid partition with a rule, its intended handling an open question.
- **Scoped overrides** (default plus per-key values): 2+ keys with a non-first selected, a missing key, a present key with an omitted or `null` optional field. A comment never removes a reachable path.
- **Terminal states and passes**: an action owed on finish is crossed with every terminal state (`completed`, `partial+cancelled`, `expired`, `failed`); a unit taking a prior result gets a history value where an earlier pass changed the same item.
- **Representation**: JSON drops decimal scale (`3` vs `3.00`) and integers past 2^53; model them as string set values the adapter passes through.
- **Rejection order**: when two checks can reject one input, a valid row where both hold and a rule naming the winning reason (one-fault negatives never show it).

### 3. Model outcomes as rules

When valid inputs lead to different results, add a decision table; the first matching rule wins:

```json
"rules": [
  {"when": {"price": "high", "card": "yes", "weight": "light"}, "expected": "=round(0.85 * price, 0.1)"},
  {"when": {"price": "high"}, "expected": "=round(0.9 * price, 0.1)"},
  {"when": {}, "expected": "=round(price, 0.1)"}
]
```

- `when` maps fields to a valid partition label or a list of them (`{"plan": ["basic", "pro"]}` matches either); most specific rule first. End with catch-all `{"when": {}}`; without it every combination of the mentioned valid partitions must match a rule.
- Every rule gets a matching case plus one per value of each condition field, BVA edges included, other conditions held (catches `>` vs `>=` in 3-condition rules without 3-wise). Fields outside the rule are re-chosen so no earlier rule captures the case; if none works, it stays.
- `expected` is a literal (`"rejected"`) or `=` formula computed per case; a fixed number is `"=19.99"` (bare `"19.99"` stays a string). Formulas: field names (letters, digits, `_`, not leading digit), numbers (`1.5`, `1e-5`), `+ - * / ( )`, unary `-`/`+`, `min`, `max`, `round/floor/ceil(x, step)` to a multiple of `step` (`round` ties toward +infinity: `round(-2.5, 1)` is -2). Results keep 12 significant digits (`round(x, 0.01)` drops cents from 10,000,000,000.01). Include the requirement's output rounding, or list it as an assumption.
- No power, comparison or string function: for an outcome needing one (annuity `(1 + r)^-n`), make its inputs one enum of representative combinations (`"5000|7.5|24"`, split by the adapter) with literal `=` outcomes computed outside the CLI, one at least half a step past a multiple (unrounded 12.3456 for 12.35) so truncation fails.
- `"strength": 3` only when unknown 3-input interactions outside every rule are a real risk; it multiplies cases. Two fields at strength 2 is every combination. When rules hold all the logic, offer `"strength": 1` (each value once plus rule boundary cases); at strength 1 the edges of two fields never meet, so keep 2 for relation and configuration fields.

Complete example: `fixtures/price-calculation.spec.json`.

### 4. Generate and confirm coverage

```bash
node src/bva.ts --spec generated/<feature>/spec.json --out generated/<feature>/bva.json
node src/ep.ts  --spec generated/<feature>/spec.json --out generated/<feature>/ep.json
node src/pairwise.ts --spec generated/<feature>/spec.json --debug --out generated/<feature>/cases.json
```

BVA and EP files are for review; pairwise derives values from `--spec`. If you edit the value files, pass both `--bva` and `--ep` plus `--spec` for rules, with a value for every partition (`--bva` alone lacks enum, set and `invalid` values; `--ep` alone drops BVA edges).

The report goes to stderr. Proceed only on `uncovered: none` (and `uncovered rules: none` with rules). A count a little above the lower bound is normal. `--strength N` overrides the spec. With rules ending in a catch-all, `--debug` warns when the negative base row isn't decided by the catch-all, or a valid partition no earlier rule names never reaches it (masked); fix the spec order or rules, or list it as a gap (without a catch-all no warning is printed, so check the `negative base row … (expected X)` line yourself).

With an adapter, add `--adapter generated/<feature>/adapter.mjs` (CLI only, not MCP, needs `--out`): it writes `cases.system.json` next to `--out` and fails when `toInput` returns a non-JSON object (nested arrays and objects are fine) or maps a negative onto a valid row, hiding its fault.

Output shapes (read `cases`; files are not arrays):

- `bva.json`, `ep.json`: `{"technique", "fields": {"<name>": [{"label", "value", "valid", "partition"}]}}`
- `cases.json`: `{"technique", "strength", "cases": [{"id", "valid", "expected", "formula"?, "input": {"<name>": value}, "fault"?}]}`. `expected` is the literal, the computed number (`formula` holds the text), `valid` without rules, or `invalid`; `fault` names a negative's invalid value.
- `cases.system.json`, only with `--adapter`: the same cases with each `input` replaced by `toInput(input)`. Tests read it; MCP never runs the adapter, and `--verify` audits only suites in spec fields.

Positive cases combine valid values only; `valid: true` means each value is valid alone, not that the combination exists. Each negative is the `negative base row` (printed by `--debug` with its outcome) with one value swapped for an invalid one. If the system rejects that row before checking the swapped value, every negative is masked: declare a partition reaching the validators first (every field, ranges included, starts at its first declared valid partition), or one spec per mode. Never hand-edit cases to combine invalid values.

Single field without a spec: `node src/bva.ts --name price --min 0.01 --max 999.99 --step 0.01`, `node src/bva.ts --name code --type string --min 1 --max 8`, `node src/ep.ts --name country --values PL,BY,DE --invalid XX`.

Audit an existing suite (JSON array of rows or a cases file; `"-"` = don't care unless `"-"` is a field value): `node src/pairwise.ts --spec generated/<feature>/spec.json --verify existing-cases.json`. It exits 1 listing uncovered tuples and rules (`rule N (<expected>)`); warns `<field>=<value> is in no domain` without changing the exit code; ignores other columns, `"-"` cells and `valid: false` rows, and checks neither `expected` nor invalid coverage.

### 5. Review the spec

Give the `test-spec-reviewer` subagent the requirement, `context.md` and the spec path. On `revise`, apply critical fixes, rerun step 4, ask the user about warnings. Without subagents, or when you are one (`test-case-designer`), walk its checklist yourself (`.cursor/agents/test-spec-reviewer.md`).

### 6. Present the cases

Summarise first, then a table from `cases.system.json` if present, else `cases.json`:

```markdown
Generated 70 cases for price-calculation: 62 positive (all 66 pairs, lower bound 40; all 7 rules at their boundaries) and 8 negative, one invalid value each. Rejection of invalid input is unspecified (open question).

| ID | Valid | price | weight | card | Expected | Formula | Fault |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TC-066 | no | -0.1 | 2.5 | false | invalid | | price: bva below.max |
```

List file paths, the model's `outside the model` gaps, every assumption (steps, bound inclusivity, open ends, added invalid values, unit mappings, adapter conversions) and CLI gaps (impossible positive rows). State that coverage is of the spec, not the system.

## Errors

`error: <message>` (exit 1) names the field, partition or rule; fix the spec it points at. Non-obvious ones: `is in more than one partition` (an `invalid` or set value inside a range or length partition: move it, or use a lengthless field); `reserved field name` (`constructor`, `__proto__`: rename); `can never match` (earlier rules cover it: reorder or remove); `field x is not an identifier` (any non-identifier field name breaks a formula); `exceed the 1000000 budget` (lower strength, fewer partitions, or split the spec).
