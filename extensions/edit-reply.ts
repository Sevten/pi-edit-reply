/**
 * /edittree — batch-edit conversation messages (text and/or thinking), then
 * commit the edits as either an in-file branch or a forked new session.
 * Originals are always preserved.
 *
 * Flow:
 *  1. A tree selector shows the session; rows with pending edits are tagged
 *     `[edited]`, thinking-only rows stay visible and tagged `[thinking]`.
 *  2. Selecting a row opens a multi-line editor with `[thinking]` /
 *     `[reply]` sections. Edits are held in memory (keyed by entry id) —
 *     nothing is written until the user explicitly saves. Esc discards, but
 *     only after a confirmation when the buffer was modified.
 *  3. Esc/Ctrl+S in the tree opens a save dialog listing every pending edit
 *     and the commit options (no default — the user must choose).
 *  4. Commit: a single path copy forked at the parent of the FIRST edited
 *     message — either keeping the conversation after the edits (tail) or
 *     cutting at the last edit — written to the same file (branch) or a new
 *     session file (fork). Copied entries get fresh ids; edited copies are
 *     tagged with a real `label` entry ("edited") so native /tree can tell
 *     the paths apart.
 *  5. After an atomic write the session is reloaded via ctx.switchSession(),
 *     which drops queued follow-up/steer messages and rebuilds the session
 *     runtime.
 *
 * See lib/ for the pieces: content parsing (content), the editor
 * (editor), tree labeling/selection (tree), and session-file IO
 * (session-file).
 */

import type {
	ExtensionAPI,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint } from "@earendil-works/pi-coding-agent";
import {
	Container,
	SelectList,
	Spacer,
	Text,
	type SelectItem,
	type SelectListTheme,
	type TUI,
} from "@earendil-works/pi-tui";

// Re-exported for tests and programmatic use.
export { buildPrefill, parseEdited } from "./lib/content.js";
export { buildPath, buildForkSession, readSessionFile } from "./lib/session-file.js";

import {
	buildPrefill,
	parseEdited,
	hasText,
	hasThinking,
	hasToolCalls,
} from "./lib/content.js";
import { openTallEditor, estimateVisualLines } from "./lib/editor.js";
import {
	editedSummary,
	asMessageEntry,
	buildCopies,
	buildPath,
	buildForkSession,
	makeLabelEntries,
	readSessionFile,
	writeAtomic,
	type FileEntry,
} from "./lib/session-file.js";
import { makeTreeSelector, withLabels } from "./lib/tree.js";

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
	| "branch-cut"
	| "fork-tail"
	| "fork-cut"
	| "discard";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("edittree", {
		description:
			"Edit conversation messages (text/thinking): batch edits, then commit as a branch or a forked new session",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("/edittree: agent is busy, wait for it to finish", "warning");
				return;
			}
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (typeof sessionFile !== "string") {
				ctx.ui.notify("/edittree: this session is not persisted to a file", "warning");
				return;
			}

			const pending = new Map<string, string>();
			let lastSelectedId: string | null = null; // keep tree selection on return
			let statusTimer: ReturnType<typeof setTimeout> | undefined;
			const pendingStatus = () =>
				pending.size > 0
					? `${pending.size} pending edit${pending.size === 1 ? "" : "s"} — Esc opens save options`
					: undefined;
			const setPendingStatus = () => ctx.ui.setStatus("edittree", pendingStatus());
			const flash = (msg: string) => {
				ctx.ui.setStatus("edittree", msg);
				if (statusTimer) clearTimeout(statusTimer);
				statusTimer = setTimeout(() => ctx.ui.setStatus("edittree", pendingStatus()), 3000);
			};
			const cleanup = () => {
				if (statusTimer) clearTimeout(statusTimer);
				ctx.ui.setStatus("edittree", undefined);
			};

			let switched = false;
			try {
				// Outer loop: Escape / Discard in the save dialog come back here.
				sessionEdit: for (;;) {
				// --- editing loop -------------------------------------------
				editingLoop: for (;;) {
					const entries = readSessionFile(sessionFile).entries;
					const path = buildPath(entries, ctx.sessionManager.getLeafId() ?? "");
					const pathIds = new Set(path.map((e) => e.id));
					const tree = withLabels(ctx.sessionManager.getTree(), pending);
					if (tree.length === 0) {
						ctx.ui.notify("/edittree: session has no entries", "warning");
						return;
					}

					// Only on-path user/assistant messages with at least one
					// editable part can be opened in the editor.
					const editGuard = (entryId: string): string | null => {
						const entry = entries.find((e) => e.id === entryId);
						const message = entry ? asMessageEntry(entry) : null;
						if (
							!message ||
							(message.message.role !== "assistant" &&
								message.message.role !== "user") ||
							(!hasText(message.message) &&
								!hasThinking(message.message) &&
								!hasToolCalls(message.message))
						) {
							if (entry && asMessageEntry(entry)?.message.role === "toolResult") {
								return "Tool results are not editable — pick the assistant tool-call row above";
							}
							return "Not editable: pick a user or assistant message";
						}
						if (!pathIds.has(entryId)) {
							return "Off the active path — /tree to that branch first";
						}
						return null;
					};

					const result = await ctx.ui.custom<TreeResult>(
						(tui, theme, _keybindings, done) => {
							// Enter = edit the picked row (editGuard keeps the tree open
							// with a flash when the row is not editable).
							const selector = makeTreeSelector(
								tree,
								ctx.sessionManager.getLeafId(),
								tui.terminal.rows,
								(entryId) => {
									const problem = editGuard(entryId);
									if (problem) {
										flash(problem);
										return; // keep the tree open
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
								? "Edit message (fullscreen):"
								: "Edit message:",
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

					if (edited === undefined) {
						flash("Edit discarded");
						continue; // back to the tree
					}
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

				// Show only the edited (after) content — a before → after diff of
				// truncated summaries is unreadable, especially for appends.
				const reviewLines = pendingOnPath.map((e, i) => {
					const role = asMessageEntry(e)?.message.role ?? "message";
					return `${i + 1}. ${role}: ${editedSummary(pending.get(e.id)!)}`;
				});

				const items: SelectItem[] = [];
				if (hasTail) {
					items.push({
						value: "branch-tail",
						label: "Branch · keep tail",
						description: "Same file; copies from the first edit to the end; originals stay",
					});
					items.push({
						value: "branch-cut",
						label: "Branch · cut tail",
						description: "Same file; copies up to the last edited message",
					});
					items.push({
						value: "fork-tail",
						label: "New session · keep tail",
						description: "New file with the full edited conversation",
					});
					items.push({
						value: "fork-cut",
						label: "New session · cut tail",
						description: "New file, up to the last edited message",
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
				// Escape goes back to editing; Discard clears the pending set and
				// re-opens the tree — neither exits to the main conversation.
				if (choice === undefined) continue sessionEdit;
				if (choice === "discard") {
					pending.clear();
					setPendingStatus();
					continue sessionEdit;
				}

				const keepTail = choice === "branch-tail" || choice === "fork-tail";
				const isFork = choice === "fork-tail" || choice === "fork-cut";
				const endIdx = keepTail ? endLeafIdx : lastIdx;

				const ids = new Set(entries.map((e) => e.id));
				const { copies, editedCopyIds } = buildCopies(path, firstIdx, endIdx, pending, ids);
				const copyLines = copies.map((e) => JSON.stringify(e));

				// Clean up on the OLD ctx before switching — pi invalidates the
				// captured command ctx after switchSession().
				cleanup();
				const clearStatus = async (fresh: {
					ui: { setStatus: (k: string, v: string | undefined) => void };
				}) => fresh.ui.setStatus("edittree", undefined);

				if (isFork) {
					const fork = buildForkSession(sessionFile, copies);
					writeAtomic(fork.file, fork.lines);
					ctx.ui.notify(
						`Forked to ${fork.file.split("/").pop()} — switching…`,
						"info",
					);
					// Leaf = last file entry = the end of the copied path.
					// Post-switch work must go through withSession (fresh ctx).
					await ctx.switchSession(fork.file, { withSession: clearStatus });
					switched = true;
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
				await ctx.switchSession(sessionFile, { withSession: clearStatus });
				switched = true;
				return;
			}
			} finally {
				if (!switched) cleanup();
			}
		},
	});
}

