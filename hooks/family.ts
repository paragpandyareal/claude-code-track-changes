// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Claude Code Track Changes: https://github.com/paragpandyareal/claude-code-track-changes
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel

import type { Doc } from '../types'

/**
 * Document families, pure: budget.xlsx, budget_v2.xlsx, budget_final.xlsx
 * and "budget (1).xlsx" are all one document. A new file is matched to the
 * document it came from by its type, its folder, its name and what it holds.
 */

/** File types that are the same kind of document: a .htm can be a new version of a .html. */
export const KINDS: Record<string, string> = {
  xlsx: 'excel',
  xlsm: 'excel',
  docx: 'word',
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  csv: 'table',
  tsv: 'table',
  txt: 'text',
  adf: 'confluence',
}

export const TRACKED = Object.keys(KINDS)

export const extOf = (path: string) => (path.match(/\.([^./]+)$/)?.[1] ?? '').toLowerCase()
export const kindOf = (path: string) => KINDS[extOf(path)]
export const nameOf = (path: string) => path.split('/').pop() ?? path
export const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))

/** The words people and tools add to a copy's name: v2, final, updated, (1), copy, a date… */
const SUFFIX =
  /(?:[\s_.-]*(?:\(\d+\)|\[\d+\]|copy(?:\s*\d+)?|v\s?\d+(?:\.\d+)*|ver(?:sion)?\s?\d+|r(?:ev(?:ision)?)?\s?\d+|final|updated?|new|revised|rev|edited|edit|draft|latest|clean|fixed|amended|corrected|redline|proposed|claude|ai|\d{4}[-_.]?\d{2}[-_.]?\d{2}|\d{1,2}[-_.]\d{1,2}[-_.]\d{2,4}|\d+))+$/i
const PREFIX = /^(?:copy of|new|updated|final|draft)[\s_.-]+/i

/** A name with its type and its copy words taken off, lower case: "Budget_v2 (1).xlsx" is "budget". */
export function stemOf(path: string): string {
  let stem = nameOf(path).replace(/\.[^.]+$/, '').toLowerCase()
  for (let k = 0; k < 4; k += 1) {
    const next = stem.replace(SUFFIX, '').replace(PREFIX, '').trim()
    if (next === stem || next === '') break
    stem = next
  }
  return stem.replace(/[\s_.-]+/g, ' ').trim()
}

/** Edit distance, for names that are close but not the same stem (budget vs budgte). */
function distance(a: string, b: string): number {
  if (a === b) return 0
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0]!
    prev[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j]!
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]!
}

/** How alike two file names are as names of one document, 0 to 1. */
export function nameScore(a: string, b: string): number {
  const x = stemOf(a)
  const y = stemOf(b)
  if (x === '' || y === '') return 0
  if (x === y) return 1
  // One name holds the other whole: "budget" and "budget for board".
  if (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x))) return 0.75
  const d = distance(x, y)
  return Math.max(0, 1 - d / Math.max(x.length, y.length))
}

/** What a version holds, in a few dozen words: sheet names and headings, then its first words. For telling which document a new file came from. */
export function fingerprintOf(d: Doc): string[] {
  const words = new Set<string>()
  const add = (text: string, most: number) => {
    for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (words.size >= most) return
      if (w.length >= 3) words.add(w)
    }
  }
  if (d.kind === 'grid') {
    for (const s of d.sheets) add(`sheet ${s.name}`, 40)
    for (const s of d.sheets.slice(0, 3)) for (const row of s.rows.slice(0, 12)) add(row.filter(c => c.x === undefined).map(c => c.v).join(' '), 80)
  } else if (d.kind === 'lines') {
    for (const r of d.rows) if (r.style === 'h1' || r.style === 'h2' || r.style === 'h3') add(r.text, 40)
    for (const r of d.rows.slice(0, 200)) add(r.text, 80)
  }
  return [...words]
}

/** How alike two fingerprints are, 0 to 1. */
export function contentScore(a: readonly string[] | undefined, b: readonly string[] | undefined): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0
  const set = new Set(a)
  let common = 0
  for (const w of b) if (set.has(w)) common += 1
  return common / Math.min(a.length, b.length)
}

export type Candidate = { family: string; path: string; fingerprint?: string[] }
export type Match = { family: string; path: string; score: number; isSameName: boolean }

/**
 * The document a new file most likely came from, and how sure that is:
 * `sure` joins it, `unsure` asks the person once, `none` is a new document.
 * Same kind of file only; the same folder counts for a little.
 */
export function matchParent(path: string, fingerprint: string[] | undefined, candidates: Candidate[]): { verdict: 'sure' | 'unsure' | 'none'; best?: Match; others: Match[] } {
  const kind = kindOf(path)
  const scored: Match[] = []
  for (const c of candidates) {
    if (c.path === path || kindOf(c.path) !== kind) continue
    const name = nameScore(path, c.path)
    const content = contentScore(fingerprint, c.fingerprint)
    const folder = folderOf(c.path) === folderOf(path) ? 1 : 0
    // A name that matches says the most; what it holds confirms it or makes up for a renamed copy.
    const score = 0.55 * name + 0.35 * content + 0.1 * folder
    if (score >= 0.35) scored.push({ family: c.family, path: c.path, score, isSameName: name === 1 && folder === 1 })
  }
  scored.sort((x, y) => y.score - x.score)
  // One match per family: its closest file.
  const seen = new Set<string>()
  const ranked = scored.filter(m => (seen.has(m.family) ? false : (seen.add(m.family), true)))
  const best = ranked[0]
  const second = ranked[1]
  if (!best) return { verdict: 'none', others: [] }
  const margin = best.score - (second?.score ?? 0)
  // The same name in the same folder is enough on its own, even when the file can't be read.
  const isOnlySameName = best.isSameName && !ranked.slice(1).some(m => m.isSameName)
  const sure = isOnlySameName || (best.score >= 0.72 && margin >= 0.12)
  return { verdict: sure ? 'sure' : best.score >= 0.5 ? 'unsure' : 'none', best, others: ranked.slice(1, 4) }
}
