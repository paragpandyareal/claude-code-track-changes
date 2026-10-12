// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Claude Code Track Changes: https://github.com/paragpandyareal/claude-code-track-changes
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel
import { expect, test } from 'claude-code/testing'

import { Disk, claudeTurn, indexOf, mount, start } from './disk'
import { docx, xlsx } from './office'

type Index = {
  files: Record<string, { family: string }>
  families: Record<string, { name: string; versions: string[]; paths: string[]; home: string }>
  versions: Record<string, { path: string; key: string | null; by: string; note?: string; family: string }>
  turns: { status: string; by: string; changes: { family: string; before: string | null; after: string }[] }[]
  asks: { path: string; guess: { path: string } }[]
  skipped: { path: string; reason: string }[]
}

const budget = (rows: (string | number)[][]) => xlsx([{ name: 'Budget', rows: [['Item', 'Q1', 'Q2'], ...rows] }, { name: 'Assumptions', rows: [['Inflation', '3%']] }])
const BUDGET = budget([['Rent', 12000, 12000], ['Salaries', 48000, 48000], ['Marketing', 8000, 9500]])
const BUDGET_V2 = budget([['Rent', 12000, 12000], ['Insurance', 1800, 1800], ['Salaries', 48000, 48000], ['Marketing', 8000, 6000]])

const famOf = (idx: Index, path: string) => idx.families[idx.files[path]?.family ?? '']
const versionsOf = (idx: Index, path: string) => (famOf(idx, path)?.versions ?? []).map(id => idx.versions[id]!)

test('a first look records what is there and shows nothing', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/plan.md', '# Plan\n\nShip it.\n')
  disk.put('/w/budget.xlsx', BUDGET)
  mount(on, disk)
  await start($)
  const idx = indexOf(disk) as Index
  expect(Object.keys(idx.files).sort()).toEqual(['/w/budget.xlsx', '/w/plan.md'])
  expect(idx.turns).toHaveLength(0)
  expect(versionsOf(idx, '/w/plan.md').map(v => v.by)).toEqual(['first'])
})

test('versions are kept in the plugin’s own folder, never in the project', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/plan.md', '# Plan\n')
  mount(on, disk)
  await start($)
  await claudeTurn($, () => disk.put('/w/plan.md', '# Plan v2\n'))
  const written = [...disk.files.keys()].filter(p => !['/w/plan.md'].includes(p))
  expect(written.every(p => p.startsWith('/home/u/.claude/track-changes/'))).toBe(true)
})

test('an edit in place becomes the next version of that file, shown as Claude’s', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/plan.md', '# Plan\n\nBeta on 3 November.\n')
  mount(on, disk)
  await start($)
  await claudeTurn($, () => disk.put('/w/plan.md', '# Plan\n\nBeta on 10 November.\n'))
  const idx = indexOf(disk) as Index
  const vs = versionsOf(idx, '/w/plan.md')
  expect(vs.map(v => v.by)).toEqual(['first', 'claude'])
  expect(idx.turns).toHaveLength(1)
  expect(idx.turns[0]!.changes).toEqual([{ family: vs[0]!.family, before: famOf(idx, '/w/plan.md')!.versions[0], after: famOf(idx, '/w/plan.md')!.versions[1] }])
})

test('a new file saved instead of editing (budget_v2.xlsx) joins the budget’s family', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/budget.xlsx', BUDGET)
  mount(on, disk)
  await start($)
  await claudeTurn($, () => disk.put('/w/budget_v2.xlsx', BUDGET_V2))
  const idx = indexOf(disk) as Index
  expect(idx.files['/w/budget_v2.xlsx']?.family).toBe(idx.files['/w/budget.xlsx']?.family)
  const fam = famOf(idx, '/w/budget.xlsx')!
  expect(fam.name).toBe('budget.xlsx')
  expect(fam.versions.map(id => idx.versions[id]!.path)).toEqual(['/w/budget.xlsx', '/w/budget_v2.xlsx'])
  // The change runs from the budget before the turn to the new file.
  const change = idx.turns[0]!.changes[0]!
  expect(idx.versions[change.before!]!.path).toBe('/w/budget.xlsx')
  expect(idx.versions[change.after]!.path).toBe('/w/budget_v2.xlsx')
})

test('Claude edits the original and saves a copy: both are in the timeline, in order', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/report.docx', docx([{ p: 'Report', style: 'Title' }, { p: 'Calls fell by 9%.' }]))
  mount(on, disk)
  await start($)
  await claudeTurn($, () => {
    disk.put('/w/report.docx', docx([{ p: 'Report', style: 'Title' }, { p: 'Calls fell by 10%.' }]))
    disk.put('/w/report_final.docx', docx([{ p: 'Report', style: 'Title' }, { p: 'Calls fell by 12%.' }]))
  })
  const idx = indexOf(disk) as Index
  const vs = versionsOf(idx, '/w/report.docx')
  expect(vs.map(v => `${v.by}:${v.path}`)).toEqual(['first:/w/report.docx', 'claude:/w/report.docx', 'claude:/w/report_final.docx'])
  expect(idx.turns[0]!.changes).toHaveLength(1)
  expect(idx.versions[idx.turns[0]!.changes[0]!.after]!.path).toBe('/w/report_final.docx')
})

test('a deleted document is a version with nothing in it, and its family remembers it', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/notes.txt', 'one\ntwo\n')
  mount(on, disk)
  await start($)
  await claudeTurn($, () => disk.remove('/w/notes.txt'))
  const idx = indexOf(disk) as Index
  const fam = Object.values(idx.families)[0]!
  expect(fam.versions.map(id => idx.versions[id]!.key === null)).toEqual([false, true])
  expect(idx.files['/w/notes.txt']).toBeUndefined()
  expect(idx.turns[0]!.changes).toHaveLength(1)
})

test('a file renamed or moved stays in its family', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/plan.md', '# Plan\n\nThe plan.\n')
  mount(on, disk)
  await start($)
  await claudeTurn($, () => disk.move('/w/plan.md', '/w/docs/launch plan.md'))
  const idx = indexOf(disk) as Index
  expect(Object.keys(idx.families)).toHaveLength(1)
  const vs = versionsOf(idx, '/w/docs/launch plan.md')
  expect(vs.map(v => v.path)).toEqual(['/w/plan.md', '/w/docs/launch plan.md'])
  expect(vs[1]!.note).toBe('moved from plan.md')
  expect(famOf(idx, '/w/docs/launch plan.md')!.home).toBe('/w/docs/launch plan.md')
})

test('your own edits between turns are yours: Claude’s changes start from your version', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/plan.md', 'v1\n')
  mount(on, disk)
  await start($)
  await claudeTurn($, () => disk.put('/w/plan.md', 'v2 by Claude\n'))
  disk.put('/w/plan.md', 'v3 by you\n')
  await claudeTurn($, () => disk.put('/w/plan.md', 'v4 by Claude\n'))
  const idx = indexOf(disk) as Index
  const vs = versionsOf(idx, '/w/plan.md')
  expect(vs.map(v => v.by)).toEqual(['first', 'claude', 'you', 'claude'])
  const last = idx.turns[idx.turns.length - 1]!.changes[0]!
  expect(idx.versions[last.before!]!.by).toBe('you')
})

test('an unsure match is asked once; the answer joins the family and is remembered', async ($, on) => {
  const disk = new Disk()
  const logs: string[] = []
  disk.put('/w/budget.xlsx', BUDGET)
  mount(on, disk, { onLog: text => logs.push(text) })
  await start($)
  await claudeTurn($, () => disk.put('/w/board pack.xlsx', BUDGET_V2))
  let idx = indexOf(disk) as Index
  expect(idx.asks).toHaveLength(1)
  expect(idx.asks[0]!.path).toBe('/w/board pack.xlsx')
  expect(idx.asks[0]!.guess.path).toBe('/w/budget.xlsx')
  expect(logs.some(l => l.includes('Is board pack.xlsx a new version of budget.xlsx?'))).toBe(true)
  // Until answered, it is a document of its own.
  expect(idx.files['/w/board pack.xlsx']?.family).not.toBe(idx.files['/w/budget.xlsx']?.family)
})

test('a brand new document with no parent is a new family, all added', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/budget.xlsx', BUDGET)
  mount(on, disk)
  await start($)
  await claudeTurn($, () => disk.put('/w/minutes.md', '# Minutes\n\nAttendees: Sam, Lee.\n'))
  const idx = indexOf(disk) as Index
  expect(idx.asks).toHaveLength(0)
  const change = idx.turns[0]!.changes[0]!
  expect(change.before).toBeNull()
  expect(idx.versions[change.after]!.path).toBe('/w/minutes.md')
})

test('a turn stopped partway is still noted, and says so', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/plan.md', 'one\n')
  mount(on, disk)
  await start($)
  await claudeTurn($, () => disk.put('/w/plan.md', 'two\n'), 'aborted')
  const idx = indexOf(disk) as Index
  expect(idx.turns[0]!.status).toBe('stopped')
  expect(versionsOf(idx, '/w/plan.md')[1]!.note).toBe('stopped partway')
})

test('a file deleted and made again in one turn is an edit in place', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/plan.md', 'one\n')
  mount(on, disk)
  await start($)
  await claudeTurn($, () => {
    disk.remove('/w/plan.md')
    disk.put('/w/plan.md', 'two\n')
  })
  const idx = indexOf(disk) as Index
  expect(versionsOf(idx, '/w/plan.md').map(v => v.by)).toEqual(['first', 'claude'])
})

test('many documents in one turn are one turn with a change for each', async ($, on) => {
  const disk = new Disk()
  for (let k = 0; k < 8; k += 1) disk.put(`/w/note-${k}.txt`, `note ${k}\n`)
  mount(on, disk)
  await start($)
  await claudeTurn($, () => {
    for (let k = 0; k < 8; k += 1) disk.put(`/w/note-${k}.txt`, `note ${k}, edited\n`)
  })
  expect((indexOf(disk) as Index).turns[0]!.changes).toHaveLength(8)
})

test('a subagent finishing does not end Claude’s turn', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/plan.md', 'one\n')
  mount(on, disk)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  disk.put('/w/plan.md', 'two\n')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', agentId: 'agent-1', reason: 'answer' } as never)
  expect((indexOf(disk) as Index).turns).toHaveLength(0)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  expect((indexOf(disk) as Index).turns).toHaveLength(1)
})

test('a file held open by another app is skipped, said plainly, and caught next time', async ($, on) => {
  const disk = new Disk()
  const logs: string[] = []
  disk.put('/w/budget.xlsx', BUDGET)
  mount(on, disk, { onLog: text => logs.push(text) })
  await start($)
  await claudeTurn($, () => {
    disk.put('/w/budget.xlsx', BUDGET_V2)
    disk.locked.add('/w/budget.xlsx')
  })
  let idx = indexOf(disk) as Index
  expect(idx.skipped[0]?.reason).toContain('open in another app such as Excel')
  expect(logs.some(l => l.includes('Couldn’t keep a copy of budget.xlsx'))).toBe(true)
  disk.locked.clear()
  await claudeTurn($, () => undefined)
  idx = indexOf(disk) as Index
  expect(versionsOf(idx, '/w/budget.xlsx').length).toBe(2)
})

test('a document over 4 MB without Python is skipped with the reason', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/huge.csv', 'a\n')
  mount(on, disk)
  await start($)
  await claudeTurn($, () => disk.put('/w/huge.csv', 'x'.repeat(5 * 1024 * 1024)))
  const idx = indexOf(disk) as Index
  expect(idx.skipped[0]?.reason).toContain('Python 3')
})

test('links, hidden folders, node_modules and Older versions are never looked in; other file types are ignored', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/plan.md', 'one\n')
  disk.put('/w/.git/notes.md', 'x\n')
  disk.put('/w/node_modules/readme.md', 'x\n')
  disk.put('/w/Older versions/plan.md', 'x\n')
  disk.put('/w/linked/outside.md', 'x\n')
  disk.links.add('/w/linked')
  disk.put('/w/script.py', 'print(1)\n')
  disk.put('/w/a/b/c/d/deep.md', 'too deep\n')
  mount(on, disk)
  await start($)
  expect(Object.keys((indexOf(disk) as Index).files)).toEqual(['/w/plan.md'])
})

test('a home folder or a drive root is never watched', async ($, on) => {
  const disk = new Disk()
  disk.put('/home/u/plan.md', 'one\n')
  mount(on, disk)
  await start($, '/home/u')
  expect(indexOf(disk)).toBeUndefined()
})

test('only so many versions are kept; the rest are let go and their space freed', async ($, on) => {
  const disk = new Disk()
  disk.put('/w/plan.md', 'v0\n')
  mount(on, disk, { store: { settings: { notices: true, autoOpen: false, tell: 'next', keepVersions: 3, keepDays: 7 } } })
  await start($)
  for (let k = 1; k <= 6; k += 1) await claudeTurn($, () => disk.put('/w/plan.md', `v${k}\n`))
  const idx = indexOf(disk) as Index
  expect(versionsOf(idx, '/w/plan.md')).toHaveLength(3)
  const emptied = [...disk.files.entries()].filter(([p, f]) => p.includes('/store/') && f.bytes.length === 0)
  expect(emptied.length).toBeGreaterThan(0)
})
