# @sevten/pi-edit-reply

A [pi](https://pi.dev) extension with two commands:

- **`/editreply`** — edit an LLM reply (text and/or its reasoning) by creating an edited copy on a new branch, preserving the original.
- **`/switch`** — navigate the session tree with full visibility: pi's own `/tree` hides assistant rows that have no text (tool-call rounds), including branches created by editing pre-tool thinking; this selector shows them, tagged `[thinking]`.

`/editreply` opens the session tree; pick any LLM reply, edit its text **and/or its reasoning (thinking) block**, and the conversation continues from the edited version — the original reply stays in the tree in case you want it back. Use `/switch` to move between branches afterwards.

## Install

```bash
pi install npm:@sevten/pi-edit-reply
```

## Usage

1. Type `/editreply` (only works while the agent isn't running).
2. A **session tree** opens, listing all messages across every branch of the current conversation (same navigation as the built-in `/tree`). Assistant replies that contain reasoning are tagged with a `[thinking]` marker so they are easy to spot — including tool-call rounds whose text is empty (pi's own `/tree` hides those rows; this editor shows them).
   - Selecting an LLM reply (text, thinking, or tool calls) opens the editor.
   - Selecting anything else (your own messages, tool results) shows a transient hint in the footer status bar and leaves the tree open.
3. Edit the content. Messages are prefilled as labeled sections whenever they contain reasoning:

   ```
   [thinking]
   …the model's reasoning…

   [reply]
   …the visible answer…
   ```

   Edit either section (or both); messages without reasoning are prefilled as plain text. **Tool-call messages can be selected too** — e.g. to fix the reasoning that preceded a tool call (the tool calls themselves are dropped from the edited copy). In the editor: `Enter` submits, `Shift+Enter`/`Ctrl+J` starts a new line, `Escape`/`Ctrl+C` returns to the session tree, `Ctrl+G` opens your system editor. `Escape` in the tree exits.
4. Done — the transcript shows your edited reply and the conversation continues from it.

The original reply isn't lost: it remains in the session tree, reachable via `/tree`.

## Notes

- **Edits text and thinking**: tool calls are dropped from the edited copy (on the new path there are no tool results to answer them). Removing all content from both sections returns to the tree without writing anything.
- **`/switch` for branch navigation**: after editing, the conversation continues from the edited copy. To move back (or anywhere else), use `/switch` — picking any entry navigates the leaf there within the same session file (no fork, no summary prompt). Escape exits.
- **Thinking signatures**: editing the thinking text invalidates the provider's cryptographic signature over it, so the copy is stored with the signature cleared. pi's Anthropic provider then degrades the unsigned block gracefully instead of failing signature verification. Redacted thinking blocks (encrypted by safety filters) are never editable and pass through untouched.
- **Idle only**: refused while the agent is streaming or compacting.
- **Saved conversations only**: no effect in one-off runs like `pi -p "…"` that have no session file.
- **Reload**: `/reload` does not re-read path-based packages — restart pi to pick up changes to this extension.
- **Queued messages are dropped**: reloading the session clears anything you queued with `Alt+Enter`.

## License

MIT
