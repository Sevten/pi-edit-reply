/**
 * /editreply - Edit an AI reply (text and/or thinking) by creating an edited
 * branch copy.
 *
 * Flow:
 *  1. Opens the same tree selector as /tree (TreeSelectorComponent).
 *  2. Selecting an assistant reply with text and/or thinking opens a
 *     multi-line editor prefilled with the message content:
 *
 *         [thinking]
 *         ...reasoning text...
 *
 *         [reply]
 *         ...answer text...
 *
 *     The `[thinking]` section only appears when the message actually has
 *     thinking blocks; otherwise the editor is prefilled with just the text.
 *  3. On submit, the sections are parsed back out. An edited COPY of the
 *     message is appended to the session file as a sibling branch (same
 *     parentId, new id), then the session is reloaded via
 *     ctx.switchSession() so the leaf lands on the copy.
 *  4. The original message and its whole subtree stay untouched in the tree;
 *     continuing the conversation continues from the edited copy.
 *
 * Notes:
 *  - Only works when the agent is idle and the session is persisted.
 *  - Assistant messages containing tool calls can be selected (e.g. to edit
 *    the thinking that preceded a tool call). Tool-call parts are stripped
 *    from the copy: after branching there are no tool results, and a
 *    dangling tool_use would be rejected by Anthropic providers. The
 *    original message keeps its tool calls and results.
 *  - Esc in the editor returns to the tree selector; Esc in the tree exits.
 *  - Editing the thinking text invalidates its `thinkingSignature`, so the
 *    signature is cleared on the copy. pi's Anthropic provider then sends the
 *    block without a valid signature (degraded to plain text, or with an
 *    empty signature when the model allows it) instead of failing signature
 *    verification. Redacted thinking blocks are left untouched.
 *  - ctx.switchSession() rebuilds the session runtime (session_shutdown /
 *    session_start fire) and drops queued follow-up/steer messages.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	KeybindingsManager,
	SessionMessageEntry,
	SessionTreeNode,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	keyHint,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Editor,
	Spacer,
	Text,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

type TextPart = { type: "text"; text: string };
type ThinkingPart = {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
};
type UnknownPart = { type: string } & Record<string, unknown>;
type ContentPart = TextPart | ThinkingPart | UnknownPart;

function isText(part: ContentPart): part is TextPart {
	return part.type === "text";
}
function isThinking(part: ContentPart): part is ThinkingPart {
	return part.type === "thinking";
}

const THINKING_HEADER = "[thinking]";
const REPLY_HEADER = "[reply]";

function partsOf(message: SessionMessageEntry["message"]): ContentPart[] {
	if (!("content" in message) || !Array.isArray(message.content)) return [];
	return message.content as ContentPart[];
}
function textOf(message: SessionMessageEntry["message"]): string {
	const parts = partsOf(message).filter(
		(p): p is TextPart => p.type === "text" && typeof p.text === "string",
	);
	return parts.map((p) => p.text).join("\n\n");
}

function thinkingOf(message: SessionMessageEntry["message"]): string {
	const parts = partsOf(message).filter(
		(p): p is ThinkingPart =>
			p.type === "thinking" && !p.redacted && typeof p.thinking === "string",
	);
	return parts.map((p) => p.thinking).join("\n\n");
}

function hasText(message: SessionMessageEntry["message"]): boolean {
	return textOf(message).trim().length > 0;
}

function hasThinking(message: SessionMessageEntry["message"]): boolean {
	return thinkingOf(message).trim().length > 0;
}

function hasToolCalls(message: SessionMessageEntry["message"]): boolean {
	return partsOf(message).some((p) => p.type === "toolCall");
}

/**
 * Deep-clone the tree and tag assistant messages that contain thinking with
 * a `[thinking]` label, so they are recognizable in the tree selector (their
 * preview text is empty when the reply is tool calls only).
 */
function withThinkingLabels(nodes: SessionTreeNode[]): SessionTreeNode[] {
	return nodes.map((node) => {
		const entry = node.entry;
		const taggable =
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			hasThinking(entry.message);
		return {
			entry,
			label: taggable ? "thinking" : node.label,
			labelTimestamp: node.labelTimestamp,
			children: withThinkingLabels(node.children),
		};
	});
}

function newId(existing: Set<string>): string {
	let id = randomUUID().slice(0, 8);
	while (existing.has(id)) id = randomUUID().slice(0, 8);
	return id;
}

/** Build the editor prefill: sections with headers when thinking exists. */
function buildPrefill(message: SessionMessageEntry["message"]): string {
	const thinking = thinkingOf(message);
	const text = textOf(message);
	if (thinking.trim().length === 0) return text;
	const sections: string[] = [`${THINKING_HEADER}\n${thinking}`];
	if (text.trim().length > 0) sections.push(`${REPLY_HEADER}\n${text}`);
	return sections.join("\n\n");
}

/**
 * Split the edited buffer back into thinking/reply sections.
 * Returns null sections when the corresponding header is absent; an absent
 * header means that part of the message was deliberately emptied.
 */
function parseEdited(
	edited: string,
): { thinking: string | null; reply: string | null } {
	const thinkingAt = edited.indexOf(THINKING_HEADER);
	if (thinkingAt === -1) return { thinking: null, reply: edited };

	const replyAt = edited.indexOf(REPLY_HEADER);
	const thinking =
		replyAt === -1
			? edited.slice(thinkingAt + THINKING_HEADER.length)
			: edited.slice(thinkingAt + THINKING_HEADER.length, replyAt);
	const reply = replyAt === -1 ? null : edited.slice(replyAt + REPLY_HEADER.length);
	return {
		thinking: thinking.trim(),
		reply: reply === null ? null : reply.trim(),
	};
}

/**
 * Replace text and thinking parts with the edited content and strip
 * tool-call parts. The thinking signature is cleared whenever the thinking
 * text was modified, so the copy is never sent with a stale signature.
 */
function buildEditedContent(
	message: SessionMessageEntry["message"],
	edited: string,
): ContentPart[] {
	const { thinking: editedThinking, reply: editedReply } = parseEdited(edited);
	const original = partsOf(message);

	let textReplaced = false;
	let thinkingReplaced = false;
	const out: ContentPart[] = [];

	for (const part of original) {
		if (part.type === "toolCall") continue; // no results in the new branch

		if (isThinking(part)) {
			if (part.redacted) {
				out.push(part); // encrypted blocks can't be meaningfully edited
				continue;
			}
			if (thinkingReplaced) continue; // collapse extra thinking blocks
			thinkingReplaced = true;
			if (editedThinking === null || editedThinking.length === 0) continue;
			const changed = editedThinking !== part.thinking.trim();
			out.push({
				...part,
				thinking: editedThinking,
				// A stale signature would fail Anthropic verification; an
				// unsigned block degrades gracefully instead.
				thinkingSignature: changed ? "" : part.thinkingSignature,
			});
			continue;
		}

		if (isText(part)) {
			if (textReplaced) continue; // drop duplicate text parts
			textReplaced = true;
			if (editedReply !== null) out.push({ ...part, text: editedReply });
			continue;
		}

		out.push(part); // images and anything else pass through
	}

	if (editedThinking !== null && editedThinking.length > 0 && !thinkingReplaced) {
		out.unshift({ type: "thinking", thinking: editedThinking, thinkingSignature: "" });
	}
	if (editedReply !== null && !textReplaced) {
		out.push({ type: "text", text: editedReply });
	}
	return out;
}

/**
 * The stock extension editor caps its height at 30% of the terminal (hardcoded
 * in pi-tui's Editor.render: maxVisibleLines = max(5, floor(rows * 0.3))),
 * which is cramped for long replies. This subclass renders with an inflated
 * row count so the edit buffer shows `desiredVisibleLines` text lines.
 *
 * Because of the internal 0.3 factor, the terminal must claim roughly
 * desiredVisibleLines / 0.3 rows. `terminal.rows` is a prototype getter, so
 * shadowing it on the instance for the duration of one render is safe.
 */
class TallEditor extends Editor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly desiredVisibleLines: number,
	) {
		super(tui, theme);
	}

	override render(width: number): string[] {
		const terminal = this.tui.terminal as { rows: number };
		const realRows = terminal.rows;
		// floor(inflated * 0.3) must be >= desiredVisibleLines
		const inflatedRows =
			Math.ceil(this.desiredVisibleLines / 0.3) + 1;
		if (inflatedRows > realRows) {
			Object.defineProperty(terminal, "rows", {
				value: inflatedRows,
				configurable: true,
			});
		}
		try {
			return super.render(width);
		} finally {
			if (inflatedRows > realRows) delete (terminal as { rows?: number }).rows;
		}
	}
}

/**
 * Full-height multi-line editor dialog (same layout as pi's built-in extension
 * editor, but using TallEditor so long replies are actually visible).
 */
function openTallEditor(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	title: string,
	prefill: string,
	maxVisibleLines: number,
	done: (value: string | undefined) => void,
): Container {
	const editorTheme: EditorTheme = {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		// No autocomplete provider is attached to this editor, so the select-list
		// colors are never rendered; keep identity functions as safe stubs.
		selectList: {
			selectedPrefix: (t: string) => t,
			selectedText: (t: string) => t,
			description: (t: string) => t,
			scrollInfo: (t: string) => t,
			noMatch: (t: string) => t,
		},
	};

	const container = new Container();
	container.addChild(new DynamicBorder());
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("accent", title), 1, 0));
	container.addChild(new Spacer(1));

	const editor = new TallEditor(tui, editorTheme, Math.max(5, maxVisibleLines));
	editor.setText(prefill);
	editor.onSubmit = (text) => done(text);
	container.addChild(editor);

	container.addChild(new Spacer(1));
	container.addChild(
		new Text(
			keyHint("tui.select.confirm", "submit") +
				"  " +
				keyHint("tui.input.newLine", "newline") +
				"  " +
				keyHint("tui.select.cancel", "cancel"),
			1,
			0,
		),
	);
	container.addChild(new Spacer(1));
	container.addChild(new DynamicBorder());

	// Route input: Esc cancels, everything else goes to the editor.
	// (Container has no handleInput of its own, so just assign one.)
	(container as unknown as { handleInput: (data: string) => void }).handleInput = (
		data: string,
	) => {
		if (keybindings.matches(data, "tui.select.cancel")) {
			done(undefined);
			return;
		}
		editor.handleInput(data);
	};
	// Container is not Focusable by itself; forward focus to the inner editor
	// so the TUI routes keyboard input to it (same as ExtensionEditorComponent).
	Object.defineProperty(container, "focused", {
		get: () => editor.focused,
		set: (value: boolean) => {
			editor.focused = value;
		},
	});
	return container;
}

/**
 * Roughly estimate how many visual lines the prefill will occupy after
 * soft-wrapping, to decide between the inline and the fullscreen editor.
 */
function estimateVisualLines(text: string, columns: number): number {
	const width = Math.max(20, columns - 4);
	return text.split("\n").reduce(
		(sum, line) => sum + Math.max(1, Math.ceil(line.length / width)),
		0,
	);
}

/**
 * Build a TreeSelectorComponent over a labeled tree, patching pi's
 * "hide assistant rows without text" filter to count thinking as content,
 * so pre-tool reasoning rows stay visible (and show their [thinking] label).
 */
function makeTreeSelector(
	tree: SessionTreeNode[],
	leafId: string | null,
	terminalRows: number,
	onSelect: (entryId: string) => void,
	onCancel: () => void,
): TreeSelectorComponent {
	const selector = new TreeSelectorComponent(tree, leafId, terminalRows, onSelect, onCancel);
	const treeList = selector.getTreeList() as unknown as {
		hasTextContent: (c: unknown) => boolean;
		applyFilter: () => void;
	};
	treeList.hasTextContent = (content: unknown) => {
		if (typeof content === "string") return content.trim().length > 0;
		if (!Array.isArray(content)) return false;
		for (const c of content) {
			if (typeof c !== "object" || c === null || !("type" in c)) continue;
			const part = c as {
				type: string;
				text?: unknown;
				thinking?: unknown;
				redacted?: unknown;
			};
			if (
				part.type === "text" &&
				typeof part.text === "string" &&
				part.text.trim().length > 0
			) {
				return true;
			}
			if (
				part.type === "thinking" &&
				part.redacted !== true &&
				typeof part.thinking === "string" &&
				part.thinking.trim().length > 0
			) {
				return true;
			}
		}
		return false;
	};
	treeList.applyFilter();
	return selector;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("editreply", {
		description:
			"Edit an AI reply (text/thinking): creates an edited branch copy, original preserved",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("/editreply: agent is busy, wait for it to finish", "warning");
				return;
			}
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (typeof sessionFile !== "string") {
				ctx.ui.notify("/editreply: this session is not persisted to a file", "warning");
				return;
			}

			const tree = withThinkingLabels(ctx.sessionManager.getTree());
			if (tree.length === 0) {
				ctx.ui.notify("/editreply: session has no entries", "warning");
				return;
			}

			// In-tree feedback: footer status instead of notify(), which would
			// stack lines in the main conversation. Auto-clears after a moment.
			let statusTimer: ReturnType<typeof setTimeout> | undefined;
			const warnInTree = (msg: string) => {
				ctx.ui.setStatus("editreply", msg);
				if (statusTimer) clearTimeout(statusTimer);
				statusTimer = setTimeout(() => ctx.ui.setStatus("editreply", undefined), 3000);
			};

			// Loop: pick a message in the tree, edit it. Esc/unchanged returns to
			// the tree so another message (or the same one) can be picked.
			for (;;) {
				const selectedId = await ctx.ui.custom<string | undefined>(
					(tui, _theme, _keybindings, done) =>
						makeTreeSelector(
							tree,
							ctx.sessionManager.getLeafId(),
							tui.terminal.rows,
							(entryId) => {
								const entry = ctx.sessionManager.getEntry(entryId);
								if (
									!entry ||
									entry.type !== "message" ||
									entry.message.role !== "assistant" ||
									(!hasText(entry.message) &&
										!hasThinking(entry.message) &&
										!hasToolCalls(entry.message))
								) {
									warnInTree(
										"Not editable: pick an assistant message ([thinking] rows have reasoning)",
									);
									return; // keep the tree open
								}
								done(entryId);
							},
							() => done(undefined),
						),
				);

				if (!selectedId) return;

				const entry = ctx.sessionManager.getEntry(selectedId);
				if (!entry || entry.type !== "message" || entry.message.role !== "assistant") return;

				const prefill = buildPrefill(entry.message);

				// The dialog wraps the editor with 8 chrome lines (borders,
				// title, hint, spacers) and the editor draws 2 border lines of
				// its own, so a fullscreen dialog fits rows - 10 text lines.
				const columns = process.stdout.columns ?? 80;
				const rows = process.stdout.rows ?? 24;
				const CHROME_LINES = 10;
				const fullscreenCap = Math.max(8, rows - CHROME_LINES);
				const estimatedLines = estimateVisualLines(prefill, columns);

				// Grow the editor with the content; once the content can no
				// longer fit on one screen, switch to a fullscreen overlay and
				// let the editor scroll (cursor stays in view automatically).
				const fullscreen = estimatedLines > fullscreenCap;
				const maxVisibleLines = fullscreen
					? fullscreenCap
					: Math.max(5, estimatedLines);

				const factory = (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (value: string | undefined) => void,
				) =>
					openTallEditor(
						tui,
						theme,
						keybindings,
						fullscreen ? "Edit AI reply (fullscreen, Esc to cancel):" : "Edit AI reply:",
						prefill,
						maxVisibleLines,
						done,
					);
				const edited = fullscreen
					? await ctx.ui.custom<string | undefined>(factory, {
							overlay: true,
							overlayOptions: {
								anchor: "top-left",
								width: "100%",
							},
						})
					: await ctx.ui.custom<string | undefined>(factory);
				if (edited === undefined) continue; // cancelled -> back to the tree
				if (edited === prefill) continue; // unchanged -> back to the tree

				const { thinking, reply } = parseEdited(edited);
				if (
					(thinking === null || thinking.length === 0) &&
					(reply === null || reply.length === 0)
				) {
					warnInTree("Nothing left after editing — nothing was written");
					continue;
				}

				const lines = readFileSync(sessionFile, "utf8")
					.split("\n")
					.filter((l) => l.trim() !== "");
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
					message: {
						...entry.message,
						content: buildEditedContent(
							entry.message,
							edited,
						) as SessionMessageEntry["message"] extends { content?: infer C } ? C : never,
					},
				};

				const tmp = `${sessionFile}.editreply.tmp`;
				writeFileSync(tmp, [...lines, JSON.stringify(copy)].join("\n") + "\n");
				renameSync(tmp, sessionFile);

				ctx.ui.notify("Reply edited, switching to edited branch…", "info");
				// Reload from disk: leaf = last file entry = the edited copy.
				// Do not use `ctx` after this point.
				await ctx.switchSession(sessionFile);
				return;
			}
		},
	});

	// /switch - navigate the session tree with [thinking] rows visible.
	// Native /tree hides assistant rows that have no text (tool-call rounds),
	// so branches created by editing pre-tool thinking can be hard to reach
	// there. This selector shows those rows; picking any entry moves the
	// conversation leaf to it (same file, no fork).
	pi.registerCommand("switch", {
		description:
			"Navigate the session tree (shows [thinking] rows that /tree hides)",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("/switch: agent is busy, wait for it to finish", "warning");
				return;
			}

			const tree = withThinkingLabels(ctx.sessionManager.getTree());
			if (tree.length === 0) {
				ctx.ui.notify("/switch: session has no entries", "warning");
				return;
			}

			const selectedId = await ctx.ui.custom<string | undefined>(
				(tui, _theme, _keybindings, done) =>
					makeTreeSelector(
						tree,
						ctx.sessionManager.getLeafId(),
						tui.terminal.rows,
						(entryId) => done(entryId),
						() => done(undefined),
					),
			);
			if (!selectedId) return;
			if (selectedId === ctx.sessionManager.getLeafId()) {
				ctx.ui.setStatus("switch", "Already at this point");
				setTimeout(() => ctx.ui.setStatus("switch", undefined), 3000);
				return;
			}

			// Moves the leaf within the same session file; the abandoned branch
			// stays in the tree. No branch-summary prompt: keep it one keystroke.
			const result = await ctx.navigateTree(selectedId, { summarize: false });
			if (!result.cancelled) {
				ctx.ui.setStatus("switch", "Navigated to selected point");
				setTimeout(() => ctx.ui.setStatus("switch", undefined), 3000);
			}
		},
	});
}
