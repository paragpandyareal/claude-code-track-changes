// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Panda Redline: https://github.com/paragpandyareal/panda-redline
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel

import type { ClientKeyEvent, ClientModule } from 'claude-code'

import type { DRow, SegKind } from './layout'

/**
 * The changes view inside the pane. It draws only the lines in view, which
 * the hooks module lays out, and turns clicks and keys into posts: the hooks
 * module owns the view.
 *
 * Changes that just arrived glow for a moment, on the view's own clock, so
 * the eye goes straight to them.
 */

/** The theme keys the view paints with. */
export type ChangesPal = { text: string; subtle: string; dim: string; accent: string; h3: string; code: string; error: string; success: string; warning: string; removedBg: string; addedBg: string; glowBg: string }

export type ChangesProps = {
  pal: ChangesPal
  rows: DRow[]
  /** The change the person is on: its lines get a bar at the left. */
  focus: number | null
  /** Bumped when new changes arrive; `fresh` are the changes that glow. */
  flashKey: number
  fresh: number[]
  width: number
  /** The scrollbar: first line in view, lines shown, lines in all. */
  scroll: { top: number; shown: number; total: number }
  /** A line under the view: "▼ 40 more lines below". */
  below?: string
}

export type ChangesPost =
  | { type: 'click'; y: number; x: number }
  | { type: 'key'; key: string; shift?: true }

type Local = { seen: number; glow: number }

const FRAMES = 16

const Changes: ClientModule<ChangesProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { pal } = props
  if (surface.state === undefined) {
    surface.setState({ seen: props.flashKey, glow: props.fresh.length > 0 ? FRAMES : 0 })
    surface.every(90, () => {
      const now = surface.state
      if (now && now.glow > 0) surface.setState({ ...now, glow: now.glow - 1 })
    })
  } else if (props.flashKey !== surface.state.seen) {
    surface.setState({ seen: props.flashKey, glow: FRAMES })
  }
  const glow = surface.state?.glow ?? 0
  const fresh = new Set(props.fresh)

  surface.onPointer(event => {
    if (event.type !== 'down' || (event.button !== undefined && event.button !== 'left')) return
    // One column for the focus bar comes first.
    surface.post({ type: 'click', y: event.y, x: Math.max(0, event.x - 1) })
  })
  surface.onKey((event: ClientKeyEvent) => {
    surface.post(event.shift ? { type: 'key', key: event.key, shift: true } : { type: 'key', key: event.key })
  })

  const look = (k: SegKind | undefined, isGlowing: boolean) => {
    switch (k) {
      case 'del':
        return { color: pal.text, backgroundColor: pal.removedBg, strikethrough: true }
      case 'add':
        return { color: pal.text, backgroundColor: isGlowing ? pal.glowBg : pal.addedBg, underline: true }
      case 'mdel':
        return { color: pal.error, bold: true }
      case 'madd':
        return { color: pal.success, bold: true }
      case 'mmod':
        return { color: pal.warning, bold: true }
      case 'h1':
      case 'h2':
        return { color: pal.accent, bold: true }
      case 'h3':
        return { color: pal.h3, bold: true }
      case 'th':
        return { color: pal.text, bold: true }
      case 'quote':
        return { color: pal.subtle, italic: true }
      case 'code':
        return { color: pal.code }
      case 'li':
        return { color: pal.accent }
      case 'num':
      case 'sep':
        return { color: pal.dim }
      case 'head':
        return { color: pal.subtle, bold: true }
      case 'fold':
        return { color: pal.accent, italic: true }
      case 'dim':
        return { color: pal.subtle }
      case 'pic':
        return { color: pal.warning }
      case 'sel':
        return { color: pal.text, inverse: true }
      default:
        return { color: pal.text }
    }
  }

  const sc = props.scroll
  const hasBar = sc.total > sc.shown
  const thumb = hasBar ? Math.max(1, Math.round((props.rows.length * sc.shown) / sc.total)) : 0
  const thumbAt = hasBar ? Math.round(((props.rows.length - thumb) * sc.top) / Math.max(1, sc.total - sc.shown)) : 0
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box flexDirection="column" width={props.width + 1}>
          {props.rows.map((row, i) => {
            const isFocus = row.change !== undefined && row.change === props.focus
            const isGlowing = glow > 0 && row.change !== undefined && fresh.has(row.change)
            return (
              <Text key={`r${i}`} wrap="truncate-end">
                <Text color={isGlowing ? pal.success : pal.accent} bold>{isFocus ? '▌' : isGlowing ? '▏' : ' '}</Text>
                {row.segs.map((seg, k) => (
                  <Text key={`s${k}`} {...look(seg.k, isGlowing)}>
                    {seg.t}
                  </Text>
                ))}
              </Text>
            )
          })}
        </Box>
        {hasBar && (
          <Box flexDirection="column">
            {props.rows.map((_, i) => (
              <Text key={`b${i}`} color={i >= thumbAt && i < thumbAt + thumb ? pal.accent : pal.dim}>
                {i >= thumbAt && i < thumbAt + thumb ? '┃' : '│'}
              </Text>
            ))}
          </Box>
        )}
      </Box>
      {props.below ? (
        <Text color={pal.subtle} wrap="truncate-end">
          {'  '}
          <Text color={pal.accent}>▼</Text> {props.below}
        </Text>
      ) : null}
    </Box>
  )
}
export default Changes
