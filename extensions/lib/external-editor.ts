/**
 * External editor support, mirroring pi's own
 * `modes/interactive/external-editor.js` (not exported from the package
 * root, so extensions reimplement it): write the buffer to a temp file, hand
 * it to $VISUAL/$EDITOR (nano as the fallback), read it back on exit.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult =
	| { status: "complete"; content: string }
	| { status: "failed" };

export function resolveExternalEditorCommand(): string {
	return (
		process.env.VISUAL ||
		process.env.EDITOR ||
		(process.platform === "win32" ? "notepad" : "nano")
	);
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function editInExternalEditor(
	options: ExternalEditorOptions,
): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		const [editor, ...editorArgs] = options.command.split(" ");
		process.stdout.write(
			`Launching external editor: ${options.command}\nPi will resume when the editor exits.\n`,
		);
		// Do not use spawnSync here. On Windows, synchronous child_process calls
		// can keep Node/libuv's console input read active after the parent
		// pauses stdin, racing vim/nvim for the console input buffer until
		// Ctrl+C cancels the pending read. (Same as pi's implementation.)
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});
		if (exitCode !== 0) {
			return { status: "failed" };
		}
		return {
			status: "complete",
			content: stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, ""),
		};
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
