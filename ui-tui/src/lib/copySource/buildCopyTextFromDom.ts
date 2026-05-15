/**
 * Host-side copy-text builder. Plugged into Ink via `setCopyTextFn`.
 *
 * Walks the live DOM at copy time to find every Box tagged with
 * `style.copyRangeId` that intersects the current selection rect, builds
 * SelectionPoints for the anchor + focus of the selection, and calls
 * `toCopyText` against the registry + transcript.
 *
 * Drag-scroll fidelity comes for free: rangeIds remain in the registry
 * after their DOMs unmount, and the anchor SelectionPoint captured at
 * mouse-down stays valid through scroll because rangeIds are stable.
 * The "extends past viewport" cases that captureScrolledRows used to
 * handle are handled by toCopyText seeing the anchor-side range as
 * fully included (start col 0, span includes the range).
 */

import type { InkInstance } from '@hermes/ink'

import { copyPointFromColRow } from './hitTestBridge.js'
import { toCopyText } from './toCopyText.js'
import type { MsgSnapshot } from './types.js'

/**
 * Build the copy-text builder. Pass the current `transcript` getter so the
 * builder always sees the latest Msg[] when copy fires (avoids closing
 * over stale state).
 */
export function makeCopyTextFn(
  getTranscript: () => readonly MsgSnapshot[]
): (ink: InkInstance) => string {
  return (ink) => {
    const bounds = ink.getSelectionBoundsScreen()

    if (!bounds) {
      return ''
    }

    const rootDom = ink.getRootDom()
    const transcript = getTranscript()
    const anchor = copyPointFromColRow(rootDom, bounds.start.col, bounds.start.row)
    const focus = copyPointFromColRow(rootDom, bounds.end.col, bounds.end.row)

    return toCopyText({ anchor, focus, transcript })
  }
}
