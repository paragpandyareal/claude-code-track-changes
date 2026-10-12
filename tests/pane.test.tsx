// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Claude Code Track Changes: https://github.com/paragpandyareal/claude-code-track-changes
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel
import { expect, test } from 'claude-code/testing'

import { Disk, PANE, claudeTurn, mount, start } from './disk'
import type { Engine, On } from './disk'
import { base64, docx, pdf, xlsx } from './office'

const budget = (rows: (string | number)[][], extra: { name: string; rows: (string | number)[][] }[] = []) => xlsx([{ name: 'Budget', rows: [['Item', 'Q1', 'Q2'], ...rows] }, ...extra])
const BUDGET = budget([['Rent', 12000, 12000], ['Salaries', 48000, 48000], ['Marketing', 8000, 9500]], [{ name: 'Notes', rows: [['Note'], ['Review in Q2']] }])
const BUDGET_V2 = budget([['Rent', 12000, 12000], ['Insurance', 1800, 1800], ['Salaries', 48000, 48000], ['Marketing', 8000, 6000]])

async function setUp($: Engine, on: On, files: Record<string, string | Uint8Array>, options: Parameters<typeof mount>[2] = {}) {
  const disk = new Disk()
  for (const [path, content] of Object.entries(files)) disk.put(path, content)
  mount(on, disk, options)
  await start($)
  return disk
}

const draw = ($: Engine, columns = 100, rows = 34) =>
  $.ui.mount({ plugin: 'track-changes', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: columns, scroll: { offset: 0, bodyRows: rows } } })

/** All the text a drawing shows, in the plugin's tree and in its views. */
async function shown(ui: Awaited<ReturnType<typeof draw>>): Promise<string> {
  const parts = [...(await ui.findAll({ type: 'Text' })).map(t => t.text), ...(await ui.findAll({ type: 'Button' })).map(b => b.text)]
  for (const view of ['changes', 'docs']) {
    try {
      parts.push(...(await ui.findAll({ type: 'Text', in: view })).map(t => t.text))
    } catch {
      /* that view isn't drawn now */
    }
  }
  return parts.join('\n')
}

test('the empty pane says, in plain words, what will happen', async ($, on) => {
  await setUp($, on, { '/w/plan.md': '# Plan\n' })
  const ui = await draw($)
  const text = await shown(ui)
  expect(text).toContain('No changes from Claude yet.')
  expect(text).toContain('it’ll show up here.')
  expect(text).toContain('/track-changes examples')
})

test('after Claude’s turn: a notice Claude never sees, the count and times in one line, the summary under more, and the change marked', async ($, on) => {
  const logs: string[] = []
  const disk = await setUp($, on, { '/w/plan.md': '# Plan\n\nBeta opens on 3 November for 200 customers.\n\nFull launch in December.\n' }, { onLog: t => logs.push(t) })
  await claudeTurn($, () => disk.put('/w/plan.md', '# Plan\n\nBeta opens on 10 November for 500 customers.\n\nFull launch in December.\n\nPress release on launch day.\n'))
  expect(logs).toContain('plan.md has 2 changes. /track-changes to see it')
  const ui = await draw($)
  const quiet = await shown(ui)
  expect(quiet).toMatch(/2 changes · \S+ → \S+ · by Claude/)
  // The summary, the other tools and the legend wait under m: more.
  expect(quiet).not.toContain('1 paragraph changed')
  expect(quiet).not.toContain('removed  + added')
  await ui.press({ key: 'more' })
  const text = await shown(ui)
  expect(text).toContain('Compare')
  expect(text).toContain('2 changes · 1 paragraph changed · 1 paragraph added')
  const texts = await ui.findAll({ type: 'Text', in: 'changes' })
  expect(texts.some(t => t.props.strikethrough === true && t.text.includes('200'))).toBe(true)
  expect(texts.some(t => t.props.underline === true && t.text.includes('500'))).toBe(true)
})

test('no technical words anywhere in the pane', async ($, on) => {
  const disk = await setUp($, on, { '/w/budget.xlsx': BUDGET })
  await claudeTurn($, () => disk.put('/w/budget_v2.xlsx', BUDGET_V2))
  const ui = await draw($)
  for (const view of [undefined, 'h', 'v']) {
    if (view) await ui.post({ type: 'key', key: view }, { in: 'changes' }).catch(() => undefined)
    const text = (await shown(ui)).toLowerCase()
    for (const word of ['diff', 'hash', 'snapshot', 'commit', 'lineage', 'blob', 'undefined', 'null', 'nan']) expect(text.includes(word) ? word : '').toBe('')
  }
})

test('Excel: a new file is shown as the budget’s next version, sheets and cells marked, the change list steps with n', async ($, on) => {
  const disk = await setUp($, on, { '/w/budget.xlsx': BUDGET })
  await claudeTurn($, () => disk.put('/w/budget_v2.xlsx', BUDGET_V2))
  const ui = await draw($, 110)
  const text = await shown(ui)
  expect(text).toContain('budget.xlsx → budget_v2.xlsx')
  expect(text).toContain('− Notes')
  await ui.press({ key: 'more' })
  const more = await shown(ui)
  expect(more).toContain('1 row added')
  expect(more).toContain('1 sheet removed')
  await ui.post({ type: 'key', key: 'n' }, { in: 'changes' })
  expect(await shown(ui)).toMatch(/1 of \d/)
  await ui.post({ type: 'key', key: 'n' }, { in: 'changes' })
  expect(await shown(ui)).toMatch(/2 of \d/)
})

test('Excel: a cell picked shows its old and new formula', async ($, on) => {
  const before = xlsx([{ name: 'S', rows: [['Item', 'Cost', 'Total'], ['Rent', 100, { f: '=B2*3', v: 300 }]] }])
  const after = xlsx([{ name: 'S', rows: [['Item', 'Cost', 'Total'], ['Rent', 100, { f: '=B2*4', v: 400 }]] }])
  const disk = await setUp($, on, { '/w/costs.xlsx': before })
  await claudeTurn($, () => disk.put('/w/costs.xlsx', after))
  const ui = await draw($)
  await ui.post({ type: 'key', key: 'n' }, { in: 'changes' })
  await ui.post({ type: 'key', key: 'return' }, { in: 'changes' })
  const text = await shown(ui)
  expect(text).toContain('ƒx C2')
  expect(text).toContain('=B2*3 = 300')
  expect(text).toContain('=B2*4 = 400')
})

test('Word: words removed and added inside a paragraph, headings and list items kept as they look', async ($, on) => {
  const a = docx([{ p: 'Report', style: 'Title' }, { p: 'Overview', style: 'Heading1' }, { p: 'Calls fell by 9% this quarter.' }, { p: 'Review the lease.', style: 'ListBullet' }])
  const b = docx([{ p: 'Report', style: 'Title' }, { p: 'Summary', style: 'Heading1' }, { p: 'Calls fell by 12% this quarter.' }])
  const disk = await setUp($, on, { '/w/report.docx': a })
  await claudeTurn($, () => disk.put('/w/report.docx', b))
  const ui = await draw($)
  const text = await shown(ui)
  expect(text).toContain('3 changes')
  const struck = (await ui.findAll({ type: 'Text', in: 'changes' })).filter(t => t.props.strikethrough === true).map(t => t.text)
  expect(struck.join(' ')).toContain('9%')
  expect(struck.join(' ')).toContain('Review the lease.')
})

test('long unchanged stretches fold; a click opens them', async ($, on) => {
  const paras = Array.from({ length: 30 }, (_, k) => `Paragraph ${k}.`).join('\n\n')
  const disk = await setUp($, on, { '/w/long.md': `${paras}\n\nOld ending.\n` })
  await claudeTurn($, () => disk.put('/w/long.md', `${paras}\n\nNew ending.\n`))
  const ui = await draw($, 100, 50)
  expect(await shown(ui)).toMatch(/unchanged paragraphs · click to show/)
  // The fold is the first line: what comes before the change.
  await ui.post({ type: 'click', y: 0, x: 4 }, { in: 'changes' })
  expect(await shown(ui)).not.toMatch(/click to show/)
})

test('restore: one short question, the file put back exactly, the current version saved first, and Claude told with your next message', async ($, on) => {
  const submitted: string[] = []
  const contexts: (readonly string[])[] = []
  const disk = await setUp($, on, { '/w/plan.md': 'Original plan.\n' }, { onSubmit: (t, c) => (submitted.push(t), contexts.push(c)) })
  await claudeTurn($, () => disk.put('/w/plan.md', 'Claude’s plan.\n'))
  const ui = await draw($)
  await ui.press({ key: 'restore' })
  expect(await shown(ui)).toMatch(/Put plan\.md back to the .* version\? What’s there now is saved first, so you can undo this\./)
  await ui.press({ key: 'restore-yes' })
  expect(disk.text('/w/plan.md')).toBe('Original plan.\n')
  const text = await shown(ui)
  expect(text).toContain('is back to the')
  expect(text).toContain('Claude will be told with your next message')
  expect(submitted).toHaveLength(0)
  // The next thing the person sends carries the note beside it; their words are unchanged.
  await $.prompt.submit({ text: 'Now add a risks section', wait: false, origin: { kind: 'composer' } } as never)
  expect(submitted).toEqual(['Now add a risks section'])
  expect(contexts[0]?.[0]).toMatch(/^Claude Code Track Changes note: I restored "plan\.md" to the .* version, from before your last change\. Re-read it before editing it again\.$/)
  // Only once.
  await $.prompt.submit({ text: 'And a summary', wait: false, origin: { kind: 'composer' } } as never)
  expect(contexts[1]).toEqual([])
})

test('restore can be undone: the version from before the restore is in the history', async ($, on) => {
  const disk = await setUp($, on, { '/w/plan.md': 'One.\n' })
  await claudeTurn($, () => disk.put('/w/plan.md', 'Two.\n'))
  const ui = await draw($)
  await ui.press({ key: 'restore' })
  await ui.press({ key: 'restore-yes' })
  expect(disk.text('/w/plan.md')).toBe('One.\n')
  await ui.press({ key: 'restore' })
  await ui.press({ key: 'restore-yes' })
  expect(disk.text('/w/plan.md')).toBe('Two.\n')
})

test('told straight away when the setting says so', async ($, on) => {
  const submitted: string[] = []
  const disk = await setUp($, on, { '/w/plan.md': 'One.\n' }, { onSubmit: t => submitted.push(t), store: { settings: { notices: true, autoOpen: false, tell: 'now', keepVersions: 20, keepDays: 7 } } })
  await claudeTurn($, () => disk.put('/w/plan.md', 'Two.\n'))
  const ui = await draw($)
  await ui.press({ key: 'restore' })
  await ui.press({ key: 'restore-yes' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/^Claude Code Track Changes note: I restored "plan\.md" to the .* version, from before your last change\. Re-read it before editing it again\.$/)
})

test('a Word file is restored byte for byte by the computer’s own tool, never through a shell', async ($, on) => {
  const a = docx([{ p: 'First draft.' }])
  const disk = await setUp($, on, { '/w/memo.docx': a })
  await claudeTurn($, () => disk.put('/w/memo.docx', docx([{ p: 'Second draft.' }])))
  const ui = await draw($)
  await ui.press({ key: 'restore' })
  await ui.press({ key: 'restore-yes' })
  expect(base64(disk.files.get('/w/memo.docx')!.bytes)).toBe(base64(a))
  expect(disk.runs.some(r => r[0] === 'openssl' && r.includes('-out') && r.includes('/w/memo.docx'))).toBe(true)
  expect(disk.runs.every(r => !['sh', 'bash', 'cmd', 'cmd.exe'].includes(r[0]!))).toBe(true)
})

test('a file another app holds open: restore says so plainly and changes nothing', async ($, on) => {
  const disk = await setUp($, on, { '/w/memo.docx': docx([{ p: 'First.' }]) })
  await claudeTurn($, () => disk.put('/w/memo.docx', docx([{ p: 'Second.' }])))
  const now = base64(disk.files.get('/w/memo.docx')!.bytes)
  disk.locked.add('/w/memo.docx')
  const ui = await draw($)
  await ui.press({ key: 'restore' })
  await ui.press({ key: 'restore-yes' })
  expect(base64(disk.files.get('/w/memo.docx')!.bytes)).toBe(now)
  expect(await shown(ui)).toMatch(/couldn’t be saved first|open in another app/)
})

test('keep this version: shows exactly what will move, then puts it in the budget’s own file and moves the copies to Older versions', async ($, on) => {
  const disk = await setUp($, on, { '/w/budget.xlsx': BUDGET })
  await claudeTurn($, () => disk.put('/w/budget_v2.xlsx', BUDGET_V2))
  const ui = await draw($)
  await ui.press({ key: 'keep' })
  // The plan is worked out, then shown.
  await new Promise(resolve => setTimeout(resolve, 50))
  const plan = await shown(ui)
  expect(plan).toContain('budget.xlsx becomes the')
  expect(plan).toContain('budget.xlsx (as it is now) moves to Older versions/budget.xlsx')
  expect(plan).not.toContain('/w/')
  expect(plan).toContain('budget_v2.xlsx moves to Older versions/budget_v2.xlsx')
  expect(plan).toContain('Nothing is deleted')
  await ui.press({ key: 'keep-yes' })
  expect(base64(disk.files.get('/w/budget.xlsx')!.bytes)).toBe(base64(BUDGET_V2))
  expect(base64(disk.files.get('/w/Older versions/budget.xlsx')!.bytes)).toBe(base64(BUDGET))
  expect(disk.files.has('/w/Older versions/budget_v2.xlsx')).toBe(true)
  expect(disk.files.has('/w/budget_v2.xlsx')).toBe(false)
  expect(await shown(ui)).toContain('Claude will be told with your next message')
})

test('comment on a change and send: the old and new text are quoted, fenced as data', async ($, on) => {
  const submitted: string[] = []
  const disk = await setUp($, on, { '/w/plan.md': 'Beta opens on 3 November.\n' }, { onSubmit: t => submitted.push(t) })
  await claudeTurn($, () => disk.put('/w/plan.md', 'Beta opens on 10 November.\n'))
  const ui = await draw($)
  await ui.post({ type: 'key', key: 'n' }, { in: 'changes' })
  await ui.press({ key: 'comment' })
  const input = (await ui.findAll({ type: 'Input' }))[0]!
  await ui.input({ key: input.key!, text: 'Keep it on the 3rd' })
  await ui.press({ key: 'send' })
  expect(submitted).toHaveLength(1)
  const prompt = submitted[0]!
  expect(prompt).toMatch(/^Claude Code Track Changes feedback: these are comments on changes you made\./)
  const fence = /<(file-excerpt-[0-9a-f]{8})>/.exec(prompt)?.[1]
  expect(fence).toBeDefined()
  expect(prompt).toContain('Before:\n   > Beta opens on 3 November.')
  expect(prompt).toContain('Now:\n   > Beta opens on 10 November.')
  expect(prompt).toContain(`</${fence}>\n   Feedback: Keep it on the 3rd`)
})

test('the ask: Yes joins the new file to the document, and the turn then shows it as that document’s change', async ($, on) => {
  const disk = await setUp($, on, { '/w/budget.xlsx': BUDGET })
  await claudeTurn($, () => disk.put('/w/board pack.xlsx', BUDGET_V2))
  const ui = await draw($)
  expect(await shown(ui)).toContain('Is board pack.xlsx a new version of budget.xlsx?')
  await ui.press({ key: 'ask-yes' })
  const text = await shown(ui)
  expect(text).not.toContain('Is board pack.xlsx a new version')
  expect(text).toContain('budget.xlsx → board pack.xlsx')
})

test('several documents in one turn: step through them, each with its own changes', async ($, on) => {
  const disk = await setUp($, on, { '/w/a.md': 'Alpha one.\n', '/w/b.md': 'Beta one.\n' })
  await claudeTurn($, () => {
    disk.put('/w/a.md', 'Alpha two.\n')
    disk.put('/w/b.md', 'Beta two.\n')
  })
  const ui = await draw($)
  expect(await shown(ui)).toContain('1/2')
  await ui.post({ type: 'key', key: '.' }, { in: 'changes' })
  expect(await shown(ui)).toContain('2/2')
})

test('history: every version with its time, who made it and the file', async ($, on) => {
  const disk = await setUp($, on, { '/w/budget.xlsx': BUDGET })
  await claudeTurn($, () => disk.put('/w/budget_v2.xlsx', BUDGET_V2))
  await $.command.run({ command: 'track-changes', args: 'history budget.xlsx' })
  const ui = await draw($)
  const text = await shown(ui)
  expect(text).toContain('budget.xlsx: 2 versions')
  expect(text).toContain('Claude')
  expect(text).toContain('First seen')
  expect(text).toContain('budget_v2.xlsx')
})

test('settings: notices, auto-open, how Claude is told, how much is kept, and space used', async ($, on) => {
  await setUp($, on, { '/w/plan.md': 'One.\n' })
  const ran = await $.command.run({ command: 'track-changes', args: 'settings' })
  expect(String((ran as { text?: unknown }).text)).toMatch(/Saved versions use .* for this folder/)
  const ui = await draw($)
  const text = await shown(ui)
  for (const words of ['Notice after Claude’s turn', 'Open this pane by itself', 'Tell Claude about a restore', 'Versions kept per document', 'Days kept', 'Space used']) expect(text).toContain(words)
  expect(text).toContain('● On')
  await ui.press({ key: 'set-auto' })
  expect((await ui.find({ type: 'Button', key: 'set-auto' }))?.text).toContain('● On')
})

test('/track-changes examples writes samples, one saved as a new file, and shows Claude’s example changes', async ($, on) => {
  const disk = new Disk()
  mount(on, disk)
  await start($)
  const ran = await $.command.run({ command: 'track-changes', args: 'examples' })
  expect(String((ran as { text?: unknown }).text)).toContain('a budget saved as a new file (budget_v2.xlsx)')
  for (const name of ['budget.xlsx', 'budget_v2.xlsx', 'report.docx', 'plan.md', 'meter-readings.csv']) expect(disk.files.has(`/w/track-changes-examples/${name}`)).toBe(true)
  const ui = await draw($)
  await ui.press({ key: 'more' })
  const text = await shown(ui)
  expect(text).toContain('by Claude (example)')
  expect(text).toContain('1/4')
})

test('small, medium and large panes all draw, inline and side by side, with nothing wider than the pane', async ($, on) => {
  const disk = await setUp($, on, { '/w/budget.xlsx': BUDGET, '/w/plan.md': '# Plan\n\nA long paragraph that needs to wrap in a narrow pane, with plenty of words in it.\n' })
  await claudeTurn($, () => {
    disk.put('/w/budget_v2.xlsx', BUDGET_V2)
    disk.put('/w/plan.md', '# Plan\n\nA long paragraph that needs to wrap in a narrow pane, with many more words in it now.\n')
  })
  for (const [columns, rows] of [
    [40, 12],
    [60, 20],
    [100, 34],
    [160, 50],
  ] as const) {
    const ui = await draw($, columns, rows)
    for (const key of ['v', '.']) {
      await ui.post({ type: 'key', key }, { in: 'changes' }).catch(() => undefined)
      const view = await ui.drawn({ in: 'changes' })
      const lines = (await ui.findAll({ type: 'Text', in: 'changes' })).filter(t => t.props.wrap === 'truncate-end')
      void view
      for (const line of lines) expect([...line.text].length).toBeLessThanOrEqual(columns + 1)
    }
    await ui.unmount()
  }
})

test('PDF, HTML, Confluence and text files each show their changes, read as documents', async ($, on) => {
  const adf = (text: string) => JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Update' }] }, { type: 'paragraph', content: [{ type: 'text', text }] }] })
  const cases: [string, string | Uint8Array, string | Uint8Array, string, string][] = [
    ['/w/letter.pdf', pdf([['Dear customer,', 'Your rate is 25 cents.']]), pdf([['Dear customer,', 'Your rate is 22 cents.']]), '25', '22'],
    ['/w/page.html', '<h1>Prices</h1><p>From <b>$40</b> a month.</p>', '<h1>Prices</h1><p>From <b>$35</b> a month.</p>', '$40', '$35'],
    ['/w/update.adf', adf('Go-live is on Monday.'), adf('Go-live is on Friday.'), 'Monday', 'Friday'],
    ['/w/notes.txt', 'alpha\nbeta\ngamma\n', 'alpha\ndelta\ngamma\n', 'beta', 'delta'],
  ]
  const disk = await setUp($, on, Object.fromEntries(cases.map(c => [c[0], c[1]])))
  await claudeTurn($, () => {
    for (const [path, , after] of cases) disk.put(path, after)
  })
  const ui = await draw($)
  const seen: string[] = []
  for (let k = 0; k < cases.length; k += 1) {
    const name = (await ui.findAll({ type: 'Text', in: 'docs' })).map(t => t.text).join(' ')
    const one = cases.find(c => name.includes(c[0].slice(3)))!
    seen.push(one[0])
    const texts = await ui.findAll({ type: 'Text', in: 'changes' })
    expect(texts.some(t => t.props.strikethrough === true && t.text.includes(one[3])) ? one[0] : `${one[0]}: ${one[3]} not struck`).toBe(one[0])
    expect(texts.some(t => t.props.underline === true && t.text.includes(one[4])) ? one[0] : `${one[0]}: ${one[4]} not underlined`).toBe(one[0])
    // Formatted, not markup.
    expect(texts.some(t => /<h1>|"type":|<p>/.test(t.text))).toBe(false)
    if (k === 0) await ui.press({ key: 'more' })
    await ui.press({ key: 'k-doc' })
  }
  expect(new Set(seen).size).toBe(4)
})

test('Windows: restore by certutil and keep by PowerShell, paths only in arguments and the environment, never in a command line', async ($, on) => {
  const disk = new Disk()
  disk.tools = new Set(['certutil', 'powershell.exe'])
  disk.put('C:/Users/sam/Work/budget.xlsx', BUDGET)
  mount(on, disk, { env: { HOME: '', USERPROFILE: 'C:\\Users\\sam' } })
  await start($, 'C:\\Users\\sam\\Work')
  await claudeTurn($, () => disk.put('C:/Users/sam/Work/budget_v2.xlsx', BUDGET_V2))
  const ui = await draw($)
  await ui.press({ key: 'keep' })
  await new Promise(resolve => setTimeout(resolve, 50))
  await ui.press({ key: 'keep-yes' })
  expect(base64(disk.files.get('C:/Users/sam/Work/budget.xlsx')!.bytes)).toBe(base64(BUDGET_V2))
  expect(disk.files.has('C:/Users/sam/Work/Older versions/budget_v2.xlsx')).toBe(true)
  const moves = disk.runs.filter(r => r[0] === 'powershell.exe')
  expect(moves.length).toBe(2)
  // The command text is the same every time: the paths are never part of it.
  expect(new Set(moves.map(r => r.join(' '))).size).toBe(1)
  expect(moves[0]!.join(' ')).not.toContain('budget')
  const decode = disk.runs.find(r => r[0] === 'certutil')!
  expect(decode[decode.length - 1]).toBe('C:\\Users\\sam\\Work\\budget.xlsx')
  // Versions live in the Claude folder, not the project.
  expect([...disk.files.keys()].some(p => p.startsWith('C:/Users/sam/.claude/track-changes/projects/'))).toBe(true)
})
