# @sevten/pi-edit-reply

A [pi](https://pi.dev) extension for rewriting AI history:

- **`/edittree`** — batch-edit LLM replies (text and/or their reasoning). Edits are held in memory until you explicitly save, then committed either as an **in-file branch** or as a **forked new session**. The original conversation is always preserved. `Ctrl+S` opens the save dialog when edits are pending.

## Install

```bash
pi install npm:@sevten/pi-edit-reply
```

## Usage

1. Type `/edittree` (only works while the agent isn't running).
2. A **session tree** opens, listing all messages across every branch of the current conversation (same navigation as the built-in `/tree`):
   - Rows whose only content is reasoning stay visible (pi's own `/tree` hides them), tagged `[thinking]` with a **preview of the thinking text**; thinking text is also searchable via the tree's type-to-search.
   - Rows with unsaved edits are tagged `[edited]`, and the footer shows a pending-edits counter.
   - `Enter` on a message opens the editor — assistant replies (text, thinking, or tool calls) and your own **user messages** alike.
   - Selecting anything else (tool results, non-message entries) shows a transient hint in the footer status bar and leaves the tree open.
   - Only messages on the **current active path** can be edited; for anything else, use the native `/tree` to move to that branch first (an edited thinking message sits at the fork visible from its tool-call row).
3. Edit the content. Messages containing reasoning are prefilled as labeled sections:

   ```
   [thinking]
   …the model's reasoning…

   [reply]
   …the visible answer…
   ```

   Returning to the tree keeps the edited row selected, so you can go straight back in. Edit either section (or both); deleting a section removes that part of the message. Messages without reasoning are prefilled as plain text. **Tool-call messages can be selected too** — e.g. to fix the reasoning that preceded a tool call; the tool calls are kept so the conversation tail stays coherent. In the editor: `Enter` (and `Shift+Enter`/`Ctrl+J`) starts a new line, `Escape`/`Ctrl+C` **keeps the draft** and returns to the session tree (re-open the message to continue where you left off), `Ctrl+S` also keeps the draft and returns to the tree (batch-edit several messages, then save from the tree), `Ctrl+G` opens your system editor.
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
- **Branch navigation**: after editing you are on the new path; to move back (or anywhere else), use pi's native `/tree` — picking any entry navigates the leaf there within the same session file (no fork, no summary prompt). Editing pre-tool thinking forks at the thinking message, which `/tree` shows via the following tool-call row.
- **Idle only**: refused while the agent is streaming or compacting.
- **Saved conversations only**: no effect in one-off runs like `pi -p "…"` that have no session file.
- **Reload**: `/reload` does not re-read path-based packages — restart pi to pick up changes to this extension.
- **Queued messages are dropped**: reloading the session clears anything you queued with `Alt+Enter`.

## License

MIT
