import { describe, expect, test } from 'vitest'

import {
  buildLineStartsFromRows,
  inlineOffsetFor,
  type InlineSpanTable,
  simpleOffsetFor
} from '../offsetMaps.js'

describe('buildLineStartsFromRows', () => {
  test('three single-line rows', () => {
    const out = buildLineStartsFromRows(['abc', 'def', 'ghi'])
    expect(Array.from(out)).toEqual([0, 4, 8])
  })

  test('empty array', () => {
    expect(buildLineStartsFromRows([]).length).toBe(0)
  })

  test('rows with varying length', () => {
    const out = buildLineStartsFromRows(['', 'longer', 'x'])
    expect(Array.from(out)).toEqual([0, 1, 8])
  })
})

describe('simpleOffsetFor', () => {
  test('col within first row returns rowStart + col', () => {
    const get = simpleOffsetFor('abc\ndef\nghi', new Uint32Array([0, 4, 8]))
    expect(get(0, 0)).toBe(0)
    expect(get(0, 2)).toBe(2)
    expect(get(1, 1)).toBe(5)
    expect(get(2, 2)).toBe(10)
  })

  test('col past end of row clamps at row end (excludes newline)', () => {
    const get = simpleOffsetFor('abc\ndef', new Uint32Array([0, 4]))
    expect(get(0, 99)).toBe(3) // end of "abc", before the \n
    expect(get(1, 99)).toBe(7) // end of "def" (end of source)
  })

  test('visualRow beyond end clamps to outerSource.length', () => {
    const get = simpleOffsetFor('abc\ndef', new Uint32Array([0, 4]))
    expect(get(5, 0)).toBe(7)
  })

  test('soft-wrap: two rows pointing into same source line', () => {
    // "abcdefghij" wrapped at col 5: row 0 → "abcde", row 1 → "fghij"
    const get = simpleOffsetFor('abcdefghij', new Uint32Array([0, 5]))
    expect(get(0, 0)).toBe(0)
    expect(get(0, 5)).toBe(5) // past row 0, clamped to row 1 start
    expect(get(1, 0)).toBe(5)
    expect(get(1, 4)).toBe(9)
    // col past end of row 1: clamp to source end
    expect(get(1, 99)).toBe(10)
  })

  test('negative visualRow returns 0', () => {
    const get = simpleOffsetFor('abc', new Uint32Array([0]))
    expect(get(-1, 0)).toBe(0)
  })

  test('negative col treated as 0', () => {
    const get = simpleOffsetFor('abc', new Uint32Array([0]))
    expect(get(0, -5)).toBe(0)
  })
})

describe('inlineOffsetFor — verbatim spans (visual == source length)', () => {
  test('single span: col offsets map 1:1 to source bytes', () => {
    const get = inlineOffsetFor('hello world', [
      [{ visualStart: 0, visualEnd: 11, sourceStart: 0, sourceEnd: 11 }]
    ])

    expect(get(0, 0)).toBe(0)
    expect(get(0, 5)).toBe(5)
    expect(get(0, 11)).toBe(11)
  })

  test('col before first span snaps to sourceStart of that span', () => {
    // Row starts with 2 columns of non-source-mapped prefix (e.g. gutter).
    const get = inlineOffsetFor('text', [
      [{ visualStart: 2, visualEnd: 6, sourceStart: 0, sourceEnd: 4 }]
    ])

    expect(get(0, 0)).toBe(0)
    expect(get(0, 1)).toBe(0)
    expect(get(0, 2)).toBe(0)
    expect(get(0, 4)).toBe(2)
    expect(get(0, 6)).toBe(4) // past end → sourceEnd of last span
  })
})

describe('inlineOffsetFor — rendered spans (visual != source length)', () => {
  test('bold span: 4 visual cells for 8 source chars (**bold**)', () => {
    // outerSource is "**bold**" (8 bytes), rendered as "bold" (4 cells).
    const get = inlineOffsetFor('**bold**', [
      [{ visualStart: 0, visualEnd: 4, sourceStart: 0, sourceEnd: 8 }]
    ])

    // col 0 → sourceStart (0)
    expect(get(0, 0)).toBe(0)
    // col 4 (past end) → sourceEnd (8)
    expect(get(0, 4)).toBe(8)
    // mid: col 2 → proportional (2/4) * 8 = 4
    expect(get(0, 2)).toBe(4)
  })

  test('link span: rendered "text" for source "[text](url)" — source byte length differs', () => {
    const outerSource = '[text](url)'

    const get = inlineOffsetFor(outerSource, [
      [{ visualStart: 0, visualEnd: 4, sourceStart: 0, sourceEnd: outerSource.length }]
    ])

    expect(get(0, 0)).toBe(0)
    expect(get(0, 4)).toBe(outerSource.length)
  })

  test('mixed row: plain text + rendered span + plain text', () => {
    // Source: "pre **bold** post" (17 bytes)
    // Rendered: "pre bold post" (13 cells)
    // Visual: 0-4 "pre " (verbatim, 4 chars), 4-8 "bold" (rendered for **bold**),
    //         8-13 " post" (verbatim, 5 chars).
    const outerSource = 'pre **bold** post'

    const spans: InlineSpanTable = [
      [
        { visualStart: 0, visualEnd: 4, sourceStart: 0, sourceEnd: 4 }, // "pre "
        { visualStart: 4, visualEnd: 8, sourceStart: 4, sourceEnd: 12 }, // "**bold**"
        { visualStart: 8, visualEnd: 13, sourceStart: 12, sourceEnd: 17 } // " post"
      ]
    ]

    const get = inlineOffsetFor(outerSource, spans)
    expect(get(0, 0)).toBe(0) // start of "pre "
    expect(get(0, 3)).toBe(3) // last char of "pre"
    expect(get(0, 4)).toBe(4) // start of bold span source
    expect(get(0, 8)).toBe(12) // end of bold span source
    expect(get(0, 13)).toBe(17) // end of post span source
  })

  test('past last span snaps to its sourceEnd', () => {
    const get = inlineOffsetFor('hello', [
      [{ visualStart: 0, visualEnd: 5, sourceStart: 0, sourceEnd: 5 }]
    ])

    expect(get(0, 99)).toBe(5)
  })

  test('empty row finds the next non-empty row sourceStart', () => {
    const get = inlineOffsetFor('first\nsecond', [
      [],
      [{ visualStart: 0, visualEnd: 6, sourceStart: 6, sourceEnd: 12 }]
    ])

    expect(get(0, 0)).toBe(6)
  })

  test('empty row at end with no further content returns outerSource.length', () => {
    const get = inlineOffsetFor('hello', [[], []])
    expect(get(0, 0)).toBe(5)
  })
})
