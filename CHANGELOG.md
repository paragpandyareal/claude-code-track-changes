# Changelog

## 0.2.0 (2026-10-12)

- **New name:** Panda Redline is now **Claude Code Track Changes** (plugin `track-changes`). The command is now `/track-changes` (was `/redline`). Saved versions now live in `~/.claude/track-changes`.
- **A quieter pane:** one header line (the file, how many changes, when, by whom); colour only on what changed; the change you're on and one line of keys at the bottom (`n` `p` `c` `m`, `r` restore, `k` keep).
- **`m: more`** holds the rest: the summary, side by side, history, the list, the next document, formulas, versions compared, settings and the colour key.
- **Spreadsheets inline** show a changed cell's new value; its old → new value is under the sheet. Side by side still shows both.
- Sheet tabs only when more than one sheet changed; the "is this a new version" question is one line; **b** goes back from history, keep and version pickers.

## 0.1.0 (2026-10-11)

First version.

- **Track changes for everything Claude edits:** Excel, Word, PDF, Markdown, Confluence, HTML, CSV and text files, in red and green, with a mark for every change (− + ~) so colour is never the only sign.
- **Documents, not files:** a new file Claude saves (`budget_v2.xlsx`, `report_final.docx`) joins the document it came from; edits in place, copies, deletions, moves and renames all stay in one timeline. Unsure matches are asked once. Your own edits between turns are marked as yours.
- **Excel:** rows and columns matched properly, formulas compared by their shape, formula changes shown, sheets added, removed and renamed, merged cells, folds for unchanged rows, side by side.
- **Word and documents:** paragraph then word, headings, lists, tables and pictures.
- **Actions:** Restore (undoable), Keep this version (copies to Older versions, nothing deleted), Comment and send, Open in app.
- **Telling Claude:** a one-line note after a restore or keep, with your next message or at once.
- **Notices and auto-open:** a line in the transcript Claude never sees (on), the pane opening by itself (off).
- **Settings:** retention (20 versions or 7 days), space used and clearing.
- **`/track-changes examples`:** a sample folder with a budget saved as a new file, a Word report, a Markdown plan and a CSV.
- Nothing to install; documents over 4 MB need Python 3.
- Started from Lazy Panda Panel 0.9.4 (https://github.com/paragpandyareal/lazy-panda-panel), same author, MIT licence; its document readers are shared.
