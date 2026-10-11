# How Panda Redline works

Panda Redline is a Claude Code **mod**: a plugin made of function hooks (TypeScript that runs inside Claude Code). It notes your documents when Claude's turn starts and when it ends, works out what changed, and draws the changes in a pane. It started from [Lazy Panda Panel](https://github.com/paragpandyareal/lazy-panda-panel) and shares its document readers.

## The loop

```
 turn.start ──► note the folder (read only files that changed since)  ◄── your edits become "by you"
     │
 Claude works (Write, Edit, Bash, subagents…)   ◄── tool.call waits for the note to be taken, passes on unchanged
     │
 turn.complete ──► note the folder again ──► edits, new files, deletions, moves
                         │
                         ▼
          each change becomes its document's newest version
          (a new file is matched to the document it came from, or asked)
                         │
                         ▼
          dim line in the transcript ("plan.md has 2 changes") ──► /redline
                         │
                         ▼
          compare before ↔ after ──► lay out ──► draw (inline or side by side)
                         │
          Restore / Keep this version / Comment and send
                         │
          a one-line note to Claude (with the next message, or at once)
```

Nothing goes into Claude's context on a normal turn. The tracking is all local.

## Files

| File | What it does |
|---|---|
| `hooks/register.tsx` | **Everything that touches `$`:** the store of versions, scanning the folder, noting turns, matching new files to families, reading stored versions back, writing files (Restore, Keep), Python for big files, the commands, and the pane. A mod may hand `$` only to functions in the same file, so these all live here. |
| `hooks/compare.ts` | **Pure:** comparing two versions. Myers' edit script; paragraphs then words; spreadsheets by columns, then rows, then cells, formulas compared by their relative shape; the list of changes and the summary line |
| `hooks/family.ts` | **Pure:** document families. File-name stems (`budget_v2 (1).xlsx` is `budget`), name and content scores, and the verdict for a new file: sure, unsure (ask), or none |
| `hooks/layout.ts` | **Pure:** a comparison as the lines the pane shows, at a width, inline or side by side, with folds for long unchanged runs and the place of every change |
| `hooks/csv.ts` | **Pure:** CSV and TSV as a sheet, quotes the RFC 4180 way |
| `hooks/hash.ts` | **Pure:** content keys, so each content is stored once |
| `hooks/model.ts` | **Pure:** paths in one form, the comment prompt with its fence, the note's file names |
| `hooks/officegen.ts` | **Pure:** small real `.xlsx` and `.docx` files for `/redline examples` |
| `hooks/changes.tsx` | Drawing thread (a `Client` module): the changes view. Draws the lines in view, a focus bar, a scrollbar, and the glow for new changes; posts clicks and keys back |
| `hooks/filebar.tsx` | Drawing thread: the top bar, with the document's badge, name, ‹ n/N › and switches (from Lazy Panda Panel) |
| `hooks/spinner.tsx` | Drawing thread: "Claude is working on N comments…" |
| `hooks/xlsx.ts`, `docx.ts`, `pdf*.ts`, `md.ts`, `html.ts`, `adf.ts`, `formulas.ts`, `zip.ts`, `xml.ts`, `picture.ts`, `format.ts`, `text.ts`, `deadline.ts`, `panda.ts`, `palette.ts` | Lazy Panda Panel's readers and helpers. `xlsx.ts` now reads up to 5,000 rows and 60 columns, and merged ranges. |
| `scripts/read_file.py` | Prints one document's bytes as base64, for files over 4 MB, only if Python is installed. Standard library only. |
| `scripts/write_file.py` | On Linux without `openssl`: writes one file from base64 (temporary file, then put in place). Standard library only. |
| `types/index.d.ts` | The state contract: the pane's state, settings, comments, notes, banner |
| `tests/` | `engine.test.ts` (comparing, families, layout), `tracking.test.ts` (turns on a disk in memory), `pane.test.tsx` (the pane, actions, notes, settings, examples, every format, Windows), `disk.ts` (the disk and the programs), `office.ts` (real Office files) |

## What's kept

`<Claude config>/panda-redline/projects/<folder>-<key>/`:

- `index.json`: the record. `files` (each tracked file as last seen: content key, size, time, family), `families` (each document: its name, its home file, every file it has been, its versions in order), `versions` (path, content key or null when deleted, size, time, who: claude, you, first, restore, keep, example), `turns` (each of Claude's turns: when, how it ended, and for each document the version before and after), `answers` (to "is this a new version of that?"), `asks` (questions waiting).
- `store/<ab>/<key>.<n>`: each content, as base64, in pieces of at most 3 MB so a mod can read them back. A content is written once; letting it go empties it.

## Matching a new file to its document

1. **Moved or renamed:** a file gone and a new one with the same content.
2. **Candidates:** every document of the same kind (Excel, Word, PDF, Markdown, HTML, table, text, Confluence).
3. **Score:** 0.55 × name (same stem is 1; one name inside the other 0.75; else edit distance) + 0.35 × content (shared words among sheet names, headings and first lines) + 0.1 × same folder.
4. **Verdict:** the same name in the same folder, with no other candidate like it, is sure; otherwise sure at 0.72 or more with a clear lead of 0.12; 0.5 or more is asked once in the pane; below that it's a new document. An earlier answer wins.

## Comparing

- **Documents:** rows are compared by style and text with Myers' algorithm (shared start and end trimmed, an edit limit). Removed and added rows between two kept ones are paired when they're the same row edited (similar words, or the same place in equal runs), and then compared word by word. Blank lines are gaps, never changes.
- **Spreadsheets:** columns are lined up first, by what they hold top to bottom (as multisets, so moved rows don't matter); then rows, by the columns both versions have; then cells. Formulas are compared by their **shape**, references made relative to the cell (R1C1), so a row inserted above doesn't make every formula below it look changed. Sheets are matched by name, then renamed sheets by content.

## The pane

- `ui.render` draws: the top bar, the versions line (Before ▾ → After ▾, by whom), the question if there is one, the summary, sheet tabs, the changes view, the formula line, the list of changes, the comment box, the actions and the keys.
- Hotkeys are Buttons' `hotkey`s: they work whenever the pane holds the keyboard. `/redline` asks for the keys a moment after the command finishes (while it runs, the prompt still holds its text).
- Short panes drop the extras before the changes: under 26 rows, no borders or key hints; under 16, the versions line folds into the summary and the question waits for a taller pane.
- The view opens at the first change. Comparisons and layouts are cached by content and width.

## Restore and keep

- **Restore** puts a version back in its own file. What's there now is noted first (a version marked *saved before restoring*). Text files are written by the mod; others by `openssl` / `python3` / `base64` / `certutil`. The result is read back and checked.
- **Keep this version** moves every file of the document that's there now into `Older versions` (a free name each), then writes the kept version into the document's home file.
- Both leave a note for Claude: in `notes` (state and store) until the next prompt the person types, which carries it as `context`; or at once through `$.prompt.submit` if the setting says so.

## Developing

```bash
claude --plugin-dir /path/to/panda-redline   # hot-reloads as you save
claude plugin validate --strict .
claude plugin test .
node <typescript>/bin/tsc --noEmit -p .        # once Claude Code has written .claude-plugin/types/
```

Gotchas:
- **`$` only goes into functions in the same file.** That's why `register.tsx` is big and the pure logic is in modules of its own.
- **A `Client` can't take the focus ring by itself.** Keys the person presses reach Buttons' hotkeys; a click on the changes view gives it arrows and Page Up/Down.
- **`$.ui.open({ focus })` is refused while a command runs** (the prompt still has its text): ask a moment later.
- **Name types inside `declare module 'claude-code'` carefully:** `Settings` there means Claude Code's own.
- **A mod writes text only and can't delete,** hence the computer's own tools for binary files and emptied pieces for letting content go.
