// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Claude Code Track Changes: https://github.com/paragpandyareal/claude-code-track-changes
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel
import { mock } from 'claude-code/testing'
import type { test } from 'claude-code/testing'

import { base64 } from './office'

type Body = Parameters<typeof test>[1]
export type Engine = Parameters<Body>[0]
export type On = Parameters<Body>[1]

const encoder = new TextEncoder()

const unbase64 = (text: string) => {
  const binary = atob(text)
  return Uint8Array.from(binary, ch => ch.charCodeAt(0))
}

/**
 * A disk in memory for the tests: files with bytes and a modification time,
 * folders made as files are written, links, files held open by another app,
 * and the commands Claude Code Track Changes runs (openssl, mkdir, mv) done on it.
 */
export class Disk {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>()
  links = new Set<string>()
  locked = new Set<string>()
  now = 1_000_000
  runs: string[][] = []
  /** Only these commands exist on this computer. */
  tools = new Set(['openssl', 'mkdir', 'mv'])

  put(path: string, content: string | Uint8Array) {
    this.now += 1000
    this.files.set(path, { bytes: typeof content === 'string' ? encoder.encode(content) : content, mtime: this.now })
  }
  text(path: string) {
    const f = this.files.get(path)
    return f ? new TextDecoder().decode(f.bytes) : undefined
  }
  remove(path: string) {
    this.files.delete(path)
  }
  move(from: string, to: string) {
    const f = this.files.get(from)
    if (!f) return
    this.files.delete(from)
    this.files.set(to, f)
  }
  isDir(path: string) {
    const prefix = `${path.replace(/\/$/, '')}/`
    return [...this.files.keys()].some(p => p.startsWith(prefix)) || [...this.links].some(p => p.startsWith(prefix))
  }
  list(dir: string) {
    const prefix = `${dir.replace(/\/$/, '')}/`
    const seen = new Map<string, { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [path, f] of this.files) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const name = rest.split('/')[0]!
      if (rest.includes('/')) {
        if (!seen.has(name)) seen.set(name, { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: this.links.has(prefix + name) })
      } else seen.set(name, { name, kind: 'file', size: f.bytes.length, mtimeMs: f.mtime, isLink: this.links.has(path) })
    }
    for (const link of this.links) {
      if (!link.startsWith(prefix)) continue
      const name = link.slice(prefix.length).split('/')[0]!
      const entry = seen.get(name)
      if (entry) entry.isLink = true
      else seen.set(name, { name, kind: 'other', size: 0, mtimeMs: 0, isLink: true })
    }
    return [...seen.values()]
  }
}

/** On Linux the test kit sees "C:/x" as relative and puts its own folder first: the Windows path is what follows. */
const fix = (path: string) => path.replace(/^.*?(?=[A-Za-z]:\/)/, '')

/** The mocks Claude Code Track Changes needs, all answered from the disk. Starts the session in /w. */
export function mount(on: On, disk: Disk, options: { store?: Record<string, unknown>; env?: Record<string, string>; onLog?: (text: string) => void; onSubmit?: (text: string, context: readonly string[]) => void; box?: string } = {}) {
  mock.store(on, options.store ?? {})
  const env: Record<string, string> = { HOME: '/home/u', ...(options.env ?? {}) }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('env.get', (_, e) => ({ value: env[e.name] }))
  // Short waits pass at once; a long one (a time limit) never ends, so what it guards finishes first.
  on('clock.sleep', (_, e) => ((e as { ms?: number }).ms ?? 0) >= 10_000 ? new Promise(() => undefined) : { value: undefined })
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_, e) => {
    options.onLog?.(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: options.box ?? '', cursor: 0 } }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('prompt.submit', (_, e) => {
    options.onSubmit?.(e.text, (e as { context?: readonly string[] }).context ?? [])
    return { text: e.text }
  })
  on('fs.exists', (_, e) => ({ value: disk.files.has(fix(e.path)) || disk.isDir(fix(e.path)) }))
  on('fs.read', (_, e) => {
    const path = fix((e as { path: string }).path)
    const f = disk.files.get(path)
    if (!f) throw new Error(`ENOENT: no such file ${path}`)
    if (disk.locked.has(path)) throw new Error(`EBUSY: resource busy or locked ${path}`)
    const asBytes = (e as { as?: string; options?: { as?: string } }).as === 'bytes' || (e as { options?: { as?: string } }).options?.as === 'bytes'
    return { value: asBytes ? { base64: base64(f.bytes) } : new TextDecoder().decode(f.bytes) }
  })
  on('fs.write', (_, e) => {
    const { path, text } = e as { path: string; text: string }
    disk.put(fix(path), text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const path = fix((e as { path?: string }).path ?? '/w').replace(/\/$/, '')
    if (!disk.isDir(path)) throw new Error(`ENOENT: ${path}`)
    return { value: disk.list(path) }
  })
  on('fs.stat', (_, e) => {
    const path = fix((e as { path: string }).path)
    const f = disk.files.get(path)
    if (f) return { value: { kind: 'file', size: f.bytes.length, mtimeMs: f.mtime, isLink: disk.links.has(path), realPath: path } }
    if (disk.isDir(path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: disk.links.has(path), realPath: disk.links.has(path) ? '/elsewhere' : path } }
    throw new Error(`ENOENT: ${path}`)
  })
  on('process.run', (_, e) => {
    const argv = [...(e as { argv: readonly string[] }).argv]
    disk.runs.push(argv)
    if (!disk.tools.has(argv[0]!)) throw new Error(`spawn ${argv[0]} ENOENT`)
    if (argv[0] === 'openssl') {
      const from = argv[argv.indexOf('-in') + 1]!
      const to = argv[argv.indexOf('-out') + 1]!
      if (disk.locked.has(to)) return { value: { exitCode: 1, stdout: '', stderr: `${to}: Permission denied` } }
      disk.put(to, unbase64(disk.text(from) ?? ''))
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    const slashes = (path: string) => path.replace(/\\/g, '/')
    if (argv[0] === 'certutil') {
      const [from, to] = argv.slice(-2).map(slashes) as [string, string]
      if (disk.locked.has(to)) return { value: { exitCode: 1, stdout: 'The process cannot access the file because it is being used by another process.', stderr: '' } }
      disk.put(to, unbase64(disk.text(from) ?? ''))
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (argv[0] === 'powershell.exe') {
      const env = (e as { env?: Record<string, string>; init?: { env?: Record<string, string> } }).env ?? (e as { init?: { env?: Record<string, string> } }).init?.env ?? {}
      const from = slashes(env.TRACK_CHANGES_FROM ?? '')
      const to = slashes(env.TRACK_CHANGES_TO ?? '')
      if (disk.locked.has(from)) return { value: { exitCode: 1, stdout: '', stderr: 'The process cannot access the file because it is being used by another process.' } }
      disk.move(from, to)
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (argv[0] === 'mkdir') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    if (argv[0] === 'mv') {
      const [from, to] = argv.slice(-2) as [string, string]
      if (disk.locked.has(from)) return { value: { exitCode: 1, stdout: '', stderr: `mv: cannot move: Resource busy` } }
      if (disk.files.has(to)) return { value: { exitCode: 0, stdout: '', stderr: '' } }
      disk.move(from, to)
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  // No Python on this computer: every start fails.
  on('process.spawn', async function* () {
    yield* []
    throw new Error('spawn python3 ENOENT')
  })
}

export async function start($: Engine, cwd = '/w') {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
}

let turns = 0

/** One of Claude's turns: what `work` does to the disk happens between its start and its end. */
export async function claudeTurn($: Engine, work: () => void | Promise<void>, reason: 'answer' | 'aborted' = 'answer') {
  turns += 1
  const turnId = `turn-${turns}`
  await $.turn.start({ text: 'please', turnId })
  await work()
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: reason === 'aborted', turnId, reason } as never)
}

/** The tracking record as saved. */
export function indexOf(disk: Disk) {
  const path = [...disk.files.keys()].find(p => p.startsWith('/home/u/.claude/track-changes/projects/') && p.endsWith('/index.json'))
  return path ? JSON.parse(disk.text(path)!) : undefined
}

export const PANE = {
  component: 'Pane',
  requestId: 'track-changes',
  props: { title: 'Claude Code Track Changes', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 34 }, view: {} },
} as const
