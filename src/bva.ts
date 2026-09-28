/**
 * @fileoverview Boundary value analysis: both edges of every range partition,
 * so internal edges between bands (100 / 100.1) are tested, not only the
 * outer min and max.
 */

import {parseArgs} from 'node:util';
import {
  inputOptions,
  loadSpec,
  pointToValue,
  run,
  write,
  type Field,
  type Item,
  type Result,
  type Spec,
} from './spec.ts';

/** Boundary values of one field; open sides and set partitions have none. */
export function boundaryValues(field: Field): Item[] {
  return field.partitions.flatMap(partition => {
    const {label, valid, min, max} = partition;
    const edges: Item[] = [];
    if (min !== undefined) {
      edges.push({
        label: `${label}.min`,
        value: pointToValue(field, min),
        valid,
        partition: label,
      });
    }
    if (max !== undefined && max !== min) {
      edges.push({
        label: `${label}.max`,
        value: pointToValue(field, max),
        valid,
        partition: label,
      });
    }
    return edges;
  });
}

/** Runs BVA over every field that has range partitions. */
export function analyzeBoundaries(spec: Spec): Result {
  const fields: Record<string, Item[]> = {};
  for (const field of spec.fields) {
    const items = boundaryValues(field);
    if (items.length) fields[field.name] = items;
  }
  return {technique: 'bva', fields};
}

if (import.meta.main) {
  run(() => {
    const {values} = parseArgs({options: inputOptions});
    write(values.out, analyzeBoundaries(loadSpec(values)));
  });
}
