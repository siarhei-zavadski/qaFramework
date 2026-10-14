---
name: analysing-system-repo
description: Designs tests for a system from its local repository. Reads the repo without running anything, lists the technologies it really uses with file:line evidence, writes their configured values and the official docs' failure modes for the detected versions into a disposable generated/<project>/components.md, and hands each component to test-case-designer. Use when the user gives a local repo path and asks to design or review tests for the system, its infrastructure or its stack (load balancer, cache, queue, database, API).
---

# Analysing a system repository

Input: a local repo path. `<project>` is the kebab-case name of its folder.

## Rules

- **Sources only.** Every technology, value and doc item cites a repo
  `file:line`, an official documentation URL (with the version), or the
  user's answer. Anything else is a question, never a default.
- **Configured is not required.** A value from config is labelled
  `configured, confirm as requirement`; a value from product docs is labelled
  `product default, not configured in repo`. Both are assumptions in the spec
  until the user confirms them.
- **Docs and config stay apart.** In each component section, what the docs
  say about the technology at that version is listed apart from the values
  this repo configures (TTL, limits, replicas).
- **Disposable, never stored here.** Everything goes under `generated/` in the
  caller's workspace and is rebuilt on every run. Nothing about the analysed
  system is written into the qaFramework repo.
- **Read-only and safe.** Never run, build or install anything from the target
  repo. Read only `.env.example`-style templates, never a real `.env`. Never
  copy secrets (keys, passwords, tokens, connection strings with credentials)
  into `generated/`.
- **Only what is found.** No component or case for a technology the
  inventory did not find.

## Workflow

```
- [ ] 1. Inventory the repo
- [ ] 2. Read the docs per technology
- [ ] 3. Design tests per component
- [ ] 4. Review each spec
- [ ] 5. Report
```

### 1. Inventory

Glob and grep the target repo (for large repos, delegate the scan to the
`explore` subagent and ask for `file:line` evidence). Signals:

| Look in | For |
| --- | --- |
| `docker-compose*`, `Dockerfile` | services, images and versions, ports, env templates |
| k8s manifests, helm charts | replicas, probes, resources, HPA, Ingress, Services |
| terraform (`*.tf`) | load balancers, caches, databases, queues, multi-AZ |
| nginx, HAProxy, Envoy configs | upstreams, timeouts, rate limits, caching, TLS |
| dependency manifests (`package.json`, `pom.xml`, `requirements.txt`, `go.mod`, ...) | client libraries: Redis, Kafka, AMQP, DB drivers, HTTP frameworks |
| app config (`application.yml`, `settings.*`, `.env.example`) | TTLs, pool sizes, retries, timeouts, feature flags |
| OpenAPI or Swagger specs | endpoints, methods, field types, `minLength`/`maxLength`, `enum`, required |
| DB migrations, schema files | column types, lengths, `NOT NULL`, `CHECK`, unique keys |

OpenAPI and migrations map directly to partitions (see the
`generating-test-cases` skill); prefer them over prose.

Write `generated/<project>/components.md` (disposable). It starts with the
stack table: one row per technology with its role (balancer, cache, queue,
database, API, ...), product, version and evidence `file:line`. Then one
section per component:

- product, version and evidence;
- trust boundary: which inputs arrive from untrusted callers (UI, public
  HTTP, files) and which are already typed or schema-validated;
- configured values, each with `file:line` and its label;
- the questions found while scanning.

No secrets. If the version can't be found, the version is a question, and
step 2 reads the latest documented version, stated as an assumption.

### 2. Read the docs per technology

For each technology found, read its official docs for the detected version
and add to its component section:

```markdown
#### Docs: <product> <version>
- Dimension: <setting or input that changes behaviour>: <technique hint: BVA at a threshold, set partitions, transition table, formula> (<doc URL>)
- Failure mode: <documented failure or risk> (<doc URL>)
- Question: <what the requirement or config must answer> (<doc URL or file:line>)
- Gap: <what the CLI can't model: sequences, timing, execution>
```

Every Dimension, Failure mode and Question line ends with its source. Drop
any item without one.

### 3. Design tests per component

Start one `test-case-designer` per component, and give it:
- the whole component section from `components.md` (configured values with
  their labels, the trust boundary, and the docs items with their sources)
  as the context for its step 1;
- the feature name `<project>/<component>`, so its output goes to
  `generated/<project>/<component>/`.

It follows `generating-test-cases` unchanged. Values labelled `configured` or
`product default` go into the spec as assumptions. Missing values are
questions.

Modelling patterns for system behaviour (tell the designer which ones apply):

1. **Scenario parameters as inputs.** A fixed script ("write, wait `d` ms,
   read from a replica") is one case whose inputs are its parameters.
   Open-ended sequences are gaps.
2. **Fix one side of a comparison.** For "age vs TTL" or "depth vs limit",
   take the constant from `components.md`, model the other side as bands with
   boundaries at it (TTL-1, TTL, TTL+1), and record the constant as an
   assumption. Another configuration needs another spec.
3. **Cross-field over small domains: enumerate.** When both sides are small
   enums (W and R with N = 3), list the combinations as rules.
4. **A single transition is a decision table.** The inputs are the current
   state plus the event or counter bands, and `expected` is the next state.
   Sequences of transitions are gaps.
5. **Computed values are `=` formulas** (availability, downtime, capacity,
   share of traffic). A threshold outcome is a rule with a literal
   `expected`.
6. **Shared negative sets.** Injection strings, malformed names and oversized
   inputs go in `invalid`, one fault per case. Not on a string field with
   lengths: there oversized input is the auto `above` partition, and no
   string can be an `invalid` value, so put injection and format strings on
   a field or spec without lengths.

Engine limits: a rule's `when` holds one label per field ("A or B" is two
rules or one set partition). Formulas have no comparison, `pow` or `mod`.
There are no constraints between fields, no time and no sequences.

### 4. Review

Run `test-spec-reviewer` on each spec. Give it the component section as the
requirement and its context. On `revise`, fix the spec and regenerate.

### 5. Report

Lead with one summary line: components, cases per component, open
confirmations. Then:

- The stack table and the `components.md` path.
- For each component: cases (as `generating-test-cases` step 6 shows them)
  and the context, spec and cases paths.
- Every `configured` and `product default` value to confirm, with its
  `file:line` or URL.
- The questions and the gaps.
