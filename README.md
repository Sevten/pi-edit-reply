# @sevten/pi-edit-reply

A [pi](https://pi.dev) extension to **edit an AI reply after it's been sent** and keep the conversation going from your corrected version.

`/editreply` opens a session tree; pick any AI reply, edit its text, and the conversation continues from the edit — the original reply stays in the tree in case you want it back.

## Install

```bash
pi install npm:@sevten/pi-edit-reply
```

Requires pi ≥ 0.84.1.

## Usage

1. Type `/editreply` (only works while the agent isn't running).
2. A **session tree** opens, listing all messages across every branch of the current conversation (same navigation as the built-in `/tree`).
   - Selecting an AI reply with text opens the editor.
   - Selecting anything else (your own messages, tool runs) shows a warning and leaves the tree open.
3. Edit the text. In the editor: `Enter` submits, `Shift+Enter`/`Ctrl+J` starts a new line, `Escape`/`Ctrl+C` cancels, `Ctrl+G` opens your system editor.
4. Done — the transcript shows your edited reply and the conversation continues from it.

The original reply isn't lost: it remains in the session tree, reachable via `/tree`.

## Notes

- **Only edits text**: tool calls are dropped from the edited copy (on the new path there are no tool results to answer them); reasoning/thinking blocks are kept.
- **Idle only**: refused while the agent is streaming or compacting.
- **Saved conversations only**: no effect in one-off runs like `pi -p "…"` that have no session file.
- **Queued messages are dropped**: reloading the session clears anything you queued with `Alt+Enter`.

## Development

```bash
git clone git@github.com:sevten/pi-edit-reply.git
cd pi-edit-reply
pi -e ./extensions/edit-reply.ts   # run pi with the local extension
```

No build step — the `.ts` extension is loaded directly. Only dependency is `@earendil-works/pi-coding-agent` (bundled by pi).

## License

MIT
