// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Panda Redline: https://github.com/paragpandyareal/panda-redline
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel

/** A run of text inside a row with its emphasis: bold, italic, code, link, strike, dim. */
export type Span = { t: string; b?: 1; i?: 1; c?: 1; l?: 1; s?: 1; d?: 1 }

/**
 * How a row is drawn. Formatted documents (Markdown, ADF, HTML, Word) use
 * h1–h3, p, li, quote, code, th/td, panel, rule and space; plain files draw
 * every row as a line.
 */
export type RowStyle =
  | 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'quote' | 'code' | 'th' | 'td' | 'panel' | 'rule' | 'space'
  | null

export type Tone = 'info' | 'note' | 'warning' | 'error' | 'success' | 'tip'

/** One row of a document: a line, a paragraph, a heading, a list item, a table row. */
export type DocRow = {
  /** The row's plain text. */
  text: string
  /** Where the row is, in words Claude can find it by: "line 12", "paragraph 4 (under "Pricing")". */
  anchor: string
  style?: RowStyle
  /** What one row is called: "line", "paragraph", "block". */
  unit?: string
  /** The text with emphasis, when the row has any. */
  spans?: Span[]
  /** List depth (0 for a top-level item) and the item's bullet or number. */
  indent?: number
  marker?: string
  /** A panel's or callout's kind. */
  tone?: Tone
  /** A picture's row: its index in the document's pictures. */
  pic?: number
  /** A Markdown or HTML picture's address as written. */
  src?: string
}

/** A picture's pixels, scaled down, 3 bytes a pixel; `fullWidth` × `fullHeight` its real size. */
export type Pixels = { width: number; height: number; rgb: Uint8Array; fullWidth: number; fullHeight: number }

/** A picture in a document: read and decoded only when asked. */
export type Picture = {
  label: string
  load: () => Promise<Pixels | string> | Pixels | string
}

/** A cell: the value as shown, its formula when it has one, its number when it is one. */
export type GridCell = { v: string; f?: string; x?: number }

export type GridSheet = {
  name: string
  cols: string[]
  rows: GridCell[][]
  isCut?: boolean
  isHidden?: boolean
  /** Merged ranges as Excel writes them: "A1:C1". */
  merges?: string[]
}

export type Doc =
  | {
      kind: 'lines'
      path: string
      rows: DocRow[]
      note?: string
      /** Drawn as a formatted document (no line numbers). */
      isFormatted?: boolean
      hasSource?: boolean
      pictures?: Picture[]
    }
  | { kind: 'grid'; path: string; sheets: GridSheet[]; note?: string }
  | { kind: 'image'; path: string; png: string; width: number; height: number }
  | { kind: 'error'; path: string; message: string; isNotice?: boolean }

/** What the pane is showing. */
export type PaneView = 'changes' | 'history' | 'pick-before' | 'pick-after' | 'settings' | 'restore' | 'keep' | 'clear' | 'pick-parent'

export type PaneState = {
  /** The turn shown (null: Claude's latest) and which of its documents. */
  turn: string | null
  doc: number
  /** A document chosen by name or from its timeline, with chosen versions (null: the defaults). */
  family: string | null
  before: string | null
  after: string | null
  view: PaneView
  /** The version Restore would put back. */
  target: string | null
  /** Inline or side by side; auto picks by the pane's width. */
  mode: 'auto' | 'inline' | 'side'
  top: number
  left: number
  sheet: number
  /** The change the person is on, by its index in the list. */
  focus: number | null
  /** Folds of unchanged lines the person opened. */
  open: string[]
  /** A cell picked, to see its old and new formula: "row:col" of the comparison. */
  cell: string | null
  /** The list of changes shown in full, rather than one line. */
  isListOpen: boolean
  /** The comment box is open on the focused change. */
  isCommenting: boolean
}

export type RedlineSettings = {
  /** A line in the transcript after Claude changes documents (Claude never sees it). */
  notices: boolean
  /** Open the pane by itself after Claude changes documents. */
  autoOpen: boolean
  /** When Claude is told about a restore or a keep: with the person's next message, or at once. */
  tell: 'next' | 'now'
  keepVersions: number
  keepDays: number
}

/** A comment on a change, waiting to go to Claude. */
export type RedlineComment = {
  id: string
  path: string
  /** Where the change is: "Budget!B6", "paragraph under “Pricing”". */
  label: string
  before: string
  after: string
  text: string
  status: 'draft' | 'sent'
  /** The change it is on: the document and the change's place in the list. */
  family: string
  change: number
}

declare module 'claude-code' {
  interface PluginState {
    'panda-redline': {
      pane: PaneState
      /** Bumped when the saved versions change, so the pane draws again. */
      tick: number
      /** New changes to glow: a counter and the changes' indexes in the turn's first document. */
      flash: { key: number; turn: string | null; fresh: number[] }
      prefs: RedlineSettings
      comments: RedlineComment[]
      /** Notes waiting to go to Claude with the next message. */
      notes: string[]
      /** A line shown at the top of the pane: what just happened, or what went wrong. */
      banner: { text: string; tone: 'info' | 'error' | 'success' } | null
    }
  }
}
