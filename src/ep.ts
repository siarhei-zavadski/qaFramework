/**
 * @fileoverview Equivalence partitioning: one representative value per
 * partition, valid and invalid.
 */

import {parseArgs} from 'node:util';
import {
  inputOptions,
  loadSpec,
  pointToValue,
  round,
  run,
  write,
  type Field,
  type Item,
  type Partition,
  type Result,
  type Spec,
  type Value,
} from './spec.ts';

// ponytail: an open range is sampled 10 steps past its closed side; add a
// per-partition `nominal` if a requirement cares where that value lands.
const OPEN_RANGE_OFFSET = 10;

/** A value from the middle of the partition, away from its edges. */
export function representative(field: Field, partition: Partition): Value {
  const {min, max, values} = partition;
  const step = field.step;
  if (values) return values[0];
  let point: number;
  if (min !== undefined && max !== undefined) {
    point = Math.round((min + max) / 2 / step) * step;
  } else if (min !== undefined) {
    point = min + OPEN_RANGE_OFFSET * step;
  } else if (max !== undefined) {
    point = max - OPEN_RANGE_OFFSET * step;
  } else {
    throw new Error(`${field.name}.${partition.label}: range has no bounds`);
  }
  return pointToValue(field, round(point, step));
}

/** Equivalence classes of one field, one item each. */
export function partitionValues(field: Field): Item[] {
  return field.partitions.map(p => ({
    label: p.label,
    value: representative(field, p),
    valid: p.valid,
    partition: p.label,
  }));
}

/** Runs EP over every field. */
export function analyzePartitions(spec: Spec): Result {
  const fields: Record<string, Item[]> = {};
  for (const field of spec.fields) fields[field.name] = partitionValues(field);
  return {technique: 'ep', fields};
}

if (import.meta.main) {
  run(() => {
    const {values} = parseArgs({options: inputOptions});
    write(values.out, analyzePartitions(loadSpec(values)));
  });
}
