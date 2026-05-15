/**
 * Factory functions for SourceRange.getOffset.
 *
 * Two flavors:
 *
 *  - `simpleOffsetFor`: for ranges where rendered text == source text
 *    character-for-character. Code fences, plain messages, tool output.
 *    Built from per-visual-row source offsets (a Uint32Array).
 *
 *  - `inlineOffsetFor`: for ranges with inline markdown rendering, where
 *    `**bold**` (6 source chars) renders as `bold` (4 visual cells). Built
 *    from per-visual-row span tables that describe each rendered segment's
 *    visual extent and source extent.
 *
 * Both produce a `(visualRow, col) → byteOffset` function with the same
 * shape. The range stores this function in `range.getOffset` and toCopyText
 * just calls it.
 */

import type { SourceRange } from './types.js'

/**
 * For each visual row, the byte offset into outerSource where that row's
 * content begins. The end of row v is `rowStarts[v+1]` (after subtracting
 * 1 if the boundary is a hard newline) or `outerSource.length` for the
 * last row.
 *
 * Multiple consecutive entries pointing into the same source line
 * represent soft-wrap of one source line over multiple visual rows.
 */
export type SimpleOffsetMap = Uint32Array

export function simpleOffsetFor(
  outerSource: string,
  rowStarts: SimpleOffsetMap
): (visualRow: number, col: number) => number {
  return (visualRow, col) => {
    if (visualRow < 0) {
      return 0
    }

    if (visualRow >= rowStarts.length) {
      return outerSource.length
    }

    const rowStart = rowStarts[visualRow]!
    let rowEnd: number

    if (visualRow + 1 < rowStarts.length) {
      const next = rowStarts[visualRow + 1]!
      // If the byte before `next` is a newline, that newline is the row
      // separator and NOT part of either row's content. Step back to
      // exclude it. For soft-wrap continuations (no intervening \n in
      // source), next IS the end of the row.
      rowEnd = next > rowStart && outerSource.charCodeAt(next - 1) === 10 ? next - 1 : next
    } else {
      rowEnd = outerSource.length
    }

    return Math.min(rowStart + Math.max(0, col), rowEnd)
  }
}

/**
 * One rendered segment on a visual row. `visualStart`/`visualEnd` are
 * 0-indexed columns within the row (visualEnd exclusive). `sourceStart`/
 * `sourceEnd` are byte offsets into outerSource (sourceEnd exclusive).
 *
 * For verbatim text (no formatting), visualEnd - visualStart ==
 * sourceEnd - sourceStart. For rendered markdown like `**bold**`, the
 * visual span is 4 cells and the source span is 8 bytes.
 *
 * Spans within a row must be contiguous and non-overlapping in visual
 * coordinates. Source coordinates need not be contiguous (a `[link](url)`
 * has rendered text "link" but the URL bytes are skipped in source span
 * order). Spans are ordered by visualStart.
 */
export type InlineSpan = {
  visualStart: number
  visualEnd: number
  sourceStart: number
  sourceEnd: number
}

/**
 * For each visual row, the ordered list of spans on that row. Empty
 * array allowed (row with no content; e.g. blank inline section). Length
 * is the row count.
 */
export type InlineSpanTable = readonly (readonly InlineSpan[])[]

export function inlineOffsetFor(
  outerSource: string,
  spansPerRow: InlineSpanTable
): (visualRow: number, col: number) => number {
  return (visualRow, col) => {
    if (visualRow < 0) {
      return 0
    }

    if (visualRow >= spansPerRow.length) {
      return outerSource.length
    }

    const spans = spansPerRow[visualRow]!

    if (spans.length === 0) {
      // Row had no source-mapped content. Best we can do is "first byte
      // of the next row's content, or end of source."
      for (let r = visualRow + 1; r < spansPerRow.length; r++) {
        const nextSpans = spansPerRow[r]!

        if (nextSpans.length > 0) {
          return nextSpans[0]!.sourceStart
        }
      }

      return outerSource.length
    }

    const c = Math.max(0, col)

    // Before the first span on this row → snap to its source start.
    if (c < spans[0]!.visualStart) {
      return spans[0]!.sourceStart
    }

    // Find the span containing col.
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i]!

      if (c >= s.visualStart && c < s.visualEnd) {
        // Within this span. The col offset within the span maps linearly
        // into the source span ONLY when source-len == visual-len (verbatim).
        // For rendered spans where they differ, we proportionally map:
        // col == visualStart → sourceStart, col == visualEnd → sourceEnd.
        const visualLen = s.visualEnd - s.visualStart
        const sourceLen = s.sourceEnd - s.sourceStart

        if (visualLen === sourceLen) {
          return s.sourceStart + (c - s.visualStart)
        }

        // Proportional: round so that "all visual cells of the span have
        // a source position" (no orphan cell falling between two source
        // chars). For c == visualStart the formula gives sourceStart;
        // for c == visualEnd - 1 the formula gives ~sourceEnd - 1.
        const t = visualLen > 0 ? (c - s.visualStart) / visualLen : 0

        return s.sourceStart + Math.round(t * sourceLen)
      }
    }

    // Past the last span on this row → snap to its source end.
    return spans[spans.length - 1]!.sourceEnd
  }
}

/**
 * Builder helper for the common case where you have an array of strings
 * (visual rows) and want a SimpleOffsetMap assuming each row corresponds
 * to one source line and rows are joined by '\n' in source.
 *
 * Returns a fresh Uint32Array. NOT for soft-wrap — callers that know
 * about wrap should build the array themselves with duplicate row-starts
 * for wrapped continuations.
 */
export function buildLineStartsFromRows(rows: readonly string[]): SimpleOffsetMap {
  const out = new Uint32Array(rows.length)
  let off = 0

  for (let i = 0; i < rows.length; i++) {
    out[i] = off
    off += rows[i]!.length + 1
  }

  return out
}

/** Re-export for SourceRange consumers. */
export type GetOffset = SourceRange['getOffset']
