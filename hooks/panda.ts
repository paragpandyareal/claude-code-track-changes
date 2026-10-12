// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Claude Code Track Changes: https://github.com/paragpandyareal/claude-code-track-changes
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel

/**
 * The panda, as pixel art drawn with half blocks the way Claude Code draws
 * its own mascot: each character is two pixels stacked, the top one in the
 * text colour and the bottom one in the background colour, so it shows in
 * any terminal without image support.
 */

/** Awake, holding a red pen: B ears and paw, W face, K eye patches (open eyes, W highlights) and nose, O a soft outline that keeps the face apart from a light background, R the pen, G its tip. */
const ART = [
  '.BBB..........BBB........RR',
  'BBBBB........BBBBB......RRR',
  'BBBBOOOOOOOOOOBBBB.....RRR.',
  '.BBWWWWWWWWWWWWBB.....RRR..',
  '.OWWWWWWWWWWWWWWO....RRR...',
  'OWWWWWWWWWWWWWWWWO..RRR....',
  'OWKKKKWWWWWWKKKKWO.RRR.....',
  'OKKKWKKWWWWKKWKKKOBBB......',
  'OKKKKKKWWWWKKKKKKBBBB......',
  '.OKKKKWWKKWWKKKKOBBB.......',
  '..OWWWWWKWWKWWWWOGG........',
  '...OOOWWWWWWOOO.GG.........',
  '......OOOOOO...............',
]

/** Greys and a red that are exact entries of the 256-colour palette, so a terminal without true colour draws them as they are (near-black became navy). */
const COLORS: Record<string, string> = { B: '#3A3A3A', W: '#EEEEEE', K: '#121212', O: '#8A8A8A', R: '#D70000', G: '#5F5F5F' }

/** One run of characters drawn alike. */
export type PandaRun = { text: string; color?: string; background?: string }

/** The panda as rows of runs, ready to draw as Text. */
export function pandaRows(): PandaRun[][] {
  const rows: PandaRun[][] = []
  for (let y = 0; y < ART.length; y += 2) {
    const top = ART[y] ?? ''
    const bottom = ART[y + 1] ?? ''
    const runs: PandaRun[] = []
    for (let x = 0; x < top.length; x += 1) {
      const up = COLORS[top[x] ?? '.']
      const down = COLORS[bottom[x] ?? '.']
      const cell: PandaRun = up && down ? { text: '▀', color: up, background: down } : up ? { text: '▀', color: up } : down ? { text: '▄', color: down } : { text: ' ' }
      const last = runs[runs.length - 1]
      if (last && last.color === cell.color && last.background === cell.background && last.text[0] === cell.text) last.text += cell.text
      else runs.push(cell)
    }
    rows.push(runs)
  }
  return rows
}
