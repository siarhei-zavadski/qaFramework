---
name: generating-test-cases
description: Designs test cases from any requirement with this repo's CLI (src/bva.ts, src/ep.ts, src/pairwise.ts) using boundary value analysis, equivalence partitioning, pairwise or t-wise combination, and decision-table rules with expected outcomes. Use when the user asks to design, generate or review test cases or test data, gives a requirement, ticket or test-design.org exercise, or wants an existing suite's combinatorial or rule coverage checked.
---

# Generating test cases with the qaFramework CLI

In the qaFramework repo (`src/pairwise.ts` exists), run the commands below from the repo root; Node 26 runs the `.ts` files directly. In any other project, call the `qa-framework` MCP tools `bva`, `ep` and `pairwise` instead: the arguments are the same flags without `--`, plus `cwd`, the absolute workspace root, for example `{"cwd": "/abs/project", "spec": "generated/x/spec.json", "debug": true, "out": "generated/x/cases.json"}`. The report and errors come back as text. The `pairwise` tool description gives the reference spec's absolute path, `<root>/fixtures/price-calculation.spec.json`; the other repo files named here (`.cursor/agents/...`) are under the same `<root>`.

## Workflow

```
- [ ] 1. Classify the requirement and gather context
- [ ] 2. Model every input as partitions
- [ ] 3. Model outcomes as rules (if outputs differ between valid inputs)
- [ ] 4. Generate and confirm coverage
- [ ] 5. Review the spec (`test-spec-reviewer` subagent) and apply its fixes
- [ ] 6. Present cases, expected results and assumptions
```

### 1. Classify the requirement and gather context

Read the requirement fully. A ticket or PR usually changes an existing system, so before modelling write `generated/<feature>/context.md` (disposable) with:

- **Requirement claims**: each rule, threshold and outcome the text states, quoted.
- **System context**, when a repo, schema or config is in scope: the unchanged contracts, OpenAPI or DB schemas, enums and config defaults the inputs come from, each with `file:line` and a label: `requirement`, `configured (confirm as requirement)` or `default (confirm as requirement)`. Never invent a placeholder value.
- **Trust boundary**: for each input, whether it crosses an untrusted boundary (UI, public HTTP or CLI, a raw file) or is already constrained by the caller's types or a validated schema (cite it). Step 2 sets the negatives from it.
- **Modes**: inputs that only matter in one mode or event. Use one spec per mode when the active inputs differ; otherwise put the activating value first (see the negative base row in step 4) and list the ignored combinations as gaps.

Then list:

- **Inputs**: every value the system reads (fields, flags, settings, lengths).
- **Conditions**: every threshold or category the text mentions ("over 100", "at least 5 kg", "members only").
- **Outcomes**: what changes between conditions (price, message, accept/reject).

Pick techniques from what you found:

| Requirement shape | Technique | Spec feature |
| --- | --- | --- |
| Input accepted or rejected by range, length or set | BVA + EP | `partitions` with `valid` |
| Several inputs that interact | pairwise (`strength: 2`) | multiple fields |
| A rule needs 3+ conditions at once | rule coverage, or `strength: 3` | `rules` |
| Output is computed or chosen by conditions | decision table | `rules` with `expected` (`=` formulas for computed values) |
| A condition combines fields (a difference, a ratio, one field compared to another) | a relation field and an adapter | step 2, conditions between fields |
| One event in a state machine (a state, a counter, the history that matters) | decision table over reachable configurations | step 2, conditions between fields; sequences of events and timing are gaps, design them by hand |

Anything the requirement leaves open (inclusive or exclusive bound, precision, upper limit, case sensitivity) is a question for the user, not a guess. If a contradiction or a missing definition blocks a meaningful model, ask before generating cases.

### 2. Model every input as partitions

Write `generated/<feature>/spec.json`. A field is a list of partitions: equivalence classes that the requirement treats the same way.

```json
{
  "name": "price", "type": "number", "step": 0.1,
  "partitions": [
    {"label": "low", "min": 0, "max": 100},
    {"label": "mid", "min": 100.1, "max": 199.9},
    {"label": "high", "min": 200}
  ]
}
```

- **Types**: `number` ranges use `min`/`max`. `string` ranges use `minLength`/`maxLength`. `enum` has only value sets. Any type can have a set partition `{"label", "values": [...]}`.
- **Bounds are inclusive.** Turn exclusive wording into a bound one step away: "exceeds 100" with step 0.1 becomes `min: 100.1`.
- **A missing `min` or `max` means open-ended.** "200 or more" is `{"min": 200}`.
- **`step`** is the smallest meaningful increment (1, 0.01 for money, 0.1 for kg). Bounds must be multiples of it.
- **Gaps and outer sides are filled with invalid partitions automatically**, named `below`, `above` and `gap:<a>:<b>`. To make values outside a range valid, add a partition for them.
- **Always test negatives, even when the requirement doesn't mention them.** Keep the auto-filled partitions and the default `invalid` values. If the requirement doesn't say how invalid input is handled, keep `expected: invalid` and list "rejection behaviour not specified" as an open question. Drop them only where step 1 shows the input can't take such values: a checkbox or fixed dropdown can't, so both may go; an internal input whose type the caller's types or a validated schema guarantee needs no wrong-type values (`"invalid": []`), nor does an input whose wrong-type values are set partitions with named rejection rules, and `"autoInvalid": false` also needs the range itself enforced upstream (schema `minimum`/`maximum`, an enum) or a relation field (conditions between fields, below). Cite the evidence in `context.md`.
- **`valid: false`** marks a declared class as invalid, for example `{"label": "tooLong", "minLength": 65, "valid": false}`. Its cases only expect `invalid`; a rejection the requirement names (`rejected:too-long`, `declined`) is a valid partition with a literal rule.
- **`invalid`** lists values of the wrong type or format. Defaults are `["abc", null]` for numbers, `[null]` for strings and `["__invalid__"]` for enums. Add domain-specific ones the requirement implies, such as an off-step amount (`0.015` at step 0.01). On a string with `minLength`/`maxLength`, every string falls in a length partition, so a string in `invalid` fails the spec and oversized input is already `above`; put format and injection strings on a separate string field or spec without lengths.
- **Shorthand for simple fields**: `{"type": "number", "min": 18, "max": 65}` is one valid range, and `{"type": "enum", "values": ["PL", "DE"]}` is one partition per value, labelled with the value.

How to model common wording:

| Requirement says | Model |
| --- | --- |
| "between 18 and 65" | `min: 18, max: 65` |
| "at least 5 kg" / "under 5 kg" | `{"label": "heavy", "min": 5}` and `{"label": "light", "min": 0, "max": 4.9}` |
| tax bands, tiers, age groups | one range partition per band, in any order |
| "1 to 64 characters" | `type: "string", minLength: 1, maxLength: 64` |
| yes/no flag | `enum` with partitions `values: [true]` and `values: [false]` |
| country, role, plan | `enum` values, or set partitions grouping values that behave the same (`{"label": "eu", "values": ["PL", "DE"]}`) |
| format rules, checksums (email, IBAN) | set partitions on an `enum` or a `string` without lengths (length values are `x` repeated, so they fail any format), one representative value per format class, valid and invalid; for a checksum, a published valid sample and the same with one character changed |
| dates, times | `number` in a unit the rule uses (days, minutes), and note the mapping as an assumption |
| a quantity that can't be negative (age, count, years of service) | close the lowest partition at `min: 0` even if the text doesn't say so |
| UI limits not in the requirement text (HTML `min`/`max`, placeholders) | not part of the model; list them as an open question |

**Conditions between fields** (`checkOut - checkIn` from 1 to 30 nights, `used / quota` at most 0.80) get no boundary from values picked per field, and positive rows get wrong expected results. Replace one field of the condition by a relation field, and write an adapter, `generated/<feature>/adapter.mjs` exporting `toInput(input)` that returns the system's input for one case (wrong-type values pass through unchanged), and quote it in `context.md`; where another field holds a negative's fault, the adapter picks a replaced input that is valid by itself and against the faulty field, so the negative keeps one fault. If the kept value plus the relation leaves the replaced input's range on a positive row, the adapter moves the kept value down inside its own partition (`checkIn` 365 with 10 nights becomes 355), or a first rule expects `invalid`. Formulas run on the spec row before the adapter, so an `=` outcome can't read a named point or a value the adapter moves: give such rows literal outcomes per representative combination. Model every relation an outcome depends on, or pin its fields so it can't trigger. A condition over three or more range fields (`min <= amount <= max`) doesn't split into relation fields: pin all but one per spec (one spec per pinned configuration, another for the pinned fields' own relation), or list it as a gap.
- **Difference**: when the replaced input lands exactly on its step, the relation field is a number, `nights` with `checkOut = checkIn + nights`; sign it the way a mode requires (`gap` is `limit - value` for one side, `value - limit` for the other).
- **Ratio or product**: an enum of points that the adapter computes from the other fields, `usagePoint` with `zero`, `on` (`floor(0.8 * quota)`), `off` (`on + 1`) and `max`, since an exact 0.80 exists only for some quotas. Name the other fields in the `on` and `off` rules (`"quota": "valid"`) so each of their values meets both points. A point that can't exist for some combination gets a first rule expecting `invalid`.
- **Outcomes of the relation** (`rejected:too-long`) are valid partitions with rules: leave its outer classes open-ended or set `"autoInvalid": false`, and declare only the band where the input is invalid (`{"label": "reversed", "max": -1, "valid": false}`). Put the replaced field's own invalid edges in `invalid` next to the defaults (`["abc", null, "checkOut=366"]`) as values the adapter writes through, and its valid edge as a set value when the relation never reaches it (`"checkOut=365"`).
- **One event in a state machine**, or fields where only some pairs exist: one enum of reachable configurations (`CLOSED/0`, and `CLOSED/2 via fail, fail` when a defect needs accumulated history; the adapter replays it), the event, and amounts relative to the configuration (`under`, `exact`, `over` the threshold). One rule per history value names its event and amount, or pairwise may skip it.

### 3. Model outcomes as rules

When valid inputs lead to different results, add a decision table. The first matching rule wins:

```json
"rules": [
  {"when": {"price": "high", "card": "yes", "weight": "light"}, "expected": "=round(0.85 * price, 0.1)"},
  {"when": {"price": "high"}, "expected": "=round(0.9 * price, 0.1)"},
  {"when": {"price": "low", "weight": "heavy"}, "expected": "=round(price + weight, 0.1)"},
  {"when": {}, "expected": "=round(price, 0.1)"}
]
```

- `when` maps field names to valid partition labels. Put the most specific rule first.
- End with the catch-all `{"when": {}}` for "otherwise". Without one, every combination of the valid partitions the rules mention must match a rule, or the CLI names the missing combination.
- Every rule gets a matching case plus one case per value of each of its condition fields, BVA edges included, with the rule's other conditions held. That tests the boundaries inside multi-field rules (`>` vs `>=` in a 3-condition rule), which pairwise misses, without full 3-wise. If an earlier rule captures such a case, the fields outside the rule are re-chosen so no earlier rule matches it; if none works, the case stays as is.
- `expected` is the outcome as stated: a literal (`"rejected"`, `"gold"`), or `=` and a formula that the CLI computes for each case; a fixed number is `"=19.99"`, since a bare `"19.99"` stays a string. Formulas use field names (letters, digits and `_`, not starting with a digit), numbers (`1.5`, `1e-5`), `+ - * / ( )`, a leading `-` or `+`, `min(...)`, `max(...)`, and `round(x, step)`, `floor(x, step)`, `ceil(x, step)`, which round to a multiple of `step` (`round` sends ties toward +infinity like JS `Math.round`, so `round(-2.5, 1)` is -2; `floor` down, `ceil` up). Results keep 12 significant digits, so `round(x, 0.01)` drops the cents of 10,000,000,000.01 and above. Include output rounding when the requirement defines it, or list it as an assumption.
- There is no power, comparison or string function. For an outcome that needs one (an annuity's `(1 + r)^-n`), make its inputs one enum of representative combinations (`"5000|7.5|24"`, split by the adapter) with `=` literal outcomes computed outside the CLI, at least one of them half a step or more past a multiple (an unrounded 12.3456 for 12.35) so truncation fails.
- Set `"strength": 3` only when unknown interactions of three inputs, not covered by any rule, are a real risk. It multiplies the case count.
- With only two fields, `strength: 2` is every combination. When rules describe all the logic, offer `"strength": 1` (each value at least once, plus the rule boundary cases) as a smaller suite and let the user choose. At strength 1 a rule moves one of its fields at a time while the others keep their first value, so the edges of two fields never meet: keep 2 for relation and configuration fields.

See `fixtures/price-calculation.spec.json` for a complete example.

### 4. Generate and confirm coverage

```bash
node src/bva.ts --spec generated/<feature>/spec.json --out generated/<feature>/bva.json
node src/ep.ts  --spec generated/<feature>/spec.json --out generated/<feature>/ep.json
node src/pairwise.ts --spec generated/<feature>/spec.json --debug --out generated/<feature>/cases.json
```

The BVA and EP files show the chosen values for review. Pairwise derives them itself from `--spec`. If you edit the value files, pass both with `--bva` and `--ep`, and keep `--spec` for the rules; every spec partition needs a value in them (`--bva` alone has no enum, set or `invalid`-list values, `--ep` alone silently drops the BVA edges).

The report goes to stderr. Proceed only when it shows `uncovered: none`, and `uncovered rules: none` when there are rules. A case count a little above the lower bound is normal. `--strength N` overrides the spec.

Output shapes (read `cases`, the file is not an array):

- `bva.json`, `ep.json`: `{"technique", "fields": {"<name>": [{"label", "value", "valid", "partition"}]}}`
- `cases.json`: `{"technique", "strength", "cases": [{"id", "valid", "expected", "formula"?, "input": {"<name>": value}, "fault"?}]}`. `expected` is the rule's literal, the computed number for `=` rules (with `formula` holding the text), `valid` without rules, or `invalid`. `fault` names the invalid value of a negative case.
- `cases.system.json`, only with an adapter: `cases.json` holds spec fields, not the system's inputs, so right after generating run every case's `input` through `toInput` into this file (the same cases with system inputs). Tests in any language read it; the CLI and the MCP tools never run the adapter, and `--verify` audits only suites written in spec fields.

Positive cases combine valid values only; `valid: true` means each value is valid alone, not that the combination is possible. Each negative case is one base row with one value swapped for an invalid one; `--debug` prints `negative base row` and its outcome. If the system rejects that row before it checks the swapped value (a rule that rejects first, another check that fails first), every negative is masked: put a value that reaches the validators first in an enum's `values` or set partitions (a range field always starts from its lowest valid range), or use one spec per mode. Don't hand-edit cases to combine invalid values.

Quick single-field answers without a spec file:

```bash
node src/bva.ts --name price --min 0.01 --max 999.99 --step 0.01
node src/bva.ts --name code --type string --min 1 --max 8
node src/ep.ts --name country --values PL,BY,DE --invalid XX
```

To audit a suite written by hand or by another tool (a JSON array of rows, or a cases file; `"-"` means "don't care", except on a field that has `"-"` as a value):

```bash
node src/pairwise.ts --spec generated/<feature>/spec.json --verify existing-cases.json
```

It exits with code 1 and lists uncovered tuples and rules (`rule N (<expected>)`) if coverage is incomplete. It warns `<field>=<value> is in no domain` for each value of a spec field that is not a generated valid value, without changing the exit code; other columns and `"-"` cells are ignored. It audits positive rows only: it skips `valid: false` cases and doesn't check `expected` or whether invalid values are tested.

### 5. Review the spec

Give the `test-spec-reviewer` subagent the requirement, `context.md` and the spec path. On `revise`, apply the critical fixes, re-run step 4, and ask the user about the warnings. If subagents aren't available, or you are running as a subagent (for example `test-case-designer`), walk its checklist yourself (`.cursor/agents/test-spec-reviewer.md`).

### 6. Present the cases

Summarise first, then give a table from `cases.system.json` when there is one, else `cases.json`:

```markdown
Generated 70 cases for price-calculation: 62 positive (all 66 pairs, lower bound 40; all 7 rules at their condition boundaries) and 8 negative, each with one invalid value. The requirement doesn't say how invalid input is handled (open question).

| ID | Valid | price | weight | card | Expected | Formula | Fault |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TC-001 | yes | 50 | 2.5 | false | 50 | round(price, 0.1) | |
| TC-047 | yes | 200 | 2.5 | true | 170 | round(0.85 * price, 0.1) | |
| TC-066 | no | -0.1 | 2.5 | false | invalid | | price: bva below.max |
| TC-068 | no | 50 | "abc" | false | invalid | | weight: ep invalid:abc |
```

List the file paths, every assumption made while modelling (steps, inclusive or exclusive bounds, open ends, added invalid values, unit mappings, adapter conversions), and the gaps: what the CLI can't model, such as positive rows that are impossible combinations.

## Errors

The CLI prints `error: <message>` and exits with code 1. The message names the field, partition or rule at fault:

- `is not a multiple of step`: fix `step` or the bound
- `partitions a and b overlap`: bands share a value; move one bound by one step
- `is in more than one partition, <a> and <b>`: an `invalid` or set value falls inside a range, or a string inside a length partition; move it outside, or put format strings on a field without lengths
- `listed twice in`: a value appears twice in one partition; remove one
- `reserved field name`: `Object.prototype` has the name (`constructor`, `toString`, `__proto__`); rename the field
- `unknown key x`: a misspelt or unsupported key (`vaild`, `autoinvalid`); fix or remove it
- `x=y is not a valid partition`: a rule uses an unknown or invalid label
- `can never match`: earlier rules cover every row this rule would match; reorder or remove it
- `no rule matches x=a, y=b`: the table has a hole; add a rule for it or a catch-all `{"when": {}}`
- `formula ...: unknown name`, `unexpected`, `ends too early`: fix the `=` formula (names are field names; only `round`, `floor`, `ceil`, `min`, `max` exist)
- `formula ...: field x is not an identifier`: a formula contains a field name that isn't letters, digits and `_`; rename the field (any formula containing the name fails, even as part of `data-b` for field `a-b`)
- `formula ...: x is "abc", not a number`: the formula uses a field whose valid values aren't numbers
- `has no value in --bva/--ep files`: a value file lacks a spec partition; pass both files, or `--spec` alone
- `is valid in one ... and invalid in the other`: edited `--bva`/`--ep` files disagree
- `exceed the 1000000 budget`: too many t-tuples; lower the strength or reduce values (fewer partitions, or split the spec)

## Checking the tool itself

`npm test` runs the self-check after any change to `src/`. `npm run format` applies the Google TypeScript style (prettier), and `npm run typecheck` runs `tsc`.
