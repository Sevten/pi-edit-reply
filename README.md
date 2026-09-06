# @sevten/pi-edit-reply

A [pi](https://pi.dev) extension for rewriting AI history: batch-edit LLM replies (text and/or their reasoning), then commit the edits as an **in-file branch** or a **forked new session**. The original conversation is always preserved.

## Install

```bash
pi install npm:@sevten/pi-edit-reply
```

## Usage

Type `/edittree` (only while the agent is idle and the session is saved to a file) to open the session tree:

- Pick a message — assistant replies and your own user messages alike — to open the editor. Messages with reasoning are shown as `[thinking]` / `[reply]` sections; either or both are editable, and deleting a section removes that part of the message. Messages without reasoning open as plain text.
- Edit as many messages as you like. Drafts are held in memory — nothing is written until you save. Rows with drafts are tagged `[edited]`; thinking-only rows stay visible (tagged `[thinking]`) where native `/tree` hides them.
- Press `Ctrl+S` (or `Escape` in the tree with pending edits) to open the **save dialog**, review every pending edit, and choose:
  - **Branch** — write the edited path into the same session file, keeping or cutting the conversation after your last edit; the original path stays intact.
  - **New session** — the same, but written to a fresh session file (the original is untouched).
  - **Discard all edits** — write nothing.
- After saving, the session reloads and the conversation continues from the edited path. Edited copies carry an `edited` label, visible in native `/tree`.

## Keys

| Key | In the editor | In the tree |
| --- | --- | --- |
| `Enter` | New line | Open the selected message |
| `Escape` / `Ctrl+C` | Return to the tree (asks for confirmation if the text was changed) | Open the save dialog when edits are pending |
| `Ctrl+S` | Stage the draft and return to the tree | Open the save dialog |
| `Ctrl+G` | Open your system editor | — |

## Notes

- Edits work on any branch, but only along a **single chain** at a time: picking a message on a different branch while edits are staged is refused — save the staged edits first (`Ctrl+S`), then start a new `/edittree` pass for that branch. Keep tail copies the entire subtree after the last edit (all sub-branches, on or off the active path); cut tail stops at the last edited message. The dialog descriptions say which.
- Messages containing tool calls can be opened to edit their reasoning or text (e.g. to fix the reasoning that preceded a call); the tool calls themselves are never modifiable and are copied verbatim so the conversation tail stays coherent. Tool results are not editable.
- Editing the thinking text clears its cryptographic signature on the copy; pi's provider handles unsigned blocks gracefully.

## License

MIT
