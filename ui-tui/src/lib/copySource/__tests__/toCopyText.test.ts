import { afterEach, describe, expect, test } from 'vitest'

import { buildLineStartsFromRows, simpleOffsetFor } from '../offsetMaps.js'
import { registerRange, resetRegistry } from '../registry.js'
import { toCopyText } from '../toCopyText.js'
import type { MsgSnapshot, RangeId, SelectionPoint } from '../types.js'

/**
 * Helper: register a one-line-per-source-line range (no soft-wrap).
 * Returns its RangeId.
 */
function registerSimple(
  msgId: string,
  blockIndex: number,
  outerSource: string,
  innerSource?: string,
  innerOffset?: number
): RangeId {
  const lines = outerSource.split('\n')
  const rowStarts = buildLineStartsFromRows(lines)

  return registerRange({
    msgId,
    blockIndex,
    outerSource,
    innerSource,
    innerOffset,
    visualLineCount: rowStarts.length,
    getOffset: simpleOffsetFor(outerSource, rowStarts)
  })
}

/**
 * Helper: register a range with explicit visual→source mapping (for
 * soft-wrap or out-of-order rendering tests).
 */
function registerCustom(
  msgId: string,
  blockIndex: number,
  outerSource: string,
  rowStartsArr: number[],
  innerSource?: string,
  innerOffset?: number
): RangeId {
  const rowStarts = new Uint32Array(rowStartsArr)

  return registerRange({
    msgId,
    blockIndex,
    outerSource,
    innerSource,
    innerOffset,
    visualLineCount: rowStarts.length,
    getOffset: simpleOffsetFor(outerSource, rowStarts)
  })
}

function msgs(...ids: string[]): readonly MsgSnapshot[] {
  return ids.map((id, order) => ({ id, order }))
}

function ptInRange(rangeId: RangeId, visualLine: number, col: number): SelectionPoint {
  return { kind: 'in-range', rangeId, visualLine, col }
}

afterEach(() => {
  resetRegistry()
})

describe('toCopyText — single range', () => {
  test('empty selection returns empty string', () => {
    const r = registerSimple('m1', 0, 'hello world')
    const p = ptInRange(r, 0, 5)
    expect(toCopyText({ anchor: p, focus: p, transcript: msgs('m1') })).toBe('')
  })

  test('within one line, returns the exact source slice', () => {
    const r = registerSimple('m1', 0, 'hello world')
    expect(
      toCopyText({
        anchor: ptInRange(r, 0, 0),
        focus: ptInRange(r, 0, 5),
        transcript: msgs('m1')
      })
    ).toBe('hello')
  })

  test('across two source lines, includes the newline', () => {
    const r = registerSimple('m1', 0, 'hello\nworld')
    expect(
      toCopyText({
        anchor: ptInRange(r, 0, 0),
        focus: ptInRange(r, 1, 5),
        transcript: msgs('m1')
      })
    ).toBe('hello\nworld')
  })

  test('reversed anchor/focus produces same result (auto-order)', () => {
    const r = registerSimple('m1', 0, 'hello world')
    const a = ptInRange(r, 0, 0)
    const b = ptInRange(r, 0, 5)
    expect(toCopyText({ anchor: b, focus: a, transcript: msgs('m1') })).toBe('hello')
    expect(toCopyText({ anchor: a, focus: b, transcript: msgs('m1') })).toBe('hello')
  })

  test('col past end of line clamps to end of that line, not next', () => {
    const r = registerSimple('m1', 0, 'abc\ndef')
    expect(
      toCopyText({
        anchor: ptInRange(r, 0, 0),
        focus: ptInRange(r, 0, 99),
        transcript: msgs('m1')
      })
    ).toBe('abc')
  })

  test('select whole single-line range', () => {
    const r = registerSimple('m1', 0, 'foo bar baz')
    expect(
      toCopyText({
        anchor: ptInRange(r, 0, 0),
        focus: ptInRange(r, 0, 11),
        transcript: msgs('m1')
      })
    ).toBe('foo bar baz')
  })
})

describe('toCopyText — multiple ranges in one message', () => {
  test('select across two blocks in one msg includes both source bodies', () => {
    const r1 = registerSimple('m1', 1, '# heading')
    const r2 = registerSimple('m1', 2, 'paragraph text')
    expect(
      toCopyText({
        anchor: ptInRange(r1, 0, 0),
        focus: ptInRange(r2, 0, 14),
        transcript: msgs('m1')
      })
    ).toBe('# heading\nparagraph text')
  })

  test('select partial of first block + all of second', () => {
    const r1 = registerSimple('m1', 1, '# heading')
    const r2 = registerSimple('m1', 2, 'para')
    expect(
      toCopyText({
        anchor: ptInRange(r1, 0, 2),
        focus: ptInRange(r2, 0, 4),
        transcript: msgs('m1')
      })
    ).toBe('heading\npara')
  })

  test('three blocks: middle block included whole', () => {
    const r1 = registerSimple('m1', 1, 'aaa')
    const r2 = registerSimple('m1', 2, 'bbb')
    const r3 = registerSimple('m1', 3, 'ccc')
    expect(
      toCopyText({
        anchor: ptInRange(r1, 0, 1),
        focus: ptInRange(r3, 0, 2),
        transcript: msgs('m1')
      })
    ).toBe('aa\nbbb\ncc')
  })
})

describe('toCopyText — across messages', () => {
  test('select spans m1 → m2 → m3, middle msgs included whole', () => {
    const r1 = registerSimple('m1', 0, 'first')
    const r2 = registerSimple('m2', 0, 'middle')
    const r3 = registerSimple('m3', 0, 'last')
    expect(
      toCopyText({
        anchor: ptInRange(r1, 0, 2),
        focus: ptInRange(r3, 0, 3),
        transcript: msgs('m1', 'm2', 'm3')
      })
    ).toBe('rst\nmiddle\nlas')
  })

  test('order independence — selecting bottom-to-top yields same text', () => {
    const r1 = registerSimple('m1', 0, 'first')
    const r2 = registerSimple('m2', 0, 'second')

    const forward = toCopyText({
      anchor: ptInRange(r1, 0, 0),
      focus: ptInRange(r2, 0, 6),
      transcript: msgs('m1', 'm2')
    })

    const reverse = toCopyText({
      anchor: ptInRange(r2, 0, 6),
      focus: ptInRange(r1, 0, 0),
      transcript: msgs('m1', 'm2')
    })

    expect(forward).toBe('first\nsecond')
    expect(reverse).toBe(forward)
  })
})

describe('toCopyText — fence-stripping rule', () => {
  test('both endpoints inside inner body of same range emits inner', () => {
    const outer = '```py\ncode\nlines\n```'
    const inner = 'code\nlines'
    const innerOffset = outer.indexOf(inner)
    const r = registerCustom('m1', 1, outer, [0, 6, 11, 17], inner, innerOffset)
    // Endpoints land on the inner visual rows (visual rows 1 and 2 — the
    // body lines). Sel from "code" start to "lines" end.
    expect(
      toCopyText({
        anchor: ptInRange(r, 1, 0),
        focus: ptInRange(r, 2, 5),
        transcript: msgs('m1')
      })
    ).toBe('code\nlines')
  })

  test('selection extending past fence emits outer with fence markers', () => {
    const outer = '```py\ncode\n```'
    const inner = 'code'
    const innerOffset = outer.indexOf(inner)
    const r = registerCustom('m1', 1, outer, [0, 6, 11], inner, innerOffset)

    // Anchor on fence opener (visualLine 0), focus on inner — fence
    // markers must survive.
    const out = toCopyText({
      anchor: ptInRange(r, 0, 0),
      focus: ptInRange(r, 1, 4),
      transcript: msgs('m1')
    })

    expect(out).toBe('```py\ncode')
  })

  test('endpoints land exactly on inner boundary still emits inner', () => {
    const outer = '```\nx\n```'
    const inner = 'x'
    const innerOffset = outer.indexOf(inner)
    const r = registerCustom('m1', 1, outer, [0, 4, 6], inner, innerOffset)
    expect(
      toCopyText({
        anchor: ptInRange(r, 1, 0),
        focus: ptInRange(r, 1, 1),
        transcript: msgs('m1')
      })
    ).toBe('x')
  })
})

describe('toCopyText — soft-wrap', () => {
  test('one source line wrapped to two visual rows', () => {
    // "abcdefghij" wrapped at col 5 → visual rows "abcde" and "fghij"
    // mapVisualToSource = [0, 5] (both rows point into the same source line)
    const r = registerCustom('m1', 0, 'abcdefghij', [0, 5])
    // Select from visual (0,2) to visual (1,3) — should give "cdefgh"
    expect(
      toCopyText({
        anchor: ptInRange(r, 0, 2),
        focus: ptInRange(r, 1, 3),
        transcript: msgs('m1')
      })
    ).toBe('cdefgh')
  })

  test('soft-wrap does not insert a newline that isn\'t in source', () => {
    const r = registerCustom('m1', 0, 'abcdefghij', [0, 5])
    expect(
      toCopyText({
        anchor: ptInRange(r, 0, 0),
        focus: ptInRange(r, 1, 5),
        transcript: msgs('m1')
      })
    ).toBe('abcdefghij')
  })
})

describe('toCopyText — boundary points', () => {
  test('before-all + after-all selects entire transcript', () => {
    const r1 = registerSimple('m1', 0, 'one')
    const r2 = registerSimple('m2', 0, 'two')
    expect(
      toCopyText({
        anchor: { kind: 'before-all' },
        focus: { kind: 'after-all' },
        transcript: msgs('m1', 'm2')
      })
    ).toBe('one\ntwo')
  })

  test('before-all to mid-msg emits from start', () => {
    const r1 = registerSimple('m1', 0, 'hello')
    expect(
      toCopyText({
        anchor: { kind: 'before-all' },
        focus: ptInRange(r1, 0, 3),
        transcript: msgs('m1')
      })
    ).toBe('hel')
  })

  test('mid-msg to after-all emits to end', () => {
    const r1 = registerSimple('m1', 0, 'hello')
    expect(
      toCopyText({
        anchor: ptInRange(r1, 0, 2),
        focus: { kind: 'after-all' },
        transcript: msgs('m1')
      })
    ).toBe('llo')
  })
})

describe('toCopyText — stale rangeId (evicted)', () => {
  test('stale anchor + valid focus + no host-side repair → empty', () => {
    // Contract: when a range is evicted, the host is expected to repair
    // the selection via the truncate-to-survivor policy BEFORE calling
    // toCopyText. If it forgets, toCopyText degrades gracefully — both
    // endpoints fall to the far-end of the document, the resolved window
    // collapses, and the output is empty rather than wrong.
    const r2 = registerSimple('m2', 0, 'two')
    const stale: SelectionPoint = { kind: 'in-range', rangeId: 99999, visualLine: 0, col: 0 }
    expect(
      toCopyText({
        anchor: stale,
        focus: ptInRange(r2, 0, 3),
        transcript: msgs('m1', 'm2')
      })
    ).toBe('')
  })
})

describe('toCopyText — idempotence / round-trip', () => {
  test('select-all of plain transcript equals concatenated source with \\n separator', () => {
    const sources = ['first message', 'second message', 'third message']
    const ids = ['m1', 'm2', 'm3']

    for (let i = 0; i < sources.length; i++) {
      registerSimple(ids[i]!, 0, sources[i]!)
    }

    expect(
      toCopyText({
        anchor: { kind: 'before-all' },
        focus: { kind: 'after-all' },
        transcript: msgs(...ids)
      })
    ).toBe('first message\nsecond message\nthird message')
  })

  test('select-all of markdown msg (multi-block) reproduces full body', () => {
    // msg "m1" with three blocks emulating:
    //   "# heading"
    //   ""
    //   "paragraph here"
    registerSimple('m1', 1, '# heading')
    registerSimple('m1', 2, '')
    registerSimple('m1', 3, 'paragraph here')
    expect(
      toCopyText({
        anchor: { kind: 'before-all' },
        focus: { kind: 'after-all' },
        transcript: msgs('m1')
      })
    ).toBe('# heading\n\nparagraph here')
  })
})

describe('toCopyText — gap points', () => {
  test('gap between two ranges acts like the boundary between them', () => {
    const r1 = registerSimple('m1', 0, 'first')
    const r2 = registerSimple('m2', 0, 'second')
    const gap: SelectionPoint = { kind: 'gap', afterRangeId: r1, beforeRangeId: r2 }
    // Anchor at start of r1, focus in the gap → emits just first
    // (gap-after-r1 means we're past r1 but before r2).
    expect(
      toCopyText({
        anchor: ptInRange(r1, 0, 0),
        focus: gap,
        transcript: msgs('m1', 'm2')
      })
    ).toBe('first')
  })
})
