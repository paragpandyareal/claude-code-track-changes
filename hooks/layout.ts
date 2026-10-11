// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Panda Redline: https://github.com/paragpandyareal/panda-redline
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel

import type { DocRow, GridCell } from '../types'
import type { Change, GridOp, LinesComparison, Piece, SheetComparison } from './compare'
import { letters } from './csv'
import { cutTo, strWidth } from './text'

/**
 * A comparison laid out as the lines the pane shows, at a width: inline
 * (one column, removed above added) or side by side (before | after). Pure.
 *
 * Every change carries a mark as well as a colour, for people who can't tell
 * red from green: removed is struck through with −, added is underlined with
 * +, changed has ~.
 */

/** How a run of text is drawn. */
export type SegKind = 'n' | 'del' | 'add' | 'mdel' | 'madd' | 'mmod' | 'dim' | 'h1' | 'h2' | 'h3' | 'quote' | 'code' | 'num' | 'head' | 'fold' | 'sep' | 'li' | 'th' | 'sel' | 'pic'

export type Seg = { t: string; k?: SegKind }

/** A cell's place on a grid line, for clicks: columns `x` to `x + w`. */
export type CellSpot = { x: number; w: number; key: string }

export type DRow = {
  segs: Seg[]
  /** The change this line belongs to, for the focus mark and the glow. */
  change?: number
  /** A fold of unchanged lines: its id, clicked to open. */
  fold?: string
  cells?: CellSpot[]
}

export type Laid = { rows: DRow[]; changeAt: number[] }

const CONTEXT = 2

const pad = (text: string, width: number) => {
  const cut = cutTo(text, width)
  return cut + ' '.repeat(Math.max(0, width - strWidth(cut)))
}

/** Wraps runs of text to `width` cells, breaking at spaces where it can; each line starts with `lead`. */
export function wrapSegs(segs: Seg[], width: number, lead: Seg[] = [], cont: Seg[] = lead.map(s => ({ ...s, t: ' '.repeat(strWidth(s.t)) }))): Seg[][] {
  const leadW = lead.reduce((n, s) => n + strWidth(s.t), 0)
  const room = Math.max(4, width - leadW)
  const lines: Seg[][] = []
  let line: Seg[] = []
  let used = 0
  const push = (t: string, k: SegKind | undefined) => {
    const last = line[line.length - 1]
    if (last && last.k === k) last.t += t
    else line.push(k ? { t, k } : { t })
    used += strWidth(t)
  }
  const flush = () => {
    lines.push([...(lines.length === 0 ? lead : cont), ...line])
    line = []
    used = 0
  }
  for (const seg of segs) {
    const words = seg.t.match(/\s+|\S+/g) ?? []
    for (let word of words) {
      while (strWidth(word) > room) {
        // A word longer than the line is broken.
        if (used > 0) flush()
        const head = cutTo(word, room)
        push(head, seg.k)
        flush()
        word = word.slice(head.length)
      }
      if (used + strWidth(word) > room) {
        if (/^\s+$/.test(word)) {
          // A space at the end of a line still shows when it is a change.
          if (seg.k === 'del' || seg.k === 'add') push(cutTo(word, Math.max(0, room - used)), seg.k)
          flush()
          continue
        }
        flush()
      }
      push(word, seg.k)
    }
  }
  if (line.length > 0 || lines.length === 0) flush()
  return lines
}

// ── Documents ──

const STYLE_KIND: Partial<Record<string, SegKind>> = { h1: 'h1', h2: 'h2', h3: 'h3', quote: 'quote', code: 'code', th: 'th' }

/** A row's own look, for its kept text. */
function rowLead(row: DocRow): Seg[] {
  if (row.style === 'li') return [{ t: `${'  '.repeat(row.indent ?? 0)}${row.marker ?? '•'} `, k: 'li' }]
  if (row.style === 'quote') return [{ t: '▎ ', k: 'quote' }]
  if (row.style === 'h2') return [{ t: '▍ ', k: 'h2' }]
  return []
}

const keptKind = (row: DocRow): SegKind => STYLE_KIND[row.style ?? ''] ?? (row.pic !== undefined ? 'pic' : 'n')

const pictureText = (row: DocRow) => (row.pic !== undefined ? `▣ ${row.text.replace(/^\[|\]$/g, '') || 'Picture'}` : row.text)

/** One document row as runs, kept, removed or added as a whole. */
function rowSegs(row: DocRow, as: 'n' | 'del' | 'add'): Seg[] {
  const text = pictureText(row)
  const lead = rowLead(row)
  if (as === 'n') return [...lead, { t: text === '' ? ' ' : text, k: keptKind(row) }]
  return [...lead.map(s => ({ ...s, k: as })), { t: text === '' ? ' ' : text, k: as }]
}

function pieceSegs(pieces: Piece[], side: 'both' | 'before' | 'after', base: SegKind): Seg[] {
  const out: Seg[] = []
  for (const p of pieces) {
    if (p.op === 0) out.push({ t: p.t, k: base })
    else if (p.op === -1 && side !== 'after') out.push({ t: p.t, k: 'del' })
    else if (p.op === 1 && side !== 'before') out.push({ t: p.t, k: 'add' })
  }
  return out.length > 0 ? out : [{ t: ' ' }]
}

const MARK: Record<'del' | 'add' | 'mod' | 'same', Seg> = {
  del: { t: '− ', k: 'mdel' },
  add: { t: '+ ', k: 'madd' },
  mod: { t: '~ ', k: 'mmod' },
  same: { t: '  ' },
}

const isQuiet = (row: DocRow | undefined) => !row || row.style === 'space' || (row.text.trim() === '' && row.pic === undefined)

/** The ops shown, with long runs of kept rows folded into one line unless opened. */
function foldRuns<T extends { kind: string }>(ops: T[], open: ReadonlySet<string>, prefix: string, isQuietOp: (op: T) => boolean = () => false): ({ op: T; at: number } | { fold: string; count: number; at: number })[] {
  const out: ({ op: T; at: number } | { fold: string; count: number; at: number })[] = []
  let k = 0
  const hasChanges = ops.some(o => o.kind !== 'same')
  while (k < ops.length) {
    if (ops[k]!.kind !== 'same') {
      out.push({ op: ops[k]!, at: k })
      k += 1
      continue
    }
    let end = k
    while (end < ops.length && ops[end]!.kind === 'same') end += 1
    const first = k === 0
    const last = end === ops.length
    const keepHead = first ? 0 : CONTEXT
    const keepTail = last ? 0 : CONTEXT
    const id = `${prefix}${k}`
    const hidden = end - k - keepHead - keepTail
    // Blank lines between paragraphs aren't counted as paragraphs.
    let count = 0
    for (let j = k + keepHead; j < end - keepTail; j += 1) if (!isQuietOp(ops[j]!)) count += 1
    if (!hasChanges || hidden < 3 || count < 2 || open.has(id)) {
      for (let j = k; j < end; j += 1) out.push({ op: ops[j]!, at: j })
    } else {
      for (let j = k; j < k + keepHead; j += 1) out.push({ op: ops[j]!, at: j })
      out.push({ fold: id, count, at: k + keepHead })
      for (let j = end - keepTail; j < end; j += 1) out.push({ op: ops[j]!, at: j })
    }
    k = end
  }
  return out
}

const plural = (n: number, one: string) => `${n.toLocaleString('en')} ${one}${n === 1 ? '' : 's'}`

function foldRow(id: string, count: number, unit: string, width: number): DRow {
  const text = `··· ${plural(count, `unchanged ${unit}`)} · click to show ···`
  return { segs: [{ t: pad(`  ${text}`, width), k: 'fold' }], fold: id }
}

export function layoutLines(cmp: LinesComparison, changes: Change[], opts: { width: number; mode: 'inline' | 'side'; open: ReadonlySet<string> }): Laid {
  const width = Math.max(20, opts.width)
  const rows: DRow[] = []
  const changeOfOp = new Map<number, number>()
  changes.forEach((c, i) => changeOfOp.set(c.op, i))
  const changeAt: number[] = changes.map(() => 0)
  // A run of added or removed rows is one change: each row of it carries that change.
  let current: number | undefined
  const shown = foldRuns(cmp.ops, opts.open, 'L', op => op.kind === 'same' && isQuiet(cmp.after[op.b]))
  for (const item of shown) {
    if ('fold' in item) {
      current = undefined
      rows.push(foldRow(item.fold, item.count, cmp.unit, width))
      continue
    }
    const { op, at } = item
    const starts = changeOfOp.get(at)
    if (starts !== undefined) {
      current = starts
      changeAt[starts] = rows.length
    } else if (op.kind === 'same' || op.kind === 'mod') current = undefined
    const change = op.kind === 'same' ? undefined : current
    if (opts.mode === 'inline') {
      let lines: Seg[][]
      if (op.kind === 'same') {
        const row = cmp.after[op.b]!
        lines = wrapSegs(rowSegs(row, 'n'), width, [MARK.same])
      } else if (op.kind === 'del') lines = wrapSegs(rowSegs(cmp.before[op.a]!, 'del'), width, [MARK.del])
      else if (op.kind === 'add') lines = wrapSegs(rowSegs(cmp.after[op.b]!, 'add'), width, [MARK.add])
      else {
        const row = cmp.after[op.b]!
        lines = wrapSegs([...rowLead(row), ...pieceSegs(op.pieces, 'both', keptKind(row))], width, [MARK.mod])
        if (op.restyled) lines.push([{ t: '  ' }, { t: `(${op.restyled})`, k: 'dim' }])
      }
      // A quiet blank line between paragraphs stays one line.
      if ((op.kind === 'same' && isQuiet(cmp.after[op.b])) || (op.kind === 'del' && isQuiet(cmp.before[op.a])) || (op.kind === 'add' && isQuiet(cmp.after[op.b]))) {
        if (op.kind === 'same' || rows[rows.length - 1]?.segs.every(s => s.t.trim() === '')) {
          rows.push({ segs: [{ t: ' ' }] })
          continue
        }
      }
      for (const segs of lines) rows.push({ segs, ...(change !== undefined ? { change } : {}) })
      continue
    }
    // Side by side: before on the left, after on the right, line for line.
    const half = Math.max(8, Math.floor((width - 3) / 2))
    let left: Seg[][]
    let right: Seg[][]
    if (op.kind === 'same') {
      left = wrapSegs(rowSegs(cmp.before[op.a]!, 'n'), half, [MARK.same])
      right = wrapSegs(rowSegs(cmp.after[op.b]!, 'n'), half, [MARK.same])
    } else if (op.kind === 'del') {
      left = wrapSegs(rowSegs(cmp.before[op.a]!, 'del'), half, [MARK.del])
      right = [[]]
    } else if (op.kind === 'add') {
      left = [[]]
      right = wrapSegs(rowSegs(cmp.after[op.b]!, 'add'), half, [MARK.add])
    } else {
      left = wrapSegs([...rowLead(cmp.before[op.a]!), ...pieceSegs(op.pieces, 'before', keptKind(cmp.before[op.a]!))], half, [MARK.mod])
      right = wrapSegs([...rowLead(cmp.after[op.b]!), ...pieceSegs(op.pieces, 'after', keptKind(cmp.after[op.b]!))], half, [MARK.mod])
    }
    const height = Math.max(left.length, right.length)
    for (let k = 0; k < height; k += 1) {
      const l = left[k] ?? []
      const used = l.reduce((n, s) => n + strWidth(s.t), 0)
      rows.push({ segs: [...l, { t: ' '.repeat(Math.max(0, half - used)) }, { t: ' │ ', k: 'sep' }, ...(right[k] ?? [])], ...(change !== undefined ? { change } : {}) })
    }
  }
  return { rows, changeAt }
}

// ── Spreadsheets ──

const EMPTY: GridCell = { v: '' }
const MAX_CELL = 22
const MIN_CELL = 3

type Col = { op: GridOp; letter: string; index: number }

/** The columns as shown: every column of either version, in order, each with its letter. */
function columnsOf(sheet: SheetComparison): Col[] {
  return sheet.cols.map((op, index) => ({ op, index, letter: letters((op.kind === 'del' ? op.a : op.b) + 1) }))
}

function cellOf(sheet: SheetComparison, side: 'a' | 'b', row: number | undefined, col: GridOp): GridCell {
  if (row === undefined) return EMPTY
  if (side === 'a') return col.kind === 'add' ? EMPTY : (sheet.before?.rows[row]?.[col.a] ?? EMPTY)
  return col.kind === 'del' ? EMPTY : (sheet.after?.rows[row]?.[col.b] ?? EMPTY)
}

/** A cell's look in a row: kept, removed, added, or changed (old struck through, then new). */
function cellSegs(sheet: SheetComparison, rowOp: GridOp, rowIndex: number, col: Col, side: 'both' | 'before' | 'after'): { segs: Seg[]; changed: boolean } {
  const a = 'a' in rowOp ? rowOp.a : undefined
  const b = 'b' in rowOp ? rowOp.b : undefined
  const before = cellOf(sheet, 'a', rowOp.kind === 'add' ? undefined : a, col.op)
  const after = cellOf(sheet, 'b', rowOp.kind === 'del' ? undefined : b, col.op)
  if (rowOp.kind === 'del' || col.op.kind === 'del') return { segs: side === 'after' ? [] : before.v ? [{ t: before.v, k: 'del' }] : [], changed: before.v !== '' }
  if (rowOp.kind === 'add' || col.op.kind === 'add') return { segs: side === 'before' ? [] : after.v ? [{ t: after.v, k: 'add' }] : [], changed: after.v !== '' }
  const change = sheet.cells.get(`${rowIndex}:${col.index}`)
  if (!change) {
    const shown = side === 'before' ? before : after
    return { segs: shown.v ? [{ t: shown.v, k: 'n' }] : [], changed: false }
  }
  if (!change.value) {
    // The value is the same but its formula changed: marked, so it isn't missed.
    const shown = side === 'before' ? before : after
    return { segs: [{ t: 'ƒ', k: 'mmod' }, { t: shown.v || ' ', k: 'n' }], changed: true }
  }
  if (side === 'before') return { segs: [{ t: before.v || '(empty)', k: 'del' }], changed: true }
  if (side === 'after') return { segs: [{ t: after.v || '(empty)', k: 'add' }], changed: true }
  return { segs: [...(before.v ? [{ t: before.v, k: 'del' as const }, { t: ' ' }] : []), { t: after.v || '(empty)', k: 'add' }], changed: true }
}

const segWidth = (segs: Seg[]) => segs.reduce((n, s) => n + strWidth(s.t), 0)

/** Cuts a cell's runs to `width`, the old value first, so the new one stays readable. */
function fitCell(segs: Seg[], width: number, isNumber: boolean): Seg[] {
  const total = segWidth(segs)
  if (total <= width) {
    const gap = { t: ' '.repeat(width - total) }
    return isNumber ? [gap, ...segs] : [...segs, gap]
  }
  const out = segs.map(s => ({ ...s }))
  let over = total - width
  for (const s of out) {
    if (over <= 0) break
    if (s.k !== 'del' && out.length > 1) continue
    const keep = Math.max(1, strWidth(s.t) - over - 1)
    const cut = `${cutTo(s.t, keep)}…`
    over -= strWidth(s.t) - strWidth(cut)
    s.t = cut
  }
  if (over > 0) {
    const flat: Seg[] = []
    let room = width
    for (const s of out) {
      if (room <= 0) break
      const t = strWidth(s.t) > room ? `${cutTo(s.t, Math.max(0, room - 1))}…` : s.t
      flat.push({ ...s, t })
      room -= strWidth(t)
    }
    return flat
  }
  return [...out, { t: ' '.repeat(Math.max(0, width - segWidth(out))) }]
}

export type GridLaid = Laid & { moreLeft: number; moreRight: number }

export function layoutGrid(sheet: SheetComparison, sheetIndex: number, changes: Change[], opts: { width: number; mode: 'inline' | 'side'; open: ReadonlySet<string>; left: number; picked: string | null }): GridLaid {
  const cols = columnsOf(sheet)
  const rowsShown = foldRuns(sheet.rows, opts.open, `G${sheetIndex}:`)
  const side = opts.mode === 'side'
  const lastRow = Math.max(sheet.before?.rows.length ?? 0, sheet.after?.rows.length ?? 0)
  const gutter = Math.max(3, String(lastRow).length)
  const lead = gutter + 3
  // Column widths from what they show, within limits.
  const widths = cols.map(col => {
    let w = Math.max(MIN_CELL, col.letter.length)
    for (const item of rowsShown.slice(0, 400)) {
      if ('fold' in item) continue
      const segs = side
        ? [cellSegs(sheet, item.op, item.at, col, 'before').segs, cellSegs(sheet, item.op, item.at, col, 'after').segs]
        : [cellSegs(sheet, item.op, item.at, col, 'both').segs]
      for (const s of segs) w = Math.max(w, segWidth(s))
    }
    return Math.min(side ? 14 : MAX_CELL, w)
  })
  const halfWidth = side ? Math.floor((opts.width - 3) / 2) : opts.width
  // As many columns as fit, from the first one in view.
  const left = Math.max(0, Math.min(opts.left, cols.length - 1))
  const shownCols: number[] = []
  let used = lead
  for (let c = left; c < cols.length; c += 1) {
    const need = (widths[c] ?? MIN_CELL) + 2
    if (used + need > halfWidth && shownCols.length > 0) break
    shownCols.push(c)
    used += need
  }
  const moreLeft = left
  const moreRight = Math.max(0, cols.length - left - shownCols.length)
  const changeAt: number[] = changes.map(() => 0)
  const rows: DRow[] = []
  // Column letters: a removed column's letter struck through, an added one's underlined.
  const header = (which: 'both' | 'before' | 'after'): { segs: Seg[]; cells: CellSpot[] } => {
    const segs: Seg[] = [{ t: pad(moreLeft > 0 ? `◀${moreLeft}` : '', gutter + 1), k: 'head' }, { t: '  ', k: 'head' }]
    for (const c of shownCols) {
      const col = cols[c]!
      const w = widths[c]!
      const isGone = col.op.kind === 'del'
      const isNew = col.op.kind === 'add'
      const hide = (which === 'after' && isGone) || (which === 'before' && isNew)
      const mark = hide ? '' : isGone ? '−' : isNew ? '+' : ''
      segs.push({ t: pad(hide ? '' : `${mark}${col.letter}`, w), k: hide ? 'head' : isGone ? 'del' : isNew ? 'add' : 'head' }, { t: '  ', k: 'head' })
    }
    return { segs, cells: [] }
  }
  const sheetChanges = changes.map((c, i) => ({ c, i })).filter(x => x.c.sheet === sheetIndex)
  for (const { c, i } of sheetChanges) if (c.op === 0 && c.col === undefined) changeAt[i] = 0
  if (side) {
    const l = header('before')
    const r = header('after')
    rows.push({ segs: [...l.segs.map(s => ({ ...s, t: s.t })), { t: ' '.repeat(Math.max(0, halfWidth - segWidth(l.segs))), k: 'head' }, { t: ' │ ', k: 'sep' }, ...r.segs] })
  } else rows.push({ segs: header('both').segs })
  for (const { c, i } of sheetChanges) if (c.col !== undefined && sheet.cols[c.col]?.kind !== 'same') changeAt[i] = 0
  const changeOfCell = new Map<string, number>()
  const cellChangesOfRow = new Map<number, number[]>()
  const changeOfRow = new Map<number, number>()
  for (const { c, i } of sheetChanges) {
    if (c.col !== undefined && sheet.cols[c.col]?.kind === 'same') {
      changeOfCell.set(`${c.op}:${c.col}`, i)
      cellChangesOfRow.set(c.op, [...(cellChangesOfRow.get(c.op) ?? []), i])
    }
    else if (c.col === undefined && (sheet.rows[c.op]?.kind === 'add' || sheet.rows[c.op]?.kind === 'del')) changeOfRow.set(c.op, i)
  }
  let runChange: number | undefined
  for (const item of rowsShown) {
    if ('fold' in item) {
      runChange = undefined
      rows.push(foldRow(item.fold, item.count, 'row', Math.min(opts.width, used + (side ? halfWidth + 3 : 0))))
      continue
    }
    const { op, at } = item
    if (changeOfRow.has(at)) runChange = changeOfRow.get(at)
    else if (op.kind !== 'add' && op.kind !== 'del') runChange = undefined
    const drawSide = (which: 'both' | 'before' | 'after'): { segs: Seg[]; cells: CellSpot[]; change?: number } => {
      const number = which === 'before' ? (op.kind === 'add' ? '' : op.a + 1) : op.kind === 'del' ? op.a + 1 : op.b + 1
      const showNumber = (which === 'before' && op.kind === 'add') || (which === 'after' && op.kind === 'del') ? '' : String(number)
      const mark = op.kind === 'del' ? MARK.del : op.kind === 'add' ? MARK.add : op.kind === 'mod' ? MARK.mod : MARK.same
      const segs: Seg[] = [{ t: showNumber.padStart(gutter), k: 'num' }, { t: ' ' }, mark]
      const cells: CellSpot[] = []
      let x = lead
      let change: number | undefined = op.kind === 'add' || op.kind === 'del' ? runChange : undefined
      for (const ci of shownCols) {
        const col = cols[ci]!
        const w = widths[ci]!
        const hide = (which === 'after' && (op.kind === 'del' || col.op.kind === 'del')) || (which === 'before' && (op.kind === 'add' || col.op.kind === 'add'))
        const { segs: cs } = hide ? { segs: [] } : cellSegs(sheet, op, at, col, which)
        const value = op.kind !== 'del' && col.op.kind !== 'del' ? sheet.after?.rows[op.b]?.[col.op.b]?.x : undefined
        const key = `${at}:${ci}`
        const isPicked = opts.picked === key
        const fitted = fitCell(cs, w, value !== undefined && cs.length === 1 && cs[0]?.k === 'n')
        segs.push(...(isPicked ? fitted.map(s => ({ ...s, k: 'sel' as const })) : fitted), { t: '  ' })
        cells.push({ x, w, key })
        x += w + 2
      }
      // Changed cells off to the side still belong to this line.
      for (const own of cellChangesOfRow.get(at) ?? []) {
        changeAt[own] = rows.length
        change ??= own
      }
      return { segs, cells, ...(change !== undefined ? { change } : {}) }
    }
    if (runChange !== undefined && changeOfRow.get(at) === runChange) changeAt[runChange] = rows.length
    if (side) {
      const l = drawSide('before')
      const r = drawSide('after')
      const lw = segWidth(l.segs)
      const change = l.change ?? r.change
      rows.push({
        segs: [...l.segs, { t: ' '.repeat(Math.max(0, halfWidth - lw)) }, { t: ' │ ', k: 'sep' }, ...r.segs],
        cells: [...l.cells, ...r.cells.map(c => ({ ...c, x: c.x + Math.max(halfWidth, lw) + 3 }))],
        ...(change !== undefined ? { change } : {}),
      })
    } else {
      const one = drawSide('both')
      rows.push({ segs: one.segs, cells: one.cells, ...(one.change !== undefined ? { change: one.change } : {}) })
    }
  }
  return { rows, changeAt, moreLeft, moreRight }
}

/** The display column a change's cell is in, so the view can scroll sideways to it. */
export function columnOf(change: Change): number | undefined {
  return change.col
}
