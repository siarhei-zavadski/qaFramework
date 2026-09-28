---
name: generating-test-cases
description: Designs test cases from any requirement with this repo's CLI (src/bva.ts, src/ep.ts, src/pairwise.ts) using boundary value analysis, equivalence partitioning, pairwise or t-wise combination, and decision-table rules with expected outcomes. Use when the user asks to design, generate or review test cases or test data, gives a requirement, ticket or test-design.org exercise, or wants an existing suite's combinatorial or rule coverage checked.
---

# Generating test cases with the qaFramework CLI

Run commands from the repo root. Node 26 runs the `.ts` files directly.

## Workflow

```
- [ ] 1. Classify the requirement
- [ ] 2. Model every input as partitions
- [ ] 3. Model outcomes as rules (if outputs differ between valid inputs)
- [ ] 4. Generate and confirm coverage
- [ ] 5. Review the spec (`test-spec-reviewer` subagent) and apply its fixes
- [ ] 6. Present cases, expected results and assumptions
```

### 1. Classify the requirement

Read the requirement fully and list:

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
| A condition combines fields (a sum, a difference, one field compared to another) | not supported | model the per-field parts, list the combined condition as a gap |
| Behaviour depends on history or order (states, workflows) | not supported | say so, design those cases by hand |

Anything the requirement leaves open (inclusive or exclusive bound, precision, upper limit, case sensitivity) is a question for the user, not a guess.

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
- **Always test negatives, even when the requirement doesn't mention them.** Keep the auto-filled partitions and the default `invalid` values. If the requirement doesn't say how invalid input is handled, keep `expected: invalid` and list "rejection behaviour not specified" as an open question. Use `"autoInvalid": false` or `"invalid": []` only when the input physically can't take such values (a checkbox, a fixed dropdown).
- **`valid: false`** marks a declared class as invalid, for example `{"label": "tooLong", "minLength": 65, "valid": false}`.
- **`invalid`** lists values of the wrong type or format. Defaults are `["abc", null]` for numbers, `[null]` for strings and `["__invalid__"]` for enums. Add domain-specific ones the requirement implies.
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
| format rules (email, date format) | `string` or `enum` set partitions with one representative value per format class, valid and invalid |
| dates, times | `number` in a unit the rule uses (days, minutes), and note the mapping as an assumption |
| a quantity that can't be negative (age, count, years of service) | close the lowest partition at `min: 0` even if the text doesn't say so |
| UI limits not in the requirement text (HTML `min`/`max`, placeholders) | not part of the model; list them as an open question |

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
- Every rule gets a matching case plus one case per value of each of its condition fields, BVA edges included, with the rule's other conditions held. That tests the boundaries inside multi-field rules (`>` vs `>=` in a 3-condition rule), which pairwise misses, without full 3-wise.
- `expected` is the outcome as stated: a literal (`"rejected"`, `"gold"`), or `=` and a formula that the CLI computes for each case. Formulas use field names, numbers, `+ - * / ( )`, `min(...)`, `max(...)`, and `round(x, step)`, `floor(x, step)`, `ceil(x, step)`, which round to a multiple of `step` (half up, down, up). Include output rounding when the requirement defines it, or list it as an assumption.
- Set `"strength": 3` only when unknown interactions of three inputs, not covered by any rule, are a real risk. It multiplies the case count.
- With only two fields, `strength: 2` is every combination. When rules describe all the logic, offer `"strength": 1` (each value at least once, plus the rule boundary cases) as a smaller suite and let the user choose.

See `fixtures/price-calculation.spec.json` for a complete example.

### 4. Generate and confirm coverage

```bash
node src/bva.ts --spec generated/<feature>/spec.json --out generated/<feature>/bva.json
node src/ep.ts  --spec generated/<feature>/spec.json --out generated/<feature>/ep.json
node src/pairwise.ts --spec generated/<feature>/spec.json --debug --out generated/<feature>/cases.json
```

The BVA and EP files show the chosen values for review. Pairwise derives them itself from `--spec`. If you edit the value files, pass them instead with `--bva`/`--ep`, and keep `--spec` for the rules.

The report goes to stderr. Proceed only when it shows `uncovered: none`, and `uncovered rules: none` when there are rules. A case count a little above the lower bound is normal. `--strength N` overrides the spec.

Output shapes (read `cases`, the file is not an array):

- `bva.json`, `ep.json`: `{"technique", "fields": {"<name>": [{"label", "value", "valid", "partition"}]}}`
- `cases.json`: `{"technique", "strength", "cases": [{"id", "valid", "expected", "formula"?, "input": {"<name>": value}, "fault"?}]}`. `expected` is the rule's literal, the computed number for `=` rules (with `formula` holding the text), `valid` without rules, or `invalid`. `fault` names the invalid value of a negative case.

Positive cases combine valid values only. Each negative case has exactly one invalid value, with valid values everywhere else. Don't hand-edit cases to combine invalid values.

Quick single-field answers without a spec file:

```bash
node src/bva.ts --name price --min 0.01 --max 999.99 --step 0.01
node src/bva.ts --name code --type string --min 1 --max 8
node src/ep.ts --name country --values PL,BY,DE --invalid XX
```

To audit a suite written by hand or by another tool (a JSON array of rows, or a cases file; `"-"` means "don't care"):

```bash
node src/pairwise.ts --spec generated/<feature>/spec.json --verify existing-cases.json
```

It exits with code 1 and lists uncovered tuples and rules if coverage is incomplete.

### 5. Review the spec

Give the `test-spec-reviewer` subagent the requirement and the spec path. On
`revise`, apply the critical fixes, re-run step 4, and ask the user about the
warnings. If subagents aren't available, or you are running as a subagent
(for example `test-case-designer`), walk its checklist yourself
(`.cursor/agents/test-spec-reviewer.md`).

### 6. Present the cases

Summarise first, then give a table from `cases.json`:

```markdown
Generated 70 cases for price-calculation: 62 positive (all 66 pairs, lower bound 40; all 7 rules at their condition boundaries) and 8 negative, each with one invalid value. The requirement doesn't say how invalid input is handled (open question).

| ID | Valid | price | weight | card | Expected | Formula | Fault |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TC-001 | yes | 50 | 2.5 | false | 50 | round(price, 0.1) | |
| TC-047 | yes | 200 | 2.5 | true | 170 | round(0.85 * price, 0.1) | |
| TC-066 | no | -0.1 | 2.5 | false | invalid | | price: bva below.max |
| TC-068 | no | 50 | "abc" | false | invalid | | weight: ep invalid:abc |
```

List the file paths and every assumption made while modelling (steps, inclusive or exclusive bounds, open ends, added invalid values, unit mappings).

## Errors

The CLI prints `error: <message>` and exits with code 1. The message names the field, partition or rule at fault:

- `is not a multiple of step`: fix `step` or the bound
- `partitions a and b overlap`: bands share a value; move one bound by one step
- `is in more than one partition`: an `invalid` or set value falls inside a range
- `x=y is not a valid partition`: a rule uses an unknown or invalid label
- `can never match`: earlier rules cover every row this rule would match; reorder or remove it
- `no rule matches x=a, y=b`: the table has a hole; add a rule for it or a catch-all `{"when": {}}`
- `formula ...: unknown name`, `unexpected`, `ends too early`: fix the `=` formula (names are field names; only `round`, `floor`, `ceil`, `min`, `max` exist)
- `formula ...: x is "abc", not a number`: the formula uses a field whose valid values aren't numbers
- `is valid in one ... and invalid in the other`: edited `--bva`/`--ep` files disagree

## Checking the tool itself

`npm test` runs the self-check after any change to `src/`. `npm run format` applies the Google TypeScript style (prettier), and `npm run typecheck` runs `tsc`.
