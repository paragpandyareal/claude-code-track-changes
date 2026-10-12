// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Claude Code Track Changes: https://github.com/paragpandyareal/claude-code-track-changes
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel

import type { GridCell, GridSheet } from '../types'

const MAX_ROWS = 5000
const MAX_COLS = 60
const MAX_CELL = 2000

/** Column letters as Excel writes them: 1 is A, 27 is AA. */
export function letters(n: number): string {
  let s = ''
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** The delimiter a file uses: a tab for .tsv, else whichever of , ; | tab is most common on the first lines. */
function delimiterOf(text: string, ext: string): string {
  if (ext === 'tsv') return '\t'
  const head = text.slice(0, 4000)
  let best = ','
  let most = -1
  for (const d of [',', ';', '\t', '|']) {
    const n = head.split(d).length
    if (n > most) {
      most = n
      best = d
    }
  }
  return best
}

/**
 * A CSV or TSV file as one sheet, quotes handled the RFC 4180 way (a quoted
 * field may hold the delimiter, a new line, or a doubled quote). Numbers keep
 * their text as written, with `x` set so they line up on the right.
 */
export function readCsv(text: string, ext = 'csv'): { sheet: GridSheet; isCut: boolean } {
  const d = delimiterOf(text, ext)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let isQuoted = false
  let isCut = false
  let i = 0
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const endField = () => {
    row.push(field.length > MAX_CELL ? `${field.slice(0, MAX_CELL)}…` : field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }
  for (; i < body.length; i += 1) {
    const ch = body[i]!
    if (isQuoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"'
          i += 1
        } else isQuoted = false
      } else field += ch
    } else if (ch === '"' && field === '') isQuoted = true
    else if (ch === d) endField()
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i += 1
      endRow()
      if (rows.length >= MAX_ROWS) {
        isCut = i + 1 < body.length
        break
      }
    } else field += ch
  }
  if (field !== '' || row.length > 0) endRow()
  const width = Math.min(MAX_COLS, rows.reduce((n, r) => Math.max(n, r.length), 0))
  if (rows.some(r => r.length > MAX_COLS)) isCut = true
  const cells: GridCell[][] = rows.map(r =>
    Array.from({ length: width }, (_, c) => {
      const v = (r[c] ?? '').replace(/\t/g, '  ')
      const n = /^\s*-?\d[\d,]*(\.\d+)?\s*$/.test(v) ? Number(v.replace(/[,\s]/g, '')) : NaN
      return Number.isFinite(n) ? { v, x: n } : { v }
    }),
  )
  return { sheet: { name: ext === 'tsv' ? 'TSV' : 'CSV', cols: Array.from({ length: width }, (_, k) => letters(k + 1)), rows: cells, ...(isCut ? { isCut: true } : {}) }, isCut }
}
