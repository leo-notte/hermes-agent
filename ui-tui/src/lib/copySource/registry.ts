/**
 * Source-range registry.
 *
 * Keyed on `${msgId}::${blockIndex}` so that re-mounting a range (e.g. when
 * a virtual-scrolled message scrolls back into view) re-uses its previous
 * RangeId. This means selection points anchored to a range survive
 * unmount/remount cycles correctly.
 *
 * The registry outlives the DOM: a range stays registered until its
 * message is evicted from the transcript history. The host app calls
 * `evictMessage(msgId)` from the history-cap path.
 *
 * The registry is a module-level singleton. This is one piece of "global
 * state" but it's confined to a single small module with a tiny API; any
 * test that needs isolation calls `resetRegistry()`.
 */

import type { RangeId, SourceRange } from './types.js'

const ranges = new Map<RangeId, SourceRange>()
const byKey = new Map<string, RangeId>()
let nextId = 1

function rangeKey(msgId: string, blockIndex: number): string {
  return `${msgId}\x00${blockIndex}`
}

export type RegisterInput = {
  msgId: string
  blockIndex: number
  outerSource: string
  /** Defaults to `outerSource`. */
  innerSource?: string
  /** Defaults to 0. */
  innerOffset?: number
  /**
   * Total visual-row count this range rendered to. For unmounted /
   * not-yet-measured ranges, pass 1 (placeholder — selection won't be
   * able to anchor inside it until a real measurement arrives).
   */
  visualLineCount: number
  /**
   * (visualRow, col) → byte offset into outerSource.
   *
   * Plain-text helper: see `simpleOffsetFor(outerSource, lineStarts)`.
   * Inline-markdown helper: see `inlineOffsetFor(spansPerRow)`.
   *
   * For ranges that lack a measurement yet, pass `() => 0` and re-register
   * later when measured — toCopyText will snap selections inside the range
   * to offset 0 in the interim (no source leak; the range still emits its
   * outerSource when fully covered).
   */
  getOffset: (visualRow: number, col: number) => number
}

/**
 * Register a source range. Returns the (possibly recycled) RangeId.
 * If a range with the same (msgId, blockIndex) is already registered,
 * the SourceRange is updated in place and the same id is returned —
 * callers don't have to coordinate unmount/remount themselves.
 */
export function registerRange(input: RegisterInput): RangeId {
  const key = rangeKey(input.msgId, input.blockIndex)
  const existing = byKey.get(key)
  const id = existing ?? nextId++
  const innerSource = input.innerSource ?? input.outerSource
  const innerOffset = input.innerOffset ?? 0

  const range: SourceRange = {
    id,
    msgId: input.msgId,
    blockIndex: input.blockIndex,
    outerSource: input.outerSource,
    innerSource,
    innerOffset,
    visualLineCount: input.visualLineCount,
    getOffset: input.getOffset,
    domNode: existing ? (ranges.get(existing)?.domNode ?? null) : null
  }

  ranges.set(id, range)

  if (!existing) {
    byKey.set(key, id)
  }

  return id
}

/** Update only the DOM node pointer (called from anchor.tsx ref). */
export function setRangeDom(id: RangeId, domNode: unknown): void {
  const range = ranges.get(id)

  if (range) {
    range.domNode = domNode
  }
}

/** Get a range by id. Returns undefined if it has been evicted. */
export function getRange(id: RangeId): SourceRange | undefined {
  return ranges.get(id)
}

/**
 * Evict all ranges belonging to a message. Called from the history-cap
 * path when a message is dropped from the transcript. The msg's ranges
 * are gone forever — any selection point still pointing at them is
 * stale and must be repaired by the caller (truncate-to-survivor policy).
 */
export function evictMessage(msgId: string): RangeId[] {
  const evicted: RangeId[] = []

  for (const [key, id] of byKey) {
    const range = ranges.get(id)

    if (range && range.msgId === msgId) {
      evicted.push(id)
      ranges.delete(id)
      byKey.delete(key)
    }
  }

  return evicted
}

/**
 * All currently-registered ranges. Used by toCopyText to assemble copy
 * text in document order. The host app must provide a message-order
 * function to break ties between ranges from different messages
 * (insertion order isn't enough — messages can be popped from the
 * middle on /undo).
 */
export function listRanges(): SourceRange[] {
  return Array.from(ranges.values())
}

/** Test helper: wipe everything. Not used in production. */
export function resetRegistry(): void {
  ranges.clear()
  byKey.clear()
  nextId = 1
}
