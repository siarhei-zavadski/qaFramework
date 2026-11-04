---
name: analysing-system-repo
description: Designs tests for a system from its local repository. Reads the repo without running anything, lists the technologies it really uses with file:line evidence, writes their configured values and the official docs' failure modes for the detected versions into a disposable generated/<project>/components.md, and hands each component to test-case-designer. Use when the user gives a local repo path and asks to design or review tests for the system, its infrastructure or its stack (load balancer, cache, queue, database, API).
---

# Analysing a system repository

Input: a local repo path; `<project>` is its folder name in kebab-case.

## Rules

- **Sources only**: every technology, value and doc item cites a repo `file:line`, an official doc URL with version, or the user's answer; anything else is a question, never a default.
- **Configured is not required**: config values are labelled `configured, confirm as requirement`, product-doc values `product default, not configured in repo`; both are spec assumptions until the user confirms.
- **Docs and config stay apart** in each component section: what the docs say at that version vs what this repo configures (TTL, limits, replicas).
- **Disposable**: everything goes under the caller's `generated/`, rebuilt each run; nothing about the analysed system goes into the qaFramework repo.
- **Read-only**: never run, build or install from the target repo; read only `.env.example`-style templates, never a real `.env`; never copy secrets (keys, passwords, tokens, credentialed connection strings).
- **Only what is found**: no component or case for a technology the inventory didn't find.

## Workflow

### 1. Inventory

Glob and grep the repo (large repos: delegate to a read-only explore subagent (`Explore` in Claude Code), asking for `file:line` evidence). Signals:

| Look in | For |
| --- | --- |
| `docker-compose*`, `Dockerfile` | services, images and versions, ports, env templates |
| k8s manifests, helm charts | replicas, probes, resources, HPA, Ingress, Services |
| terraform (`*.tf`) | load balancers, caches, databases, queues, multi-AZ |
| nginx, HAProxy, Envoy | upstreams, timeouts, rate limits, caching, TLS |
| dependency manifests (`package.json`, `pom.xml`, `go.mod`, ...) | Redis, Kafka, AMQP, DB drivers, HTTP frameworks |
| app config (`application.yml`, `settings.*`, `.env.example`) | TTLs, pool sizes, retries, timeouts, flags |
| OpenAPI or Swagger | endpoints, field types, `minLength`/`maxLength`, `enum`, required |
| DB migrations, schemas | column types, lengths, scale, `NOT NULL`, `CHECK`, unique keys, other readers of a column |

Prefer OpenAPI and migrations over prose: they map directly to partitions.

Write `generated/<project>/components.md`: a stack table (role, product, version, evidence `file:line`), then per component: product, version and evidence; trust boundary (untrusted inputs vs typed or schema-validated); configured values with `file:line` and label; questions found. An unknown version is a question; step 2 then reads the latest docs, stated as an assumption.

### 2. Read the docs per technology

Per technology, read the official docs for the detected version and add:

```markdown
#### Docs: <product> <version>
- Dimension: <setting or input that changes behaviour>: <technique hint: BVA at a threshold, set partitions, transition table, formula> (<doc URL>)
- Failure mode: <documented failure or risk>; trigger: <what starts or multiplies the work>; mechanism: <state change that exhausts the resource>; amplifier: <other load, or none> (<doc URL>)
- Question: <what the requirement or config must answer> (<doc URL or file:line>)
- Gap: <what the CLI can't model: sequences, timing, execution>
```

Drop any Dimension, Failure mode or Question without a source. If normal traffic fires a mechanism without its trigger, the mechanism is the primary failure mode and the trigger a separate one (`generating-test-cases` step 0, failure chain).

### 3. Design tests per component

Start one `test-case-designer` per component with the whole component section as its step 1 context and feature `<project>/<component>` (output in `generated/<project>/<component>/`). It follows `generating-test-cases` unchanged. Tell it which patterns apply:

1. **Scenario parameters as inputs**: a fixed script ("write, wait `d` ms, read from a replica") is one case whose inputs are its parameters; open-ended sequences are gaps.
2. **Fix one side of a comparison** ("age vs TTL"): the constant from `components.md` as an assumption, the other side as bands at TTL-1, TTL, TTL+1; another configuration is another spec.
3. **Small cross domains** (W and R with N = 3): enumerate combinations as rules.
4. **A single transition** is a decision table over reachable configurations (`generating-test-cases` step 2); sequences are gaps.
5. **Computed values** (availability, capacity, traffic share) are `=` formulas; threshold outcomes are literal rules.
6. **Shared negative sets**: injection strings, malformed names, oversized inputs in `invalid`, one fault per case (string length limits: skill step 2).
7. **Armed together**: a fixed timeout, TTL or lease set for many items by one event (bulk start, restart, one shared notice) is a scenario whose inputs are the count armed at once and the window their expiries fall in; the cost per expiry (a persisted or replicated write) is a component value.

The engine limits are the skill's: `when` is per-field equality (a label or a list of labels for "A or B"), no comparison, `pow` or `mod`, no time or sequences.

### 4. Review

Run `test-spec-reviewer` on each spec with the component section as requirement and context. On `revise`, fix and regenerate.

### 5. Report

One summary line (components, cases per component, open confirmations), then: stack table and `components.md` path; per component the cases (as skill step 6) and paths; every `configured` and `product default` value to confirm with its source; questions and gaps.
