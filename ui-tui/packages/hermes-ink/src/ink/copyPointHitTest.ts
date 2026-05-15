/**
 * Map (col, row) screen coordinates to a copy-source SelectionPoint.
 *
 * Used by the new transcript-virtual selection pipeline: when a mouse
 * event fires at (col, row), this walks the DOM to find the nearest
 * ancestor box tagged with `style.copyRangeId` and translates the
 * coords to (visualLine, col) relative to that box's rect.
 *
 * The returned SelectionPoint is structurally identical to the
 * `lib/copySource/types.ts` SelectionPoint (host code), but this module
 * doesn't import from there to avoid a circular dependency (host depends
 * on hermes-ink, not vice versa). Host code reinterprets the returned
 * object via a duck-typed cast.
 *
 * Gap handling: when (col,row) isn't inside any tagged region, we walk
 * the entire DOM looking for ranges and return the rangeIds of the
 * nearest ranges above (`beforeRangeId`) and below (`afterRangeId`).
 * This lets toCopyText anchor the gap-endpoint correctly between two
 * known messages instead of degrading to far-end-of-doc.
 */

import type { DOMElement } from './dom.js'
import { nodeCache } from './node-cache.js'

export type RawSelectionPoint =
  | { kind: 'in-range'; rangeId: number; visualLine: number; col: number }
  | { kind: 'gap'; afterRangeId: null | number; beforeRangeId: null | number }

/**
 * Walk the DOM tree from `root` finding the deepest box at (col, row),
 * then walk back up looking for `style.copyRangeId`. Returns the raw
 * SelectionPoint with adjacency info for gaps.
 *
 * `root` is the Ink rootNode. The walk uses nodeCache rects (computed
 * by the last frame's render pass), which already account for
 * scrollTop translation — so a click on a visually-on-screen row that
 * came from a virtually-scrolled ScrollBox is hit correctly.
 */
export function copyPointAt(root: DOMElement, col: number, row: number): RawSelectionPoint {
  const deepest = hitDeepest(root, col, row)

  if (deepest) {
    // Walk up looking for a Box tagged with copyRangeId.
    let node: DOMElement | undefined = deepest

    while (node) {
      const rangeId = (node.style as { copyRangeId?: number }).copyRangeId

      if (typeof rangeId === 'number') {
        const rect = nodeCache.get(node)

        if (rect) {
          return {
            kind: 'in-range',
            rangeId,
            visualLine: Math.max(0, row - rect.y),
            col: Math.max(0, col - rect.x)
          }
        }

        // Tagged but not in cache → shouldn't happen normally (the tag
        // got there via the same render that populates cache), but if it
        // does, fall through to the gap path so we still produce a
        // useful adjacency answer.
      }

      node = node.parentNode
    }
  }

  // No tagged ancestor at (col, row). Scan the WHOLE DOM for tagged
  // boxes, partition them into "above row" and "below row" by their
  // cached y bounds, and pick the nearest each direction. This gives
  // toCopyText enough info to slot the gap between two known ranges.
  const { afterRangeId, beforeRangeId } = findAdjacentRanges(root, row)

  return { kind: 'gap', afterRangeId, beforeRangeId }
}

/**
 * Recursive depth-first hit test. Returns the deepest element whose
 * cached rect contains (col, row). Mirrors the existing hit-test.ts
 * implementation but without the side effects (no event dispatch, no
 * hover tracking).
 */
function hitDeepest(node: DOMElement, col: number, row: number): DOMElement | null {
  const rect = nodeCache.get(node)

  if (!rect) {
    return null
  }

  if (col < rect.x || col >= rect.x + rect.width || row < rect.y || row >= rect.y + rect.height) {
    return null
  }

  // Reverse iteration: later siblings paint over earlier (so they win on
  // overlap). Matches existing hit-test.ts.
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const child = node.childNodes[i]

    if (!child || child.nodeName === '#text') {
      continue
    }

    const hit = hitDeepest(child, col, row)

    if (hit) {
      return hit
    }
  }

  return node
}

/**
 * Walk the tree collecting every node with `copyRangeId`, then bucket
 * each by whether its rect ends strictly above `row` (→ candidate for
 * `beforeRangeId`) or starts strictly below `row` (→ candidate for
 * `afterRangeId`). Ranges straddling `row` are ignored — they would
 * have been picked up by the in-range path before us.
 *
 * "Nearest" is measured by row distance (Manhattan-y). Ties are broken
 * by the smaller rangeId, which approximates document order (ids are
 * allocated in mount order).
 */
function findAdjacentRanges(root: DOMElement, row: number): { afterRangeId: null | number; beforeRangeId: null | number } {
  let beforeRangeId: null | number = null
  let beforeDist = Number.POSITIVE_INFINITY
  let afterRangeId: null | number = null
  let afterDist = Number.POSITIVE_INFINITY

  const visit = (node: DOMElement): void => {
    const rangeId = (node.style as { copyRangeId?: number }).copyRangeId

    if (typeof rangeId === 'number') {
      const rect = nodeCache.get(node)

      if (rect) {
        const top = rect.y
        const bottom = rect.y + rect.height // exclusive

        if (bottom <= row) {
          const d = row - (bottom - 1)

          if (d < beforeDist || (d === beforeDist && (beforeRangeId === null || rangeId < beforeRangeId))) {
            beforeDist = d
            beforeRangeId = rangeId
          }
        } else if (top > row) {
          const d = top - row

          if (d < afterDist || (d === afterDist && (afterRangeId === null || rangeId < afterRangeId))) {
            afterDist = d
            afterRangeId = rangeId
          }
        }
        // Straddling row — leave to the in-range path; we wouldn't be
        // here if it had hit, so the rect's hit-test failed (likely
        // because col was outside). Treat as neither above nor below.
      }
    }

    for (const child of node.childNodes) {
      if (child.nodeName === '#text') {
        continue
      }

      visit(child)
    }
  }

  visit(root)

  return { afterRangeId, beforeRangeId }
}

/**
 * Locate the DOM node currently rendering a given rangeId by walking the
 * tree top-down. Returns null if no node has `style.copyRangeId === id`
 * (e.g. the range is registered but its rendering is unmounted due to
 * virtual scrolling).
 *
 * Used by the host's selection-overlay path to translate a virtual
 * anchor/focus point back to screen coordinates for highlight rendering.
 */
export function findRangeDom(root: DOMElement, id: number): DOMElement | null {
  if ((root.style as { copyRangeId?: number }).copyRangeId === id) {
    return root
  }

  for (const child of root.childNodes) {
    if (child.nodeName === '#text') {
      continue
    }

    const found = findRangeDom(child, id)

    if (found) {
      return found
    }
  }

  return null
}
