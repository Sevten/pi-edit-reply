# @sevten/pi-edit-reply

A [pi](https://pi.dev) extension for rewriting AI history:

- **`/editreply`** — batch-edit LLM replies (text and/or their reasoning). Edits are held in memory until you explicitly save, then committed either as an **in-file branch** or as a **forked new session**. The original conversation is always preserved.
- **`/switch`** — navigate the session tree with full visibility: pi's own `/tree` hides assistant rows that have no text (tool-call rounds), including branches created by editing pre-tool thinking; this selector shows them, tagged `[thinking]`.

## Install

```bash
pi install npm:@sevten/pi-edit-reply
```

## Usage

1. Type `/editreply` (only works while the agent isn't running).
2. A **session tree** opens, listing all messages across every branch of the current conversation (same navigation as the built-in `/tree`). Assistant replies that contain reasoning are tagged with a `[thinking]` marker so they are easy to spot — including tool-call rounds whose text is empty (pi's own `/tree` hides those rows; this editor shows them). Rows with unsaved edits are tagged `[edited]`, and the footer shows a pending-edits counter.
   - Selecting an LLM reply (text, thinking, or tool calls) opens the editor.
   - Selecting anything else (your own messages, tool results) shows a transient hint in the footer status bar and leaves the tree open.
   - Only replies on the **current active path** can be edited; for anything else, `/switch` to that branch first.
3. Edit the content. Messages are prefilled as labeled sections whenever they contain reasoning:

   ```
   [thinking]
   …the model's reasoning…

   [reply]
   …the visible answer…
   ```

   Returning to the tree keeps the edited row selected, so you can go straight back in. Edit either section (or both); deleting a section removes that part of the message. User messages can be edited the same way — the editor shows their plain text and the same save flow applies. Messages without reasoning are prefilled as plain text. **Tool-call messages can be selected too** — e.g. to fix the reasoning that preceded a tool call; the tool calls are kept so the conversation tail stays coherent. In the editor: `Enter` (and `Shift+Enter`/`Ctrl+J`) starts a new line, `Escape`/`Ctrl+C` **keeps the draft** and returns to the session tree (re-open the message to continue where you left off), `Ctrl+S` also keeps the draft and returns to the tree (batch-edit several messages, then save from the tree), `Ctrl+G` opens your system editor.
4. Keep editing: drafts accumulate in memory — nothing is written to disk until you save. Submitting a message back to its original text removes it from the pending set.
5. The **save dialog** opens with `Ctrl+S` (in the tree, or in the editor), or with `Escape` in the tree when there are pending edits. It lists every pending edit (before → after) and the commit options — there is no default, you always choose explicitly:
   - **Branch · keep subsequent conversation** — copies the path from the first edited message to the end of the conversation into the same session file, with your edits woven in; the original path stays intact.
   - **Branch · start fresh from last edit** — same, but the copy stops at the last edited message (the conversation continues from there without the old tail).
   - **New session · keep subsequent conversation / start fresh from last edit** — the same copies written to a brand-new session file (a fork; the original session is untouched). The new file carries a `parentSession` link and appears in pi's session list.
   - **Discard all edits** — write nothing.
6. After saving, the session reloads and the conversation continues from the edited path.

### How branches are laid out

There is exactly **one fork point**: the parent of the first edited message. Everything from there to the chosen end point is copied (edited messages replaced, everything else verbatim), forming a parallel path that native `/tree` displays like any other branch. Edited copies are tagged with a real `edited` label so you can tell the paths apart in `/tree` (fork sessions skip labels — there is nothing to contrast against).

```
U1 ─┬─ A1 → U2 → A2 → U3 → A3          (original, untouched)
    └─ A1' → U2' → A2' → U3' → A3'     (edited path; single fork at U1)
```

## Notes

- **Tool calls survive**: edited copies keep their tool-call parts, so copied `toolResult` entries stay paired and the context remains valid. Clearing thinking and reply from a tool-call message is a valid edit ("keep the call, drop the prose"); clearing both from a plain message is rejected as "nothing left".
- **Thinking signatures**: editing the thinking text invalidates the provider's cryptographic signature over it, so edited copies store the signature cleared. pi's Anthropic provider then degrades the unsigned block gracefully instead of failing signature verification. Verbatim-copied messages keep their signatures. Redacted thinking blocks (encrypted by safety filters) are never editable and pass through untouched.
- **`/switch` for branch navigation**: after editing you are on the new path; to move back (or anywhere else), use `/switch` — picking any entry navigates the leaf there within the same session file (no fork, no summary prompt). Escape exits.
- **Idle only**: refused while the agent is streaming or compacting.
- **Saved conversations only**: no effect in one-off runs like `pi -p "…"` that have no session file.
- **Reload**: `/reload` does not re-read path-based packages — restart pi to pick up changes to this extension.
- **Queued messages are dropped**: reloading the session clears anything you queued with `Alt+Enter`.

## License

MIT
