/**
 * Bridge between hermes-ink's `copyPointAt` (operates on Ink's internal
 * DOMElement type) and the host's `SelectionPoint` type. The shapes are
 * structurally identical now that `copyPointAt` returns gap adjacency
 * directly — this bridge is a thin re-typing layer that keeps the
 * dependency direction clean (host depends on hermes-ink; hermes-ink
 * doesn't import host types).
 */

import { copyPointAt as inkCopyPointAt } from '@hermes/ink'

import type { SelectionPoint } from './types.js'

type RawPoint =
  | { kind: 'in-range'; rangeId: number; visualLine: number; col: number }
  | { kind: 'gap'; afterRangeId: null | number; beforeRangeId: null | number }

export function copyPointFromColRow(rootDom: unknown, col: number, row: number): SelectionPoint {
  const raw = (inkCopyPointAt as (root: unknown, col: number, row: number) => RawPoint)(
    rootDom,
    col,
    row
  )

  if (raw.kind === 'in-range') {
    return { kind: 'in-range', rangeId: raw.rangeId, visualLine: raw.visualLine, col: raw.col }
  }

  // Gap: copy adjacency through. When both adjacents are null (no ranges
  // on screen at all — empty transcript) the gap is treated as far-end
  // by toCopyText, which falls through to empty output. Correct
  // degradation; user gets nothing to paste, which beats getting wrong
  // text.
  return { kind: 'gap', afterRangeId: raw.afterRangeId, beforeRangeId: raw.beforeRangeId }
}
