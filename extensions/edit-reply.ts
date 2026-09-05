/**
 * /editreply — batch-edit AI replies (text and/or thinking), then commit the
 * edits as either an in-file branch or a forked new session.
 *
 * Flow:
 *  1. Opens the same tree selector as /tree (TreeSelectorComponent), patched
 *     so assistant rows without text (tool-call rounds) stay visible and are
 *     tagged `[thinking]`. Rows with pending edits are tagged `[edited]`.
 *  2. Selecting an assistant reply opens a multi-line editor prefilled with
 *
 *         [thinking]
 *         ...reasoning text...
 *
 *         [reply]
 *         ...answer text...
 *
 *     Esc returns to the tree so more messages can be edited. Edits are held
 *     in memory (keyed by the original entry id) — nothing is written until
 *     the user explicitly saves. Editing a message back to its original text
 *     removes it from the pending set. Only messages on the current active
 *     path (leaf → root) can be edited.
 *  3. Esc in the tree with pending edits opens a save dialog: a summary of
 *     each pending edit plus the commit options (no default — the user must
 *     choose). Esc there returns to the tree.
 *  4. Commit semantics — a path copy with a single fork point, the parent of
 *     the FIRST edited message:
 *       - Branch · keep subsequent conversation: copies of every path entry
 *         from the fork point to the current leaf; edited messages replaced
 *         by their edited versions, everything else copied verbatim (so
 *         thinking signatures stay valid). The originals stay untouched.
 *       - Branch · start fresh from last edit: same, but the copy stops at
 *         the last edited message (single-edit case = the old behavior).
 *       - New session (fork): the same copies written to a brand-new session
 *         file (header carries parentSession), original file untouched.
 *         Copied entries get fresh ids either way.
 *       - Edited copies are tagged with a real `label` entry ("edited") so
 *         native /tree can tell the two paths apart (fork sessions skip
 *         labels — there is nothing to contrast against).
 *  5. After writing (tmp+rename, atomic) the session is reloaded via
 *     ctx.switchSession(), so the leaf lands on the new path.
 *
 * Notes:
 *  - Only works when the agent is idle and the session is persisted.
 *  - Assistant messages containing tool calls can be selected (e.g. to edit
 *    the thinking that preceded a tool call). Tool-call parts are KEPT on
 *    edited copies: with the full tail copied along, the copied toolResult
 *    entries must stay paired with a toolCall. The "message is empty" check
 *    therefore only triggers when thinking and reply are cleared AND no tool
 *    calls remain.
 *  - Editing the thinking text invalidates its `thinkingSignature`; the
 *    signature is cleared on edited copies so pi's Anthropic provider
 *    degrades the block gracefully instead of failing verification.
 *    Redacted thinking blocks are left untouched.
 *  - ctx.switchSession() rebuilds the session runtime (session_shutdown /
 *    session_start fire) and drops queued follow-up/steer messages.
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
	ExtensionAPI,
	KeybindingsManager,
	SessionMessageEntry,
	SessionTreeNode,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getSelectListTheme,
	keyHint,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Editor,
	SelectList,
	Spacer,
	Text,
	type EditorTheme,
	type SelectItem,
	type SelectListTheme,
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
 * Deep-clone the tree and tag assistant messages: pending edits win
 * (`edited`), then thinking (`thinking`, so tool-call-only replies with
 * reasoning stay recognizable — their preview text is empty).
 */
function withLabels(
	nodes: SessionTreeNode[],
	pendingIds: ReadonlySet<string>,
): SessionTreeNode[] {
	return nodes.map((node) => {
		const entry = node.entry;
		let label = node.label;
		if (entry.type === "message" && entry.message.role === "assistant") {
			if (pendingIds.has(entry.id)) label = "edited";
			else if (hasThinking(entry.message)) label = "thinking";
		}
		return {
			entry,
			label,
			labelTimestamp: node.labelTimestamp,
			children: withLabels(node.children, pendingIds),
		};
	});
}

function newId(existing: Set<string>): string {
	let id = randomUUID().slice(0, 8);
	while (existing.has(id)) id = randomUUID().slice(0, 8);
	return id;
}

/** Build the editor prefill: sections with headers when thinking exists. */
export function buildPrefill(message: SessionMessageEntry["message"]): string {
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
export function parseEdited(
	edited: string,
): { thinking: string | null; reply: string | null } {
	const norm = (s: string | null) =>
		s !== null && s.trim().length > 0 ? s.trim() : null;
	const thinkingAt = edited.indexOf(THINKING_HEADER);
	const replyAt = edited.indexOf(REPLY_HEADER);
	if (thinkingAt === -1) {
		// No thinking section. A lone [reply] header at the very start means
		// the user deleted the thinking section but kept the reply one; plain
		// text (no thinking existed) is the whole buffer.
		if (replyAt === 0) {
			return {
				thinking: null,
				reply: norm(edited.slice(replyAt + REPLY_HEADER.length)),
			};
		}
		return { thinking: null, reply: norm(edited) };
	}

	const thinking =
		replyAt === -1
			? edited.slice(thinkingAt + THINKING_HEADER.length)
			: edited.slice(thinkingAt + THINKING_HEADER.length, replyAt);
	const reply = replyAt === -1 ? null : edited.slice(replyAt + REPLY_HEADER.length);
	return {
		thinking: norm(thinking),
		reply: norm(reply),
	};
}

/**
 * Replace text and thinking parts with the edited content. Tool-call parts
 * are KEPT: commit copies the conversation tail along, and the copied
 * toolResult entries must stay paired with a toolCall. The thinking
 * signature is cleared whenever the thinking text was modified, so the copy
 * is never sent with a stale signature.
 */
export function buildEditedContent(
	message: SessionMessageEntry["message"],
	edited: string,
): ContentPart[] {
	const { thinking: editedThinking, reply: editedReply } = parseEdited(edited);
	const original = partsOf(message);

	let textReplaced = false;
	let thinkingReplaced = false;
	let firstToolCallIdx = -1;
	const out: ContentPart[] = [];

	for (const part of original) {
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

		if (part.type === "toolCall") {
			if (firstToolCallIdx === -1) firstToolCallIdx = out.length;
			out.push(part);
			continue;
		}

		out.push(part); // images and anything else pass through
	}

	if (editedThinking !== null && editedThinking.length > 0 && !thinkingReplaced) {
		out.unshift({ type: "thinking", thinking: editedThinking, thinkingSignature: "" });
		if (firstToolCallIdx !== -1) firstToolCallIdx++;
	}
	if (editedReply !== null && !textReplaced) {
		const textPart: TextPart = { type: "text", text: editedReply };
		if (firstToolCallIdx === -1) out.push(textPart);
		else out.splice(firstToolCallIdx, 0, textPart);
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
				writable: true,
				configurable: true,
			});
		}
		try {
			return super.render(width);
		} finally {
			// Drop the own property so the prototype getter shines through again.
			delete (terminal as { rows?: number }).rows;
		}
	}
}

export function openTallEditor(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	title: string,
	prefill: string,
	visibleLines: number,
	done: (value: string | undefined) => void,
) {
	// The factory hands us the interactive Theme, but Editor expects an
	// EditorTheme ({ borderColor, selectList }). getEditorTheme() is not
	// exported from the package root, so synthesize one from the theme.
	const editorTheme: EditorTheme = {
		borderColor: (text) => theme.fg("border", text),
		selectList: getSelectListTheme(),
	};
	const editor = new TallEditor(tui, editorTheme, visibleLines);
	editor.setText(prefill);
	// NOTE: use the argument — Editor.submitValue() resets its internal state
	// BEFORE firing onSubmit, so editor.getText() would already be "" here.
	editor.onSubmit = (text) => {
		done(text);
	};
	const container = new Container();
	container.addChild(new DynamicBorder());
	container.addChild(new Text(keyHint("tui.select.cancel", "keep draft, back"), 1, 0));
	container.addChild(new Text(title, 1, 0));
	container.addChild(new DynamicBorder());
	container.addChild(editor);
	container.addChild(new Spacer(1));
	container.addChild(
		new Text(
			keyHint("tui.select.confirm", "submit") +
				"  " +
				keyHint("tui.input.newLine", "newline") +
				"  " +
				keyHint("tui.select.cancel", "keep draft, back"),
			1,
			0,
		),
	);
	container.addChild(new Spacer(1));
	container.addChild(new DynamicBorder());

	// Route input: Esc/Ctrl+C closes the editor but KEEPS the draft (the
	// handler records any changed text as a pending edit), everything else
	// goes to the editor.
	(container as unknown as { handleInput: (data: string) => void }).handleInput = (
		data: string,
	) => {
		if (keybindings.matches(data, "tui.select.cancel")) {
			done(editor.getText());
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
	initialSelectedId?: string | null,
): TreeSelectorComponent {
	const selector = new TreeSelectorComponent(
		tree,
		leafId,
		terminalRows,
		onSelect,
		onCancel,
		undefined,
		initialSelectedId ?? undefined,
	);
	const treeList = selector.getTreeList() as unknown as {
		hasTextContent: (c: unknown) => boolean;
		applyFilter: () => void;
		findNearestVisibleIndex: (entryId: string) => number;
		selectedIndex: number;
		lastSelectedId: string | null;
		filteredNodes: Array<{ node: { entry: { id: string } } }>;
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
	// The constructor picked the initial selection while thinking-only rows
	// were still hidden (it walks up to the nearest visible ancestor, e.g. the
	// user message). Re-target now that the patched filter shows them.
	if (initialSelectedId) {
		const idx = treeList.findNearestVisibleIndex(initialSelectedId);
		treeList.selectedIndex = idx;
		treeList.lastSelectedId =
			treeList.filteredNodes[idx]?.node?.entry?.id ?? null;
	}
	return selector;
}

// ---------------------------------------------------------------------------
// Session file machinery
// ---------------------------------------------------------------------------

type FileEntry = {
	type: string;
	id: string;
	parentId: string | null;
} & Record<string, unknown>;

function asMessageEntry(entry: FileEntry): SessionMessageEntry | null {
	if (
		entry.type !== "message" ||
		typeof entry.message !== "object" ||
		entry.message === null
	) {
		return null;
	}
	return entry as unknown as SessionMessageEntry;
}

export function readSessionFile(
	sessionFile: string,
): { lines: string[]; entries: FileEntry[] } {
	const lines = readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "");
	const entries: FileEntry[] = [];
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line) as FileEntry;
			if (
				parsed &&
				typeof parsed === "object" &&
				typeof parsed.id === "string" &&
				typeof parsed.type === "string" &&
				parsed.type !== "session"
			) {
				entries.push(parsed);
			}
		} catch {
			// skip malformed lines
		}
	}
	return { lines, entries };
}

/** Path from the root down to `leafId` (inclusive), following parentIds. */
export function buildPath(entries: FileEntry[], leafId: string): FileEntry[] {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const path: FileEntry[] = [];
	const seen = new Set<string>();
	let cursor: string | null = leafId;
	while (cursor !== null && !seen.has(cursor)) {
		const entry = byId.get(cursor);
		if (!entry) break;
		seen.add(cursor);
		path.push(entry);
		cursor = entry.parentId;
	}
	return path.reverse();
}

function summarize(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function messageSummary(message: SessionMessageEntry["message"], max = 46): string {
	const parts: string[] = [];
	const thinking = thinkingOf(message);
	const text = textOf(message);
	if (thinking.trim()) parts.push(`think: ${summarize(thinking, max)}`);
	if (text.trim()) parts.push(`reply: ${summarize(text, max)}`);
	if (hasToolCalls(message)) parts.push("[tool calls]");
	return parts.join(" · ") || "(empty)";
}

function editedSummary(edited: string, max = 46): string {
	const { thinking, reply } = parseEdited(edited);
	const parts: string[] = [];
	if (thinking) parts.push(`think: ${summarize(thinking, max)}`);
	if (reply) parts.push(`reply: ${summarize(reply, max)}`);
	return parts.join(" · ") || "(cleared)";
}

/**
 * Copies of path[firstIdx..endIdx]: the new branch. Edited messages get
 * their rebuilt content; everything else is a verbatim clone (fresh ids, so
 * thinking signatures of untouched messages stay valid). The first copy's
 * parentId is the original parent of the first edited entry — that node is
 * the single fork point.
 */
export function buildCopies(
	path: FileEntry[],
	firstIdx: number,
	endIdx: number,
	pending: ReadonlyMap<string, string>,
	ids: Set<string>,
): { copies: FileEntry[]; editedCopyIds: string[] } {
	const copies: FileEntry[] = [];
	const editedCopyIds: string[] = [];
	let prevParentId = path[firstIdx]!.parentId;
	for (let i = firstIdx; i <= endIdx; i++) {
		const original = path[i]!;
		const copy = { ...original, id: newId(ids), parentId: prevParentId } as FileEntry;
		ids.add(copy.id);
		const message = asMessageEntry(original);
		const edited = pending.get(original.id);
		if (message && edited !== undefined) {
			(copy as unknown as { message: SessionMessageEntry["message"] }).message = {
				...message.message,
				content: buildEditedContent(message.message, edited),
			} as unknown as SessionMessageEntry["message"];
			editedCopyIds.push(copy.id);
		}
		copies.push(copy);
		prevParentId = copy.id;
	}
	return { copies, editedCopyIds };
}

/**
 * Real `label` entries (what native /tree reads). Written BEFORE the copies
 * in the file: _buildIndex sets the leaf to the last non-header entry, so
 * labels must not come last.
 */
export function makeLabelEntries(
	targetIds: string[],
	parentId: string | null,
	ids: Set<string>,
): FileEntry[] {
	const timestamp = new Date().toISOString();
	return targetIds.map((targetId) => ({
		type: "label",
		id: newId(ids),
		parentId,
		timestamp,
		targetId,
		label: "edited",
	}));
}

function writeAtomic(file: string, lines: string[]): void {
	const tmp = `${file}.editreply.tmp`;
	writeFileSync(tmp, [...lines, ""].join("\n"));
	renameSync(tmp, file);
}

/**
 * New session file for the fork option: pi-style header (parentSession points
 * at this session's file) + the copies, placed next to the original file.
 */
export function buildForkSession(
	sessionFile: string,
	copies: FileEntry[],
): { file: string; lines: string[] } {
	let version = 3;
	let cwd = process.cwd();
	try {
		const firstLine = readFileSync(sessionFile, "utf8").split("\n", 1)[0] ?? "";
		const header = JSON.parse(firstLine) as {
			type?: string;
			version?: number;
			cwd?: string;
		};
		if (header.type === "session") {
			if (typeof header.version === "number") version = header.version;
			if (typeof header.cwd === "string") cwd = header.cwd;
		}
	} catch {
		// keep defaults
	}
	const id = randomUUID();
	const timestamp = new Date().toISOString();
	const headerEntry = {
		type: "session",
		version,
		id,
		timestamp,
		cwd,
		parentSession: sessionFile,
	};
	const file = join(dirname(sessionFile), `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	return {
		file,
		lines: [JSON.stringify(headerEntry), ...copies.map((e) => JSON.stringify(e))],
	};
}

// ---------------------------------------------------------------------------
// Save dialog: review of pending edits + commit options in one screen
// ---------------------------------------------------------------------------

class CommitDialog extends Container {
	private readonly list: SelectList;
	private focusedState = false;

	constructor(
		theme: Theme,
		title: string,
		reviewLines: string[],
		items: SelectItem[],
		done: (value: CommitChoice | undefined) => void,
	) {
		super();
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
		for (const line of reviewLines) {
			this.addChild(new Text(theme.fg("text", line), 1, 0));
		}
		this.addChild(new Spacer(1));
		const listTheme: SelectListTheme = {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		};
		this.list = new SelectList(items, Math.min(items.length, 8), listTheme);
		this.list.onSelect = (item) => done(item.value as CommitChoice);
		this.list.onCancel = () => done(undefined);
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`${keyHint("tui.select.confirm", "confirm")}  ${keyHint("tui.select.cancel", "back to editing")}`,
				),
				1,
				0,
			),
		);
		this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
	}

	get focused(): boolean {
		return this.focusedState;
	}
	set focused(value: boolean) {
		this.focusedState = value;
	}
	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

type TreeResult = { kind: "edit"; entryId: string } | { kind: "commit" } | undefined;
type CommitChoice =
	| "branch-tail"
	| "branch-cut"
	| "fork-tail"
	| "fork-cut"
	| "discard";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("editreply", {
		description:
			"Edit AI replies (text/thinking): batch edits, then commit as a branch or a forked new session",
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

			const pending = new Map<string, string>();
			let lastSelectedId: string | null = null; // keep tree selection on return
			let statusTimer: ReturnType<typeof setTimeout> | undefined;
			const pendingStatus = () =>
				pending.size > 0
					? `${pending.size} pending edit${pending.size === 1 ? "" : "s"} — Esc opens save options`
					: undefined;
			const setPendingStatus = () => ctx.ui.setStatus("editreply", pendingStatus());
			const flash = (msg: string) => {
				ctx.ui.setStatus("editreply", msg);
				if (statusTimer) clearTimeout(statusTimer);
				statusTimer = setTimeout(() => ctx.ui.setStatus("editreply", pendingStatus()), 3000);
			};
			const cleanup = () => {
				if (statusTimer) clearTimeout(statusTimer);
				ctx.ui.setStatus("editreply", undefined);
			};

			try {
				// --- editing loop -------------------------------------------
				editingLoop: for (;;) {
					const entries = readSessionFile(sessionFile).entries;
					const path = buildPath(entries, ctx.sessionManager.getLeafId() ?? "");
					const pathIds = new Set(path.map((e) => e.id));
					const tree = withLabels(ctx.sessionManager.getTree(), new Set(pending.keys()));
					if (tree.length === 0) {
						ctx.ui.notify("/editreply: session has no entries", "warning");
						return;
					}

					const result = await ctx.ui.custom<TreeResult>(
						(tui, theme, _keybindings, done) => {
							const selector = makeTreeSelector(
								tree,
								ctx.sessionManager.getLeafId(),
								tui.terminal.rows,
								(entryId) => {
									const entry = entries.find((e) => e.id === entryId);
									const message = entry ? asMessageEntry(entry) : null;
									if (
										!message ||
										message.message.role !== "assistant" ||
										(!hasText(message.message) &&
											!hasThinking(message.message) &&
											!hasToolCalls(message.message))
									) {
										flash("Not editable: pick an assistant message ([thinking] rows have reasoning)");
										return; // keep the tree open
									}
									if (!pathIds.has(entryId)) {
										flash("Off the active path — /switch to that branch first");
										return;
									}
									done({ kind: "edit", entryId });
								},
								() => done(pending.size > 0 ? { kind: "commit" } : undefined),
								lastSelectedId,
							);
							// Ctrl+S opens the save dialog directly (same as Esc with
							// pending edits), so saving has a dedicated, visible key.
							const wrapper = new Container();
							wrapper.addChild(selector);
							if (pending.size > 0) {
								wrapper.addChild(
									new Text(
										theme.fg("dim", "Ctrl+S save  ·  Esc exit"),
										1,
										0,
									),
								);
							}
							(wrapper as unknown as { handleInput: (data: string) => void }).handleInput = (
								data: string,
							) => {
								if (data === "\u0013" && pending.size > 0) {
									done({ kind: "commit" });
									return;
								}
								selector.handleInput(data);
							};
							Object.defineProperty(wrapper, "focused", {
								get: () => selector.focused,
								set: (value: boolean) => {
									selector.focused = value;
								},
							});
							return wrapper;
						},
					);

					if (result === undefined) return; // tree Esc with no pending edits
					if (result.kind === "commit") break editingLoop;

					const entry = entries.find((e) => e.id === result.entryId);
					const message = entry ? asMessageEntry(entry) : null;
					if (!message) continue;
					lastSelectedId = message.id; // return to the tree with this row selected

					const originalPrefill = buildPrefill(message.message);
					const prefill = pending.get(message.id) ?? originalPrefill;

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
							fullscreen
								? "Edit AI reply (fullscreen, Esc to cancel):"
								: "Edit AI reply:",
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
					if (edited === originalPrefill) {
						pending.delete(message.id); // reverted to the original text
						flash("Edit reverted");
						continue;
					}
					const { thinking, reply } = parseEdited(edited);
					if (
						thinking === null &&
						reply === null &&
						!hasToolCalls(message.message)
					) {
						// Tool calls survive on the copy, so a message that still has
						// them is a valid edit ("clear the reply, keep the call").
						flash("Nothing left after editing — edit not recorded");
						continue;
					}
					pending.set(message.id, edited);
					setPendingStatus();
					flash("Draft kept (not written yet) — re-open to continue, Ctrl+S to save");
				}

				// --- commit phase -------------------------------------------
				const { lines } = readSessionFile(sessionFile);
				const { entries } = readSessionFile(sessionFile);
				const leafId = ctx.sessionManager.getLeafId();
				if (pending.size === 0 || leafId === null) {
					cleanup();
					return;
				}
				const path = buildPath(entries, leafId);
				const pendingOnPath = path.filter((e) => pending.has(e.id));
				if (pendingOnPath.length === 0) {
					cleanup();
					return;
				}
				const firstIdx = path.findIndex((e) => pending.has(e.id));
				const lastIdx = path.reduce(
					(last, e, i) => (pending.has(e.id) ? i : last),
					-1,
				);
				const endLeafIdx = path.length - 1;
				const hasTail = lastIdx < endLeafIdx;

				const reviewLines = pendingOnPath.map(
					(e) =>
						`${messageSummary(asMessageEntry(e)!.message)}  →  ${editedSummary(pending.get(e.id)!)}`,
				);

				const items: SelectItem[] = [];
				if (hasTail) {
					items.push({
						value: "branch-tail",
						label: "Branch · keep subsequent conversation",
						description: "Same session file; copies from the first edit through the end; originals stay",
					});
					items.push({
						value: "branch-cut",
						label: "Branch · start fresh from last edit",
						description: "Same session file; copies up to the last edited message",
					});
					items.push({
						value: "fork-tail",
						label: "New session · keep subsequent conversation",
						description: "Fork to a new session file with the full edited conversation",
					});
					items.push({
						value: "fork-cut",
						label: "New session · start fresh from last edit",
						description: "Fork to a new session file, up to the last edited message",
					});
				} else {
					items.push({
						value: "branch-cut",
						label: "Branch",
						description: "Same session file; the edited copy becomes the current point",
					});
					items.push({
						value: "fork-cut",
						label: "New session",
						description: "Fork to a new session file",
					});
				}
				items.push({
					value: "discard",
					label: "Discard all edits",
					description: "Write nothing",
				});

				const choice = await ctx.ui.custom<CommitChoice | undefined>(
					(_tui, theme, _keybindings, done) =>
						new CommitDialog(
							theme,
							`Save ${pendingOnPath.length} edited message${pendingOnPath.length === 1 ? "" : "s"}?`,
							reviewLines,
							items,
							done,
						),
				);
				if (choice === undefined || choice === "discard") {
					cleanup();
					return;
				}

				const keepTail = choice === "branch-tail" || choice === "fork-tail";
				const isFork = choice === "fork-tail" || choice === "fork-cut";
				const endIdx = keepTail ? endLeafIdx : lastIdx;

				const ids = new Set(entries.map((e) => e.id));
				const { copies, editedCopyIds } = buildCopies(path, firstIdx, endIdx, pending, ids);
				const copyLines = copies.map((e) => JSON.stringify(e));

				if (isFork) {
					const fork = buildForkSession(sessionFile, copies);
					writeAtomic(fork.file, fork.lines);
					ctx.ui.notify(
						`Forked to ${fork.file.split("/").pop()} — switching…`,
						"info",
					);
					// Leaf = last file entry = the end of the copied path.
					// Do not use `ctx` after this point.
					await ctx.switchSession(fork.file);
					return;
				}

				// Branch: labels first (the leaf must land on the last copy),
				// then the copied path, appended to the existing entries.
				const labelEntries = makeLabelEntries(editedCopyIds, leafId, ids);
				const labelLines = labelEntries.map((e) => JSON.stringify(e));
				writeAtomic(sessionFile, [...lines, ...labelLines, ...copyLines]);
				ctx.ui.notify(
					`Branch created (${copies.length} entries copied) — switching…`,
					"info",
				);
				await ctx.switchSession(sessionFile);
				return;
			} finally {
				cleanup();
			}
		},
	});
}

/**
 * Roughly estimate how many visual lines the prefill will occupy after
 * word-wrap at `columns`, for the editor height heuristic.
 */
function estimateVisualLines(text: string, columns: number): number {
	let lines = 0;
	for (const rawLine of text.split("\n")) {
		lines += Math.max(1, Math.ceil(rawLine.length / Math.max(1, columns - 2)));
	}
	return lines;
}
