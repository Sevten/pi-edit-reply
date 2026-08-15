/**
 * /editreply - Edit an AI reply by creating an edited branch copy.
 *
 * Flow:
 *  1. Opens the same tree selector as /tree (TreeSelectorComponent).
 *  2. Selecting an assistant reply with text opens a multi-line editor
 *     prefilled with the reply text.
 *  3. On submit, an edited COPY of the message is appended to the session
 *     file as a sibling branch (same parentId, new id), then the session is
 *     reloaded via ctx.switchSession() so the leaf lands on the copy.
 *  4. The original message and its whole subtree stay untouched in the tree;
 *     continuing the conversation continues from the edited copy.
 *
 * Notes:
 *  - Only works when the agent is idle and the session is persisted.
 *  - Tool-call parts are stripped from the copy: after branching there are no
 *    tool results, and a dangling tool_use would be rejected by Anthropic
 *    providers. The original message keeps its tool calls and results.
 *  - ctx.switchSession() rebuilds the session runtime (session_shutdown /
 *    session_start fire) and drops queued follow-up/steer messages.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { TreeSelectorComponent } from "@earendil-works/pi-coding-agent";

type TextPart = { type: "text"; text: string };

function textOf(message: SessionMessageEntry["message"]): string {
	const parts = (message.content ?? []).filter(
		(p): p is TextPart => p.type === "text" && typeof p.text === "string",
	);
	return parts.map((p) => p.text).join("\n\n");
}

function hasText(message: SessionMessageEntry["message"]): boolean {
	return textOf(message).trim().length > 0;
}

function newId(existing: Set<string>): string {
	let id = randomUUID().slice(0, 8);
	while (existing.has(id)) id = randomUUID().slice(0, 8);
	return id;
}

/** Replace text parts with the edited text and strip tool-call parts. */
function buildEditedContent(content: SessionMessageEntry["message"]["content"], edited: string) {
	let replaced = false;
	const out = (content ?? []).flatMap((part) => {
		if (part.type === "toolCall") return []; // no results in the new branch
		if (part.type !== "text") return [part];
		if (replaced) return []; // drop duplicate text parts
		replaced = true;
		return [{ ...part, text: edited }];
	});
	if (!replaced) out.push({ type: "text", text: edited });
	return out;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("editreply", {
		description: "Edit an AI reply: creates an edited branch copy, original preserved",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("/editreply: agent is busy, wait for it to finish", "warning");
				return;
			}
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("/editreply: this session is not persisted to a file", "warning");
				return;
			}

			const tree = ctx.sessionManager.getTree();
			if (tree.length === 0) {
				ctx.ui.notify("/editreply: session has no entries", "warning");
				return;
			}

			const selectedId = await ctx.ui.custom((tui, _theme, _keybindings, done) => {
				return new TreeSelectorComponent(
					tree,
					ctx.sessionManager.getLeafId(),
					tui.terminal.rows,
					(entryId) => {
						const entry = ctx.sessionManager.getEntry(entryId);
						if (
							!entry ||
							entry.type !== "message" ||
							entry.message.role !== "assistant" ||
							!hasText(entry.message)
						) {
							ctx.ui.notify("Only assistant replies with text can be edited", "warning");
							return; // keep the tree open
						}
						done(entryId);
					},
					() => done(undefined),
				);
			});
			if (!selectedId) return;

			const entry = ctx.sessionManager.getEntry(selectedId);
			if (!entry || entry.type !== "message" || entry.message.role !== "assistant") return;

			const original = textOf(entry.message);
			const edited = await ctx.ui.editor("Edit AI reply:", original);
			if (!edited || edited === original) return; // cancelled, empty, or unchanged

			const lines = readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.trim() !== "");
			const ids = new Set(
				lines
					.map((l) => (JSON.parse(l) as { id?: unknown }).id)
					.filter((id): id is string => typeof id === "string"),
			);
			const copy: SessionMessageEntry = {
				type: "message",
				id: newId(ids),
				parentId: entry.parentId,
				timestamp: new Date().toISOString(),
				message: { ...entry.message, content: buildEditedContent(entry.message.content, edited) },
			};

			const tmp = `${sessionFile}.editreply.tmp`;
			writeFileSync(tmp, [...lines, JSON.stringify(copy)].join("\n") + "\n");
			renameSync(tmp, sessionFile);

			ctx.ui.notify("Reply edited, switching to edited branch…", "info");
			// Reload from disk: leaf = last file entry = the edited copy.
			// Do not use `ctx` after this point.
			await ctx.switchSession(sessionFile);
		},
	});
}
