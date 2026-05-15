/**
 * React component that wraps content with a source-range association.
 *
 * Usage:
 *
 *   <CopySource msgId={msg.id} blockIndex={0} outerSource={msg.text}>
 *     <Text>{rendered}</Text>
 *   </CopySource>
 *
 * The component:
 *   1. Registers the range with the copySource registry on mount.
 *   2. Renders its children inside an <ink-box copyRangeId={id}>, which
 *      causes the underlying DOMElement to carry the rangeId so the
 *      hit-test pipeline can map mouse coords back to a SelectionPoint.
 *   3. Updates the registry's domNode pointer via a ref so hit-test can
 *      find the DOM node from a rangeId.
 *   4. On unmount, clears the domNode pointer but DOES NOT evict the
 *      range from the registry — virtual-scroll unmounts and remounts
 *      should reuse the same rangeId. The host calls `evictMessage()`
 *      from the history-cap path when a message is dropped entirely.
 *
 * The component re-registers whenever `outerSource` / `innerSource` /
 * `innerOffset` / `visualLineCount` / `getOffset` change so the
 * registered range always reflects the current render.
 */

import { Box } from '@hermes/ink'
import { type ReactNode, useEffect, useRef } from 'react'

import { registerRange, setRangeDom } from './registry.js'
import type { RangeId, SourceRange } from './types.js'

export type CopySourceProps = {
  children?: ReactNode
  msgId: string
  /** 0 for whole-msg, ≥1 for per-block. */
  blockIndex: number
  /** Full source including any wrapper (e.g. fence markers). */
  outerSource: string
  /** Body without wrapper. Defaults to `outerSource`. */
  innerSource?: string
  /** Byte offset of innerSource within outerSource. Defaults to 0. */
  innerOffset?: number
  /** Total visual rows this content renders to. */
  visualLineCount: number
  /** Source-mapping function. See offsetMaps.ts for builders. */
  getOffset: SourceRange['getOffset']
}

export function CopySource(props: CopySourceProps): ReactNode {
  const idRef = useRef<RangeId | null>(null)
  const boxRef = useRef<unknown>(null)

  // Register / update the range every render. registerRange is keyed on
  // (msgId, blockIndex) so it returns the same id when those don't change.
  // This is intentionally NOT inside a useEffect: the rangeId needs to
  // exist on the FIRST render so the <Box copyRangeId={id}> below picks
  // it up; useEffect runs post-mount which is too late.
  const id = registerRange({
    msgId: props.msgId,
    blockIndex: props.blockIndex,
    outerSource: props.outerSource,
    innerSource: props.innerSource,
    innerOffset: props.innerOffset,
    visualLineCount: props.visualLineCount,
    getOffset: props.getOffset
  })

  idRef.current = id

  // After mount, point the registry at the live DOMElement so hit-test
  // can walk DOM → rangeId → SourceRange. Cleanup nulls it out on unmount
  // (virtual-scroll cycle) without evicting the range (still in registry).
  useEffect(() => {
    setRangeDom(id, boxRef.current)

    return () => {
      setRangeDom(id, null)
    }
  }, [id])

  return (
    <Box copyRangeId={id} ref={boxRef as never}>
      {props.children}
    </Box>
  )
}
