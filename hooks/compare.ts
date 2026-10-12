// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Claude Code Track Changes: https://github.com/paragpandyareal/claude-code-track-changes
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel

import type { DocRow, GridCell, GridSheet } from '../types'
import { letters } from './csv'

/**
 * Comparing two versions of a document: pure, no `$`.
 *
 * Documents are compared paragraph by paragraph (or line by line), then word
 * by word inside a changed paragraph. Spreadsheets line up columns first, then
 * rows, so one row added near the top doesn't make every row below it look
 * changed; then cell by cell, value and formula.
 */

// ── Sequences ──

/** One step of an edit script: kept (both sides), removed (before only), added (after only). */
export type Step = { op: '='; a: number; b: number } | { op: '-'; a: number } | { op: '+'; b: number }

/**
 * The shortest edit script between two sequences of keys (Myers' algorithm),
 * with the shared start and end trimmed first. Past `maxEdits` it gives up
 * and calls the middle all removed then all added; the caller pairs those up.
 */
export function editScript(a: readonly string[], b: readonly string[], maxEdits = 2000): Step[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const head: Step[] = []
  for (let k = 0; k < start; k += 1) head.push({ op: '=', a: k, b: k })
  const tail: Step[] = []
  for (let k = 0; k < a.length - endA; k += 1) tail.push({ op: '=', a: endA + k, b: endB + k })
  const n = endA - start
  const m = endB - start
  const middle: Step[] = []
  if (n === 0) for (let j = 0; j < m; j += 1) middle.push({ op: '+', b: start + j })
  else if (m === 0) for (let i = 0; i < n; i += 1) middle.push({ op: '-', a: start + i })
  else {
    // Keys as small numbers, so the inner loop compares integers.
    const ids = new Map<string, number>()
    const id = (s: string) => {
      let v = ids.get(s)
      if (v === undefined) {
        v = ids.size
        ids.set(s, v)
      }
      return v
    }
    const A = Int32Array.from({ length: n }, (_, i) => id(a[start + i]!))
    const B = Int32Array.from({ length: m }, (_, j) => id(b[start + j]!))
    const max = Math.min(n + m, maxEdits)
    const offset = max + 1
    const v = new Int32Array(2 * max + 3)
    const trace: Int32Array[] = []
    let found = -1
    for (let d = 0; d <= max && found < 0; d += 1) {
      trace.push(v.slice(offset - d - 1, offset + d + 2))
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
        let y = x - k
        while (x < n && y < m && A[x] === B[y]) {
          x += 1
          y += 1
        }
        v[offset + k] = x
        if (x >= n && y >= m) {
          found = d
          break
        }
      }
    }
    if (found < 0) {
      for (let i = 0; i < n; i += 1) middle.push({ op: '-', a: start + i })
      for (let j = 0; j < m; j += 1) middle.push({ op: '+', b: start + j })
    } else {
      // Walk back through the saved frontiers.
      let x = n
      let y = m
      const back: Step[] = []
      for (let d = found; d > 0; d -= 1) {
        const frame = trace[d]!
        const at = (k: number) => frame[k + d + 1]!
        const k = x - y
        const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
        const prevX = at(prevK)
        const prevY = prevX - prevK
        while (x > prevX && y > prevY) {
          x -= 1
          y -= 1
          back.push({ op: '=', a: start + x, b: start + y })
        }
        if (x === prevX) {
          y -= 1
          back.push({ op: '+', b: start + y })
        } else {
          x -= 1
          back.push({ op: '-', a: start + x })
        }
      }
      while (x > 0 && y > 0) {
        x -= 1
        y -= 1
        back.push({ op: '=', a: start + x, b: start + y })
      }
      middle.push(...back.reverse())
    }
  }
  return [...head, ...middle, ...tail]
}

/**
 * Pairs the removed and added items between two kept ones, when they are the
 * same item edited: in order, each removed item with the next added item
 * similar enough. Equal-sized runs pair one to one (an item edited in place)
 * unless the two are nothing alike.
 */
function pairRuns(steps: Step[], similar: (a: number, b: number) => number, threshold: number, loose: number): PairedStep[] {
  const out: PairedStep[] = []
  let k = 0
  while (k < steps.length) {
    const step = steps[k]!
    if (step.op === '=') {
      out.push({ op: '=', a: step.a, b: step.b })
      k += 1
      continue
    }
    const dels: number[] = []
    const adds: number[] = []
    while (k < steps.length && steps[k]!.op !== '=') {
      const s = steps[k]!
      if (s.op === '-') dels.push(s.a)
      else if (s.op === '+') adds.push(s.b)
      k += 1
    }
    const isEven = dels.length === adds.length
    let j = 0
    const pending: PairedStep[] = []
    for (const a of dels) {
      // Look a few added items ahead for this one's edited copy.
      let best = -1
      let bestScore = 0
      for (let t = j; t < Math.min(adds.length, j + 8); t += 1) {
        const score = similar(a, adds[t]!)
        if (score > bestScore) {
          bestScore = score
          best = t
        }
      }
      const isPair = best >= 0 && (bestScore >= threshold || (isEven && best === j && bestScore >= loose))
      if (isPair) {
        for (; j < best; j += 1) pending.push({ op: '+', b: adds[j]! })
        pending.push({ op: '~', a, b: adds[best]! })
        j = best + 1
      } else pending.push({ op: '-', a })
    }
    for (; j < adds.length; j += 1) pending.push({ op: '+', b: adds[j]! })
    // Removed items read before added ones between two kept items.
    out.push(...pending)
  }
  return out
}

type PairedStep = Step | { op: '~'; a: number; b: number }

// ── Words ──

/** A run of words: kept (0), removed (-1) or added (1). */
export type Piece = { t: string; op: 0 | 1 | -1 }

/** Words, numbers with their points and commas (12,000.50, 3.5%), runs of space, and any other character alone: so "78%." is the number and then the full stop. */
const TOKEN = /\s+|[\p{L}\p{N}_'’$€£%]+(?:[.,\-/:][\p{L}\p{N}_'’$€£%]+)*|[^\s]/gu

export const tokens = (text: string) => text.match(TOKEN) ?? []

/** How alike two texts are, 0 to 1: the share of their words they have in common. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  const wa = tokens(a.toLowerCase()).filter(t => t.trim() !== '')
  const wb = tokens(b.toLowerCase()).filter(t => t.trim() !== '')
  if (wa.length === 0 || wb.length === 0) return 0
  const count = new Map<string, number>()
  for (const w of wa) count.set(w, (count.get(w) ?? 0) + 1)
  let common = 0
  for (const w of wb) {
    const n = count.get(w) ?? 0
    if (n > 0) {
      common += 1
      count.set(w, n - 1)
    }
  }
  return (2 * common) / (wa.length + wb.length)
}

/**
 * Word by word: what was removed and added inside a changed paragraph. A
 * lone space between two changes joins them, so "red fox" becoming "blue
 * cat" reads as one replacement, not four.
 */
export function wordPieces(before: string, after: string): Piece[] {
  const a = tokens(before)
  const b = tokens(after)
  const raw: Piece[] = editScript(a, b, 600).map(s => (s.op === '=' ? { t: a[s.a]!, op: 0 as const } : s.op === '-' ? { t: a[s.a]!, op: -1 as const } : { t: b[s.b]!, op: 1 as const }))
  // A kept space between changes goes with them.
  for (let k = 1; k < raw.length - 1; k += 1) {
    const p = raw[k]!
    if (p.op === 0 && /^\s+$/.test(p.t) && raw[k - 1]!.op !== 0 && raw[k + 1]!.op !== 0) {
      raw.splice(k, 1, { t: p.t, op: -1 }, { t: p.t, op: 1 })
      k += 1
    }
  }
  // Removed then added, never interleaved, within each changed stretch; neighbours of a kind merged.
  const out: Piece[] = []
  let k = 0
  while (k < raw.length) {
    if (raw[k]!.op === 0) {
      const last = out[out.length - 1]
      if (last && last.op === 0) last.t += raw[k]!.t
      else out.push({ ...raw[k]! })
      k += 1
      continue
    }
    let del = ''
    let add = ''
    while (k < raw.length && raw[k]!.op !== 0) {
      if (raw[k]!.op === -1) del += raw[k]!.t
      else add += raw[k]!.t
      k += 1
    }
    if (del) out.push({ t: del, op: -1 })
    if (add) out.push({ t: add, op: 1 })
  }
  return out
}

// ── Documents ──

/** One row of the comparison: kept, removed, added, or changed (with its words). */
export type LineOp =
  | { kind: 'same'; a: number; b: number }
  | { kind: 'del'; a: number }
  | { kind: 'add'; b: number }
  | { kind: 'mod'; a: number; b: number; pieces: Piece[]; restyled?: string }

export type LinesComparison = {
  kind: 'lines'
  before: DocRow[]
  after: DocRow[]
  ops: LineOp[]
  /** What a row is called: "paragraph" for formatted documents, "line" for text. */
  unit: string
  counts: { changed: number; added: number; removed: number; pictures: { added: number; removed: number } }
}

const STYLE_NAMES: Record<string, string> = { h1: 'a title', h2: 'a heading', h3: 'a heading', li: 'a list item', quote: 'a quote', code: 'code', th: 'a table header', td: 'a table row', p: 'a paragraph', panel: 'a panel' }
const rowKey = (r: DocRow) => `${r.style ?? ''}|${r.indent ?? 0}|${r.marker ?? ''}|${r.text}`
const isBlank = (r: DocRow) => r.style === 'space' || (r.text.trim() === '' && r.pic === undefined && r.style !== 'rule')

export function compareLines(before: DocRow[], after: DocRow[], isFormatted: boolean): LinesComparison {
  const steps = editScript(before.map(rowKey), after.map(rowKey))
  const paired = pairRuns(
    steps,
    (a, b) => {
      const x = before[a]!
      const y = after[b]!
      if (x.text === y.text) return 1
      // A picture is the same picture or another one, never an edited one.
      if (x.pic !== undefined || y.pic !== undefined) return 0
      const score = similarity(x.text, y.text)
      // A heading in the same place, at the same level, renamed: still that heading.
      const isHeading = /^h[123]$/.test(x.style ?? '') && x.style === y.style
      return isHeading ? Math.max(score, 0.3) : score
    },
    0.5,
    0.2,
  )
  const ops: LineOp[] = []
  const counts = { changed: 0, added: 0, removed: 0, pictures: { added: 0, removed: 0 } }
  for (const s of paired) {
    if (s.op === '=') {
      ops.push({ kind: 'same', a: s.a, b: s.b })
      continue
    }
    if (s.op === '-') {
      ops.push({ kind: 'del', a: s.a })
      if (isBlank(before[s.a]!)) continue
      if (before[s.a]!.pic !== undefined) counts.pictures.removed += 1
      else counts.removed += 1
      continue
    }
    if (s.op === '+') {
      ops.push({ kind: 'add', b: s.b })
      if (isBlank(after[s.b]!)) continue
      if (after[s.b]!.pic !== undefined) counts.pictures.added += 1
      else counts.added += 1
      continue
    }
    const x = before[s.a]!
    const y = after[s.b]!
    const restyled = (x.style ?? 'p') !== (y.style ?? 'p') || (x.indent ?? 0) !== (y.indent ?? 0) ? `now ${STYLE_NAMES[y.style ?? 'p'] ?? 'restyled'}` : undefined
    ops.push({ kind: 'mod', a: s.a, b: s.b, pieces: wordPieces(x.text, y.text), ...(restyled ? { restyled } : {}) })
    counts.changed += 1
  }
  return { kind: 'lines', before, after, ops, unit: isFormatted ? 'paragraph' : 'line', counts }
}

// ── Spreadsheets ──

export type GridOp = { kind: 'same' | 'mod'; a: number; b: number } | { kind: 'del'; a: number } | { kind: 'add'; b: number }

export type SheetComparison = {
  /** The sheet's name now (or, removed, as it was). */
  name: string
  /** Its old name, when renamed. */
  was?: string
  status: 'same' | 'changed' | 'added' | 'removed' | 'renamed'
  before?: GridSheet
  after?: GridSheet
  rows: GridOp[]
  cols: GridOp[]
  /** Changed cells as "row:col" of `rows` and `cols` indexes, with what changed. */
  cells: Map<string, { value: boolean; formula: boolean }>
  counts: { cells: number; formulas: number; rowsAdded: number; rowsRemoved: number; colsAdded: number; colsRemoved: number }
  merges: { added: string[]; removed: string[] }
  isCut: boolean
}

export type GridComparison = { kind: 'grid'; sheets: SheetComparison[] }

const EMPTY: GridCell = { v: '' }
const cellAt = (sheet: GridSheet | undefined, r: number, c: number): GridCell => sheet?.rows[r]?.[c] ?? EMPTY

const colNumber = (letters: string) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
const REF = /(^|[^A-Za-z0-9_.'!$])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])/g

/**
 * A formula as its shape, wherever the cell is: references made relative to
 * the cell, as Excel's R1C1 form. A row inserted above moves =SUM(B3:D3) to
 * =SUM(B4:D4); both are "the three cells to the left", so neither is a change.
 */
export function formulaShape(formula: string | undefined, row: number, col: number): string {
  if (!formula) return ''
  // Text in quotes is left as it is.
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, k) =>
      k % 2 === 1
        ? part
        : part.replace(REF, (_, lead: string, absCol: string, letters: string, absRow: string, digits: string) => {
            const c = colNumber(letters) - 1
            const r = Number(digits) - 1
            return `${lead}R${absRow ? r : `[${r - row}]`}C${absCol ? c : `[${c - col}]`}`
          }),
    )
    .join('')
    .toUpperCase()
}

const cellKey = (c: GridCell, row: number, col: number) => `${c.v}\u0001${formulaShape(c.f, row, col)}`

/** How alike two lists of values are, as multisets: for lining up columns that moved. */
function multisetSimilarity(a: string[], b: string[]): number {
  const filled = (list: string[]) => list.filter(v => v !== '\u0001')
  const x = filled(a)
  const y = filled(b)
  if (x.length === 0 && y.length === 0) return 1
  if (x.length === 0 || y.length === 0) return 0
  const count = new Map<string, number>()
  for (const v of x) count.set(v, (count.get(v) ?? 0) + 1)
  let common = 0
  for (const v of y) {
    const n = count.get(v) ?? 0
    if (n > 0) {
      common += 1
      count.set(v, n - 1)
    }
  }
  return (2 * common) / (x.length + y.length)
}

const widthOf = (sheet: GridSheet | undefined) => Math.max(sheet?.cols.length ?? 0, ...(sheet?.rows.slice(0, 1).map(r => r.length) ?? [0]))

export function compareSheet(before: GridSheet | undefined, after: GridSheet | undefined): SheetComparison {
  const name = after?.name ?? before?.name ?? ''
  const rowsA = before?.rows ?? []
  const rowsB = after?.rows ?? []
  const nColsA = before ? widthOf(before) : 0
  const nColsB = after ? widthOf(after) : 0
  // Columns first, by what they hold top to bottom (the first 2,000 rows say enough).
  const colValues = (rows: GridCell[][], c: number) => rows.slice(0, 2000).map((row, r) => cellKey(row[c] ?? EMPTY, r, c))
  const colsA = Array.from({ length: nColsA }, (_, c) => colValues(rowsA, c))
  const colsB = Array.from({ length: nColsB }, (_, c) => colValues(rowsB, c))
  const colSteps = editScript(colsA.map(v => v.join('\u0002')), colsB.map(v => v.join('\u0002')), 200)
  const colPairs = pairRuns(colSteps, (a, b) => multisetSimilarity(colsA[a]!, colsB[b]!), 0.5, 0.3)
  const cols: GridOp[] = colPairs.map(s => (s.op === '=' || s.op === '~' ? { kind: 'same', a: s.a, b: s.b } : s.op === '-' ? { kind: 'del', a: s.a } : { kind: 'add', b: s.b }))
  const kept = cols.filter((c): c is Extract<GridOp, { a: number; b: number }> => c.kind === 'same')
  // Then rows, by the columns both versions have, so a column added doesn't change every row.
  const rowSig = (row: GridCell[] | undefined, r: number, side: 'a' | 'b') => kept.map(c => cellKey(row?.[side === 'a' ? c.a : c.b] ?? EMPTY, r, side === 'a' ? c.a : c.b)).join('\u0002')
  const sigA = rowsA.map((row, r) => rowSig(row, r, 'a'))
  const sigB = rowsB.map((row, r) => rowSig(row, r, 'b'))
  const rowSteps = editScript(sigA, sigB, 3000)
  const rowPairs = pairRuns(
    rowSteps,
    (a, b) => {
      let same = 0
      let filled = 0
      for (const c of kept) {
        const x = cellAt(before, a, c.a)
        const y = cellAt(after, b, c.b)
        if (x.v === '' && y.v === '' && !x.f && !y.f) continue
        filled += 1
        if (cellKey(x, a, c.a) === cellKey(y, b, c.b)) same += 1
      }
      return filled === 0 ? 1 : same / filled
    },
    0.5,
    0,
  )
  const rows: GridOp[] = []
  const cells = new Map<string, { value: boolean; formula: boolean }>()
  const counts = { cells: 0, formulas: 0, rowsAdded: 0, rowsRemoved: 0, colsAdded: 0, colsRemoved: 0 }
  const isEmptyRow = (row: GridCell[] | undefined) => !row || row.every(c => c.v === '' && !c.f)
  for (const s of rowPairs) {
    if (s.op === '-') {
      rows.push({ kind: 'del', a: s.a })
      if (!isEmptyRow(rowsA[s.a])) counts.rowsRemoved += 1
    } else if (s.op === '+') {
      rows.push({ kind: 'add', b: s.b })
      if (!isEmptyRow(rowsB[s.b])) counts.rowsAdded += 1
    } else {
      const index = rows.length
      let isChanged = false
      cols.forEach((c, ci) => {
        if (c.kind !== 'same') return
        const x = cellAt(before, s.a, c.a)
        const y = cellAt(after, s.b, c.b)
        const value = x.v !== y.v
        const formula = formulaShape(x.f, s.a, c.a) !== formulaShape(y.f, s.b, c.b)
        if (!value && !formula) return
        cells.set(`${index}:${ci}`, { value, formula })
        counts.cells += 1
        if (formula) counts.formulas += 1
        isChanged = true
      })
      rows.push({ kind: isChanged ? 'mod' : 'same', a: s.a, b: s.b })
    }
  }
  for (const c of cols) {
    if (c.kind === 'add' && colsB[c.b]!.some(v => v !== '\u0001')) counts.colsAdded += 1
    if (c.kind === 'del' && colsA[c.a]!.some(v => v !== '\u0001')) counts.colsRemoved += 1
  }
  const mergesA = new Set(before?.merges ?? [])
  const mergesB = new Set(after?.merges ?? [])
  const merges = { added: [...mergesB].filter(m => !mergesA.has(m)), removed: [...mergesA].filter(m => !mergesB.has(m)) }
  const isChanged = counts.cells + counts.rowsAdded + counts.rowsRemoved + counts.colsAdded + counts.colsRemoved + merges.added.length + merges.removed.length > 0
  return {
    name,
    status: !before ? 'added' : !after ? 'removed' : isChanged ? 'changed' : 'same',
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    rows,
    cols,
    cells,
    counts,
    merges,
    isCut: before?.isCut === true || after?.isCut === true,
  }
}

/** How alike two sheets are by their rows: for telling a renamed sheet from a new one. */
function sheetSimilarity(a: GridSheet, b: GridSheet): number {
  const sig = (s: GridSheet) => s.rows.slice(0, 500).map((row, r) => row.map((cell, c) => cellKey(cell, r, c)).join('\u0002'))
  return multisetSimilarity(sig(a), sig(b))
}

export function compareGrids(before: GridSheet[], after: GridSheet[]): GridComparison {
  const byName = new Map(before.map(s => [s.name, s]))
  const used = new Set<string>()
  const out: SheetComparison[] = []
  const unmatched = after.filter(s => !byName.has(s.name))
  const orphans = before.filter(s => !after.some(t => t.name === s.name))
  const renamedFrom = new Map<string, GridSheet>()
  for (const fresh of unmatched) {
    let best: GridSheet | undefined
    let score = 0
    for (const old of orphans) {
      if (used.has(old.name)) continue
      const sim = sheetSimilarity(old, fresh)
      if (sim > score) {
        score = sim
        best = old
      }
    }
    if (best && score >= 0.5) {
      used.add(best.name)
      renamedFrom.set(fresh.name, best)
    }
  }
  for (const sheet of after) {
    const old = byName.get(sheet.name) ?? renamedFrom.get(sheet.name)
    const sc = compareSheet(old, sheet)
    if (old && old.name !== sheet.name) out.push({ ...sc, was: old.name, status: 'renamed' })
    else out.push(sc)
  }
  // Removed sheets go where they were, after the sheet that came before them.
  for (const [k, sheet] of before.entries()) {
    if (after.some(s => s.name === sheet.name) || used.has(sheet.name)) continue
    const removed = compareSheet(sheet, undefined)
    const prev = before[k - 1]
    const at = prev ? out.findIndex(s => s.name === prev.name || s.was === prev.name) : -1
    out.splice(at + 1, 0, removed)
  }
  return { kind: 'grid', sheets: out }
}

/** A cell's address in a version: "B6". */
export const address = (col: number, row: number) => `${letters(col + 1)}${row + 1}`

// ── The list of changes ──

/** One change the person can step to: where it is, and a line saying what it is. */
export type Change = {
  /** For a grid, the sheet's index in the comparison; the row op (and column op) it is at. */
  sheet?: number
  op: number
  col?: number
  label: string
  kind: 'changed' | 'added' | 'removed'
}

const quoteShort = (text: string, most = 40) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > most ? `${flat.slice(0, most - 1)}…` : flat
}

/** Every change, in reading order, each with a one-line label. */
export function changesOf(cmp: LinesComparison | GridComparison): Change[] {
  const out: Change[] = []
  if (cmp.kind === 'lines') {
    let k = 0
    while (k < cmp.ops.length) {
      const op = cmp.ops[k]!
      if (op.kind === 'same') {
        k += 1
        continue
      }
      if (op.kind === 'mod') {
        const row = cmp.after[op.b]!
        out.push({ op: k, kind: 'changed', label: `Changed: “${quoteShort(row.text)}”${op.restyled ? ` (${op.restyled})` : ''}` })
        k += 1
        continue
      }
      // A run of removed or added rows is one change.
      const kind = op.kind
      const startK = k
      let n = 0
      let first = ''
      let pictures = 0
      while (k < cmp.ops.length && cmp.ops[k]!.kind === kind) {
        const o = cmp.ops[k]!
        const row = o.kind === 'del' ? cmp.before[o.a]! : o.kind === 'add' ? cmp.after[o.b]! : undefined
        if (row && !isBlank(row)) {
          if (row.pic !== undefined) pictures += 1
          else n += 1
          if (!first) first = row.text
        }
        k += 1
      }
      if (n === 0 && pictures === 0) continue
      const what = n > 0 ? (n === 1 ? `“${quoteShort(first)}”` : `${n} ${cmp.unit}s`) : ''
      const pics = pictures > 0 ? `${pictures} picture${pictures === 1 ? '' : 's'}` : ''
      out.push({ op: startK, kind: kind === 'add' ? 'added' : 'removed', label: `${kind === 'add' ? 'Added' : 'Removed'}: ${[what, pics].filter(Boolean).join(' and ')}` })
    }
    return out
  }
  cmp.sheets.forEach((sheet, si) => {
    if (sheet.status === 'added') {
      out.push({ sheet: si, op: 0, kind: 'added', label: `Sheet added: ${sheet.name}` })
      return
    }
    if (sheet.status === 'removed') {
      out.push({ sheet: si, op: 0, kind: 'removed', label: `Sheet removed: ${sheet.name}` })
      return
    }
    if (sheet.status === 'renamed') out.push({ sheet: si, op: 0, kind: 'changed', label: `Sheet renamed: ${sheet.was} → ${sheet.name}` })
    sheet.cols.forEach((c, ci) => {
      if (c.kind === 'add') out.push({ sheet: si, op: 0, col: ci, kind: 'added', label: `${sheet.name}: column ${letters(c.b + 1)} added` })
      if (c.kind === 'del') out.push({ sheet: si, op: 0, col: ci, kind: 'removed', label: `${sheet.name}: column ${letters(c.a + 1)} removed` })
    })
    let k = 0
    while (k < sheet.rows.length) {
      const op = sheet.rows[k]!
      if (op.kind === 'del' || op.kind === 'add') {
        const kind = op.kind
        const startK = k
        const firstRow = kind === 'add' ? (op as { b: number }).b : (op as { a: number }).a
        let n = 0
        while (k < sheet.rows.length && sheet.rows[k]!.kind === kind) {
          n += 1
          k += 1
        }
        out.push({
          sheet: si,
          op: startK,
          kind: kind === 'add' ? 'added' : 'removed',
          label: `${sheet.name}: ${n === 1 ? `row ${firstRow + 1}` : `rows ${firstRow + 1}–${firstRow + n}`} ${kind === 'add' ? 'added' : 'removed'}`,
        })
        continue
      }
      if (op.kind === 'mod') {
        sheet.cols.forEach((c, ci) => {
          const change = sheet.cells.get(`${k}:${ci}`)
          if (!change || c.kind !== 'same') return
          const x = cellAt(sheet.before, op.a, c.a)
          const y = cellAt(sheet.after, op.b, c.b)
          const where = address(c.b, op.b)
          const label = change.value
            ? `${where}: ${quoteShort(x.v || '(empty)', 24)} → ${quoteShort(y.v || '(empty)', 24)}${change.formula ? ' (formula changed)' : ''}`
            : `${where}: formula changed`
          out.push({ sheet: si, op: k, col: ci, kind: 'changed', label })
        })
      }
      k += 1
    }
    for (const m of sheet.merges.added) out.push({ sheet: si, op: 0, kind: 'changed', label: `${sheet.name}: cells ${m} merged` })
    for (const m of sheet.merges.removed) out.push({ sheet: si, op: 0, kind: 'changed', label: `${sheet.name}: cells ${m} unmerged` })
  })
  return out
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** The summary line: "7 changes · 3 cells · 1 row added · 1 sheet removed". */
export function summaryOf(cmp: LinesComparison | GridComparison, changes: Change[]): string {
  if (changes.length === 0) return 'No changes'
  const parts = [n(changes.length, 'change')]
  if (cmp.kind === 'lines') {
    const c = cmp.counts
    if (c.changed) parts.push(`${n(c.changed, cmp.unit)} changed`)
    if (c.added) parts.push(`${n(c.added, cmp.unit)} added`)
    if (c.removed) parts.push(`${n(c.removed, cmp.unit)} removed`)
    if (c.pictures.added) parts.push(`${n(c.pictures.added, 'picture')} added`)
    if (c.pictures.removed) parts.push(`${n(c.pictures.removed, 'picture')} removed`)
    return parts.join(' · ')
  }
  let cells = 0
  let rowsAdded = 0
  let rowsRemoved = 0
  let colsAdded = 0
  let colsRemoved = 0
  let formulas = 0
  for (const s of cmp.sheets) {
    if (s.status === 'added' || s.status === 'removed') continue
    cells += s.counts.cells
    formulas += s.counts.formulas
    rowsAdded += s.counts.rowsAdded
    rowsRemoved += s.counts.rowsRemoved
    colsAdded += s.counts.colsAdded
    colsRemoved += s.counts.colsRemoved
  }
  if (cells) parts.push(`${n(cells, 'cell')}${formulas ? ` (${n(formulas, 'formula')})` : ''}`)
  if (rowsAdded) parts.push(`${n(rowsAdded, 'row')} added`)
  if (rowsRemoved) parts.push(`${n(rowsRemoved, 'row')} removed`)
  if (colsAdded) parts.push(`${n(colsAdded, 'column')} added`)
  if (colsRemoved) parts.push(`${n(colsRemoved, 'column')} removed`)
  const added = cmp.sheets.filter(s => s.status === 'added').length
  const removed = cmp.sheets.filter(s => s.status === 'removed').length
  const renamed = cmp.sheets.filter(s => s.status === 'renamed').length
  if (added) parts.push(`${n(added, 'sheet')} added`)
  if (removed) parts.push(`${n(removed, 'sheet')} removed`)
  if (renamed) parts.push(`${n(renamed, 'sheet')} renamed`)
  return parts.join(' · ')
}
