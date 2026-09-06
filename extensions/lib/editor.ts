/**
 * The multi-line message editor: a height-inflated Editor plus the
 * discard-confirmation wrapper around it.
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { editInExternalEditor, resolveExternalEditorCommand } from "./external-editor.js";
import {
	Container,
	Editor,
	SelectList,
	Spacer,
	Text,
	type EditorTheme,
	type SelectListTheme,
	type TUI,
} from "@earendil-works/pi-tui";

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

	// Ctrl+G: hand the buffer to the system editor ($VISUAL/$EDITOR, nano as
	// the fallback), like pi's own editor. The TUI is suspended while the
	// external editor runs; a re-entrant Ctrl+G while it is already open is
	// ignored (input still flows to this handler until tui.stop() takes
	// effect).
	let externalEditorOpen = false;
	const openExternalEditor = async () => {
		if (externalEditorOpen) return;
		externalEditorOpen = true;
		tui.stop();
		try {
			const result = await editInExternalEditor({
				command: resolveExternalEditorCommand(),
				content: editor.getText(),
			});
			if (result.status === "complete") {
				editor.setText(result.content);
			}
		} finally {
			tui.start();
			tui.requestRender(true);
			externalEditorOpen = false;
		}
	};
	// NOTE: text flows through `done` below — Editor.submitValue() resets its
	// internal state BEFORE firing onSubmit, so getText() must not be read
	// from an onSubmit callback.
	const container = new Container();
	const cancelHint = keyHint("tui.select.cancel", "discard, back");
	const buildEditorView = () => {
		container.clear();
		container.addChild(new DynamicBorder());
		container.addChild(new Text(cancelHint, 1, 0));
		container.addChild(new Text(title, 1, 0));
		container.addChild(new DynamicBorder());
		container.addChild(editor);
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				"enter newline  " +
					cancelHint +
					"  ctrl+s stage, back  " +
					keyHint("app.editor.external", "system editor"),
				1,
				0,
			),
		);
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder());
	};

	// --- discard confirmation ------------------------------------------------
	// Esc with an untouched buffer exits immediately; Esc with real edits
	// swaps in a confirm dialog so a stray Esc can't throw away work.
	let active: "editor" | "confirm" = "editor";
	let confirmList: SelectList;
	let confirmFocused = false;
	const buildConfirmView = () => {
		const listTheme: SelectListTheme = {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		};
		confirmList = new SelectList(
			[
				{
					value: "keep",
					label: "Keep editing",
					description: "Return to the editor with your changes intact",
				},
				{
					value: "discard",
					label: "Discard changes",
					description: "Throw away the edited text and go back",
				},
			],
			2,
			listTheme,
		);
		confirmList.onSelect = (item) => {
			if (item.value === "discard") {
				done(undefined);
				return;
			}
			active = "editor";
			buildEditorView();
		};
		confirmList.onCancel = () => {
			// Esc in the confirm dialog = keep editing (the safe default).
			active = "editor";
			buildEditorView();
		};
		container.clear();
		container.addChild(new DynamicBorder());
		container.addChild(new Text(theme.fg("warning", "Discard your edits?"), 1, 0));
		container.addChild(new DynamicBorder());
		container.addChild(confirmList);
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					`${keyHint("tui.select.confirm", "confirm")}  ${keyHint("tui.select.cancel", "keep editing")}`,
				),
				1,
				0,
			),
		);
		container.addChild(new DynamicBorder());
	};
	buildEditorView();

	// Route input. Keys are deliberately unlike pi's default editor:
	// - Enter inserts a newline so multi-line text can be typed naturally
	//   (Shift+Enter/Ctrl+J also reach the editor's own newline handling)
	// - Esc/Ctrl+C discard the buffer and return to the tree — but only
	//   after a confirmation when the buffer was actually modified; Ctrl+S
	//   stages the edit (pending set), keeping originals untouched until
	//   the save dialog commits them
	(container as unknown as { handleInput: (data: string) => void }).handleInput = (
		data: string,
	) => {
		if (active === "confirm") {
			confirmList.handleInput(data);
			return;
		}
		if (data === "\u0013") {
			// Ctrl+S: stage the edit and return to the tree.
			done(editor.getText());
			return;
		}
		if (keybindings.matches(data, "app.editor.external")) {
			// Ctrl+G: open the system editor on the current buffer.
			void openExternalEditor();
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			// Esc/Ctrl+C: leave without staging — confirm first if edited.
			if (editor.getText() === prefill) {
				done(undefined);
				return;
			}
			active = "confirm";
			buildConfirmView();
			return;
		}
		if (data === "\r") {
			// Bare Enter: newline instead of submit.
			(editor as unknown as { addNewLine: () => void }).addNewLine();
			return;
		}
		editor.handleInput(data);
	};
	// Container is not Focusable by itself; forward focus to the active inner
	// component so the TUI routes keyboard input to it (same as
	// ExtensionEditorComponent).
	Object.defineProperty(container, "focused", {
		get: () => (active === "confirm" ? confirmFocused : editor.focused),
		set: (value: boolean) => {
			editor.focused = value;
			confirmFocused = value;
		},
	});
	return container;
}

/**
 * Roughly estimate how many visual lines the prefill will occupy after
 * word-wrap at `columns`, for the editor height heuristic.
 */
export function estimateVisualLines(text: string, columns: number): number {
	let lines = 0;
	for (const rawLine of text.split("\n")) {
		lines += Math.max(1, Math.ceil(rawLine.length / Math.max(1, columns - 2)));
	}
	return lines;
}
