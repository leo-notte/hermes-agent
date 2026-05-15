/**
 * Transcript-virtual selection coordinates.
 *
 * The TUI's source-of-truth is the `Msg[]` array of conversation messages.
 * Selection endpoints are anchored to source ranges within those messages,
 * NOT to screen cells. This decouples copy/paste fidelity from rendering
 * concerns like soft-wrap, viewport culling, and drag-scroll.
 *
 * A SourceRange represents one contiguous span of original source text that
 * was rendered to a contiguous block of visual rows. Markdown messages emit
 * one range per block (paragraph, heading, fence, list, etc.). Plain
 * messages and tool output emit one range covering the whole message.
 *
 * Each range carries a `mapVisualToSource` table built at render time that
 * lets hitTest translate (visualRow, col) into a position in the outer
 * source string. toCopyText slices outer/inner source by these positions.
 */

/** Stable handle for a SourceRange. Allocated by the registry. */
export type RangeId = number

/**
 * One contiguous block of source text + the visual rendering of that text.
 *
 * `outerSource` is the original source string including any wrapper syntax
 * (fence markers, blockquote markers, etc.). `innerSource` is the body
 * without the wrapper — equal to `outerSource` when there is no wrapper
 * (paragraphs, plain text, tool output).
 *
 * `mapVisualToSource[v]` = byte offset into `outerSource` where the visual
 * row `v` begins. The end of row v is `mapVisualToSource[v+1]` or
 * `outerSource.length` for the last row. This handles soft-wrap correctly:
 * one source line that wrapped to N visual rows has N entries, each
 * pointing into the same source line at the right column.
 */
export type SourceRange = {
  /** Stable id assigned by the registry. */
  readonly id: RangeId
  /** Message this range belongs to. Used for inter-range ordering. */
  readonly msgId: string
  /** 0 for whole-msg ranges; ≥1 for per-block ranges within a msg. */
  readonly blockIndex: number
  /** Full source including any wrapper (e.g. fence markers). */
  readonly outerSource: string
  /** Body without wrapper. Equals outerSource when there is no wrapper. */
  readonly innerSource: string
  /** Byte offset in outerSource where innerSource begins. */
  readonly innerOffset: number
  /**
   * Number of visual rows this range rendered to. Used by toCopyText to
   * compute "did the selection cover this whole range" and to know what
   * range a `visualLine == visualLineCount` (after-end) point refers to.
   */
  readonly visualLineCount: number
  /**
   * (visualRow, col) → byte offset into outerSource.
   *
   * For ranges where rendered text == source text (code fences, plain
   * messages, tool output), this is `rowStart[visualRow] + col`, clamped
   * to the row's source-byte length.
   *
   * For ranges where inline markdown rendering is applied (paragraphs,
   * headings), this looks up the source-byte position via a per-row table
   * of <Text>-span source ranges that the host computed during render.
   *
   * Callers are expected to clamp visualRow ∈ [0, visualLineCount].
   * visualRow == visualLineCount returns outerSource.length.
   */
  readonly getOffset: (visualRow: number, col: number) => number
  /**
   * The DOM node currently rendering this range. Mutated by anchor.tsx
   * on mount/unmount. Null when the range is registered but unmounted
   * (e.g. scrolled out of viewport). Typed as `unknown` here because
   * the registry is dom-agnostic; hitTest casts as needed.
   */
  domNode: unknown
}

/**
 * A point in transcript-virtual space. Used as the anchor and focus of a
 * selection. Survives DOM unmount cycles — only depends on the registry,
 * which outlives any individual render.
 */
export type SelectionPoint =
  /** Inside a known range. */
  | { kind: 'in-range'; rangeId: RangeId; visualLine: number; col: number }
  /** Before any range we know about (e.g. above the first message). */
  | { kind: 'before-all' }
  /** After all known ranges (e.g. below the last message). */
  | { kind: 'after-all' }
  /**
   * In a gap between ranges (blank row, chrome, prompt). The selection
   * snaps to the appropriate side of the gap based on drag direction;
   * both adjacents are tracked so extendSelection / toCopyText can pick
   * the right side. Either side may be null at the document edges.
   */
  | { kind: 'gap'; afterRangeId: RangeId | null; beforeRangeId: RangeId | null }

/** Snapshot of a transcript message minimally needed by toCopyText. */
export type MsgSnapshot = {
  /** Stable id matching what each SourceRange records. */
  readonly id: string
  /**
   * Insertion-order index. Used to order ranges from different messages
   * when assembling copy text. The transcript array index serves directly.
   */
  readonly order: number
}
