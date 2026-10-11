# Security policy

## Supported versions

Only the latest release gets fixes.

## Reporting a vulnerability

Please report it privately. On GitHub, open this repository's **Security** tab and choose **Report a vulnerability**. Please don't open a public issue. You'll get a reply within 7 days.

## Threat model

**Trust boundary.** Panda Redline is a Claude Code mod. It runs inside Claude Code with your user account's permissions, outside Claude Code's sandbox. Claude Code's permission rules don't govern the mod's own file reads, writes, process launches or prompts. That is why the mod keeps them few and narrow. The README's [Permissions and data](README.md#permissions-and-data) section lists each one.

**What it treats as untrusted:** the content of every document it tracks, including text, cell values, formulas, sheet names, headings, HTML and ADF structure, and file names.

| Risk | Mitigation |
|---|---|
| **Writing over your documents** | The mod writes a document only when you press **Restore** (after a one-line confirmation) or **Keep this version** (after showing exactly what will move). Before a restore, what's there now is saved as a version, so a restore can be undone. Keep this version moves copies into an `Older versions` folder and never deletes. Every write is read back and checked. Moves never overwrite (`mv -n`; on Windows the target name is checked free first). |
| **Running programs** | Only the programs listed in the README, without a shell, with fixed arguments. File paths are separate arguments; on Windows, PowerShell gets them as environment variables, never in its command text. Nothing from a document's content is ever part of a command. The mod installs nothing and downloads nothing. |
| **Copies of documents on disk** | Versions are kept in Panda Redline's own folder under Claude Code's settings folder (`~/.claude/panda-redline/`), with the same permissions as the rest of that folder, never in the project. Retention lets them go after 20 versions or 7 days by default (emptied, since a mod can't delete). `/redline space` shows and clears them. |
| **Scanning more than intended** | The working folder only, 3 levels down, at most 4,000 entries and 400 documents, only the tracked document types. Links are never followed; a folder whose real location is outside the working folder (a Windows junction) is never entered. Hidden folders, `node_modules` and similar are skipped. A home folder or a drive's root is never watched. |
| **Prompt injection:** a document contains text meant to steer Claude, which ends up in a prompt | A prompt carrying document text is only sent when you press Send, or Enter after Edit before sending. The file name, the place and the quoted before and after text sit inside a fence whose name is random for every prompt; look-alike tags are neutralised; each quoted line starts with `> `; and the prompt says the fenced text is data, never instructions. Control and invisible characters are stripped, and an `@` before a path becomes `＠`. The note after a restore or keep contains only file names (quoted, one line, at most 200 characters) and times. |
| **Code execution from spreadsheet formulas** | Formulas are shown, compared and, where a file has no saved result, calculated by a small interpreter (`hooks/formulas.ts`, from Lazy Panda Panel) with no `eval` or `Function`, capped in size, depth and work. |
| **Parser denial of service** (huge, deeply nested or malformed files, zip bombs) | The readers are Lazy Panda Panel's, tested against over 1,100 public Word, Excel and PDF files, with caps on unpacked size, rows, nesting and time. Comparisons are bounded too: at most 5,000 rows and 60 columns per sheet, 20,000 rows per document, and an edit-distance limit after which a stretch is shown as removed and added. |
| **Terminal escape injection** | ANSI escapes and control characters are removed from all document text before it's drawn. |
| **Another plugin driving `/redline`** | Only you can change settings, write the samples or clear versions; the same command run by another plugin is refused. Restore and Keep happen only from the pane's own buttons. |

**Environment variables.** The mod reads five, none of them secret: `CLAUDE_CONFIG_DIR`, `HOME`, `USERPROFILE`, `DISPLAY` and `WAYLAND_DISPLAY`.

**Known limits:**
- Programs are found through your `PATH`.
- Text inside a document can still try to persuade Claude. The fence makes this much harder but can't make it impossible.
- The saved copies are as private as your Claude Code settings folder: anyone who can read that folder can read them.

**Out of scope:** Claude Code itself, Anthropic's API, and what Claude does with a prompt you send.
