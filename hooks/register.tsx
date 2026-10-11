// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Panda Redline: https://github.com/paragpandyareal/panda-redline
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderNode, RenderSurface } from 'claude-code'
import type { Doc, DocRow, PaneState, PaneView, RedlineComment, RedlineSettings as Settings } from '../types'
import { adfRows, isAdf } from './adf'
import type { ChangesPal, ChangesPost, ChangesProps } from './changes'
import { address, changesOf, compareGrids, compareLines, summaryOf } from './compare'
import type { Change, GridComparison, LinesComparison } from './compare'
import { readCsv } from './csv'
import { startReading, stopReading, TooSlow } from './deadline'
import { readDocx } from './docx'
import { extOf, fingerprintOf, folderOf, kindOf, matchParent, nameOf, stemOf, TRACKED } from './family'
import type { Candidate } from './family'
import type { FileBarProps } from './filebar'
import { contentKey, shortKey } from './hash'
import { htmlRows } from './html'
import { layoutGrid, layoutLines } from './layout'
import type { DRow, Laid } from './layout'
import { markdownRows } from './md'
import { feedbackPrompt, isAbsolutePath, normalizePath, noteName, PROMPT_HEADER, shortPath } from './model'
import { makeDocx, makeXlsx } from './officegen'
import { BADGES, PALETTE } from './palette'
import { pandaRows } from './panda'
import { readPdf } from './pdf'
import type { SpinnerProps } from './spinner'
import { cutTo, sanitizeLine, stripControls } from './text'
import { readXlsx } from './xlsx'

/*
 * Everything here that reaches files, programs or the store does so through `$`,
 * which a mod may only hand to functions in this same file: so the storage,
 * the tracking and the writer live here, and the pure work (comparing, matching
 * families, laying out) in modules of its own.
 */

// ════ store ════

/**
 * Where versions are kept: the plugin's own folder under the Claude Code
 * configuration folder, never in the project. Each file's content is stored
 * once, whatever number of versions share it.
 */

// ── What is kept ──

export type Who = 'claude' | 'you' | 'first' | 'restore' | 'keep' | 'example'

export type Version = {
  id: string
  family: string
  path: string
  /** The content's key; null when the file was deleted. */
  key: string | null
  size: number
  /** When the version was noted, ms since the epoch. */
  at: number
  by: Who
  turn?: string
  /** A word on how it came about: "stopped partway", "before restoring". */
  note?: string
  /** A few words of what it holds, for matching new files to it. */
  fp?: string[]
}

export type Family = {
  id: string
  /** The name people know it by: its first file's name. */
  name: string
  kind: string
  /** The file it lives in, where Keep this version puts it. */
  home: string
  /** Every file it has been, in order. */
  paths: string[]
  versions: string[]
}

export type TurnChange = { family: string; before: string | null; after: string }

export type Turn = {
  id: string
  start: number
  end: number
  by: 'claude' | 'example'
  status: 'done' | 'stopped' | 'failed'
  changes: TurnChange[]
}

/** A new file Panda Redline isn't sure about: asked once in the pane. */
export type Ask = { version: string; path: string; guess: { family: string; path: string }; others: { family: string; path: string }[] }

/** A file on disk as last noted. */
export type Known = { key: string; size: number; mtime: number; family: string }

/** A file that couldn't be kept, and why, in plain words. */
export type Skipped = { path: string; reason: string }

export type Index = {
  v: 1
  folder: string
  files: Record<string, Known>
  families: Record<string, Family>
  versions: Record<string, Version>
  turns: Turn[]
  /** Answers to "is this a new version of that?", by "new path → old path": yes or no. */
  answers: Record<string, 'yes' | 'no'>
  asks: Ask[]
  skipped: Skipped[]
  /** The turn running now: its id and when it started. */
  running: { id: string; start: number } | null
  /** Whether the folder has been noted once: the first look records, it shows nothing. */
  isReady: boolean
}

export const emptyIndex = (folder: string): Index => ({ v: 1, folder, files: {}, families: {}, versions: {}, turns: [], answers: {}, asks: [], skipped: [], running: null, isReady: false })

// ── Limits ──

/** Claude Code reads files of up to 4 MiB for a mod; larger ones come through Python, up to 50 MB. */
export const READ_MAX = 4 * 1024 * 1024
export const BIG_MAX = 50 * 1024 * 1024
/** Content is stored in pieces a mod can read back (4 MiB at most). */
const PIECE = 3_000_000

export const isTracked = (path: string) => TRACKED.includes(extOf(path))

/**
 * A root (`/`, `C:/`, a network share), a home folder or the folder of them:
 * too broad to watch.
 */
export const isHomeOrRoot = (dir: string) =>
  /^(?:[A-Z]:)?\/?$|^\/\/[^/]+(?:\/[^/]+)?\/?$|^(?:[A-Z]:|\/mnt\/[a-z]|\/var)?\/(?:home|Users)(?:\/[^/]+)?\/?$|^\/(?:var\/)?root\/?$/i.test(dir)

// ── Where it is kept ──

/** The session's tracking state, set at session.start. */
export const vault = {
  /** The data folder: <Claude config>/panda-redline. */
  data: '',
  /** This project's folder in it. */
  project: '',
  folder: '',
  index: emptyIndex(''),
  /** The note-taking in progress, so a tool waits for the turn's start to be noted. */
  pending: null as Promise<void> | null,
}

/** A document's newest version. */
export const latestOf = (fam: Family): Version | undefined => vault.index.versions[fam.versions[fam.versions.length - 1] ?? '']

export async function dataFolder($: EngineInterface): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config) return `${config.replace(/\\/g, '/').replace(/\/$/, '')}/panda-redline`
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  return `${home.replace(/\\/g, '/').replace(/\/$/, '')}/.claude/panda-redline`
}

export async function openVault($: EngineInterface, folder: string) {
  vault.data = await dataFolder($)
  vault.folder = folder
  const last = folder.split('/').filter(Boolean).pop() ?? 'root'
  vault.project = `${vault.data}/projects/${last.replace(/[^\w.-]+/g, '_').slice(0, 40)}-${shortKey(folder.toLowerCase())}`
  vault.index = emptyIndex(folder)
  try {
    const text = await $.fs.read(`${vault.project}/index.json`)
    const parsed = JSON.parse(text) as Index
    if (parsed && parsed.v === 1 && parsed.files && parsed.families) vault.index = { ...emptyIndex(folder), ...parsed, folder }
  } catch {
    /* a first look at this folder */
  }
}

export async function saveIndex($: EngineInterface) {
  await $.fs.write(`${vault.project}/index.json`, JSON.stringify(vault.index))
}

export const blobPath = (key: string, part: number) => `${vault.project}/store/${key.slice(0, 2)}/${key}.${part}`

/** Stores a file's content (base64) once; a second store of the same content costs nothing. */
export async function putBlob($: EngineInterface, key: string, base64: string) {
  if (await $.fs.exists(blobPath(key, 0))) {
    const first = await $.fs.stat(blobPath(key, 0)).catch(() => undefined)
    if (first && first.size > 0) return
  }
  const parts = Math.max(1, Math.ceil(base64.length / PIECE))
  // Later pieces first, so a store cut short never looks whole.
  for (let k = parts - 1; k >= 0; k -= 1) await $.fs.write(blobPath(key, k), (k === 0 ? `${parts}\n` : '') + base64.slice(k * PIECE, (k + 1) * PIECE))
}

/** A stored content's base64, or null when it is no longer kept. */
export async function getBlob($: EngineInterface, key: string): Promise<string | null> {
  try {
    const first = await $.fs.read(blobPath(key, 0))
    const newline = first.indexOf('\n')
    if (newline < 0) return null
    const parts = Number(first.slice(0, newline))
    const out = [first.slice(newline + 1)]
    for (let k = 1; k < parts; k += 1) out.push(await $.fs.read(blobPath(key, k)))
    const text = out.join('')
    return contentKey(text) === key ? text : null
  } catch {
    return null
  }
}

/** Lets go of a stored content: a mod can't delete files, so each piece is emptied, which frees its space. */
export async function dropBlob($: EngineInterface, key: string) {
  try {
    const first = await $.fs.read(blobPath(key, 0))
    const parts = Number(first.slice(0, first.indexOf('\n'))) || 1
    for (let k = 0; k < parts; k += 1) await $.fs.write(blobPath(key, k), '')
  } catch {
    /* already gone */
  }
}

// ════ python ════

/**
 * Python 3, only when it is already on the computer, only for documents over
 * 4 MB (the most Claude Code lets a mod read). It runs the bundled
 * scripts/read_file.py, which prints one file's bytes as base64. The command
 * is fixed text; the file's path goes on standard input.
 */

type Python = 'python3' | 'py' | 'python'

export const py = { cmd: null as Python | 'none' | null, home: '' }

function startScript($: EngineInterface, python: Python, input: string) {
  if (python === 'python3') return $.process.spawn({ argv: ['python3', '-I', './scripts/read_file.py'], cwd: $.plugin.root, input })
  if (python === 'py') return $.process.spawn({ argv: ['py', '-3', '-I', './scripts/read_file.py'], cwd: $.plugin.root, input })
  return $.process.spawn({ argv: ['python', '-I', './scripts/read_file.py'], cwd: $.plugin.root, input })
}

/** A script's standard output, or 'timeout', or null when it could not start or wrote too much. */
async function collect($: EngineInterface, stream: ReturnType<typeof startScript>, timeoutMs: number): Promise<string | null | 'timeout'> {
  const parts: string[] = []
  let size = 0
  const iterator = stream[Symbol.asyncIterator]()
  const stop = new AbortController()
  const timer = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(
    () => 'timeout' as const,
    () => 'stopped' as const,
  )
  try {
    for (;;) {
      const step = await Promise.race([iterator.next(), timer])
      if (step === 'timeout') {
        await iterator.return?.(undefined as never)
        return 'timeout'
      }
      if (step === 'stopped' || step.done) break
      if (step.value.stream !== 'stdout') continue
      size += step.value.text.length
      if (size > 70 * 1024 * 1024) {
        await iterator.return?.(undefined as never)
        return null
      }
      parts.push(step.value.text)
    }
  } catch {
    return null
  } finally {
    stop.abort()
  }
  return parts.join('')
}

/** Where a Mac keeps a real Python 3: Apple's developer tools or Xcode, python.org's installer, Homebrew, MacPorts. */
const MAC_PYTHONS = [
  '/Library/Developer/CommandLineTools/usr/bin/python3',
  '/Applications/Xcode.app/Contents/Developer/usr/bin/python3',
  '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
  '/usr/local/bin/python3',
  '/opt/homebrew/bin/python3',
  '/opt/local/bin/python3',
  '/opt/anaconda3/bin/python3',
  '/opt/miniconda3/bin/python3',
]

/** A Mac where /usr/bin/python3 can only be Apple's stub (running it pops up Apple's offer to install developer tools). */
async function isMacWithoutPython($: EngineInterface): Promise<boolean> {
  if (!(await $.fs.exists('/System/Library/CoreServices/SystemVersion.plist'))) return false
  const own = py.home ? [`${py.home}/.pyenv/shims/python3`, `${py.home}/miniconda3/bin/python3`, `${py.home}/anaconda3/bin/python3`, `${py.home}/.local/bin/python3`] : []
  for (const path of [...MAC_PYTHONS, ...own]) if (await $.fs.exists(path)) return false
  return true
}

/**
 * Runs read_file.py with Python 3: python3, then py -3 (the Windows
 * launcher), then python, until one answers. The one that worked is
 * remembered for the session; so is finding none (/redline setup asks again).
 */
export async function runPython($: EngineInterface, input: string, timeoutMs: number): Promise<string | 'none' | 'timeout'> {
  if (py.cmd === 'none') return 'none'
  if (py.cmd === null && (await isMacWithoutPython($))) {
    py.cmd = 'none'
    return 'none'
  }
  const order: Python[] = py.cmd ? [py.cmd] : ['python3', 'py', 'python']
  for (const python of order) {
    const out = await collect($, startScript($, python, input), timeoutMs)
    if (out === 'timeout') return 'timeout'
    if (out !== null && out.startsWith('LPP1')) {
      py.cmd = python
      return out
    }
  }
  py.cmd = 'none'
  return 'none'
}

/** A document over 4 MB as base64, through Python; or why it can't be read. */
export async function readBigBase64($: EngineInterface, path: string): Promise<string | { reason: string }> {
  const out = await runPython($, path, 60_000)
  if (out === 'none') return { reason: 'it is over 4 MB, and files that size need Python 3 on this computer (run /redline setup to check)' }
  if (out === 'timeout') return { reason: 'reading it took too long' }
  const newline = out.indexOf('\n')
  const head = newline < 0 ? out : out.slice(0, newline)
  if (head.startsWith('LPP1 error')) return { reason: head.slice(11).trim().slice(0, 200) || 'it could not be read' }
  return out.slice(newline + 1).replace(/\s+/g, '')
}

// ════ writer ════

/**
 * Writing files back, only when the person clicks Restore or Keep this
 * version (and for /redline examples). A mod can write text files only, so
 * Word, Excel and PDF files are written by the computer's own tools, run
 * without a shell, with fixed arguments and the file paths as the only
 * variable parts:
 *
 * - Windows: certutil -decode, and PowerShell's Move-Item with the paths in
 *   environment variables (never in the command text)
 * - macOS: base64 -D, mv -n
 * - Linux: openssl base64 -d, or Python 3, and mv -n
 *
 * Every write is read back and checked against what was meant.
 */

export type Os = 'windows' | 'mac' | 'linux'

export const host = { os: 'linux' as Os, tmp: '', pluginRoot: '' }

export async function detectOs($: EngineInterface, folder: string): Promise<Os> {
  if (/^[a-z]:\//i.test(folder) || folder.startsWith('//')) return 'windows'
  if (await $.fs.exists('/System/Library/CoreServices/SystemVersion.plist')) return 'mac'
  return 'linux'
}

const native = (path: string) => (host.os === 'windows' ? path.replace(/\//g, '\\') : path)

export class WriteError extends Error {}

/** Why a write failed, in words a person can act on. */
function why(text: string, name: string): string {
  if (/being used|EBUSY|locked|sharing violation|process cannot access/i.test(text)) return `${name} is open in another app (maybe Excel or Word). Close it there and try again.`
  if (/denied|EACCES|EPERM|read-only/i.test(text)) return `Panda Redline isn't allowed to change ${name}. Check that it isn't read-only.`
  return `${name} couldn't be written: ${text.replace(/\s+/g, ' ').slice(0, 160)}`
}


/** Decodes a base64 file into `target` with whichever tool this computer has. */
async function decode($: EngineInterface, from: string, target: string): Promise<{ ok: true } | { ok: false; text: string }> {
  const attempts: (readonly string[])[] =
    host.os === 'windows'
      ? [['certutil', '-f', '-decode', native(from), native(target)]]
      : host.os === 'mac'
        ? [['base64', '-D', '-i', from, '-o', target]]
        : [
            ['openssl', 'base64', '-d', '-A', '-in', from, '-out', target],
            ['python3', '-I', './scripts/write_file.py', from, target],
          ]
  let last = 'no tool on this computer could write it'
  for (const argv of attempts) {
    try {
      const cwd = argv[0] === 'python3' ? host.pluginRoot : undefined
      const run = await $.process.run(argv, { timeoutMs: 60_000, ...(cwd ? { cwd } : {}) })
      if (run.exitCode === 0) return { ok: true }
      last = run.stderr || run.stdout || `exit ${run.exitCode}`
    } catch (error) {
      last = String((error as { message?: unknown })?.message ?? error)
    }
  }
  return { ok: false, text: last }
}

/** Whether `path` now holds exactly `base64`. */
async function holds($: EngineInterface, path: string, base64: string): Promise<boolean> {
  try {
    const st = await $.fs.stat(path)
    if (st.size > 4 * 1024 * 1024) return st.size === Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
    return contentKey((await $.fs.read(path, { as: 'bytes' })).base64) === contentKey(base64)
  } catch {
    return false
  }
}

/** The bytes as text when they are valid UTF-8 (a byte order mark kept), else null. */
const decodeUtf8 = (bytes: Uint8Array): string | null => {
  const text = new TextDecoder().decode(bytes)
  const hasMark = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const whole = hasMark && !text.startsWith('\ufeff') ? `\ufeff${text}` : text
  const again = new TextEncoder().encode(whole)
  if (again.length !== bytes.length) return null
  for (let k = 0; k < bytes.length; k += 1) if (again[k] !== bytes[k]) return null
  return whole
}

export function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let k = 0; k < binary.length; k += 1) bytes[k] = binary.charCodeAt(k)
  return bytes
}

export function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (let k = 0; k < bytes.length; k += 0x8000) binary += String.fromCharCode(...bytes.subarray(k, k + 0x8000))
  return btoa(binary)
}

/**
 * Writes `base64` into `target`, exactly. Text files (valid UTF-8, without
 * NUL bytes) are written by the mod itself; anything else by the computer's
 * own tool. Throws a WriteError with words for the person when it fails.
 */
export async function writeExactly($: EngineInterface, target: string, base64: string) {
  const name = nameOf(target)
  const bytes = bytesOf(base64)
  const text = bytes.includes(0) ? null : decodeUtf8(bytes)
  if (text !== null && !/\.(xlsx|xlsm|docx|pdf)$/i.test(target)) {
    try {
      await $.fs.write(target, text)
    } catch (error) {
      throw new WriteError(why(String((error as { message?: unknown })?.message ?? error), name))
    }
    if (!(await holds($, target, base64))) throw new WriteError(`${name} didn't come out as expected. Try again, or open it to check.`)
    return
  }
  const from = `${host.tmp}/${crypto.randomUUID()}.b64`
  await $.fs.write(from, base64)
  try {
    const done = await decode($, from, target)
    if (!done.ok) throw new WriteError(why(done.text, name))
    if (!(await holds($, target, base64))) throw new WriteError(`${name} didn't come out as expected (it may be open in another app). Close it and try again.`)
  } finally {
    // A mod can't delete files: the temporary copy is emptied.
    await $.fs.write(from, '').catch(() => undefined)
  }
}

/** Moves a file to `to` (a path that doesn't exist yet), its folder made if needed. Never overwrites. */
export async function moveFile($: EngineInterface, from: string, to: string) {
  const name = nameOf(from)
  if (await $.fs.exists(to)) throw new WriteError(`${nameOf(to)} already exists in the Older versions folder.`)
  let result: { exitCode: number; stderr: string; stdout: string }
  try {
    if (host.os === 'windows') {
      result = await $.process.run(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$ErrorActionPreference = "Stop"; New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $env:PANDA_REDLINE_TO) | Out-Null; Move-Item -LiteralPath $env:PANDA_REDLINE_FROM -Destination $env:PANDA_REDLINE_TO',
        ],
        { env: { PANDA_REDLINE_FROM: native(from), PANDA_REDLINE_TO: native(to) }, timeoutMs: 60_000 },
      )
    } else {
      const folder = to.slice(0, to.lastIndexOf('/'))
      const made = await $.process.run(['mkdir', '-p', '--', folder], { timeoutMs: 20_000 })
      if (made.exitCode !== 0) throw new WriteError(why(made.stderr, 'the Older versions folder'))
      result = await $.process.run(['mv', '-n', '--', from, to], { timeoutMs: 60_000 })
    }
  } catch (error) {
    if (error instanceof WriteError) throw error
    throw new WriteError(why(String((error as { message?: unknown })?.message ?? error), name))
  }
  if (result.exitCode !== 0 || !(await $.fs.exists(to)) || (await $.fs.exists(from))) throw new WriteError(why(result.stderr || result.stdout || 'the move did not happen', name))
}

/** A free name in a folder: "budget_v2.xlsx", else "budget_v2 (2).xlsx", "(3)"… */
export async function freeName($: EngineInterface, folder: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let k = 1; k < 200; k += 1) {
    const candidate = `${folder}/${k === 1 ? name : `${stem} (${k})${ext}`}`
    if (!(await $.fs.exists(candidate))) return candidate
  }
  throw new WriteError(`The Older versions folder already has too many copies of ${name}.`)
}

// ════ versions ════

/**
 * A stored version, read back as a document: the same readers Lazy Panda
 * Panel uses, for every kind of file Panda Redline tracks. Read once per
 * content, then kept for a while.
 */

const DOC_MAX_ROWS = 20_000
const DOC_MAX_LINE = 20_000
const docCache = new Map<string, Doc>()

const kindName = (ext: string) => (ext === 'docx' ? 'Word document' : ext === 'pdf' ? 'PDF' : ext === 'xlsx' || ext === 'xlsm' ? 'workbook' : 'file')

/** Rows made safe to draw and to compare: tables as cells joined by a bar, never padded (padding would change with the widest cell). */
function cleanRows(rows: (DocRow & { cells?: string[]; isHeader?: boolean })[]): DocRow[] {
  return rows.slice(0, DOC_MAX_ROWS).map(row => {
    const { cells, isHeader, spans, ...rest } = row
    void spans
    const text = stripControls(cells ? cells.join(' │ ') : row.style === 'th' || row.style === 'td' ? row.text.split(' | ').join(' │ ') : row.text)
    return { ...rest, text: text.length > DOC_MAX_LINE ? `${text.slice(0, DOC_MAX_LINE)}…` : text, ...(cells ? { style: isHeader ? ('th' as const) : ('td' as const) } : {}) }
  })
}

/** An empty document of the kind a file is: what a deleted file, or one not there yet, compares as. */
export const emptyOf = (path: string): Doc => (['xlsx', 'xlsm', 'csv', 'tsv'].includes(extOf(path)) ? { kind: 'grid', path, sheets: [] } : { kind: 'lines', path, rows: [], isFormatted: !['txt'].includes(extOf(path)) })

/** An Office file saved with a password is not a zip but an older compound file. */
const isLocked = (bytes: Uint8Array) => bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0

export async function parseBytes(path: string, bytes: Uint8Array): Promise<Doc> {
  const ext = extOf(path)
  try {
    if (['xlsx', 'xlsm', 'docx'].includes(ext) && isLocked(bytes)) {
      return { kind: 'error', path, message: `This ${kindName(ext)} is protected with a password, so its changes can't be shown. Panda Redline still keeps its versions, and Restore still works.`, isNotice: true }
    }
    if (ext === 'xlsx' || ext === 'xlsm' || ext === 'docx' || ext === 'pdf') {
      startReading(6000)
      try {
        if (ext === 'docx') {
          const word = readDocx(bytes)
          return { kind: 'lines', path, rows: cleanRows(word.rows), isFormatted: true, ...(word.note ? { note: word.note } : {}) }
        }
        if (ext === 'pdf') {
          const pdf = await readPdf(bytes)
          if (pdf.kind === 'error') return { ...pdf, path, message: /password|encrypt/i.test(pdf.message) ? 'This PDF is protected with a password, so its changes can’t be shown. Panda Redline still keeps its versions.' : pdf.message }
          return { kind: 'lines', path, rows: cleanRows(pdf.rows), isFormatted: true, ...(pdf.note ? { note: pdf.note } : {}) }
        }
        return { ...readXlsx(bytes), path }
      } finally {
        stopReading()
      }
    }
    const text = stripControls(new TextDecoder('utf-8').decode(bytes))
    if (ext === 'csv' || ext === 'tsv') {
      const { sheet, isCut } = readCsv(text, ext)
      return { kind: 'grid', path, sheets: [sheet], ...(isCut ? { note: 'Only the first 5,000 rows and 60 columns are compared.' } : {}) }
    }
    if (ext === 'md' || ext === 'markdown') return { kind: 'lines', path, rows: cleanRows(markdownRows(text)), isFormatted: true }
    if (ext === 'html' || ext === 'htm') return { kind: 'lines', path, rows: cleanRows(htmlRows(text)), isFormatted: true }
    if (ext === 'adf') {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      if (isAdf(parsed)) return { kind: 'lines', path, rows: cleanRows(adfRows(parsed)), isFormatted: true }
      return { kind: 'error', path, message: 'This version isn’t a Confluence page Panda Redline can read (it may have been saved halfway).' }
    }
    const rows: DocRow[] = text.split('\n').map((line, i) => ({ text: line.replace(/\t/g, '  '), anchor: `line ${i + 1}`, unit: 'line' }))
    if (rows.length > 1 && rows[rows.length - 1]?.text === '') rows.pop()
    return { kind: 'lines', path, rows: cleanRows(rows) }
  } catch (error) {
    if (error instanceof TooSlow) return { kind: 'error', path, message: `This ${kindName(ext)} takes too long to read here. Open it in its own app to see it.` }
    return { kind: 'error', path, message: `This version couldn’t be read (it may have been saved halfway): ${sanitizeLine(error instanceof Error ? error.message : String(error), 200)}.` }
  }
}

/** A version as a document; a deleted file is an empty one. */
export async function readVersion($: EngineInterface, v: Version): Promise<Doc> {
  if (v.key === null) return emptyOf(v.path)
  const id = `${v.key}|${extOf(v.path)}`
  const hit = docCache.get(id)
  if (hit) return { ...hit, path: v.path }
  const base64 = await getBlob($, v.key)
  if (base64 === null) return { kind: 'error', path: v.path, message: 'This version is no longer kept (older versions are let go after a while: see /redline settings).' }
  const doc = await parseBytes(v.path, bytesOf(base64))
  docCache.set(id, doc)
  for (const key of docCache.keys()) if (docCache.size > 12 && key !== id) docCache.delete(key)
  return doc
}

// ════ tracker ════

/**
 * Noting what changed. At the start of Claude's turn the working folder is
 * noted (only files that changed since are read); at its end, whatever
 * changed becomes the newest version of its document, however Claude saved it.
 */

const DEPTH = 3
const ENTRIES = 4000
const MAX_DOCS = 400
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '__pycache__', 'venv', 'Older versions'])


// ── Looking at the folder ──

type Seen = { size: number; mtime: number }

/**
 * The documents in the working folder: 3 levels down, 4,000 entries at most,
 * never through a link or a Windows junction, never in hidden folders,
 * node_modules and the like, a home folder or a drive's root.
 */
export async function scanFolder($: EngineInterface, folder: string, extra: readonly string[] = []): Promise<{ found: Map<string, Seen>; isCut: boolean }> {
  const found = new Map<string, Seen>()
  if (isHomeOrRoot(folder)) return { found, isCut: false }
  let left = ENTRIES
  let isCut = false
  const realRoot = (await $.fs.stat(folder, { resolve: true }).catch(() => undefined))?.realPath?.replace(/\\/g, '/')
  const walk = async (dir: string, depth: number) => {
    if (left <= 0) {
      isCut = true
      return
    }
    let entries
    try {
      entries = await $.fs.list(dir)
    } catch {
      return
    }
    left -= entries.length
    for (const entry of entries) {
      if (entry.isLink || entry.name.startsWith('.') || entry.name.startsWith('~$')) continue
      const path = `${dir.replace(/\/$/, '')}/${entry.name}`
      if (entry.kind === 'dir') {
        if (depth <= 0 || SKIP_DIRS.has(entry.name)) continue
        // A junction can pass for a folder: one that leads outside where it sits is never entered.
        if (realRoot) {
          const real = (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath?.replace(/\\/g, '/')
          if (!real || !real.toLowerCase().startsWith(`${realRoot.toLowerCase().replace(/\/$/, '')}/`)) continue
        }
        await walk(path, depth - 1)
      } else if (entry.kind === 'file' && isTracked(entry.name)) {
        found.set(path, { size: entry.size, mtime: entry.mtimeMs })
      }
    }
  }
  await walk(folder, DEPTH)
  // Files Claude wrote deeper down still count.
  for (const path of extra) {
    if (found.has(path) || !isTracked(path)) continue
    const st = await $.fs.stat(path).catch(() => undefined)
    if (st && st.kind === 'file' && !st.isLink) found.set(path, { size: st.size, mtime: st.mtimeMs })
  }
  if (found.size > MAX_DOCS) {
    // The most recently changed first; the rest wait.
    const keep = [...found.entries()].sort((a, b) => b[1].mtime - a[1].mtime).slice(0, MAX_DOCS)
    return { found: new Map(keep), isCut: true }
  }
  return { found, isCut }
}

/** Reads a file and stores its content: its key, or why it couldn't be kept. */
async function capture($: EngineInterface, path: string, seen: Seen): Promise<{ key: string } | { reason: string }> {
  if (seen.size > BIG_MAX) return { reason: `it is ${mb(seen.size)}, and Panda Redline keeps files up to 50 MB` }
  let base64: string
  if (seen.size > READ_MAX) {
    const got = await readBigBase64($, path)
    if (typeof got !== 'string') return got
    base64 = got
  } else {
    try {
      base64 = (await $.fs.read(path, { as: 'bytes' })).base64
    } catch (error) {
      const text = String((error as { message?: unknown })?.message ?? error)
      // Windows: Excel and Word hold the files they have open.
      if (/ENOENT/.test(text)) return { reason: 'it was gone before it could be read' }
      // Windows: Excel and Word hold the files they have open, so they can't be read.
      return { reason: 'it couldn’t be read; it may be open in another app such as Excel (close it there, and it’s caught at the end of Claude’s next turn)' }
    }
  }
  const key = contentKey(base64)
  await putBlob($, key, base64)
  return { key }
}

const mb = (size: number) => `${(size / (1024 * 1024)).toFixed(1)} MB`

const newId = () => crypto.randomUUID().slice(0, 13)

// ── Versions and families ──

function addFamily(path: string): Family {
  const id = newId()
  const fam: Family = { id, name: nameOf(path), kind: kindOf(path) ?? 'text', home: path, paths: [path], versions: [] }
  vault.index.families[id] = fam
  return fam
}

function addVersion(fam: Family, v: Omit<Version, 'id' | 'family'>): Version {
  const version: Version = { ...v, id: newId(), family: fam.id }
  vault.index.versions[version.id] = version
  fam.versions.push(version.id)
  if (!fam.paths.includes(v.path)) fam.paths.push(v.path)
  return version
}


export const familyOfPath = (path: string): Family | undefined => {
  const known = vault.index.files[path]
  if (known) return vault.index.families[known.family]
  return Object.values(vault.index.families).find(f => f.paths.includes(path))
}

// ── Noting the folder ──

type Look = { now: Map<string, Seen>; isCut: boolean }

/** Paths Claude wrote with Write or Edit this session, wherever they are below the working folder. */
export const written = new Set<string>()

async function look($: EngineInterface): Promise<Look> {
  const { found, isCut } = await scanFolder($, vault.folder, [...written])
  return { now: found, isCut }
}

/**
 * Brings the record up to date with the folder as it is: what changed since
 * it was last noted is read and stored, and comes back as edits, new files
 * and deletions. Nothing is attributed here.
 */
async function difference($: EngineInterface, l: Look) {
  const idx = vault.index
  const edits: { path: string; key: string; seen: Seen }[] = []
  const created: { path: string; key: string; seen: Seen }[] = []
  const deleted: string[] = []
  const skipped: Skipped[] = []
  for (const [path, seen] of l.now) {
    const known = idx.files[path]
    if (known && known.size === seen.size && known.mtime === seen.mtime) continue
    const got = await capture($, path, seen)
    if ('reason' in got) {
      skipped.push({ path, reason: got.reason })
      continue
    }
    if (known && known.key === got.key) {
      // Touched, not changed.
      known.mtime = seen.mtime
      continue
    }
    ;(known ? edits : created).push({ path, key: got.key, seen })
  }
  for (const path of Object.keys(idx.files)) {
    if (l.now.has(path)) continue
    // Past the folder's limits is not deleted: only a file truly gone is.
    if (l.isCut && (await $.fs.exists(path).catch(() => true))) continue
    if (await $.fs.exists(path).catch(() => false)) continue
    deleted.push(path)
  }
  return { edits, created, deleted, skipped }
}

async function fingerprint($: EngineInterface, v: Version): Promise<string[]> {
  if (v.fp) return v.fp
  if (v.key === null) return []
  try {
    v.fp = fingerprintOf(await readVersion($, v))
  } catch {
    v.fp = []
  }
  return v.fp
}

/**
 * The start of a turn (or a first look): whatever changed since Claude's last
 * turn ended was changed by the person (or by another app), so it is noted as
 * theirs, and only what Claude does from here is shown as Claude's.
 */
export async function noteStart($: EngineInterface, turnId: string) {
  const idx = vault.index
  if (idx.running) return
  const startedAt = Date.now()
  const l = await look($)
  const d = await difference($, l)
  const by: Who = idx.isReady ? 'you' : 'first'
  for (const e of d.edits) {
    const fam = familyOfPath(e.path) ?? addFamily(e.path)
    addVersion(fam, { path: e.path, key: e.key, size: e.seen.size, at: startedAt, by })
    idx.files[e.path] = { key: e.key, size: e.seen.size, mtime: e.seen.mtime, family: fam.id }
  }
  for (const e of d.created) {
    // A file the person added between turns is a document of its own (or one they had before).
    const fam = familyOfPath(e.path) ?? addFamily(e.path)
    addVersion(fam, { path: e.path, key: e.key, size: e.seen.size, at: startedAt, by })
    idx.files[e.path] = { key: e.key, size: e.seen.size, mtime: e.seen.mtime, family: fam.id }
  }
  for (const path of d.deleted) {
    const fam = familyOfPath(path)
    if (fam) addVersion(fam, { path, key: null, size: 0, at: startedAt, by })
    delete idx.files[path]
  }
  idx.skipped = d.skipped
  idx.isReady = true
  idx.running = { id: turnId, start: startedAt }
  await saveIndex($)
}

export type TurnResult = { turn: Turn | null; asks: Ask[]; skipped: Skipped[] }

/**
 * The end of Claude's turn: each change becomes the newest version of its
 * document. A file changed in place is its own next version; a new file joins
 * the document it came from (by type, folder, name and content) or starts one;
 * a deleted file is a version with nothing in it; a file moved or renamed
 * keeps its document.
 */
export async function noteEnd($: EngineInterface, status: Turn['status'], by: 'claude' | 'example' = 'claude', retry?: () => Promise<void>): Promise<TurnResult> {
  const idx = vault.index
  const running = idx.running ?? { id: newId(), start: Date.now() }
  idx.running = null
  const l = await look($)
  let d = await difference($, l)
  // A file read halfway through a save: looked at again once, a moment later.
  if (retry && d.skipped.length > 0) {
    await retry()
    const again = await difference($, await look($))
    d = { edits: [...d.edits, ...again.edits], created: [...d.created, ...again.created], deleted: [...new Set([...d.deleted, ...again.deleted])], skipped: again.skipped }
  }
  const endedAt = Date.now()
  const startOf = new Map<string, string | null>()
  const touched: string[] = []
  const note = status === 'stopped' ? 'stopped partway' : status === 'failed' ? 'ended with an error' : undefined
  const remember = (fam: Family) => {
    if (!startOf.has(fam.id)) startOf.set(fam.id, latestOf(fam)?.id ?? null)
    if (!touched.includes(fam.id)) touched.push(fam.id)
  }
  const stamp = (path: string, key: string, seen: Seen, fam: Family) => (idx.files[path] = { key, size: seen.size, mtime: seen.mtime, family: fam.id })
  // A version's time is when it was noted; the file's own time only orders what happened in the turn.
  const base = (path: string, key: string | null, size: number, at: number) => ({ path, key, size, at: Math.min(Math.max(at, running.start), endedAt), by: by as Who, turn: running.id, ...(note ? { note } : {}) })

  // Renamed or moved: a file gone and a new one with the same content.
  const gone = new Set(d.deleted)
  const fresh: typeof d.created = []
  for (const c of d.created) {
    const from = [...gone].find(path => idx.files[path]?.key === c.key && kindOf(path) === kindOf(c.path))
    if (from) {
      gone.delete(from)
      const fam = vault.index.families[idx.files[from]!.family]!
      remember(fam)
      addVersion(fam, { ...base(c.path, c.key, c.seen.size, c.seen.mtime || endedAt), note: `moved from ${nameOf(from)}` })
      if (fam.home === from) fam.home = c.path
      delete idx.files[from]
      stamp(c.path, c.key, c.seen, fam)
    } else fresh.push(c)
  }
  // Changes in the order they happened, so an edit and a copy both read in turn.
  type Event = { at: number; run: () => Promise<void> }
  const events: Event[] = []
  for (const e of d.edits) {
    events.push({
      at: e.seen.mtime,
      run: async () => {
        const fam = familyOfPath(e.path) ?? addFamily(e.path)
        remember(fam)
        addVersion(fam, base(e.path, e.key, e.seen.size, e.seen.mtime || endedAt))
        stamp(e.path, e.key, e.seen, fam)
      },
    })
  }
  const asks: Ask[] = []
  for (const c of fresh) {
    events.push({
      at: c.seen.mtime,
      run: async () => {
        const probe: Version = { id: '', family: '', ...base(c.path, c.key, c.seen.size, c.seen.mtime || endedAt) }
        const fp = await fingerprint($, probe)
        const candidates: Candidate[] = []
        for (const fam of Object.values(idx.families)) {
          if (fam.kind !== kindOf(c.path)) continue
          const last = latestOf(fam)
          // Its newest version that has content: what a copy would be made from.
          const source = [...fam.versions].reverse().map(id => idx.versions[id]).find(v => v && v.key !== null)
          if (!last || !source) continue
          // Names say most; content is read only for candidates with a name or folder in common.
          const isNear = folderOf(source.path) === folderOf(c.path) || stemOf(source.path) === stemOf(c.path)
          candidates.push({ family: fam.id, path: source.path, ...(isNear ? { fingerprint: await fingerprint($, source) } : {}) })
        }
        let match = matchParent(c.path, fp, candidates)
        // An answer the person gave before wins.
        const answered = match.best ? idx.answers[`${c.path}→${match.best.path}`] : undefined
        if (answered === 'yes' && match.best) match = { ...match, verdict: 'sure' }
        if (answered === 'no') match = { verdict: 'none', others: [] }
        const parent = match.verdict !== 'none' && match.best ? idx.families[match.best.family] : undefined
        if (parent && match.verdict === 'sure') {
          remember(parent)
          addVersion(parent, { ...probe, fp })
          stamp(c.path, c.key, c.seen, parent)
          return
        }
        const fam = addFamily(c.path)
        remember(fam)
        const v = addVersion(fam, { ...probe, fp })
        stamp(c.path, c.key, c.seen, fam)
        if (parent && match.best) {
          asks.push({ version: v.id, path: c.path, guess: { family: parent.id, path: match.best.path }, others: match.others.map(o => ({ family: o.family, path: o.path })) })
        }
      },
    })
  }
  for (const path of gone) {
    events.push({
      at: endedAt,
      run: async () => {
        const fam = familyOfPath(path)
        if (fam) {
          remember(fam)
          addVersion(fam, base(path, null, 0, endedAt))
        }
        delete idx.files[path]
      },
    })
  }
  events.sort((a, b) => a.at - b.at)
  for (const e of events) await e.run()
  idx.skipped = d.skipped
  idx.asks = [...idx.asks.filter(a => idx.versions[a.version]), ...asks]
  let turn: Turn | null = null
  if (touched.length > 0) {
    turn = {
      id: running.id,
      start: running.start,
      end: endedAt,
      by,
      status,
      changes: touched.map(family => ({ family, before: startOf.get(family) ?? null, after: latestOf(idx.families[family]!)!.id })),
    }
    idx.turns.push(turn)
  }
  await saveIndex($)
  return { turn, asks, skipped: d.skipped }
}

// ── Answers to "is this a new version of that?" ──

/**
 * Moves a document's versions into another document: "Yes, report_final.docx
 * is a new version of report.docx." The turns that showed it as a new
 * document now show it as that document's change.
 */
export async function joinFamily($: EngineInterface, versionId: string, intoFamily: string, answerFor?: string) {
  const idx = vault.index
  const v = idx.versions[versionId]
  const into = idx.families[intoFamily]
  if (!v || !into) return
  const from = idx.families[v.family]
  if (!from || from.id === into.id) return
  for (const id of from.versions) {
    const one = idx.versions[id]
    if (!one) continue
    one.family = into.id
  }
  into.versions = [...into.versions, ...from.versions].sort((a, b) => (idx.versions[a]?.at ?? 0) - (idx.versions[b]?.at ?? 0))
  for (const p of from.paths) if (!into.paths.includes(p)) into.paths.push(p)
  for (const [path, known] of Object.entries(idx.files)) if (known.family === from.id) idx.files[path] = { ...known, family: into.id }
  for (const turn of idx.turns) {
    const mine = turn.changes.find(c => c.family === from.id)
    if (!mine) continue
    const theirs = turn.changes.find(c => c.family === into.id)
    if (theirs) {
      // Both in one turn: from where the document was, to whichever is newer.
      const a = idx.versions[theirs.after]
      const b = idx.versions[mine.after]
      theirs.after = (b?.at ?? 0) >= (a?.at ?? 0) ? mine.after : theirs.after
      turn.changes = turn.changes.filter(c => c !== mine)
    } else {
      // The document's version from before this turn is where the change starts.
      const before = into.versions.map(id => idx.versions[id]).filter((x): x is Version => !!x && x.at < turn.start && x.family === into.id).pop()
      mine.family = into.id
      mine.before = before?.id ?? null
    }
  }
  delete idx.families[from.id]
  if (answerFor) idx.answers[answerFor] = 'yes'
  idx.asks = idx.asks.filter(a => a.version !== versionId)
  await saveIndex($)
}

export async function answerNo($: EngineInterface, ask: Ask) {
  vault.index.answers[`${ask.path}→${ask.guess.path}`] = 'no'
  vault.index.asks = vault.index.asks.filter(a => a.version !== ask.version)
  await saveIndex($)
}

// ── Versions made by the pane: restore and keep ──

/** Notes a file Panda Redline itself just wrote, as a version of its document. */
export async function noteWrite($: EngineInterface, fam: Family, path: string, key: string, by: Who, note: string) {
  const st = await $.fs.stat(path).catch(() => undefined)
  const v = addVersion(fam, { path, key, size: st?.size ?? 0, at: Date.now(), by, note })
  vault.index.files[path] = { key, size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0, family: fam.id }
  await saveIndex($)
  return v
}

/** Makes sure the file as it is now is kept as a version, so a restore can always be undone. */
export async function keepCurrent($: EngineInterface, fam: Family, path: string): Promise<Version | undefined> {
  const st = await $.fs.stat(path).catch(() => undefined)
  if (!st || st.kind !== 'file') return undefined
  const got = await capture($, path, { size: st.size, mtime: st.mtimeMs })
  if ('reason' in got) throw new Error(`${nameOf(path)} couldn't be saved first: ${got.reason}`)
  const last = [...fam.versions].reverse().map(id => vault.index.versions[id]).find(v => v?.path === path)
  if (last && last.key === got.key) return last
  return noteWrite($, fam, path, got.key, 'you', 'saved before restoring')
}

/**
 * Reads a version's file again: a file read halfway through a save is read
 * whole once it is saved, and the version takes the whole file.
 */
export async function recapture($: EngineInterface, versionId: string) {
  const v = vault.index.versions[versionId]
  if (!v || v.key === null) return
  const st = await $.fs.stat(v.path).catch(() => undefined)
  if (!st || st.kind !== 'file') return
  const got = await capture($, v.path, { size: st.size, mtime: st.mtimeMs })
  if ('reason' in got) return
  v.key = got.key
  v.size = st.size
  delete v.fp
  const known = vault.index.files[v.path]
  if (known) vault.index.files[v.path] = { ...known, key: got.key, size: st.size, mtime: st.mtimeMs }
  await saveIndex($)
}

export function forgetPath(path: string) {
  delete vault.index.files[path]
}

// ── Keeping only so much ──

export type Retention = { versions: number; days: number }

/**
 * Keeps the newest `versions` versions of each document, and none older than
 * `days`; the newest of each is always kept. Stored content no version uses
 * any more is let go.
 */
export async function prune($: EngineInterface, keep: Retention) {
  const idx = vault.index
  const cutoff = Date.now() - keep.days * 24 * 60 * 60 * 1000
  for (const fam of Object.values(idx.families)) {
    const keepIds = new Set<string>()
    const list = fam.versions.map(id => idx.versions[id]).filter((v): v is Version => !!v)
    // The window: versions from the last `days`, and the one just before them, so the first change in the window still has its before.
    const firstRecent = list.findIndex(v => v.at >= cutoff)
    const from = Math.max(firstRecent < 0 ? list.length - 1 : firstRecent - 1, list.length - keep.versions, 0)
    list.forEach((v, k) => {
      const isOnDisk = Object.values(idx.files).some(f => f.key === v.key && f.family === fam.id && f.key !== null) && k === list.length - 1
      if (k >= from || isOnDisk) keepIds.add(v.id)
    })
    for (const id of fam.versions) if (!keepIds.has(id)) delete idx.versions[id]
    fam.versions = fam.versions.filter(id => keepIds.has(id))
  }
  idx.turns = idx.turns
    .map(t => ({ ...t, changes: t.changes.filter(c => idx.versions[c.after]).map(c => (c.before && !idx.versions[c.before] ? { ...c, before: null } : c)) }))
    .filter(t => t.changes.length > 0 && t.end >= cutoff)
  await dropUnused($)
  await saveIndex($)
}

async function dropUnused($: EngineInterface) {
  const used = new Set<string>()
  for (const v of Object.values(vault.index.versions)) if (v.key) used.add(v.key)
  for (const f of Object.values(vault.index.files)) used.add(f.key)
  const store = `${vault.project}/store`
  let dirs
  try {
    dirs = await $.fs.list(store)
  } catch {
    return
  }
  for (const dir of dirs) {
    if (dir.kind !== 'dir') continue
    const entries = await $.fs.list(`${store}/${dir.name}`).catch(() => [])
    for (const entry of entries) {
      const m = /^(.+)\.0$/.exec(entry.name)
      if (m && entry.size > 0 && !used.has(m[1]!)) await dropBlob($, m[1]!)
    }
  }
}

/** Space used by every project's saved versions, in bytes, and how many documents and versions. */
export async function spaceUsed($: EngineInterface): Promise<{ bytes: number; here: number; projects: number }> {
  let bytes = 0
  let here = 0
  let projects = 0
  const root = `${vault.data}/projects`
  const sum = async (dir: string, depth: number): Promise<number> => {
    let total = 0
    const entries = await $.fs.list(dir).catch(() => [])
    for (const e of entries) {
      if (e.kind === 'file') total += e.size
      else if (e.kind === 'dir' && depth > 0 && !e.isLink) total += await sum(`${dir}/${e.name}`, depth - 1)
    }
    return total
  }
  for (const p of await $.fs.list(root).catch(() => [])) {
    if (p.kind !== 'dir') continue
    projects += 1
    const size = await sum(`${root}/${p.name}`, 3)
    bytes += size
    if (`${root}/${p.name}` === vault.project) here = size
  }
  return { bytes, here, projects }
}

/** Forgets every saved version of this folder; the files themselves are not touched. */
export async function clearProject($: EngineInterface) {
  const files = vault.index.files
  vault.index = { ...emptyIndex(vault.folder), files: {} }
  // What's on disk now is where tracking starts again.
  vault.index.isReady = false
  await dropUnused($)
  void files
  await saveIndex($)
}

// ════ the pane ════

const PANE = 'redline'
const TITLE = 'Panda Redline'

const DEFAULT_PANE: PaneState = {
  turn: null,
  doc: 0,
  family: null,
  before: null,
  after: null,
  view: 'changes',
  target: null,
  mode: 'auto',
  top: 0,
  left: 0,
  sheet: 0,
  focus: null,
  open: [],
  cell: null,
  isListOpen: false,
  isCommenting: false,
}
const DEFAULT_SETTINGS: Settings = { notices: true, autoOpen: false, tell: 'next', keepVersions: 20, keepDays: 7 }

const pane = atom({ plugin: 'panda-redline', key: 'pane' } as const, DEFAULT_PANE)
const tick = atom({ plugin: 'panda-redline', key: 'tick' } as const, 0)
const flash = atom({ plugin: 'panda-redline', key: 'flash' } as const, { key: 0, turn: null, fresh: [] })
const settings = atom({ plugin: 'panda-redline', key: 'prefs' } as const, DEFAULT_SETTINGS)
const comments = atom({ plugin: 'panda-redline', key: 'comments' } as const, [])
const notes = atom({ plugin: 'panda-redline', key: 'notes' } as const, [])
const banner = atom({ plugin: 'panda-redline', key: 'banner' } as const, null)

/** What this session's hooks share; set again on each load by session.start. */
const session = {
  folder: '',
  /** How to open a file in the computer's own app; null over SSH or with no desktop. */
  opener: null as 'open' | 'xdg-open' | 'explorer' | null,
  /** Comments sent, waiting for Claude's turn to finish. */
  isSending: false,
  /** Space used, worked out when the settings open. */
  space: null as { bytes: number; here: number; projects: number } | null,
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const megabytes = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`)
const errorText = (error: unknown) => sanitizeLine(String((error as { message?: unknown })?.message ?? error), 200)

// ── Words for times and people ──

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A time as people say it: "2.14pm" today, "Tue 2.14pm" this week, "3 Oct 2.14pm" before. */
export function clock(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const h = d.getHours()
  const time = `${h % 12 === 0 ? 12 : h % 12}.${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`
  if (d.toDateString() === new Date(now).toDateString()) return time
  if (now - ms < 6 * 24 * 60 * 60 * 1000 && ms < now) return `${DAYS[d.getDay()]} ${time}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`
}

const WHO: Record<Who, string> = { claude: 'by Claude', you: 'by you', first: 'as first seen', restore: 'restored by you', keep: 'kept by you', example: 'by Claude (example)' }
const whoOf = (v: Version) => `${WHO[v.by]}${v.note ? ` (${v.note})` : ''}`
const shortWho = (v: Version) => (v.by === 'claude' || v.by === 'example' ? 'Claude' : v.by === 'first' ? 'First seen' : 'You')
const isClaude = (v: Version) => v.by === 'claude' || v.by === 'example'

const APPS: Record<string, string> = { xlsx: 'Excel', xlsm: 'Excel', csv: 'Excel', tsv: 'Excel', docx: 'Word', pdf: 'your PDF reader', html: 'your browser', htm: 'your browser' }

// ── What the pane shows ──

type Shown = { fam: Family; before: Version | null; after: Version; turn: Turn | null; docs: TurnChange[]; index: number }

/** The newest of Claude's turns that changed documents. */
const lastTurn = () => [...vault.index.turns].reverse().find(t => t.changes.length > 0)

function shownOf(p: PaneState): Shown | null {
  const idx = vault.index
  if (p.family) {
    const fam = idx.families[p.family]
    if (!fam) return null
    const after = (p.after ? idx.versions[p.after] : undefined) ?? latestOf(fam)
    if (!after) return null
    let before: Version | null = null
    if (p.before) before = idx.versions[p.before] ?? null
    else {
      // Claude's change that made this version, when there is one; else the version before it.
      const turn = [...idx.turns].reverse().find(t => t.changes.some(c => c.family === fam.id && c.after === after.id))
      const change = turn?.changes.find(c => c.family === fam.id)
      if (change) before = change.before ? (idx.versions[change.before] ?? null) : null
      else {
        const at = fam.versions.indexOf(after.id)
        before = at > 0 ? (idx.versions[fam.versions[at - 1]!] ?? null) : null
      }
    }
    return { fam, before, after, turn: null, docs: [{ family: fam.id, before: before?.id ?? null, after: after.id }], index: 0 }
  }
  const turn = (p.turn ? idx.turns.find(t => t.id === p.turn) : undefined) ?? lastTurn()
  if (!turn) return null
  const docs = turn.changes.filter(c => idx.families[c.family] && idx.versions[c.after])
  if (docs.length === 0) return null
  const index = clamp(p.doc, 0, docs.length - 1)
  const change = docs[index]!
  const fam = idx.families[change.family]!
  const after = idx.versions[change.after]!
  const before = change.before ? (idx.versions[change.before] ?? null) : null
  return { fam, before, after, turn, docs, index }
}

type Compared = {
  key: string
  cmp: LinesComparison | GridComparison | null
  error?: string
  /** A version that couldn't be read is still there: Reload reads the file again. */
  canReload?: boolean
  changes: Change[]
  summary: string
  note?: string
}

const compared = new Map<string, Compared>()

async function compareOf($: EngineInterface, before: Version | null, after: Version): Promise<Compared> {
  const key = `${before?.key ?? '-'}|${after.key ?? '-'}|${extOf(after.path)}|${before ? extOf(before.path) : ''}`
  const hit = compared.get(key)
  if (hit) return hit
  const a = await readVersion($, after)
  const b = before
    ? await readVersion($, before)
    : a.kind === 'grid'
      ? { kind: 'grid' as const, path: after.path, sheets: [] }
      : { kind: 'lines' as const, path: after.path, rows: [], isFormatted: a.kind === 'lines' && a.isFormatted === true }
  let out: Compared
  if (a.kind === 'error' || b.kind === 'error') {
    const bad = a.kind === 'error' ? a : (b as Extract<typeof b, { kind: 'error' }>)
    out = { key, cmp: null, error: bad.message, canReload: a.kind === 'error' && !a.isNotice && after.key !== null, changes: [], summary: '' }
  } else if (a.kind === 'grid' && b.kind === 'grid') {
    const cmp = compareGrids(b.sheets, a.sheets)
    const changes = changesOf(cmp)
    out = { key, cmp, changes, summary: summaryOf(cmp, changes), ...(a.note ? { note: a.note } : {}) }
  } else if (a.kind === 'lines' && b.kind === 'lines') {
    const cmp = compareLines(b.rows, a.rows, a.isFormatted === true || b.isFormatted === true)
    const changes = changesOf(cmp)
    out = { key, cmp, changes, summary: summaryOf(cmp, changes), ...(a.note ? { note: a.note } : {}) }
  } else {
    out = { key, cmp: null, error: 'These two versions are different kinds of file, so they can’t be compared.', changes: [], summary: '' }
  }
  compared.set(key, out)
  for (const k of compared.keys()) if (compared.size > 16 && k !== key) compared.delete(k)
  return out
}

type AnyLaid = Laid & { moreLeft?: number; moreRight?: number }
const laidCache = new Map<string, AnyLaid>()

function laidOf(c: Compared, p: PaneState, width: number, mode: 'inline' | 'side', sheet: number): AnyLaid {
  const key = `${c.key}|${width}|${mode}|${p.open.join(',')}|${sheet}|${p.left}|${p.cell ?? ''}`
  const hit = laidCache.get(key)
  if (hit) return hit
  let laid: AnyLaid
  if (!c.cmp) laid = { rows: [], changeAt: [] }
  else if (c.cmp.kind === 'lines') laid = layoutLines(c.cmp, c.changes, { width, mode, open: new Set(p.open) })
  else {
    const sc = c.cmp.sheets[sheet]
    laid = sc ? layoutGrid(sc, sheet, c.changes, { width, mode, open: new Set(p.open), left: p.left, picked: p.cell }) : { rows: [], changeAt: [] }
  }
  laidCache.set(key, laid)
  for (const k of laidCache.keys()) if (laidCache.size > 12 && k !== key) laidCache.delete(k)
  return laid
}

const forgetDrawings = () => {
  compared.clear()
  laidCache.clear()
}

/** What a surface last drew, for clicks and keys. */
type Drawn = { laid: Laid; top: number; height: number; changes: Change[]; sheet: number; isGrid: boolean; sheets: number; columns: number }
const drawnBy = new Map<RenderSurface, Drawn>()

// ── Opening and moving about ──

async function openPane($: EngineInterface, focus = false) {
  const opened = await $.ui.open({ id: PANE, title: TITLE, rows: 34 })
  // While a command runs the prompt still holds its text, so the keys are asked for a moment after; then n, p and the rest work at once (Esc gives them back).
  if (focus) $.clock.after(150, () => void takeKeys($))
  return opened
}

async function takeKeys($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE, focus: true }).catch(() => undefined)
  await $.ui.focus({ requestId: PANE, key: 'next' }).catch(() => undefined)
}

async function redraw($: EngineInterface) {
  await update($, tick, n => n + 1)
}

async function setBanner($: EngineInterface, text: string | null, tone: 'info' | 'error' | 'success' = 'info') {
  await update($, banner, () => (text ? { text, tone } : null))
}

async function setView($: EngineInterface, view: PaneView, target: string | null = null) {
  await update($, pane, old => ({ ...old, view, target, isCommenting: false }))
}

/** Shows a turn's documents from the first, with nothing picked. */
async function showTurn($: EngineInterface, turnId: string | null, doc = 0) {
  await update($, pane, old => ({ ...DEFAULT_PANE, mode: old.mode, turn: turnId, doc }))
}

/** Shows one document: its last change, or two versions chosen from its timeline. */
async function showFamily($: EngineInterface, family: string, before: string | null = null, after: string | null = null, view: PaneView = 'changes') {
  await update($, pane, old => ({ ...DEFAULT_PANE, mode: old.mode, family, before, after, view }))
}

/** Goes to a change: its sheet, its line in view, its column in view. */
async function focusChange($: EngineInterface, index: number, surface: RenderSurface) {
  const d = drawnBy.get(surface)
  const changes = d?.changes ?? []
  if (changes.length === 0) return
  const i = ((index % changes.length) + changes.length) % changes.length
  const change = changes[i]!
  await update($, pane, old => {
    const sheet = change.sheet ?? old.sheet
    const left = change.col !== undefined ? Math.max(0, change.col - 1) : sheet !== old.sheet ? 0 : old.left
    const isHere = sheet === (d?.sheet ?? 0) && left === old.left
    const at = isHere ? (d?.laid.changeAt[i] ?? 0) : -1
    const height = d?.height ?? 10
    // Off this sheet or scrolled sideways, the line is found on the next draw.
    const top = at < 0 ? old.top : at < old.top || at >= old.top + height - 1 ? Math.max(0, at - 2) : old.top
    return { ...old, focus: i, sheet, left, top, cell: null, isCommenting: false }
  })
  if (!(d && (change.sheet ?? d.sheet) === d.sheet)) {
    // Drawn on the new sheet first, then scrolled to.
    await redraw($)
    const again = drawnBy.get(surface)
    const at = again?.laid.changeAt[i]
    if (again && at !== undefined) await update($, pane, old => ({ ...old, top: Math.max(0, at - 2) }))
  }
}

async function onKey($: EngineInterface, key: string, surface: RenderSurface) {
  const d = drawnBy.get(surface)
  const p = await read($, pane)
  const total = d?.laid.rows.length ?? 0
  const height = d?.height ?? 10
  const scrollTo = (top: number) => update($, pane, old => ({ ...old, top: clamp(top, 0, Math.max(0, total - height)) }))
  // From where the view is drawn, which may differ from where it was left (it opens at the first change).
  const at = d?.top ?? p.top
  if (key === 'down') return scrollTo(at + 1)
  if (key === 'up') return scrollTo(at - 1)
  if (key === 'pagedown' || key === 'space' || key === ' ') return scrollTo(at + height - 1)
  if (key === 'pageup') return scrollTo(at - height + 1)
  if (key === 'home') return scrollTo(0)
  if (key === 'end') return scrollTo(total)
  if (key === 'n' || key === 'j' || key === 'tab') return focusChange($, (p.focus ?? -1) + 1, surface)
  if (key === 'p' || key === 'k') return focusChange($, (p.focus ?? 0) - 1, surface)
  if ((key === 'left' || key === 'right') && d?.isGrid) return update($, pane, old => ({ ...old, left: Math.max(0, old.left + (key === 'left' ? -1 : 1)) }))
  if ((key === '[' || key === ']') && d?.isGrid && d.sheets > 1) return update($, pane, old => ({ ...old, sheet: clamp(old.sheet + (key === '[' ? -1 : 1), 0, d.sheets - 1), top: 0, left: 0, cell: null }))
  if (key === ',' || key === '<' || key === '.' || key === '>') return stepDoc($, key === ',' || key === '<' ? -1 : 1)
  if (key === 'v') return toggleMode($, d?.columns ?? 80)
  if (key === 'h') return setView($, p.view === 'history' ? 'changes' : 'history')
  if (key === 'c' && p.focus !== null) return update($, pane, old => ({ ...old, isCommenting: true }))
  if (key === 'l') return update($, pane, old => ({ ...old, isListOpen: !old.isListOpen }))
  if (key === 'return' && p.focus !== null && d?.isGrid) {
    // Enter on a change in a sheet shows its cell's old and new formula.
    const change = d.changes[p.focus]
    if (change?.col !== undefined) return update($, pane, old => ({ ...old, cell: old.cell === `${change.op}:${change.col}` ? null : `${change.op}:${change.col}` }))
  }
}

async function stepDoc($: EngineInterface, delta: number) {
  const p = await read($, pane)
  const shown = shownOf(p)
  if (!shown || shown.docs.length < 2) return
  const doc = (shown.index + delta + shown.docs.length) % shown.docs.length
  await update($, pane, old => ({ ...DEFAULT_PANE, mode: old.mode, turn: shown.turn?.id ?? old.turn, doc }))
}

/** Inline on small panes; side by side once there is room for two readable columns. */
const autoMode = (columns: number): 'inline' | 'side' => (columns >= 120 ? 'side' : 'inline')

async function toggleMode($: EngineInterface, columns: number) {
  await update($, pane, old => {
    const now = old.mode === 'auto' ? autoMode(columns) : old.mode
    return { ...old, mode: now === 'inline' ? ('side' as const) : ('inline' as const), top: 0, left: 0 }
  })
}

async function onClick($: EngineInterface, post: { y: number; x: number }, surface: RenderSurface) {
  const d = drawnBy.get(surface)
  if (!d) return
  const row = d.laid.rows[d.top + post.y]
  if (!row) return
  if (row.fold) {
    const id = row.fold
    await update($, pane, old => ({ ...old, open: [...old.open, id] }))
    return
  }
  const spot = row.cells?.find(c => post.x >= c.x && post.x < c.x + c.w + 2)
  await update($, pane, old => ({
    ...old,
    ...(row.change !== undefined ? { focus: row.change } : {}),
    cell: spot ? (old.cell === spot.key ? null : spot.key) : old.cell,
    isCommenting: false,
  }))
}

// ── Restore and keep ──

/** Tells Claude a file is not what it last saw: with the person's next message, or at once. */
async function tell($: EngineInterface, note: string) {
  const s = await read($, settings)
  if (s.tell === 'now') {
    void $.prompt.submit({ text: `Panda Redline note: ${note}` })
    return 'Claude has been told.'
  }
  await update($, notes, old => [...old, note])
  await $.store.set('notes', await read($, notes))
  return 'Claude will be told with your next message.'
}

/** The file a document lives in now: its newest version's file. */
const currentPath = (fam: Family) => latestOf(fam)?.path ?? fam.home

async function restore($: EngineInterface, versionId: string) {
  const idx = vault.index
  const v = idx.versions[versionId]
  const fam = v ? idx.families[v.family] : undefined
  if (!v || !fam || v.key === null) {
    await setBanner($, 'That version has no content to put back.', 'error')
    return
  }
  const target = currentPath(fam)
  try {
    const base64 = await getBlob($, v.key)
    if (base64 === null) throw new WriteError('That version is no longer kept, so it can’t be put back.')
    // What is there now is kept first, so this restore can be undone.
    const saved = await keepCurrent($, fam, target)
    await writeExactly($, target, base64)
    const made = await noteWrite($, fam, target, v.key, 'restore', `back to the ${clock(v.at)} version`)
    const lastClaude = [...fam.versions].reverse().map(id => idx.versions[id]).find(x => x && isClaude(x))
    const isBeforeClaude = !!lastClaude && v.at < lastClaude.at
    const told = await tell($, `I restored ${noteName(target, session.folder)} to the ${clock(v.at)} version${isBeforeClaude ? ', from before your last change' : ''}. Re-read it before editing it again.`)
    forgetDrawings()
    await showFamily($, fam.id, saved?.id ?? null, made.id)
    await setBanner($, `✓ ${nameOf(target)} is back to the ${clock(v.at)} version. ${told}`, 'success')
  } catch (error) {
    await setView($, 'changes')
    await setBanner($, error instanceof WriteError ? error.message : `Couldn’t restore ${nameOf(target)}: ${errorText(error)}`, 'error')
  }
  await redraw($)
}

type KeepPlan = { fam: Family; keep: Version; home: string; moves: { from: string; to: string }[] }

/** What Keep this version would do: the version goes in the document's own file, every copy that's there now into "Older versions". */
async function keepPlan($: EngineInterface, fam: Family, keep: Version): Promise<KeepPlan | null> {
  const home = fam.home
  const on = Object.entries(vault.index.files)
    .filter(([, k]) => k.family === fam.id)
    .map(([path]) => path)
  const others = on.filter(path => path !== home)
  if (others.length === 0 && keep.path === home) return null
  const moves: { from: string; to: string }[] = []
  const taken = new Set<string>()
  for (const from of [...on.filter(p => p === home), ...others]) {
    const folder = `${folderOf(from)}/Older versions`
    let to = await freeName($, folder, nameOf(from))
    for (let k = 2; taken.has(to) && k < 200; k += 1) to = await freeName($, folder, nameOf(from).replace(/(\.[^.]+)?$/, ` (${k})$1`))
    taken.add(to)
    moves.push({ from, to })
  }
  return { fam, keep, home, moves }
}

async function keepVersion($: EngineInterface, plan: KeepPlan) {
  const { fam, keep, home, moves } = plan
  const moved: string[] = []
  try {
    if (keep.key === null) throw new WriteError('That version has no content to keep.')
    const base64 = await getBlob($, keep.key)
    if (base64 === null) throw new WriteError('That version is no longer kept.')
    for (const m of moves) {
      await moveFile($, m.from, m.to)
      forgetPath(m.from)
      moved.push(m.from)
    }
    await writeExactly($, home, base64)
    await noteWrite($, fam, home, keep.key, 'keep', `kept the ${clock(keep.at)} version`)
    fam.paths = [home, ...fam.paths.filter(p => p !== home)]
    await saveIndex($)
    const others = moves.filter(m => m.from !== home).map(m => noteName(m.from, session.folder))
    const told = await tell(
      $,
      `I kept the ${clock(keep.at)} version of ${noteName(home, session.folder)}${keep.path !== home ? ` (from ${noteName(keep.path, session.folder)})` : ''}${others.length > 0 ? ` and moved ${others.join(', ')} into the "Older versions" folder` : ''}. Use ${noteName(home, session.folder)} from now on, and re-read it before editing it.`,
    )
    forgetDrawings()
    await showFamily($, fam.id, null, null, 'history')
    await setBanner($, `✓ Kept the ${clock(keep.at)} version as ${nameOf(home)}.${moves.length > 0 ? ` ${plural(moves.length, 'copy', 'copies')} moved to Older versions.` : ''} ${told}`, 'success')
  } catch (error) {
    await saveIndex($)
    await setView($, 'changes')
    const done = moved.length > 0 ? ` Already moved to Older versions: ${moved.map(nameOf).join(', ')}.` : ''
    await setBanner($, `${error instanceof WriteError ? error.message : `Couldn’t keep this version: ${errorText(error)}`}${done}`, 'error')
  }
  await redraw($)
}

/** Opens a file in the computer's own app, as double-clicking it would. */
async function openOutside($: EngineInterface, path: string) {
  $.ui.toast(`Opening ${nameOf(path)}…`)
  try {
    if (session.opener === 'open') await $.process.run(['open', path], { timeoutMs: 10_000 })
    else if (session.opener === 'xdg-open') await $.process.run(['xdg-open', path], { timeoutMs: 10_000 })
    else if (session.opener === 'explorer') await $.process.run(['explorer.exe', path.replace(/\//g, '\\')], { timeoutMs: 10_000 })
  } catch {
    $.ui.toast(`Couldn’t open ${nameOf(path)}. Open it from your files instead.`)
  }
}

async function openerHere($: EngineInterface): Promise<typeof session.opener> {
  if (host.os === 'windows') return 'explorer'
  if (host.os === 'mac') return 'open'
  return (await $.env.get('DISPLAY')) || (await $.env.get('WAYLAND_DISPLAY')) ? 'xdg-open' : null
}

// ── Comments ──

/** What a change quotes: the text or value before, and now. */
function quotesOf(c: Compared, change: Change): { before: string; after: string } {
  const cmp = c.cmp
  if (!cmp) return { before: '', after: '' }
  if (cmp.kind === 'lines') {
    const take: [string[], string[]] = [[], []]
    const first = cmp.ops[change.op]
    for (let k = change.op; k < cmp.ops.length && first; k += 1) {
      const op = cmp.ops[k]!
      if (k > change.op && op.kind !== first.kind) break
      if (op.kind === 'del' || op.kind === 'mod') take[0].push(cmp.before[op.a]!.text)
      if (op.kind === 'add' || op.kind === 'mod') take[1].push(cmp.after[op.b]!.text)
      if (op.kind === 'mod' || op.kind === 'same') break
    }
    return { before: take[0].join('\n'), after: take[1].join('\n') }
  }
  const sheet = cmp.sheets[change.sheet ?? 0]
  if (!sheet) return { before: '', after: '' }
  const op = sheet.rows[change.op]
  const col = change.col !== undefined ? sheet.cols[change.col] : undefined
  const cellText = (cell: { v: string; f?: string } | undefined) => (cell ? `${cell.v}${cell.f ? ` (${cell.f})` : ''}` : '')
  if (op && col && op.kind === 'mod' && col.kind === 'same') return { before: cellText(sheet.before?.rows[op.a]?.[col.a]), after: cellText(sheet.after?.rows[op.b]?.[col.b]) }
  if (op && (op.kind === 'add' || op.kind === 'del') && change.col === undefined) {
    const row = op.kind === 'add' ? sheet.after?.rows[op.b] : sheet.before?.rows[op.a]
    const text = (row ?? []).map(cell => cell.v).filter(Boolean).join(' | ')
    return op.kind === 'add' ? { before: '', after: text } : { before: text, after: '' }
  }
  return { before: change.kind === 'added' ? '' : change.label, after: change.kind === 'removed' ? '' : change.label }
}

async function addComment($: EngineInterface, text: string, shown: Shown, c: Compared, index: number) {
  const trimmed = text.trim()
  const change = c.changes[index]
  if (!change) return
  const existing = (await read($, comments)).find(x => x.status === 'draft' && x.family === shown.fam.id && x.change === index)
  if (existing) {
    if (trimmed === '') await update($, comments, old => old.filter(x => x.id !== existing.id))
    else await update($, comments, old => old.map(x => (x.id === existing.id ? { ...x, text: trimmed } : x)))
  } else if (trimmed !== '') {
    const q = quotesOf(c, change)
    const sheetName = change.sheet !== undefined && c.cmp?.kind === 'grid' ? c.cmp.sheets[change.sheet]?.name : undefined
    const label = sheetName && /^[A-Z]+\d+:/.test(change.label) ? `${sheetName}!${change.label}` : change.label
    const one: RedlineComment = { id: crypto.randomUUID(), path: shown.after.path, label: label.slice(0, 200), before: q.before, after: q.after, text: trimmed, status: 'draft', family: shown.fam.id, change: index }
    await update($, comments, old => [...old, one])
    $.ui.toast('✓ Comment added. Pick another change, or send when you’re done.')
  }
  await update($, pane, old => ({ ...old, isCommenting: false }))
}

async function deliver($: EngineInterface, how: 'fill' | 'submit') {
  const drafts = (await read($, comments)).filter(c => c.status === 'draft')
  if (drafts.length === 0) return
  let text = feedbackPrompt(drafts, session.folder)
  const waiting = await read($, notes)
  if (waiting.length > 0) {
    text = `Panda Redline note: ${waiting.join(' ')}\n\n${text}`
    await update($, notes, () => [])
    await $.store.set('notes', [])
  }
  const ids = new Set(drafts.map(c => c.id))
  if (how === 'fill') {
    const box = await $.prompt.read()
    const filled = await $.prompt.fill(box.text.trim() === '' ? { text, mode: 'replace' } : { text: `\n\n${text}`, mode: 'append' })
    if (!filled.isFilled) {
      $.ui.toast('Couldn’t reach the prompt box. Try “Send to Claude” instead.')
      return
    }
    await update($, comments, old => old.filter(c => !ids.has(c.id)))
    $.ui.toast(`Your ${plural(drafts.length, 'comment')} ${drafts.length === 1 ? 'is' : 'are'} in the prompt box. Edit, then press Enter.`)
    return
  }
  session.isSending = true
  await update($, comments, old => old.map(c => (ids.has(c.id) ? { ...c, status: 'sent' as const } : c)))
  void $.prompt.submit({ text })
  $.ui.toast(`✓ Sent ${plural(drafts.length, 'comment')}. Claude is on it.`)
}

// ── Claude's turn ──

/** What a turn changed, in a line for the transcript: "budget.xlsx has 7 changes". */
async function turnLine($: EngineInterface, turn: Turn): Promise<string> {
  const parts: string[] = []
  for (const change of turn.changes.slice(0, 4)) {
    const after = vault.index.versions[change.after]
    if (!after) continue
    const before = change.before ? (vault.index.versions[change.before] ?? null) : null
    const name = nameOf(after.path)
    if (after.key === null) parts.push(`${name} was deleted`)
    else if (!before) parts.push(`${name} is new`)
    else {
      const c = await compareOf($, before, after).catch(() => null)
      const of = before.path !== after.path ? ` (a new version of ${nameOf(before.path)})` : ''
      parts.push(c?.cmp ? `${name}${of} has ${plural(c.changes.length, 'change')}` : `${name}${of} changed`)
    }
  }
  const more = turn.changes.length - 4
  return `${parts.join(', ')}${more > 0 ? `, and ${plural(more, 'more document')} changed` : ''}`
}

async function afterTurn($: EngineInterface, status: Turn['status']) {
  const result = await noteEnd($, status, 'claude', () => $.clock.sleep(1500))
  const s = await read($, settings)
  await prune($, { versions: s.keepVersions, days: s.keepDays }).catch(() => undefined)
  if (result.turn) {
    const p = await read($, pane)
    // What the person was looking at gives way to the new changes, unless they are in the middle of something.
    if (!['restore', 'keep', 'clear', 'settings'].includes(p.view) && !p.isCommenting) await showTurn($, null)
    await update($, flash, old => ({ key: old.key + 1, turn: result.turn?.id ?? null, fresh: [] }))
    if (s.notices) $.ui.log(`Panda Redline: ${await turnLine($, result.turn)}. /redline to see ${result.turn.changes.length === 1 ? 'it' : 'them'}`)
    if (s.autoOpen) {
      const opened = await openPane($)
      if (!opened.isPlaced) $.ui.toast('🐼 Claude changed your documents. Type /redline to see what changed.')
    }
  }
  if (s.notices) {
    for (const ask of result.asks) $.ui.log(`Panda Redline: is ${nameOf(ask.path)} a new version of ${nameOf(ask.guess.path)}? /redline to answer`)
    for (const skip of result.skipped.slice(0, 3)) $.ui.log(`Panda Redline: couldn’t keep a copy of ${nameOf(skip.path)}: ${skip.reason}`)
  }
  await redraw($)
}

// ── /redline examples ──

type GenRow = (string | number | null | { f: string; v: number })[]

function budgetSheets(isAfter: boolean): { name: string; rows: GenRow[] }[] {
  const items: [string, number[]][] = isAfter
    ? [
        ['Rent', [12000, 12000, 12000]],
        ['Insurance', [1800, 1800, 1800]],
        ['Salaries', [48000, 48000, 50000]],
        ['Marketing', [8000, 6000, 7000]],
        ['Software', [2400, 2400, 2400]],
        ['Travel', [3000, 2500, 3200]],
      ]
    : [
        ['Rent', [12000, 12000, 12000]],
        ['Salaries', [48000, 48000, 50000]],
        ['Marketing', [8000, 9500, 7000]],
        ['Software', [2400, 2400, 2400]],
        ['Travel', [3000, 2500, 4000]],
      ]
  const rows: GenRow[] = [['Item', 'Q1', 'Q2', 'Q3', 'Total']]
  items.forEach(([name, q], k) => {
    const r = k + 2
    rows.push([name, ...q, { f: isAfter && name === 'Software' ? `=B${r}*3` : `=SUM(B${r}:D${r})`, v: q.reduce((a, b) => a + b, 0) }])
  })
  const last = items.length + 1
  const col = (c: number) => items.reduce((a, [, q]) => a + q[c]!, 0)
  rows.push(['Total', { f: `=SUM(B2:B${last})`, v: col(0) }, { f: `=SUM(C2:C${last})`, v: col(1) }, { f: `=SUM(D2:D${last})`, v: col(2) }, { f: `=SUM(E2:E${last})`, v: col(0) + col(1) + col(2) }])
  const inputs: GenRow[] = [['Assumption', 'Value'], ['Inflation', '3%'], ['Headcount', 6], ['Office days', 3]]
  return isAfter
    ? [{ name: 'Budget', rows }, { name: 'Inputs', rows: inputs }, { name: 'Forecast', rows: [['Quarter', 'Spend'], ['Q4', 75000], ['Q1 next year', 78000]] }]
    : [{ name: 'Budget', rows }, { name: 'Assumptions', rows: inputs }, { name: 'Notes', rows: [['Note'], ['Marketing spend to be reviewed in Q2.'], ['Travel budget includes the team offsite.']] }]
}

function reportBlocks(isAfter: boolean) {
  return [
    { p: 'Q3 Operations Report', style: 'Title' },
    { p: isAfter ? 'Summary' : 'Overview', style: 'Heading1' },
    { p: isAfter ? 'Customer calls fell by 12% this quarter, and first-call resolution rose to 81%.' : 'Customer calls fell by 9% this quarter, and first-call resolution rose to 78%.' },
    { p: 'The new billing system went live on 14 August without any outages.' },
    ...(isAfter ? [{ p: 'Two vendor contracts were renewed at lower rates, saving $18,000 a year.' }] : []),
    { p: 'Next steps', style: 'Heading1' },
    { p: 'Hire two more support staff before the summer peak.', style: 'ListBullet' },
    { p: isAfter ? 'Move the last 15% of customers to e-billing.' : 'Move the last 20% of customers to e-billing.', style: 'ListBullet' },
    ...(isAfter ? [] : [{ p: 'Review the office lease.', style: 'ListBullet' }]),
    { p: 'Key numbers', style: 'Heading1' },
    { table: [['Measure', 'Q2', 'Q3'], ['Calls', '42,100', isAfter ? '37,050' : '38,300'], ['Resolution', '74%', isAfter ? '81%' : '78%']] },
  ]
}

const PLAN_BEFORE = `# Launch plan: smart meter app

## Dates

- Beta opens on **3 November** for 200 customers.
- Full launch on **1 December**.

## Owners

| Task | Owner |
|---|---|
| App store listing | Priya |
| Support scripts | Tom |

## Risks

The meter data feed may lag by up to a day. We will show the last reading time on every screen.
`

const PLAN_AFTER = `# Launch plan: smart meter app

## Dates

- Beta opens on **10 November** for 500 customers.
- Full launch on **8 December**.
- Press release on launch day.

## Owners

| Task | Owner |
|---|---|
| App store listing | Priya |
| Support scripts | Jordan |

## Risks

The meter data feed may lag by up to six hours. We will show the last reading time on every screen.
`

const CSV_BEFORE = 'site,meter,reading_kwh,date\nNorth Depot,M-1001,1520,2026-10-01\nHarbour Office,M-1002,880,2026-10-01\nWest Yard,M-1003,2310,2026-10-01\nCity Store,M-1004,640,2026-10-01\n'
const CSV_AFTER = 'site,meter,reading_kwh,date\nNorth Depot,M-1001,1520,2026-10-01\nAirport Kiosk,M-1007,410,2026-10-01\nHarbour Office,M-1002,905,2026-10-01\nWest Yard,M-1003,2310,2026-10-01\nCity Store,M-1004,640,2026-10-01\n'

async function examples($: EngineInterface, base: string): Promise<string> {
  let folder = base
  for (let k = 2; await $.fs.exists(folder); k += 1) {
    if (k > 99) return `There are already 99 sample folders next to ${base}. Delete some first.`
    folder = `${base}-${k}`
  }
  if (!folder.startsWith(`${session.folder}/`)) return `The samples go inside the working folder (${session.folder}), so Panda Redline can track them.`
  if (vault.index.running) return 'Claude is working right now. Try /redline examples again when it finishes.'
  // Before: the documents as they were.
  const names = ['plan.md', 'meter-readings.csv']
  await $.fs.write(`${folder}/plan.md`, PLAN_BEFORE)
  await $.fs.write(`${folder}/meter-readings.csv`, CSV_BEFORE)
  let hasOffice = false
  try {
    await writeExactly($, `${folder}/budget.xlsx`, base64Of(makeXlsx(budgetSheets(false))))
    await writeExactly($, `${folder}/report.docx`, base64Of(makeDocx(reportBlocks(false))))
    names.push('budget.xlsx', 'report.docx')
    hasOffice = true
  } catch {
    /* no tool here writes Office files: the text samples still show */
  }
  for (const name of names) written.add(`${folder}/${name}`)
  await noteStart($, `example-${crypto.randomUUID().slice(0, 8)}`)
  // The "before" reads as a little earlier, as it would in a real session.
  const earlier = Date.now() - 17 * 60 * 1000
  for (const name of names) {
    const known = vault.index.files[`${folder}/${name}`]
    const fam = known ? vault.index.families[known.family] : undefined
    const v = fam ? latestOf(fam) : undefined
    if (v) v.at = earlier
  }
  const running = vault.index.running as { id: string; start: number } | null
  if (running) running.start = earlier + 1
  // After: Claude's changes. The budget comes back as a new file, budget_v2.xlsx, as Claude often does.
  if (hasOffice) {
    await writeExactly($, `${folder}/budget_v2.xlsx`, base64Of(makeXlsx(budgetSheets(true))))
    written.add(`${folder}/budget_v2.xlsx`)
    await $.clock.sleep(20)
    await writeExactly($, `${folder}/report.docx`, base64Of(makeDocx(reportBlocks(true))))
    await $.clock.sleep(20)
  }
  await $.fs.write(`${folder}/plan.md`, PLAN_AFTER)
  await $.clock.sleep(20)
  await $.fs.write(`${folder}/meter-readings.csv`, CSV_AFTER)
  const result = await noteEnd($, 'done', 'example')
  forgetDrawings()
  if (result.turn) {
    await showTurn($, result.turn.id)
    await update($, flash, old => ({ key: old.key + 1, turn: result.turn?.id ?? null, fresh: [] }))
  }
  await redraw($)
  return (
    `Wrote sample documents to ${shortPath(folder, session.folder)} and showed what “Claude” changed: ` +
    (hasOffice ? 'a budget saved as a new file (budget_v2.xlsx), a Word report, a Markdown plan and a CSV.' : 'a Markdown plan and a CSV. (This computer has no tool that writes Excel and Word samples.)')
  )
}

// ── Commands ──

const resolvePath = (path: string) => normalizePath(isAbsolutePath(path) ? path : `${session.folder}/${path}`)
const homeOf = (folder: string) => /^(?:[A-Z]:)?\/(?:home|Users)\/[^/]+|^\/root/i.exec(folder)?.[0]

function typedPath(text: string): string {
  let bare = text.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\\([ ()[\]'"&;!$#,])/g, '$1')
  const home = homeOf(session.folder)
  if (home && /^~(?:[\\/]|$)/.test(bare)) bare = home + bare.slice(1)
  return resolvePath(bare)
}

/** The document a typed name means: a file it has been, by path or by name. */
function familyNamed(text: string): Family | undefined {
  const path = typedPath(text).toLowerCase()
  const name = nameOf(text.trim()).toLowerCase()
  const fams = Object.values(vault.index.families)
  return (
    fams.find(f => f.paths.some(p => p.toLowerCase() === path)) ??
    fams.find(f => f.paths.some(p => nameOf(p).toLowerCase() === name)) ??
    fams.find(f => f.name.toLowerCase().startsWith(name.replace(/\.[^.]+$/, '')))
  )
}

async function setSetting($: EngineInterface, change: Partial<Settings>) {
  await update($, settings, old => ({ ...old, ...change }))
  await $.store.set('settings', await read($, settings))
}

/** Before a tool that can change files runs: the turn's start must have been noted, and a file Claude writes is watched wherever it is below the folder. */
async function beforeTool(path: unknown) {
  if (vault.pending) await vault.pending
  if (typeof path === 'string' && isTracked(path)) {
    const full = resolvePath(path)
    if (full.startsWith(`${session.folder}/`) && !full.slice(session.folder.length + 1).split('/').some(part => part.startsWith('.'))) written.add(full)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    session.folder = normalizePath(e.cwd)
    host.os = await detectOs($, session.folder)
    host.pluginRoot = $.plugin.root
    session.opener = await openerHere($)
    py.home = homeOf(session.folder) ?? ''
    await openVault($, session.folder)
    host.tmp = `${vault.data}/tmp`
    const started = await next(e)
    const stored = (await $.store.get('settings')) as Partial<Settings> | undefined
    await update($, settings, () => ({ ...DEFAULT_SETTINGS, ...(stored ?? {}) }))
    const waiting = (await $.store.get('notes')) as unknown
    if (Array.isArray(waiting)) await update($, notes, () => waiting.filter((n): n is string => typeof n === 'string'))
    // A sent comment's turn can't be followed across a reload.
    await update($, comments, old => old.filter(c => c.status !== 'sent'))
    if (!isHomeOrRoot(session.folder)) {
      // A turn left open by a session that ended mid-turn is closed now, as stopped partway.
      if (vault.index.running) await noteEnd($, 'stopped').catch(() => undefined)
      if (!vault.index.isReady) {
        // A first look: what is here now is where tracking starts. Nothing is shown for it.
        await noteStart($, 'first').catch(() => undefined)
        vault.index.running = null
        await saveIndex($).catch(() => undefined)
      }
    }
    await redraw($)
    if ((await $.store.get('welcomed')) !== true) {
      await $.store.set('welcomed', true)
      $.ui.toast('🐼 Panda Redline is ready. When Claude edits a document, /redline shows what changed. Try /redline examples. Nothing to install; documents over 4 MB need Python 3.')
    }
    await $.command.register({
      name: 'redline',
      description: 'See what Claude changed in your documents: /redline [file] · history <file> · settings · examples',
      argumentHint: '[file | history <file> | settings | examples | space | setup]',
    })
    return started
  })

  on('command.run', { command: 'redline' }, async ($, e) => {
    try {
      const args = e.args.trim()
      const word = args.toLowerCase().replace(/\s+/g, ' ')
      // Only the person changes settings, writes samples or clears versions; another plugin running /redline can't.
      const isPerson = ['composer', 'bridge', undefined].includes(e.origin?.kind as string | undefined)
      if (isHomeOrRoot(session.folder) && word !== 'setup') {
        return { text: 'Panda Redline doesn’t watch a home folder or a drive’s root (it would copy far too much). Start Claude Code in a project folder and try again.' }
      }
      const toggles: Record<string, Partial<Settings>> = {
        'notices on': { notices: true },
        'notices off': { notices: false },
        'auto on': { autoOpen: true },
        'auto off': { autoOpen: false },
        'tell next': { tell: 'next' },
        'tell now': { tell: 'now' },
      }
      const toggle = toggles[word]
      if (toggle) {
        if (!isPerson) return { text: 'Only you can change Panda Redline’s settings.', exitCode: 1 }
        await setSetting($, toggle)
        return { text: 'Saved.' }
      }
      if (word === 'settings' || word === 'space' || word === 'clear') {
        session.space = await spaceUsed($).catch(() => null)
        await setView($, word === 'clear' && isPerson ? 'clear' : 'settings')
        await openPane($, true)
        const s = session.space
        return { text: s ? `Saved versions use ${megabytes(s.here)} for this folder (${megabytes(s.bytes)} in all). The settings are open in the pane.` : 'The settings are open in the pane.' }
      }
      if (word === 'examples' || word.startsWith('examples ')) {
        if (!isPerson) return { text: 'Only you can write the samples: type /redline examples.', exitCode: 1 }
        const text = await examples($, typedPath(args.slice('examples'.length).trim() || 'panda-redline-examples'))
        const opened = await openPane($, true)
        return { text: opened.isPlaced ? text : `${text} Make the window wider to see the pane, or run /redline again.` }
      }
      if (word === 'setup') {
        py.cmd = null
        const found = await runPython($, '--check', 15_000)
        if (found !== 'none' && found !== 'timeout') return { text: `Python ${/LPP1 ok (\S+)/.exec(found)?.[1] ?? '3'} is ready: documents over 4 MB (up to 50 MB) are tracked too. Nothing was installed.` }
        return {
          text: 'Documents up to 4 MB are tracked with nothing installed. Documents over 4 MB need Python 3, which isn’t on this computer (or Claude Code can’t see it). Nothing has been installed. If you’d like it, ask Claude: “Please help me install Python 3 for Panda Redline.”',
        }
      }
      if (word === 'history' || word.startsWith('history ')) {
        const name = args.slice('history'.length).trim()
        const fam = name ? familyNamed(name) : shownOf(await read($, pane))?.fam
        if (!fam) return { text: name ? `Panda Redline has no versions of ${name} yet.` : 'Name a document: /redline history budget.xlsx', exitCode: 1 }
        await showFamily($, fam.id, null, null, 'history')
        await openPane($, isPerson)
        return { text: `${fam.name}: ${plural(fam.versions.length, 'version')}.` }
      }
      if (args) {
        const fam = familyNamed(args)
        if (!fam) {
          const path = typedPath(args)
          const isThere = await $.fs.exists(path)
          return {
            text: !isThere
              ? `No document at ${path}.`
              : !isTracked(path)
                ? `Panda Redline tracks Excel, Word, PDF, Markdown, Confluence, HTML, CSV and text files, not .${extOf(path) || '(no type)'} files.`
                : `Panda Redline hasn’t seen ${nameOf(path)} change yet.`,
            exitCode: 1,
          }
        }
        await showFamily($, fam.id)
      } else if ((await read($, pane)).view !== 'changes') {
        await setView($, 'changes')
      }
      // Typed by the person: the pane takes the keys, so n and p step through the changes at once (Esc gives them back).
      const opened = await openPane($, isPerson)
      return { text: opened.isPlaced ? 'Panda Redline opened.' : 'Panda Redline needs a wider terminal: make the window wider, or run /redline again.' }
    } catch (failure) {
      return { text: `/redline ${sanitizeLine(e.args.trim(), 200)} failed: ${errorText(failure)}`, exitCode: 1 }
    }
  }).catch(($, e, next) => next(e))

  // The note to Claude, when the person said "with my next message": beside their words, never changing them.
  on('prompt.submit', async ($, e, next) => {
    const waiting = await read($, notes)
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (waiting.length === 0 || !isPerson || e.text.trimStart().startsWith('/') || e.text.includes(PROMPT_HEADER)) return next(e)
    await update($, notes, () => [])
    await $.store.set('notes', [])
    $.ui.log(`Panda Redline told Claude: ${waiting.join(' ')}`)
    return next({ ...e, context: [...(e.context ?? []), `Panda Redline note: ${waiting.join(' ')}`] })
  }).catch(($, e, next) => next(e))

  // The start of Claude's turn: the folder is noted, so only Claude's changes are shown as Claude's.
  on('turn.start', async ($, e, next) => {
    if (!isHomeOrRoot(session.folder) && !vault.index.running) {
      vault.pending = noteStart($, e.turnId).catch(() => undefined)
      await vault.pending
      vault.pending = null
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Tools that change files: each waits for the turn's start to be noted, then is passed on unchanged.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    await beforeTool((((e as { input?: unknown }).input ?? e) as { file_path?: unknown }).file_path)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    await beforeTool((((e as { input?: unknown }).input ?? e) as { file_path?: unknown }).file_path)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    await beforeTool(undefined)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await beforeTool(undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || isHomeOrRoot(session.folder)) return done
    // Comments sent earlier have had their answer.
    if (session.isSending) {
      session.isSending = false
      await update($, comments, old => old.filter(c => c.status !== 'sent'))
    }
    if (!vault.index.running) return done
    await afterTurn($, e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed')
    return done
  }).catch(($, e, next) => next(e))

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const post = e.data as ChangesPost | { type: 'tab'; index: number } | { type: 'aside'; id: string }
    if (post.type === 'tab') {
      await update($, pane, old => ({ ...DEFAULT_PANE, mode: old.mode, turn: old.turn, doc: post.index }))
    } else if (post.type === 'aside') {
      if (post.id === 'mode') await toggleMode($, drawnBy.get(e.surface)?.columns ?? 80)
      else if (post.id === 'history') await setView($, (await read($, pane)).view === 'history' ? 'changes' : 'history')
      else if (post.id === 'settings') {
        session.space = await spaceUsed($).catch(() => null)
        await setView($, (await read($, pane)).view === 'settings' ? 'changes' : 'settings')
      }
    } else if (post.type === 'click') await onClick($, post, e.surface)
    else if (post.type === 'key') await onKey($, post.key, e.surface)
    return next(e)
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person' || !e.pointer) return next(e)
    const d = drawnBy.get('terminal')
    const total = d?.laid.rows.length ?? 0
    const height = d?.height ?? 10
    await update($, pane, old => ({ ...old, top: clamp((d?.top ?? old.top) + e.by * 3, 0, Math.max(0, total - height)) }))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Input, Client } = els as Partial<Elements['terminal']>
    const hasViews = e.surface === 'terminal' || e.surface === 'desktop'
    void (await read($, tick))
    const p = await read($, pane)
    const rows = e.props.scroll.bodyRows
    const shown = isHomeOrRoot(session.folder) ? null : shownOf(p)
    const ctx: Ctx = {
      els,
      Input: hasViews ? Input : undefined,
      Client: hasViews ? Client : undefined,
      surface: e.surface,
      columns: Math.max(36, e.props.bodyColumns),
      rows,
      isCompact: rows < 26,
      isTiny: rows < 16,
      p,
      s: await read($, settings),
      shown,
      c: shown ? await compareOf($, shown.before, shown.after) : null,
      notes: await read($, comments),
      banner: await read($, banner),
      flash: await read($, flash),
      waiting: await read($, notes),
    }
    return drawPane($, ctx)
  })
}

// ── Drawing the pane ──

type Els = ReturnType<EngineInterface['ui']['resolve']>
/** What a part of the pane draws: a tree, or nothing. */
type Part = RenderNode | null | undefined
type Ctx = {
  els: Els
  Input: Elements['terminal']['Input'] | undefined
  Client: Elements['terminal']['Client'] | undefined
  surface: RenderSurface
  columns: number
  rows: number
  isCompact: boolean
  /** A pane so short that only the changes and the way through them fit. */
  isTiny: boolean
  p: PaneState
  s: Settings
  shown: Shown | null
  c: Compared | null
  notes: RedlineComment[]
  banner: { text: string; tone: 'info' | 'error' | 'success' } | null
  flash: { key: number; turn: string | null; fresh: number[] }
  waiting: string[]
}

const pal = PALETTE

const CHANGES_PAL: ChangesPal = {
  text: pal.text,
  subtle: pal.subtle,
  dim: pal.dim,
  accent: pal.accent,
  h3: pal.h3,
  code: pal.code,
  error: pal.error,
  success: pal.success,
  warning: pal.warning,
  removedBg: 'diffRemoved',
  addedBg: 'diffAdded',
  glowBg: 'diffAddedWord',
}

function drawPane($: EngineInterface, ctx: Ctx): JSX.Element {
  const { Box, Text } = ctx.els
  const { p } = ctx
  const parts: Part[] = [topBar(ctx)]
  if (ctx.banner) parts.push(bannerRow($, ctx))
  const ask = vault.index.asks[0]
  if (p.view === 'settings') parts.push(settingsView($, ctx))
  else if (p.view === 'clear') parts.push(clearView($, ctx))
  else if (!ctx.shown) {
    if (ask) parts.push(askRow($, ctx, ask))
    parts.push(emptyView(ctx))
  } else {
    if (!ctx.isTiny) parts.push(versionsRow($, ctx))
    // A short pane keeps the question to a line in the summary; it's answered in a taller one.
    if (ask && p.view === 'changes' && !ctx.isTiny) parts.push(askRow($, ctx, ask))
    if (p.view === 'history') parts.push(historyView($, ctx))
    else if (p.view === 'pick-before' || p.view === 'pick-after') parts.push(pickView($, ctx))
    else if (p.view === 'restore') parts.push(restoreView($, ctx))
    else if (p.view === 'keep') parts.push(keepView($, ctx))
    else if (p.view === 'pick-parent') parts.push(pickParentView($, ctx))
    else parts.push(...changesView($, ctx))
  }
  const sent = ctx.notes.filter(n => n.status === 'sent').length
  if (sent > 0 && ctx.Client) {
    const props: SpinnerProps = { text: `Claude is working on ${plural(sent, 'comment')}…`, color: pal.claude, glow: pal.warning }
    parts.push(h(ctx.Client, { module: './spinner.tsx', key: 'spinner', props }))
  }
  if (ctx.waiting.length > 0) {
    parts.push(
      <Text color={pal.subtle} wrap="truncate-end">
        ✉ Claude will be told with your next message: {ctx.waiting.join(' ')}
      </Text>,
    )
  }
  return (
    <Box flexDirection="column" width={ctx.columns}>
      {parts.map((part, i) => (
        <Box key={`part-${i}`} flexDirection="column">
          {part}
        </Box>
      ))}
    </Box>
  )
}

function topBar(ctx: Ctx): Part {
  const { Text } = ctx.els
  const shown = ctx.shown
  const ext = shown ? extOf(shown.after.path) : ''
  const badge = BADGES[ext === 'xlsm' ? 'xlsx' : ext === 'tsv' ? 'csv' : ext === 'markdown' ? 'md' : ext]
  const side = (ctx.p.mode === 'auto' ? autoMode(ctx.columns) : ctx.p.mode) === 'side'
  const names = shown
    ? shown.docs.map((d, i) => {
        const fam = vault.index.families[d.family]
        const after = vault.index.versions[d.after]
        const name = fam?.name ?? ''
        // Saved as a new file: the document's name, then the file it's in now.
        return i === shown.index && after && nameOf(after.path) !== name ? `${name} → ${nameOf(after.path)}` : after && nameOf(after.path) !== name ? `${name} → ${nameOf(after.path)}` : name
      })
    : [TITLE]
  const isChanges = ctx.p.view === 'changes'
  const props: FileBarProps = {
    files: names.map(name => ({ name, color: pal.accent })),
    active: shown?.index ?? 0,
    colors: { accent: pal.accent, text: pal.text, subtle: pal.subtle, dim: pal.dim, band: pal.band },
    ...(badge ? { badge } : {}),
    width: ctx.columns,
    asides: shown
      ? [
          ...(isChanges ? [{ id: 'mode', label: side ? '◫ Side by side' : '▤ Inline', short: side ? '◫' : '▤', color: pal.accent }] : []),
          { id: 'history', label: '◷ History', short: '◷', color: ctx.p.view === 'history' ? pal.accent : pal.subtle, isBold: ctx.p.view === 'history' },
          { id: 'settings', label: '⚙', short: '⚙', color: ctx.p.view === 'settings' ? pal.accent : pal.subtle },
        ]
      : [{ id: 'settings', label: '⚙ Settings', short: '⚙', color: ctx.p.view === 'settings' ? pal.accent : pal.subtle }],
  }
  if (!ctx.Client) return <Text bold>{names[props.active] ?? TITLE}</Text>
  return h(ctx.Client, { module: './filebar.tsx', key: 'docs', props })
}

function bannerRow($: EngineInterface, ctx: Ctx): RenderNode {
  const { Box, Text, Button } = ctx.els
  const b = ctx.banner!
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={b.tone === 'error' ? pal.error : b.tone === 'success' ? pal.success : pal.accent} wrap="wrap">
          {b.text}
        </Text>
      </Box>
      <Button key="banner-x" label="✕" plain onPress={() => void setBanner($, null)} />
    </Box>
  )
}

function versionsRow($: EngineInterface, ctx: Ctx): RenderNode {
  const { Box, Text, Button } = ctx.els
  const { before, after } = ctx.shown!
  const narrow = ctx.columns < 70
  const pick = (view: PaneView) => () => void setView($, ctx.p.view === view ? 'changes' : view)
  return (
    <Box flexDirection="row" columnGap={1}>
      {before === null ? <Text color={pal.subtle}>New document,</Text> : null}
      {before !== null && !narrow ? <Text color={pal.subtle}>Before</Text> : null}
      {before !== null ? (
        <Button key="pick-before" plain onPress={pick('pick-before')}>
          <Text color={pal.accent} bold>{clock(before.at)} ▾</Text>
        </Button>
      ) : null}
      {before !== null ? <Text color={pal.dim}>→</Text> : null}
      {before !== null && !narrow ? <Text color={pal.subtle}>After</Text> : null}
      <Button key="pick-after" plain onPress={pick('pick-after')}>
        <Text color={pal.accent} bold>{clock(after.at)} ▾</Text>
      </Button>
      <Box flexShrink={1}>
        <Text color={isClaude(after) ? pal.claude : pal.text} wrap="truncate-end">
          {after.key === null ? 'deleted ' : ''}
          {narrow ? shortWho(after) : whoOf(after)}
        </Text>
      </Box>
    </Box>
  )
}

async function answer($: EngineInterface, ask: Ask, family: string | null) {
  if (family) await joinFamily($, ask.version, family, `${ask.path}→${ask.guess.path}`)
  else await answerNo($, ask)
  forgetDrawings()
  await setView($, 'changes')
  await redraw($)
}

function askRow($: EngineInterface, ctx: Ctx, ask: Ask): RenderNode {
  const { Box, Text, Button } = ctx.els
  return (
    <Box flexDirection="row" columnGap={1} {...(ctx.isCompact ? {} : { borderStyle: 'round', borderColor: pal.warning, paddingX: 1 })}>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap={ctx.isCompact ? 'truncate-end' : 'wrap'}>
          <Text color={pal.warning} bold>? </Text>
          Is <Text bold>{nameOf(ask.path)}</Text> a new version of <Text bold>{nameOf(ask.guess.path)}</Text>?
        </Text>
      </Box>
      <Button key="ask-yes" label="Yes" variant="primary" onPress={() => void answer($, ask, ask.guess.family)} />
      <Button key="ask-no" label="No" onPress={() => void answer($, ask, null)} />
      <Button key="ask-pick" label={ctx.columns < 70 ? 'Other' : 'Pick another'} plain onPress={() => void setView($, 'pick-parent')} />
    </Box>
  )
}

function pickParentView($: EngineInterface, ctx: Ctx): RenderNode {
  const { Box, Text, Button } = ctx.els
  const ask = vault.index.asks[0]
  if (!ask) return <Text color={pal.subtle}>Nothing to answer.</Text>
  const asked = vault.index.versions[ask.version]?.family
  const kind = vault.index.families[asked ?? '']?.kind
  const options = Object.values(vault.index.families)
    .filter(f => f.id !== asked && f.kind === kind)
    .slice(0, 12)
  return (
    <Box flexDirection="column">
      <Text bold>Which document is {nameOf(ask.path)} a new version of?</Text>
      {options.map(f => (
        <Button key={`parent-${f.id}`} plain onPress={() => void answer($, { ...ask, guess: { family: f.id, path: currentPath(f) } }, f.id)}>
          {`  ${f.name}`}
          <Text color={pal.dim}>  {shortPath(folderOf(currentPath(f)), vault.folder) || 'in this folder'}</Text>
        </Button>
      ))}
      <Box flexDirection="row" columnGap={2}>
        <Button key="parent-none" label="None: it’s a new document" plain onPress={() => void answer($, ask, null)} />
        <Button key="parent-back" label="Back" plain onPress={() => void setView($, 'changes')} />
      </Box>
    </Box>
  )
}

function emptyView(ctx: Ctx): RenderNode {
  const { Box, Text } = ctx.els
  const isWatched = !isHomeOrRoot(session.folder)
  const message = isWatched
    ? ['No changes from Claude yet.', 'When Claude edits a document,', 'it’ll show up here.']
    : ['Panda Redline doesn’t watch a home', 'folder or a drive’s root. Start', 'Claude Code in a project folder.']
  const hints = (
    <>
      <Text wrap="truncate-end">
        <Text color={pal.subtle}>Try it:    </Text>
        <Text color={pal.accent}>/redline examples</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={pal.subtle}>One file:  </Text>
        <Text color={pal.accent}>/redline budget.xlsx</Text>
      </Text>
    </>
  )
  // A short pane: no spacing, the message on as few lines as the width allows.
  if (ctx.rows < 10) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold color={pal.accent}>{message[0]} </Text>
          <Text color={pal.text}>{message.slice(1).join(' ')}</Text>
        </Text>
        {isWatched && hints}
      </Box>
    )
  }
  // The panda only when it fits whole beside the text.
  const panda = ctx.rows >= 20 && ctx.columns >= 70 ? pandaRows() : []
  return (
    <Box flexDirection="row" columnGap={3} paddingTop={1}>
      {panda.length > 0 && (
        <Box flexDirection="column" flexShrink={0}>
          {panda.map((runs, y) => (
            <Text key={`panda-${y}`}>
              {runs.map((run, x) => (
                <Text key={`p${x}`} {...(run.color ? { color: run.color } : {})} {...(run.background ? { backgroundColor: run.background } : {})}>
                  {run.text}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column">
        {panda.length > 0 && <Text> </Text>}
        <Text bold color={pal.accent}>{message[0]}</Text>
        <Text color={pal.text}>{message[1]}</Text>
        <Text color={pal.text}>{message[2]}</Text>
        <Text> </Text>
        {isWatched && hints}
      </Box>
    </Box>
  )
}

function changesView($: EngineInterface, ctx: Ctx): Part[] {
  const { Box, Text, Button } = ctx.els
  const { p } = ctx
  const shown = ctx.shown!
  const c = ctx.c
  const out: Part[] = []
  if (!c) return out
  if (c.error) {
    out.push(
      <Box flexDirection="column" marginTop={ctx.isCompact ? 0 : 1}>
        <Text color={pal.warning} wrap="wrap">
          ⓘ {c.error}
        </Text>
        {c.canReload ? (
          <Button
            key="reload"
            label="⟳ Reload"
            onPress={async () => {
              await recapture($, shown.after.id)
              forgetDrawings()
              await redraw($)
            }}
          />
        ) : null}
      </Box>,
    )
    out.push(actionsRow($, ctx, null))
    return out
  }
  const cmp = c.cmp!
  const isGrid = cmp.kind === 'grid'
  const sheets = isGrid ? cmp.sheets : []
  const sheet = isGrid ? clamp(p.sheet, 0, Math.max(0, sheets.length - 1)) : 0
  out.push(
    <Text wrap="truncate-end">
      {ctx.isTiny ? (
        <Text color={pal.subtle}>
          {shown.before ? `${clock(shown.before.at)} → ` : 'New · '}
          {clock(shown.after.at)} {shortWho(shown.after)} ·{' '}
        </Text>
      ) : null}
      <Text bold color={c.changes.length > 0 ? pal.text : pal.subtle}>
        {c.changes.length > 0 ? (ctx.isTiny ? plural(c.changes.length, 'change') : c.summary) : 'No changes between these two versions'}
      </Text>
      {ctx.isTiny && vault.index.asks[0] ? <Text color={pal.warning}> · ? a question for you (make the pane taller)</Text> : null}
      {c.note && !ctx.isCompact ? <Text color={pal.dim}>  ⓘ {c.note}</Text> : null}
    </Text>,
  )
  let extras = 0
  if (isGrid && sheets.length > 1 && !ctx.isTiny) {
    extras += 1
    out.push(
      <Box flexDirection="row" columnGap={2}>
        {sheets.map((one, i) => {
          const mark = one.status === 'added' ? '+ ' : one.status === 'removed' ? '− ' : one.status === 'same' ? '' : '~ '
          const color = one.status === 'added' ? pal.success : one.status === 'removed' ? pal.error : one.status === 'same' ? pal.subtle : pal.warning
          const isOn = i === sheet
          return (
            <Button key={`sheet-${i}`} plain onPress={() => void update($, pane, old => ({ ...old, sheet: i, top: 0, left: 0, cell: null }))}>
              <Text color={isOn ? pal.accent : color} bold={isOn} underline={isOn}>
                {`${mark}${cutTo(one.name, 20)}${one.status === 'renamed' && ctx.columns >= 90 ? ` (was ${cutTo(one.was ?? '', 14)})` : ''}`}
              </Text>
            </Button>
          )
        })}
      </Box>,
    )
  }
  const picked = isGrid && p.cell ? cellDetail(ctx, cmp as GridComparison, sheet, p.cell) : null
  if (picked) extras += 1
  const drafts = ctx.notes.filter(n => n.status === 'draft')
  const listLines = c.changes.length === 0 ? 0 : p.isListOpen ? Math.min(c.changes.length, ctx.isCompact ? 4 : 8) + 1 : 1
  const hasActions = !ctx.isTiny || ctx.rows >= 12
  extras += listLines + (p.isCommenting ? (ctx.isCompact ? 1 : 3) : 0) + (drafts.length > 0 ? 1 : 0) + (hasActions ? 1 : 0) + (ctx.isCompact ? 0 : 2)
  const fixed = (ctx.isTiny ? 2 : 3) + (ctx.banner ? 1 : 0) + (vault.index.asks[0] && !ctx.isTiny ? (ctx.isCompact ? 1 : 3) : 0) + extras + (ctx.waiting.length > 0 ? 1 : 0)
  const height = clamp(ctx.rows - fixed - 1, 3, 200)
  const mode = p.mode === 'auto' ? autoMode(ctx.columns) : p.mode
  const width = Math.max(30, ctx.columns - 3)
  const laid = laidOf(c, p, width, mode, sheet)
  const total = laid.rows.length
  // Opened fresh, the view starts where the first change is, if that's below what fits.
  const first = laid.changeAt[0] ?? 0
  const start = p.top === 0 && p.focus === null && first >= height - 1 ? first - 1 : p.top
  const top = clamp(start, 0, Math.max(0, total - height))
  const visible = laid.rows.slice(top, top + height)
  drawnBy.set(ctx.surface, { laid, top, height, changes: c.changes, sheet, isGrid, sheets: sheets.length, columns: ctx.columns })
  const below = total - top - visible.length
  const isFresh = ctx.flash.turn !== null && ctx.flash.turn === shown.turn?.id
  const props: ChangesProps = {
    pal: CHANGES_PAL,
    rows: visible,
    focus: p.focus,
    flashKey: isFresh ? ctx.flash.key : 0,
    fresh: isFresh ? c.changes.map((_, i) => i) : [],
    width,
    scroll: { top, shown: visible.length, total },
    // A short pane has the scrollbar to say there's more; a taller one says how much.
    ...(below > 0 && !ctx.isTiny ? { below: `${plural(below, 'more line')} below${ctx.columns >= 70 ? ' · scroll, PgDn, or n for the next change' : ''}` } : {}),
  }
  if (ctx.Client) out.push(h(ctx.Client, { module: './changes.tsx', key: 'changes', props, height: visible.length + (props.below ? 1 : 0) }))
  else out.push(<Text>{visible.map(rowText).join('\n')}</Text>)
  if (picked) out.push(picked)
  if (c.changes.length > 0) out.push(changeList($, ctx, c))
  if (p.isCommenting && p.focus !== null) out.push(commentBox($, ctx, shown, c, p.focus))
  if (drafts.length > 0) out.push(draftsRow($, ctx, drafts))
  if (hasActions) out.push(actionsRow($, ctx, c))
  if (!ctx.isCompact) out.push(keysRow($, ctx, isGrid, sheets.length))
  return out
}

/** A line as plain text, where the surface draws no views: marks only, no colour. */
const rowText = (row: DRow) => row.segs.map(s => (s.k === 'del' ? `[-${s.t}-]` : s.k === 'add' ? `{+${s.t}+}` : s.t)).join('')

function cellDetail(ctx: Ctx, cmp: GridComparison, sheetIndex: number, key: string): RenderNode | null {
  const { Text } = ctx.els
  const [opIndex, colIndex] = key.split(':').map(Number)
  const sheet = cmp.sheets[sheetIndex]
  const op = sheet?.rows[opIndex ?? -1]
  const col = sheet?.cols[colIndex ?? -1]
  if (!sheet || !op || !col) return null
  const before = op.kind !== 'add' && col.kind !== 'add' ? sheet.before?.rows[op.a]?.[col.a] : undefined
  const after = op.kind !== 'del' && col.kind !== 'del' ? sheet.after?.rows[op.b]?.[col.b] : undefined
  const where = op.kind !== 'del' && col.kind !== 'del' ? address(col.b, op.b) : op.kind !== 'add' && col.kind !== 'add' ? address(col.a, op.a) : ''
  const show = (cell: { v: string; f?: string } | undefined) => (cell ? `${cell.f ? `${cell.f} = ` : ''}${cell.v || '(empty)'}` : '(not there)')
  const isSame = before && after && before.v === after.v && (before.f ?? '') === (after.f ?? '')
  if (isSame) {
    return (
      <Text wrap="truncate-end">
        <Text color={pal.formula} bold>ƒx {where}  </Text>
        <Text color={pal.text}>{show(after)}</Text>
        <Text color={pal.dim}>  (unchanged)</Text>
      </Text>
    )
  }
  return (
    <Text wrap="truncate-end">
      <Text color={pal.formula} bold>ƒx {where}  </Text>
      <Text color={pal.subtle}>before </Text>
      <Text strikethrough color={pal.text} backgroundColor="diffRemoved">− {show(before)}</Text>
      <Text color={pal.subtle}>  now </Text>
      <Text underline color={pal.text} backgroundColor="diffAdded">+ {show(after)}</Text>
    </Text>
  )
}

const markOf = (change: Change) => (change.kind === 'added' ? '+' : change.kind === 'removed' ? '−' : '~')
const colorOf = (change: Change) => (change.kind === 'added' ? pal.success : change.kind === 'removed' ? pal.error : pal.warning)

function changeList($: EngineInterface, ctx: Ctx, c: Compared): RenderNode {
  const { Box, Text, Button } = ctx.els
  const { p } = ctx
  const n = c.changes.length
  const focus = p.focus
  const step = (delta: number) => () => void focusChange($, (focus ?? (delta > 0 ? -1 : 0)) + delta, ctx.surface)
  const current = focus !== null ? c.changes[focus] : undefined
  const head = (
    <Box flexDirection="row" columnGap={1}>
      <Button key="list-toggle" plain onPress={() => void update($, pane, old => ({ ...old, isListOpen: !old.isListOpen }))}>
        <Text color={pal.accent} bold>{p.isListOpen ? '▾ ' : '▸ '}</Text>
        <Text bold>{current ? `${focus! + 1} of ${n}` : 'Changes'}</Text>
      </Button>
      <Box flexGrow={1} flexShrink={1}>
        {current ? (
          <Text wrap="truncate-end">
            <Text color={colorOf(current)} bold>{markOf(current)} </Text>
            {current.label}
          </Text>
        ) : (
          <Text color={pal.subtle} wrap="truncate-end">
            {ctx.columns >= 60 ? 'click one, or press n to step through them' : 'n: next'}
          </Text>
        )}
      </Box>
      <Button key="prev" label="prev" hotkey="p" plain onPress={step(-1)} />
      <Button key="next" label="next" hotkey="n" plain onPress={step(1)} />
    </Box>
  )
  if (!p.isListOpen) return head
  const most = Math.min(n, ctx.isCompact ? 4 : 8)
  const first = clamp((focus ?? 0) - Math.floor(most / 2), 0, Math.max(0, n - most))
  return (
    <Box flexDirection="column">
      {head}
      {c.changes.slice(first, first + most).map((change, k) => {
        const i = first + k
        const isOn = i === focus
        const hasComment = ctx.notes.some(note => note.status === 'draft' && note.family === ctx.shown?.fam.id && note.change === i)
        return (
          <Button key={`change-${i}`} plain onPress={() => void focusChange($, i, ctx.surface)}>
            <Text color={pal.accent} bold>{isOn ? ' ▸ ' : '   '}</Text>
            <Text color={colorOf(change)} bold>{markOf(change)} </Text>
            <Text bold={isOn}>{cutTo(change.label, Math.max(10, ctx.columns - 10))}</Text>
            {hasComment ? <Text color={pal.comment}> ✎</Text> : ''}
          </Button>
        )
      })}
    </Box>
  )
}

function commentBox($: EngineInterface, ctx: Ctx, shown: Shown, c: Compared, index: number): RenderNode {
  const { Box, Text } = ctx.els
  const { Input } = ctx
  const change = c.changes[index]
  if (!Input || !change) return <Text color={pal.subtle}>Comments can be added from the terminal.</Text>
  const editing = ctx.notes.find(n => n.status === 'draft' && n.family === shown.fam.id && n.change === index)
  return (
    <Box flexDirection="row" {...(ctx.isCompact ? {} : { borderStyle: 'round', borderColor: pal.comment, paddingX: 1 })}>
      <Box flexShrink={0}>
        <Text color={pal.comment} bold>✎ </Text>
      </Box>
      <Input
        key={`comment-${shown.fam.id}-${index}-${editing?.text.length ?? 0}`}
        label={`On ${cutTo(change.label, clamp(Math.floor(ctx.columns * 0.3), 12, 60))}`}
        placeholder={editing ? 'Clear it and press Enter to delete · Esc: back to Claude' : 'What’s wrong with this change? · Esc: back to Claude'}
        submitLabel={editing ? 'Save' : 'Add'}
        {...(editing ? { value: editing.text } : {})}
        autoFocus
        onSubmit={value => void addComment($, value, shown, c, index)}
      />
    </Box>
  )
}

function draftsRow($: EngineInterface, ctx: Ctx, drafts: RedlineComment[]): RenderNode {
  const { Box, Text, Button } = ctx.els
  return (
    <Box flexDirection="row" columnGap={1}>
      <Text color={pal.comment} bold>
        ✎ {plural(drafts.length, 'comment')}
      </Text>
      <Button key="send" label={ctx.columns < 70 ? '➤ Send' : '➤ Send to Claude'} variant="primary" onPress={() => void deliver($, 'submit')} />
      <Button key="fill" label={ctx.columns < 70 ? 'Edit first' : 'Edit before sending'} plain onPress={() => void deliver($, 'fill')} />
      <Button key="discard" label="✕" plain onPress={() => void update($, comments, old => old.filter(n => n.status !== 'draft'))} />
    </Box>
  )
}

function actionsRow($: EngineInterface, ctx: Ctx, c: Compared | null): RenderNode {
  const { Box, Button } = ctx.els
  const { p } = ctx
  const { before, after, fam } = ctx.shown!
  const narrow = ctx.columns < 70
  const copies = Object.values(vault.index.files).filter(k => k.family === fam.id).length
  const canKeep = after.key !== null && (after.path !== fam.home || copies > 1) && after.id === latestOf(fam)?.id
  const app = APPS[extOf(after.path)]
  return (
    <Box flexDirection="row" columnGap={2}>
      {before && before.key !== null ? (
        <Button
          key="restore"
          label={narrow ? `↺ ${clock(before.at)}` : after.key === null ? `↺ Bring back ${nameOf(before.path)}` : `↺ Restore ${clock(before.at)} version`}
          hotkey="r"
          onPress={() => void setView($, 'restore', before.id)}
        />
      ) : null}
      {canKeep ? <Button key="keep" label={narrow ? '✓ Keep' : '✓ Keep this version'} hotkey="k" onPress={() => void setView($, 'keep', after.id)} /> : null}
      {c && p.focus !== null && !p.isCommenting && ctx.Input ? <Button key="comment" label="✎ Comment" hotkey="c" plain onPress={() => void update($, pane, old => ({ ...old, isCommenting: true }))} /> : null}
      {session.opener && after.key !== null && app ? <Button key="open" label={narrow ? 'Open' : `Open in ${app}`} hotkey="o" plain onPress={() => void openOutside($, after.path)} /> : null}
    </Box>
  )
}

/** The legend, then the pane's keys as buttons: each one's letter presses it while the pane has the keys. */
function keysRow($: EngineInterface, ctx: Ctx, isGrid: boolean, sheets: number): RenderNode {
  const { Box, Text, Button } = ctx.els
  const { p } = ctx
  const side = (p.mode === 'auto' ? autoMode(ctx.columns) : p.mode) === 'side'
  const docs = ctx.shown?.docs.length ?? 0
  const narrow = ctx.columns < 90
  const tools: { key: string; label: string; hotkey: string; onPress: () => void }[] = [
    { key: 'k-view', label: side ? 'Inline' : 'Side by side', hotkey: 'v', onPress: () => void toggleMode($, ctx.columns) },
    { key: 'k-history', label: 'History', hotkey: 'h', onPress: () => void setView($, 'history') },
    ...(docs > 1 ? [{ key: 'k-doc', label: 'Next document', hotkey: 'd', onPress: () => void stepDoc($, 1) }] : []),
    ...(isGrid && sheets > 1 ? [{ key: 'k-sheet', label: 'Next sheet', hotkey: 's', onPress: () => void update($, pane, old => ({ ...old, sheet: (old.sheet + 1) % sheets, top: 0, left: 0, cell: null })) }] : []),
    { key: 'k-list', label: p.isListOpen ? 'Hide list' : 'All changes', hotkey: 'l', onPress: () => void update($, pane, old => ({ ...old, isListOpen: !old.isListOpen })) },
  ]
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2}>
        {tools.slice(0, narrow ? 3 : tools.length).map(t => (
          <Button key={t.key} label={t.label} hotkey={t.hotkey} plain dimColor onPress={t.onPress} />
        ))}
      </Box>
      <Text wrap="truncate-end">
        <Text color={pal.error} bold>−</Text>
        <Text color={pal.dim}> removed  </Text>
        <Text color={pal.success} bold>+</Text>
        <Text color={pal.dim}> added  </Text>
        <Text color={pal.warning} bold>~</Text>
        <Text color={pal.dim}> changed  · Esc: back to Claude{isGrid && !narrow ? ' · click a cell for its formula' : ''}</Text>
      </Text>
    </Box>
  )
}

function historyView($: EngineInterface, ctx: Ctx): RenderNode {
  const { Box, Text, Button } = ctx.els
  const shown = ctx.shown!
  const fam = shown.fam
  const list = [...fam.versions]
    .reverse()
    .map(id => vault.index.versions[id])
    .filter((v): v is Version => !!v)
  const most = clamp(ctx.rows - 8, 3, 30)
  const narrow = ctx.columns < 70
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">
        {fam.name}: {plural(list.length, 'version')}
        <Text color={pal.subtle}>{narrow ? '' : '  · newest first · pick one to see what changed'}</Text>
      </Text>
      {list.slice(0, most).map((v, k) => {
        const prev = list[k + 1]
        const isAfter = v.id === shown.after.id
        const isBefore = v.id === shown.before?.id
        const who = shortWho(v)
        return (
          <Box key={`v-${v.id}`} flexDirection="row" columnGap={2}>
            <Box flexGrow={1} flexShrink={1}>
              <Button key={`see-${v.id}`} plain onPress={() => void showFamily($, fam.id, prev?.id ?? null, v.id)}>
                <Text color={isAfter ? pal.accent : isBefore ? pal.warning : pal.dim} bold>{isAfter ? '● ' : isBefore ? '○ ' : '│ '}</Text>
                <Text bold={isAfter}>{clock(v.at).padEnd(narrow ? 8 : 13)}</Text>
                <Text color={who === 'Claude' ? pal.claude : pal.text}>{who.padEnd(11)}</Text>
                <Text color={pal.subtle}>{cutTo(nameOf(v.path), narrow ? 16 : 32)}</Text>
                <Text color={pal.dim}>{v.key === null ? '  deleted' : v.note && !narrow ? `  ${cutTo(v.note, 28)}` : ''}</Text>
              </Button>
            </Box>
            {v.key !== null && k > 0 ? <Button key={`restore-${v.id}`} label={narrow ? '↺' : '↺ Restore'} plain onPress={() => void setView($, 'restore', v.id)} /> : null}
          </Box>
        )
      })}
      {list.length > most ? <Text color={pal.dim}>  … and {plural(list.length - most, 'older version')}</Text> : null}
      <Text color={pal.dim} wrap="truncate-end">
        Keeps the last {ctx.s.keepVersions} versions for up to {plural(ctx.s.keepDays, 'day')} · ⚙ to change
      </Text>
      <Button key="history-back" label="Back to the changes" plain onPress={() => void setView($, 'changes')} />
    </Box>
  )
}

function pickView($: EngineInterface, ctx: Ctx): RenderNode {
  const { Box, Text, Button } = ctx.els
  const shown = ctx.shown!
  const fam = shown.fam
  const isBefore = ctx.p.view === 'pick-before'
  const all = fam.versions.map(id => vault.index.versions[id]).filter((v): v is Version => !!v)
  const options = all.filter(v => (isBefore ? v.at <= shown.after.at && v.id !== shown.after.id : v.at >= (shown.before?.at ?? 0) && v.id !== shown.before?.id)).reverse()
  return (
    <Box flexDirection="column">
      <Text bold>{isBefore ? 'Compare from which version?' : 'Compare up to which version?'}</Text>
      {options.slice(0, clamp(ctx.rows - 6, 3, 20)).map(v => (
        <Button key={`pick-${v.id}`} plain onPress={() => void showFamily($, fam.id, isBefore ? v.id : (shown.before?.id ?? null), isBefore ? shown.after.id : v.id)}>
          <Text color={pal.accent}>{(isBefore ? v.id === shown.before?.id : v.id === shown.after.id) ? ' ● ' : '   '}</Text>
          <Text bold>{clock(v.at).padEnd(13)}</Text>
          <Text>{shortWho(v).padEnd(11)}</Text>
          <Text color={pal.subtle}>{cutTo(nameOf(v.path), 30)}</Text>
          <Text color={pal.dim}>{v.key === null ? '  deleted' : ''}</Text>
        </Button>
      ))}
      {options.length === 0 ? <Text color={pal.subtle}>No {isBefore ? 'earlier' : 'later'} versions.</Text> : null}
      <Button key="pick-back" label="Back" plain onPress={() => void setView($, 'changes')} />
    </Box>
  )
}

function restoreView($: EngineInterface, ctx: Ctx): RenderNode {
  const { Box, Text, Button } = ctx.els
  const v = ctx.p.target ? vault.index.versions[ctx.p.target] : undefined
  const fam = v ? vault.index.families[v.family] : undefined
  if (!v || !fam) return <Text color={pal.subtle}>Nothing to restore.</Text>
  return (
    <Box flexDirection="column" {...(ctx.isCompact ? {} : { borderStyle: 'round', borderColor: pal.warning, paddingX: 1 })}>
      <Text wrap="wrap">
        Put <Text bold>{nameOf(currentPath(fam))}</Text> back to the <Text bold>{clock(v.at)}</Text> version? What’s there now is saved first, so you can undo this.
      </Text>
      <Box flexDirection="row" columnGap={2}>
        <Button key="restore-yes" label="↺ Restore" variant="primary" onPress={() => void restore($, v.id)} />
        <Button key="restore-no" label="Cancel" plain onPress={() => void setView($, 'changes')} />
      </Box>
    </Box>
  )
}

const plans = new Map<string, KeepPlan | null>()

async function planKeep($: EngineInterface, fam: Family, v: Version) {
  plans.set(v.id, await keepPlan($, fam, v).catch(() => null))
  await redraw($)
}

function keepView($: EngineInterface, ctx: Ctx): RenderNode {
  const { Box, Text, Button } = ctx.els
  const v = ctx.p.target ? vault.index.versions[ctx.p.target] : undefined
  const fam = v ? vault.index.families[v.family] : undefined
  if (!v || !fam) return <Text color={pal.subtle}>Nothing to keep.</Text>
  const plan = plans.get(v.id)
  if (plan === undefined) {
    // Worked out once, off the draw: which files would move where.
    void planKeep($, fam, v)
    return <Text color={pal.subtle}>Working out what would move…</Text>
  }
  if (plan === null) {
    return (
      <Box flexDirection="column">
        <Text>This version is already in {nameOf(fam.home)}, with no other copies to tidy away.</Text>
        <Button key="keep-back" label="Back" plain onPress={() => void setView($, 'changes')} />
      </Box>
    )
  }
  return (
    <Box flexDirection="column" {...(ctx.isCompact ? {} : { borderStyle: 'round', borderColor: pal.accent, paddingX: 1 })}>
      <Text bold wrap="wrap">
        Keep the {clock(v.at)} version as {nameOf(plan.home)}?
      </Text>
      <Text wrap="truncate-end">
        <Text color={pal.success} bold>  ✓ </Text>
        {nameOf(plan.home)} becomes the {clock(v.at)} version{v.path !== plan.home ? ` (from ${nameOf(v.path)})` : ''}
      </Text>
      {plan.moves.map(m => (
        <Text key={`m-${m.from}`} wrap="truncate-end">
          <Text color={pal.accent} bold>  → </Text>
          {nameOf(m.from)}
          {m.from === plan.home ? <Text color={pal.dim}> (as it is now)</Text> : ''}
          <Text color={pal.subtle}> moves to {shortPath(m.to, session.folder)}</Text>
        </Text>
      ))}
      <Text color={pal.dim} wrap="wrap">
        Nothing is deleted, and every version stays in the history.
      </Text>
      <Box flexDirection="row" columnGap={2}>
        <Button
          key="keep-yes"
          label="✓ Keep it"
          variant="primary"
          onPress={() => {
            plans.delete(v.id)
            void keepVersion($, plan)
          }}
        />
        <Button
          key="keep-no"
          label="Cancel"
          plain
          onPress={() => {
            plans.delete(v.id)
            void setView($, 'changes')
          }}
        />
      </Box>
    </Box>
  )
}

function settingsView($: EngineInterface, ctx: Ctx): RenderNode {
  const { Box, Text, Button } = ctx.els
  const { s } = ctx
  const onOff = (isOn: boolean) => (isOn ? '● On' : '○ Off')
  const labelWidth = clamp(ctx.columns - 26, 18, 34)
  const row = (key: string, label: string, control: RenderNode) => (
    <Box key={key} flexDirection="row" columnGap={1}>
      <Box width={labelWidth} flexShrink={0}>
        <Text wrap="truncate-end">{label}</Text>
      </Box>
      {control}
    </Box>
  )
  const space = session.space
  return (
    <Box flexDirection="column">
      <Text bold color={pal.accent}>
        Settings
      </Text>
      {row('r1', 'Notice after Claude’s turn', <Button key="set-notices" label={onOff(s.notices)} plain onPress={() => void setSetting($, { notices: !s.notices })} />)}
      {row('r2', 'Open this pane by itself', <Button key="set-auto" label={onOff(s.autoOpen)} plain onPress={() => void setSetting($, { autoOpen: !s.autoOpen })} />)}
      {row('r3', 'Tell Claude about a restore', <Button key="set-tell" label={s.tell === 'next' ? 'With my next message' : 'Straight away'} plain onPress={() => void setSetting($, { tell: s.tell === 'next' ? 'now' : 'next' })} />)}
      {row(
        'r4',
        'Versions kept per document',
        <Box flexDirection="row" columnGap={1}>
          <Button key="v-minus" label="−" plain onPress={() => void setSetting($, { keepVersions: Math.max(2, s.keepVersions - (s.keepVersions > 20 ? 10 : 5)) })} />
          <Text bold>{s.keepVersions}</Text>
          <Button key="v-plus" label="+" plain onPress={() => void setSetting($, { keepVersions: Math.min(200, s.keepVersions + (s.keepVersions >= 20 ? 10 : 5)) })} />
        </Box>,
      )}
      {row(
        'r5',
        'Days kept',
        <Box flexDirection="row" columnGap={1}>
          <Button key="d-minus" label="−" plain onPress={() => void setSetting($, { keepDays: Math.max(1, s.keepDays - 1) })} />
          <Text bold>{s.keepDays}</Text>
          <Button key="d-plus" label="+" plain onPress={() => void setSetting($, { keepDays: Math.min(90, s.keepDays + 1) })} />
        </Box>,
      )}
      <Text color={pal.dim} wrap="wrap">
        Whichever comes first. The newest version of each document is always kept.
      </Text>
      <Text wrap="wrap">
        Space used: <Text bold>{space ? megabytes(space.here) : '…'}</Text>
        <Text color={pal.subtle}>{space ? ` for this folder · ${megabytes(space.bytes)} for ${plural(space.projects, 'folder')} in all` : ''}</Text>
      </Text>
      <Box flexDirection="row" columnGap={2}>
        <Button key="clear" label="Clear this folder’s versions" plain onPress={() => void setView($, 'clear')} />
        <Button key="settings-done" label="Done" variant="primary" onPress={() => void setView($, 'changes')} />
      </Box>
    </Box>
  )
}

async function clearAll($: EngineInterface) {
  await clearProject($)
  await noteStart($, 'first').catch(() => undefined)
  vault.index.running = null
  await saveIndex($)
  forgetDrawings()
  session.space = await spaceUsed($).catch(() => null)
  await update($, pane, () => ({ ...DEFAULT_PANE, view: 'settings' }))
  await setBanner($, '✓ Saved versions cleared for this folder.', 'success')
  await redraw($)
}

function clearView($: EngineInterface, ctx: Ctx): RenderNode {
  const { Box, Text, Button } = ctx.els
  return (
    <Box flexDirection="column" {...(ctx.isCompact ? {} : { borderStyle: 'round', borderColor: pal.error, paddingX: 1 })}>
      <Text wrap="wrap">
        Forget every saved version of the documents in this folder? Your documents themselves aren’t touched; Panda Redline starts again from them as they are now.
      </Text>
      <Box flexDirection="row" columnGap={2}>
        <Button key="clear-yes" label="Clear versions" variant="primary" onPress={() => void clearAll($)} />
        <Button key="clear-no" label="Cancel" plain onPress={() => void setView($, 'settings')} />
      </Box>
    </Box>
  )
}
