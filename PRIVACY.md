# Privacy policy

_Panda Redline, a Claude Code plugin by Parag Pandya. Last updated 11 October 2026._

**In short: the plugin collects nothing and sends nothing to its author or to anyone else. It keeps copies of your documents on your own computer, so it can show what changed.**

## What it reads
The documents in the folder you run Claude Code in (Excel, Word, PDF, Markdown, Confluence, HTML, CSV and text files), when Claude's turn starts and ends, so it can tell what Claude changed. Those documents can contain personal information. They're read on your own computer. It also reads a few environment variables that say where Claude Code's settings folder is and whether your computer has a desktop (for example `HOME`), never anything personal.

## What it stores
- **Copies of your tracked documents**, one per version, in Panda Redline's own folder inside Claude Code's settings folder on your computer (`~/.claude/panda-redline/`, or `%USERPROFILE%\.claude\panda-redline\` on Windows). Each content is stored once. Copies are let go after the last 20 versions of a document or 7 days, whichever comes first; you can change both, and clear everything with `/redline space`.
- **A record of the versions**: file names, times, who made each version (Claude or you), and your answers to "is this a new version of that?".
- **Three small settings** in Claude Code's own plugin store: your settings, a note waiting to go to Claude, and whether you've seen the welcome message.

Comments you're writing last for the session only.

## What it sends, and where
- **Nothing to the author or any third party.** There is no server, no account, no analytics and no telemetry.
- **Your comments, to Claude, only when you press Send** (or Enter after "Edit before sending"), with the quoted parts of the change you commented on.
- **A one-line note, to Claude, only after you restore or keep a version**, such as "I restored "budget.xlsx" to the 2.14pm version". It holds only file names and times.
- Both go as normal prompts in your own Claude Code session. Like anything you type in Claude Code, they go to Anthropic under your account and are kept in your session transcript. [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy) covers them from there.
- **To your own apps, only when you ask.** Pressing **Open in …** opens the file in your computer's usual app.
- **Nothing over the network.** The plugin makes no network requests.

## Retention
Copies of documents: as set in `/redline settings` (20 versions or 7 days by default), and until you clear them or uninstall. Nothing else is kept beyond the session.

## Children
The plugin is not intended for people under 18.

## Contact
Questions about privacy: open an issue at https://github.com/paragpandyareal/panda-redline/issues. Report security problems privately as described in [SECURITY.md](SECURITY.md).
