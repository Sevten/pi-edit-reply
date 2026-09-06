/**
 * Session file machinery: reading the JSONL file, walking the active path,
 * building the edited copies, and writing branches / forked sessions.
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { buildEditedContent, parseEdited } from "./content.js";

function newId(existing: Set<string>): string {
	let id = randomUUID().slice(0, 8);
	while (existing.has(id)) id = randomUUID().slice(0, 8);
	return id;
}

export type FileEntry = {
	type: string;
	id: string;
	parentId: string | null;
} & Record<string, unknown>;

export function asMessageEntry(entry: FileEntry): SessionMessageEntry | null {
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


export function editedSummary(edited: string, max = 46): string {
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

export function writeAtomic(file: string, lines: string[]): void {
	const tmp = `${file}.edittree.tmp`;
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
