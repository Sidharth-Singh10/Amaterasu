import type { Annotation, DocPayload, Op, Series } from "./schema.ts"

/**
 * A protocol-level inverse produced by the chart adapter. The journal stores these on the
 * applied ack and replays them, in reverse, as a new turn when the user undoes.
 *
 * Inverses are intentionally expressed in the chart DSL rather than snapshots: the server
 * stays domain-neutral, and the adapter remains the only component that knows how to mutate
 * a chart document.
 */
export interface InverseOp {
  type: string
  target: { kind: string; id?: string }
  payload: { op: Op }
}

function shapeCreate(annotation: Annotation): InverseOp {
  return {
    type: "chart.shape.create",
    target: { kind: "chart.shape" },
    payload: {
      op: {
        op: "draw",
        id: annotation.id,
        kind: annotation.kind,
        points: structuredClone(annotation.points),
        style: structuredClone(annotation.style),
        label: annotation.label,
        z: annotation.z,
        source: annotation.source,
      },
    },
  }
}

function shapeUpdate(annotation: Annotation): InverseOp {
  return {
    type: "chart.shape.update",
    target: { kind: "chart.shape", id: annotation.id },
    payload: {
      op: {
        op: "update",
        id: annotation.id,
        points: structuredClone(annotation.points),
        style: structuredClone(annotation.style),
        label: annotation.label,
        hidden: annotation.hidden,
        locked: annotation.locked,
      },
    },
  }
}

function shapeDelete(id: string): InverseOp {
  return {
    type: "chart.shape.delete",
    target: { kind: "chart.shape", id },
    payload: { op: { op: "remove", id } },
  }
}

function seriesUpsert(series: Series): InverseOp {
  return {
    type: "chart.series.upsert",
    target: { kind: "chart.series", id: series.id },
    payload: {
      op: {
        op: "add_series",
        id: series.id,
        name: series.name,
        points: structuredClone(series.points),
        style: structuredClone(series.style),
        source: series.source,
      },
    },
  }
}

function seriesDelete(id: string): InverseOp {
  return {
    type: "chart.series.delete",
    target: { kind: "chart.series", id },
    payload: { op: { op: "remove_series", id } },
  }
}

/**
 * Diffs the document before and after one or more adapter ops. This is robust for batched
 * turns (one agent message can draw and update in any order) and ignores view-only changes.
 *
 * Limitation until the DSL grows replace semantics: `update` merges style, so a style key
 * introduced by the original op is not removed by the inverse.
 */
export function inverseOf(before: DocPayload, after: DocPayload): InverseOp[] {
  const inverses: InverseOp[] = []

  const beforeShapes = new Map(before.annotations.map((annotation) => [annotation.id, annotation]))
  const afterShapes = new Map(after.annotations.map((annotation) => [annotation.id, annotation]))

  for (const annotation of before.annotations) {
    const next = afterShapes.get(annotation.id)
    if (!next) {
      inverses.push(shapeCreate(annotation))
    } else if (JSON.stringify(annotation) !== JSON.stringify(next)) {
      inverses.push(shapeUpdate(annotation))
    }
  }
  for (const annotation of after.annotations) {
    if (!beforeShapes.has(annotation.id)) inverses.push(shapeDelete(annotation.id))
  }

  const beforeSeries = new Map(before.series.map((series) => [series.id, series]))
  const afterSeries = new Map(after.series.map((series) => [series.id, series]))

  for (const series of before.series) {
    const next = afterSeries.get(series.id)
    if (!next || JSON.stringify(series) !== JSON.stringify(next)) {
      inverses.push(seriesUpsert(series))
    }
  }
  for (const series of after.series) {
    if (!beforeSeries.has(series.id)) inverses.push(seriesDelete(series.id))
  }

  return inverses
}
