# Changelog

## 0.2.0 (unreleased)

Changes since 0.1.1. The command is renamed `/editreply` → **`/edittree`**; branch navigation is left to pi's native `/tree`.

### Added

- **Edit multiple messages in one pass** — open message after message; each edit is held in the tree (`[edited]` tag, pending counter in the footer) and nothing is written until you explicitly save via `Ctrl+S`. The save dialog shows every pending edit (before → after) and offers: commit as an **in-file branch** (original path preserved) or a **forked new session**, each either keeping the conversation after your edits or cutting it at the last edit — or discard everything.
- **Edit thinking, and see it in the tree** — messages with reasoning open as `[thinking]` / `[reply]` sections, either part editable or deletable; the reasoning-only rows (e.g. before a tool call) stay visible in the tree — tagged `[thinking]`, with a preview of the thinking text, searchable — where native `/tree` hides them.
- **Edit your own messages** — user messages open in the same editor with the same save flow.
- **Edit tool-call messages with prose** — e.g. to fix the reasoning or text that accompanied a tool call; the tool calls themselves are kept so the copied tail stays coherent (tool-call-only rows are listed in the tree for orientation but are not editable).
- **Spot edited branches** — committed copies carry a real `edited` label, visible in native `/tree` too (fork sessions skip them).

### Changed

- Editor keys: `Enter` now inserts a newline (it used to submit); `Escape` / `Ctrl+C` / `Ctrl+S` keep the draft and return to the tree so you can continue with the next message; `Ctrl+G` still opens the system editor.
