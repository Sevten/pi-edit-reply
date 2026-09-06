# Changelog

## 0.2.1 - 2026-09-06

### Added

- **Ctrl+G opens the system editor** inside the message editor (`$VISUAL`/`$EDITOR`, nano as the fallback) — the TUI suspends while it runs, and the result lands back in the edit buffer; the `Esc`/`Ctrl+S` staging flow is unchanged.

## 0.2.0 - 2026-09-06

### Added

- **Edit multiple messages in one pass** — open message after message; each edit is held in the tree (`[edited]` tag, pending counter in the footer) and nothing is written until you explicitly save via `Ctrl+S`. The save dialog shows every pending edit (before → after) and offers: commit as an **in-file branch** (original path preserved) or a **forked new session**, each either keeping the conversation after your edits or cutting it at the last edit — or discard everything.
- **Edit thinking, and see it in the tree** — messages with reasoning open as `[thinking]` / `[reply]` sections, either part editable or deletable. Reasoning-only rows (typically right before a tool call) stay visible in the tree — tagged `[thinking]`, with a preview of the thinking text, searchable — where native `/tree` hides them. Tool calls themselves are never editable; they are copied verbatim so the tail stays paired and coherent (tool-call-only rounds stay hidden).
- **Edit your own messages** — user messages open in the same editor with the same save flow.
- **Spot edited branches** — committed copies carry a real `edited` label, visible in native `/tree` too (fork sessions skip them).

### Changed

- **Edit on any branch** — messages off the active path no longer require switching via `/tree` first. Edits are limited to a single chain per pass: touching a message on a different branch while edits are staged is refused with a hint to save first and start a new pass for that branch. Keep-tail copies the entire descendant subtree of the last edit (all sub-branches, noted in the dialog); cut-tail stops at the last edited message.
- Renamed the command `/editreply` → **`/edittree`**.
- Editor keys: `Enter` now inserts a newline (it used to submit); `Escape` / `Ctrl+C` / `Ctrl+S` keep the draft and return to the tree so you can continue with the next message.

## 0.1.1

Packaging and metadata fixes; no functional changes.

### Fixed

- Mark the scoped package as public (`publishConfig.access: "public"`) so npm publishes succeed.
- Use the canonical GitHub repo casing in `repository` / `bugs` / `homepage` URLs.

### Changed

- Add `pi-extension` / `ai-agent` keywords; reword the package description and README.

## 0.1.0

Initial release: `/editreply` — edit an LLM reply's text from a session tree; the edited copy becomes the conversation's continuation on a new branch, the original stays in the tree.
