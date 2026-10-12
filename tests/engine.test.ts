// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Claude Code Track Changes: https://github.com/paragpandyareal/claude-code-track-changes
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel
import { expect, test } from 'claude-code/testing'

import type { DocRow, GridCell, GridSheet } from '../types'
import { changesOf, compareGrids, compareLines, editScript, summaryOf, wordPieces } from '../hooks/compare'
import { readCsv } from '../hooks/csv'
import { matchParent, nameScore, stemOf } from '../hooks/family'
import { layoutGrid, layoutLines, wrapSegs } from '../hooks/layout'
import { strWidth } from '../hooks/text'

const p = (text: string, style: DocRow['style'] = 'p'): DocRow => ({ text, anchor: '', style })
const cell = (v: string | number, f?: string): GridCell => (typeof v === 'number' ? { v: v.toLocaleString('en'), x: v, ...(f ? { f } : {}) } : { v, ...(f ? { f } : {}) })
const sheet = (name: string, rows: (string | number | GridCell)[][]): GridSheet => ({
  name,
  cols: Array.from({ length: Math.max(...rows.map(r => r.length)) }, (_, k) => String.fromCharCode(65 + k)),
  rows: rows.map(r => r.map(c => (typeof c === 'object' ? c : cell(c)))),
})

// ── Sequences and words ──

test('the edit script keeps what is shared and finds the smallest change', () => {
  const steps = editScript(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])
  expect(steps.filter(s => s.op === '=').length).toBe(3)
  expect(steps.filter(s => s.op === '-').length).toBe(1)
  expect(steps.filter(s => s.op === '+').length).toBe(2)
})

test('words inside a changed paragraph: removed, then added, with what stayed between', () => {
  const pieces = wordPieces('Calls fell by 9% this quarter.', 'Calls fell by 12% this quarter.')
  expect(pieces).toEqual([
    { t: 'Calls fell by ', op: 0 },
    { t: '9%', op: -1 },
    { t: '12%', op: 1 },
    { t: ' this quarter.', op: 0 },
  ])
})

test('two words replaced side by side read as one replacement, not four', () => {
  const pieces = wordPieces('the red fox ran', 'the blue cat ran')
  expect(pieces.filter(x => x.op !== 0)).toEqual([
    { t: 'red fox', op: -1 },
    { t: 'blue cat', op: 1 },
  ])
})

// ── Documents ──

test('documents: paragraphs first, words inside a changed one; added and removed paragraphs stay whole', () => {
  const before = [p('Overview', 'h2'), p('Calls fell by 9%.'), p('Billing went live.'), p('Review the lease.', 'li')]
  const after = [p('Summary', 'h2'), p('Calls fell by 12%.'), p('Billing went live.'), p('Contracts were renewed.'), p('Hire two staff.', 'li')]
  const cmp = compareLines(before, after, true)
  const kinds = cmp.ops.map(o => o.kind)
  expect(kinds[0]).toBe('mod')
  expect(kinds[1]).toBe('mod')
  expect(kinds[2]).toBe('same')
  expect(cmp.counts.changed).toBe(2)
  // "Review the lease." went, two new paragraphs came: not paired with something unalike.
  expect(cmp.counts.added).toBe(2)
  expect(cmp.counts.removed).toBe(1)
  const changes = changesOf(cmp)
  expect(changes.map(c => c.kind)).toEqual(['changed', 'changed', 'removed', 'added'])
  expect(summaryOf(cmp, changes)).toBe('4 changes · 2 paragraphs changed · 2 paragraphs added · 1 paragraph removed')
})

test('a paragraph turned into a heading says so, even with the same words', () => {
  const cmp = compareLines([p('Next steps')], [p('Next steps', 'h2')], true)
  const op = cmp.ops[0]!
  expect(op.kind).toBe('mod')
  expect(op.kind === 'mod' && op.restyled).toBe('now a heading')
})

test('a brand new document is all added; a deleted one all removed', () => {
  const added = compareLines([], [p('One'), p('Two')], true)
  expect(changesOf(added)).toEqual([{ op: 0, kind: 'added', label: 'Added: 2 paragraphs' }])
  const removed = compareLines([p('One')], [], true)
  expect(changesOf(removed)[0]?.label).toBe('Removed: “One”')
})

test('pictures added and removed are their own rows', () => {
  const pic = (label: string): DocRow => ({ text: `[Picture: ${label}]`, anchor: '', style: 'p', pic: 0 })
  const cmp = compareLines([p('Text'), pic('old chart')], [p('Text'), pic('new map')], true)
  expect(cmp.counts.pictures).toEqual({ added: 1, removed: 1 })
})

// ── Spreadsheets ──

test('a row added near the top does not make every row below look changed', () => {
  const rows = Array.from({ length: 40 }, (_, k) => [`Item ${k}`, k * 10])
  const before = sheet('Budget', [['Item', 'Cost'], ...rows])
  const after = sheet('Budget', [['Item', 'Cost'], ['New item', 5], ...rows])
  const cmp = compareGrids([before], [after])
  const s = cmp.sheets[0]!
  expect(s.counts.rowsAdded).toBe(1)
  expect(s.counts.cells).toBe(0)
  expect(s.rows.filter(r => r.kind === 'mod')).toHaveLength(0)
  expect(summaryOf(cmp, changesOf(cmp))).toBe('1 change · 1 row added')
})

test('a column inserted is one column added, not every cell changed', () => {
  const before = sheet('S', [['Item', 'Q1', 'Q2'], ['Rent', 10, 20], ['Pay', 30, 40]])
  const after = sheet('S', [['Item', 'Region', 'Q1', 'Q2'], ['Rent', 'North', 10, 20], ['Pay', 'South', 30, 40]])
  const s = compareGrids([before], [after]).sheets[0]!
  expect(s.counts.colsAdded).toBe(1)
  expect(s.counts.cells).toBe(0)
})

test('changed cells keep the old and new value; a formula change counts even when the value is the same', () => {
  const before = sheet('S', [['Item', 'Cost', 'Total'], ['Rent', 100, cell(300, '=B2*3')], ['Pay', 50, cell(150, '=B3*3')]])
  const after = sheet('S', [['Item', 'Cost', 'Total'], ['Rent', 120, cell(360, '=B2*3')], ['Pay', 50, cell(150, '=SUM(B3,B3,B3)')]])
  const cmp = compareGrids([before], [after])
  const s = cmp.sheets[0]!
  expect(s.counts.cells).toBe(3)
  expect(s.counts.formulas).toBe(1)
  const labels = changesOf(cmp).map(c => c.label)
  expect(labels).toHaveLength(3)
  expect(labels).toContain('B2: 100 → 120')
  expect(labels).toContain('C2: 300 → 360')
  expect(labels).toContain('C3: formula changed')
})

test('sheets added, removed and renamed', () => {
  const data = [['Assumption', 'Value'], ['Inflation', '3%'], ['Headcount', 6]] as (string | number)[][]
  const before = [sheet('Budget', [['A']]), sheet('Assumptions', data), sheet('Notes', [['Note'], ['Old']])]
  const after = [sheet('Budget', [['A']]), sheet('Inputs', data), sheet('Forecast', [['Q4', 75000]])]
  const cmp = compareGrids(before, after)
  const status = cmp.sheets.map(s => `${s.name}:${s.status}`)
  expect(status).toEqual(['Budget:same', 'Inputs:renamed', 'Notes:removed', 'Forecast:added'])
  expect(cmp.sheets[1]?.was).toBe('Assumptions')
  expect(summaryOf(cmp, changesOf(cmp))).toBe('3 changes · 1 sheet added · 1 sheet removed · 1 sheet renamed')
})

test('merged cells added and removed are changes', () => {
  const before = { ...sheet('S', [['Title', '', '']]), merges: ['A1:B1'] }
  const after = { ...sheet('S', [['Title', '', '']]), merges: ['A1:C1'] }
  const labels = changesOf(compareGrids([before], [after])).map(c => c.label)
  expect(labels).toEqual(['S: cells A1:C1 merged', 'S: cells A1:B1 unmerged'])
})

test('a big sheet compares quickly: 5,000 rows, one changed', () => {
  const rows = Array.from({ length: 5000 }, (_, k) => [`Row ${k}`, k, k * 2])
  const before = sheet('Big', rows)
  const changed = rows.map(r => [...r])
  changed[2500]![1] = 999999
  const started = Date.now()
  const s = compareGrids([before], [sheet('Big', changed)]).sheets[0]!
  expect(s.counts.cells).toBe(1)
  expect(Date.now() - started).toBeLessThan(3000)
})

// ── CSV ──

test('CSV: quoted fields, a delimiter and a new line inside quotes, doubled quotes', () => {
  const { sheet: s } = readCsv('name,note\n"Smith, J","said ""hi""\nthen left"\nLee,ok\n')
  expect(s.rows.map(r => r.map(c => c.v))).toEqual([
    ['name', 'note'],
    ['Smith, J', 'said "hi"\nthen left'],
    ['Lee', 'ok'],
  ])
})

test('CSV compares like a table: a row inserted, a value changed', () => {
  const a = readCsv('site,kwh\nNorth,1520\nHarbour,880\nWest,2310\n').sheet
  const b = readCsv('site,kwh\nNorth,1520\nAirport,410\nHarbour,905\nWest,2310\n').sheet
  const cmp = compareGrids([a], [b])
  expect(summaryOf(cmp, changesOf(cmp))).toBe('2 changes · 1 cell · 1 row added')
})

test('semicolon CSVs and TSVs are read with their own delimiter', () => {
  expect(readCsv('a;b\n1;2\n').sheet.rows[1]?.map(c => c.v)).toEqual(['1', '2'])
  expect(readCsv('a\tb\n1\t2\n', 'tsv').sheet.rows[1]?.map(c => c.v)).toEqual(['1', '2'])
})

// ── Families ──

test('copy names come back to one stem: v2, final, updated, (1), dates, copy of', () => {
  for (const name of ['budget.xlsx', 'budget_v2.xlsx', 'Budget_FINAL.xlsx', 'budget-updated.xlsx', 'budget (1).xlsx', 'budget_2026-10-11.xlsx', 'Copy of budget.xlsx', 'budget v3 final.xlsx', 'budget_revised_v2.xlsx']) {
    expect(stemOf(`/w/${name}`)).toBe('budget')
  }
  expect(stemOf('/w/q3 board report.docx')).toBe('q3 board report')
})

test('name scores: same stem 1, a name inside another fairly close, others low', () => {
  expect(nameScore('/w/report.docx', '/w/report_final.docx')).toBe(1)
  expect(nameScore('/w/report.docx', '/w/report for board.docx')).toBe(0.75)
  expect(nameScore('/w/report.docx', '/w/invoice.docx')).toBeLessThan(0.5)
})

test('a new file joins the document it came from when sure, asks when not, and starts one otherwise', () => {
  const fp = ['budget', 'rent', 'salaries', 'marketing']
  const sure = matchParent('/w/budget_v2.xlsx', fp, [{ family: 'f1', path: '/w/budget.xlsx', fingerprint: fp }, { family: 'f2', path: '/w/invoice.xlsx', fingerprint: ['invoice'] }])
  expect(sure.verdict).toBe('sure')
  expect(sure.best?.family).toBe('f1')
  // A renamed copy with the same content in the same folder: likely, so asked.
  const unsure = matchParent('/w/board pack.xlsx', fp, [{ family: 'f1', path: '/w/budget.xlsx', fingerprint: fp }])
  expect(unsure.verdict).toBe('unsure')
  const none = matchParent('/w/minutes.xlsx', ['minutes', 'attendees'], [{ family: 'f1', path: '/w/budget.xlsx', fingerprint: fp }])
  expect(none.verdict).toBe('none')
  // Never across kinds: a Word file is not a version of a workbook.
  expect(matchParent('/w/budget.docx', fp, [{ family: 'f1', path: '/w/budget.xlsx', fingerprint: fp }]).verdict).toBe('none')
})

test('the same name in the same folder is enough even when the file can’t be read', () => {
  expect(matchParent('/w/report_final.docx', [], [{ family: 'f1', path: '/w/report.docx', fingerprint: [] }]).verdict).toBe('sure')
})

// ── Layout ──

test('every change has a mark as well as a colour: − removed, + added, ~ changed', () => {
  const cmp = compareLines([p('Keep'), p('Calls fell by 9%.'), p('Gone')], [p('Keep'), p('Calls fell by 12%.'), p('New one')], true)
  const laid = layoutLines(cmp, changesOf(cmp), { width: 60, mode: 'inline', open: new Set() })
  expect(laid.rows.some(r => r.segs.some(s => s.k === 'del' && s.t.includes('9%')))).toBe(true)
  expect(laid.rows.some(r => r.segs.some(s => s.k === 'add' && s.t.includes('12%')))).toBe(true)
  expect(laid.rows.some(r => r.segs[0]?.t === '~ ')).toBe(true)
})

test('long runs of unchanged paragraphs fold into one line that opens on click', () => {
  const same = Array.from({ length: 40 }, (_, k) => p(`Para ${k}`))
  const cmp = compareLines([...same, p('Old end')], [...same, p('New end')], true)
  const closed = layoutLines(cmp, changesOf(cmp), { width: 60, mode: 'inline', open: new Set() })
  const fold = closed.rows.find(r => r.fold)
  expect(fold?.segs[0]?.t).toContain('38 unchanged paragraphs')
  const opened = layoutLines(cmp, changesOf(cmp), { width: 60, mode: 'inline', open: new Set([fold!.fold!]) })
  expect(opened.rows.some(r => r.fold)).toBe(false)
})

test('no line is ever wider than the pane, inline or side by side, at any width', () => {
  const long = 'A sentence that is long enough to need wrapping in a narrow pane, with more words after it.'
  const cmp = compareLines([p(long), p('Short')], [p(`${long} Added words.`), p('Short')], true)
  for (const width of [30, 45, 80, 140]) {
    for (const mode of ['inline', 'side'] as const) {
      const laid = layoutLines(cmp, changesOf(cmp), { width, mode, open: new Set() })
      for (const row of laid.rows) expect(strWidth(row.segs.map(s => s.t).join(''))).toBeLessThanOrEqual(width)
    }
  }
})

test('grids: inline a changed cell shows its new value, side by side the old one struck; cells line up, removed rows marked', () => {
  const before = sheet('S', [['Item', 'Cost'], ['Rent', 100], ['Pay', 50], ['Gone', 1]])
  const after = sheet('S', [['Item', 'Cost'], ['Rent', 120], ['Pay', 50]])
  const cmp = compareGrids([before], [after])
  for (const width of [40, 80, 160]) {
    for (const mode of ['inline', 'side'] as const) {
      const laid = layoutGrid(cmp.sheets[0]!, 0, changesOf(cmp), { width, mode, open: new Set(), left: 0, picked: null })
      for (const row of laid.rows) expect(strWidth(row.segs.map(s => s.t).join(''))).toBeLessThanOrEqual(width)
      const rent = laid.rows.find(r => r.segs.some(s => s.t.includes('120')))!
      expect(rent.segs.some(s => s.k === 'add' && s.t.includes('120'))).toBe(true)
      expect(rent.segs.some(s => s.k === 'del' && s.t.includes('100'))).toBe(mode === 'side')
      expect(laid.rows.some(r => r.segs.some(s => s.k === 'mdel'))).toBe(true)
    }
  }
})

test('wrapping keeps a lead on the first line and spaces under it after', () => {
  const lines = wrapSegs([{ t: 'one two three four five six' }], 12, [{ t: '+ ', k: 'madd' }])
  expect(lines.length).toBeGreaterThan(1)
  expect(lines[0]?.[0]?.t).toBe('+ ')
  expect(lines[1]?.[0]?.t).toBe('  ')
})

test('a row inserted above formulas does not make them look changed: they are compared by their shape', async () => {
  const before = sheet('S', [['Item', 'Q1', 'Q2', 'Total'], ['Rent', 10, 20, cell(30, '=SUM(B2:C2)')], ['Pay', 5, 5, cell(10, '=SUM(B3:C3)')], ['Total', cell(15, '=SUM(B2:B3)'), cell(25, '=SUM(C2:C3)'), cell(40, '=SUM(D2:D3)')]])
  const after = sheet('S', [['Item', 'Q1', 'Q2', 'Total'], ['Rent', 10, 20, cell(30, '=SUM(B2:C2)')], ['Cover', 1, 1, cell(2, '=SUM(B3:C3)')], ['Pay', 5, 5, cell(10, '=SUM(B4:C4)')], ['Total', cell(16, '=SUM(B2:B4)'), cell(26, '=SUM(C2:C4)'), cell(42, '=SUM(D2:D4)')]])
  const s = compareGrids([before], [after]).sheets[0]!
  expect(s.counts.rowsAdded).toBe(1)
  expect(s.counts.colsAdded + s.counts.colsRemoved).toBe(0)
  // Only the totals row changed: its sums now take in the new row.
  expect(s.counts.cells).toBe(3)
})
