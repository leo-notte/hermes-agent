/**
 * Assemble clipboard text from two SelectionPoints + the transcript.
 *
 * This is the entire copy pipeline. Pure function. No screen-buffer access,
 * no DOM access, no globals — just point arithmetic over registered
 * SourceRanges.
 *
 * Algorithm:
 *   1. Order the two endpoints into (lo, hi).
 *   2. Collect every SourceRange whose msg falls in [lo.msg .. hi.msg] in
 *      document order.
 *   3. For each range, compute the source-byte slice it contributes:
 *        - middle ranges (not touched by either endpoint) → entire outerSource
 *        - lo's range → from lo's source offset to end
 *        - hi's range → from start to hi's source offset
 *        - same range (lo and hi point into it) → from lo to hi
 *   4. Apply the fence-stripping rule: if BOTH endpoints land inside the
 *      inner body of the same range, swap outerSource for innerSource and
 *      adjust offsets accordingly.
 *   5. Join the slices with newlines. The separator between two adjacent
 *      ranges is one newline; nothing else is added (the source already
 *      has its own trailing newlines if appropriate).
 */

import { getRange, listRanges } from './registry.js'
import type { MsgSnapshot, SelectionPoint, SourceRange } from './types.js'

type Point = SelectionPoint

/**
 * Compare two ranges in document order using msg order then blockIndex.
 * Used to sort the ranges between lo and hi.
 */
function compareRanges(
  a: SourceRange,
  b: SourceRange,
  msgOrder: ReadonlyMap<string, number>
): number {
  const oa = msgOrder.get(a.msgId) ?? Number.POSITIVE_INFINITY
  const ob = msgOrder.get(b.msgId) ?? Number.POSITIVE_INFINITY

  if (oa !== ob) {
    return oa - ob
  }

  return a.blockIndex - b.blockIndex
}

/**
 * Within a single range, convert (visualLine, col) to a source-byte offset.
 *
 * The map gives the source offset where each visual row begins. The column
 * is added on top: visual columns map 1-to-1 to source bytes WITHIN a
 * single row (assuming ASCII or single-codepoint chars). For unicode-aware
 * handling, callers should pre-clamp `col` to the on-screen column index
 * of the desired character. This function performs no width conversion.
 *
 * If `visualLine >= visualLineCount`, the offset clamps to outerSource.length.
 */
function pointToOffset(range: SourceRange, visualLine: number, col: number): number {
  if (visualLine < 0) {
    return 0
  }

  if (visualLine >= range.visualLineCount) {
    return range.outerSource.length
  }

  return range.getOffset(visualLine, Math.max(0, col))
}

/**
 * Order two points so the smaller (earlier in the document) is first.
 *
 * Order rules:
 *   - before-all < anything < after-all
 *   - in-range comparison: by (msgOrder, blockIndex, visualLine, col)
 *   - gap with after/before refs falls between the two referenced ranges;
 *     gap.afterRangeId == X and another point on range X → the gap comes
 *     after range X.
 */
function orderPoints(
  a: Point,
  b: Point,
  msgOrder: ReadonlyMap<string, number>
): [Point, Point] {
  if (compareToA(a, b, msgOrder) <= 0) {
    return [a, b]
  }

  return [b, a]
}

/**
 * Negative when a < b, positive when a > b, 0 when equal in document order.
 */
function compareToA(a: Point, b: Point, msgOrder: ReadonlyMap<string, number>): number {
  // Universal endpoints
  if (a.kind === 'before-all') {
    return b.kind === 'before-all' ? 0 : -1
  }

  if (b.kind === 'before-all') {
    return 1
  }

  if (a.kind === 'after-all') {
    return b.kind === 'after-all' ? 0 : 1
  }

  if (b.kind === 'after-all') {
    return -1
  }

  // Reduce gap → range-anchored point for comparison: a gap "after X" is
  // (X-end + epsilon), "before X" is (X-start - epsilon).
  const ar = reducePoint(a)
  const br = reducePoint(b)
  const ag = msgOrder.get(ar.msgId) ?? Number.POSITIVE_INFINITY
  const bg = msgOrder.get(br.msgId) ?? Number.POSITIVE_INFINITY

  if (ag !== bg) {
    return ag - bg
  }

  if (ar.blockIndex !== br.blockIndex) {
    return ar.blockIndex - br.blockIndex
  }

  if (ar.visualLine !== br.visualLine) {
    return ar.visualLine - br.visualLine
  }

  return ar.col - br.col
}

type Reduced = {
  msgId: string
  blockIndex: number
  visualLine: number
  col: number
}

/** Reduce in-range / gap into a Reduced shape for ordering. */
function reducePoint(p: Exclude<Point, { kind: 'before-all' | 'after-all' }>): Reduced {
  if (p.kind === 'in-range') {
    const r = getRange(p.rangeId)

    if (!r) {
      return { msgId: '\uFFFF', blockIndex: 0, visualLine: 0, col: 0 }
    }

    return { msgId: r.msgId, blockIndex: r.blockIndex, visualLine: p.visualLine, col: p.col }
  }

  // gap
  const afterId = p.afterRangeId
  const beforeId = p.beforeRangeId

  if (afterId != null) {
    const r = getRange(afterId)

    if (r) {
      return {
        msgId: r.msgId,
        blockIndex: r.blockIndex,
        // After the last visual row → position AFTER it.
        visualLine: r.visualLineCount,
        col: 0
      }
    }
  }

  if (beforeId != null) {
    const r = getRange(beforeId)

    if (r) {
      return { msgId: r.msgId, blockIndex: r.blockIndex, visualLine: -1, col: 0 }
    }
  }

  // Truly empty gap (no neighbors known): treat as far-end so two empty
  // gaps compare equal.
  return { msgId: '\uFFFF', blockIndex: 0, visualLine: 0, col: 0 }
}

/**
 * Resolve a point to either:
 *   - { rangeId, offset } when it falls inside a range (in-range) OR
 *     when it's a gap whose adjacency uniquely places it at a known
 *     range's start/end (gap-after-X → end of X, gap-before-X → start
 *     of X)
 *   - null when it's before/after/in-an-empty-gap (the point contributes
 *     nothing to the output; the ranges between the two points are what
 *     matters)
 *
 * The gap resolution is what lets selections that anchor on the blank
 * line between two messages emit clean output. Without it, gap endpoints
 * always fall through to the "include the whole adjacent range" path,
 * which is what the user gets when they drag across a gap.
 */
function resolvePoint(p: Point): { rangeId: number; offset: number } | null {
  if (p.kind === 'in-range') {
    const r = getRange(p.rangeId)

    if (!r) {
      return null
    }

    return { rangeId: p.rangeId, offset: pointToOffset(r, p.visualLine, p.col) }
  }

  if (p.kind === 'gap') {
    // gap-after-X: the gap is past the end of range X → resolve to
    // (X, X.outerSource.length). When X is the lo endpoint, this means
    // X contributes nothing (from == to == end). When X is the hi
    // endpoint, this means X contributes its entire source (from 0 to
    // end).
    if (p.afterRangeId != null) {
      const r = getRange(p.afterRangeId)

      if (r) {
        return { rangeId: p.afterRangeId, offset: r.outerSource.length }
      }
    }

    // gap-before-Y: the gap is just before the start of range Y →
    // resolve to (Y, 0). When Y is the hi endpoint, Y contributes
    // nothing (from == to == 0). When Y is the lo endpoint, Y
    // contributes its entire source.
    if (p.beforeRangeId != null) {
      const r = getRange(p.beforeRangeId)

      if (r) {
        return { rangeId: p.beforeRangeId, offset: 0 }
      }
    }
  }

  return null
}

export type ToCopyTextInput = {
  anchor: Point
  focus: Point
  transcript: readonly MsgSnapshot[]
}

/**
 * Main entry. Returns the clipboard text for a selection.
 *
 * Empty when the selection is empty (anchor == focus AND both point at
 * nothing meaningful), or when the transcript is empty.
 */
export function toCopyText(input: ToCopyTextInput): string {
  const { anchor, focus, transcript } = input

  if (transcript.length === 0) {
    return ''
  }

  // Build msg-id → order map once for ordering.
  const msgOrder = new Map<string, number>()

  for (const m of transcript) {
    msgOrder.set(m.id, m.order)
  }

  const [lo, hi] = orderPoints(anchor, focus, msgOrder)

  // Filter to ranges that lie in [lo .. hi] inclusive.
  const all = listRanges().sort((a, b) => compareRanges(a, b, msgOrder))
  const loResolved = resolvePoint(lo)
  const hiResolved = resolvePoint(hi)

  // Find the range index window.
  // Stale rangeIds (the range was evicted between selection time and now)
  // order to the far-end of the document via reducePoint's '\uFFFF' msgId
  // fallback. This makes findFirstAtOrAfter / findLastAtOrBefore yield -1
  // for them, which short-circuits below into an empty result. The
  // expected lifecycle is that the host repairs the selection via the
  // truncate-to-survivor policy when a msg is evicted; toCopyText's
  // behavior here is the graceful-degradation backstop.
  const startIdx = lo.kind === 'before-all' ? 0 : findFirstAtOrAfter(all, lo, msgOrder)
  const endIdx = hi.kind === 'after-all' ? all.length - 1 : findLastAtOrBefore(all, hi, msgOrder)

  if (startIdx > endIdx || startIdx === -1 || endIdx === -1) {
    return ''
  }

  // Fence-stripping rule: if BOTH points land inside the inner body of
  // the SAME range, emit innerSource sliced by inner-relative offsets.
  if (
    loResolved &&
    hiResolved &&
    loResolved.rangeId === hiResolved.rangeId &&
    startIdx === endIdx
  ) {
    const r = all[startIdx]!
    const a = loResolved.offset
    const b = hiResolved.offset
    const innerStart = r.innerOffset
    const innerEnd = r.innerOffset + r.innerSource.length

    if (a >= innerStart && a <= innerEnd && b >= innerStart && b <= innerEnd) {
      const lo2 = Math.min(a, b) - innerStart
      const hi2 = Math.max(a, b) - innerStart

      return r.innerSource.slice(lo2, hi2)
    }
  }

  // General path: walk ranges, slice each.
  const parts: string[] = []

  for (let i = startIdx; i <= endIdx; i++) {
    const r = all[i]!
    let from = 0
    let to = r.outerSource.length

    if (i === startIdx && loResolved && loResolved.rangeId === r.id) {
      from = loResolved.offset
    }

    if (i === endIdx && hiResolved && hiResolved.rangeId === r.id) {
      to = hiResolved.offset
    }

    if (from < to) {
      parts.push(r.outerSource.slice(from, to))
    } else if (from === to && i !== startIdx && i !== endIdx) {
      // Empty middle range — still include as a separator-only entry
      // so blank blocks (rare) survive the round-trip.
      parts.push('')
    }
  }

  // Join with single newline. Trailing newlines in sources already exist
  // where appropriate; we don't add extra.
  return parts.join('\n')
}

/** Find first range that is >= point in document order. */
function findFirstAtOrAfter(
  ranges: readonly SourceRange[],
  point: Point,
  msgOrder: ReadonlyMap<string, number>
): number {
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]!

    // Compare: is this range's END >= point.start?
    const rEnd: Reduced = {
      msgId: r.msgId,
      blockIndex: r.blockIndex,
      visualLine: r.visualLineCount,
      col: 0
    }

    if (compareReducedToPoint(rEnd, point, msgOrder) >= 0) {
      return i
    }
  }

  return -1
}

/** Find last range that is <= point in document order. */
function findLastAtOrBefore(
  ranges: readonly SourceRange[],
  point: Point,
  msgOrder: ReadonlyMap<string, number>
): number {
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!
    const rStart: Reduced = { msgId: r.msgId, blockIndex: r.blockIndex, visualLine: 0, col: 0 }

    if (compareReducedToPoint(rStart, point, msgOrder) <= 0) {
      return i
    }
  }

  return -1
}

function compareReducedToPoint(
  a: Reduced,
  p: Point,
  msgOrder: ReadonlyMap<string, number>
): number {
  if (p.kind === 'before-all') {return 1}

  if (p.kind === 'after-all') {return -1}
  const b = reducePoint(p)
  const ag = msgOrder.get(a.msgId) ?? Number.POSITIVE_INFINITY
  const bg = msgOrder.get(b.msgId) ?? Number.POSITIVE_INFINITY

  if (ag !== bg) {return ag - bg}

  if (a.blockIndex !== b.blockIndex) {return a.blockIndex - b.blockIndex}

  if (a.visualLine !== b.visualLine) {return a.visualLine - b.visualLine}

  return a.col - b.col
}
