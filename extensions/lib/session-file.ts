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
 * Commit plan for the save dialog. `edited` lists the staged messages in
 * depth order (root → leaf). `onOldPath` is true when every edit sits on
 * the currently active path (leaf → root) — only then is the conversation
 * tail below the edits defined, so only then are "keep tail" options
 * offered. `lcaId` is the deepest common ancestor of all edited messages:
 * its parent is the single fork point of the commit.
 */
export function planEditedCommit(
	entries: FileEntry[],
	pendingIds: ReadonlySet<string>,
	leafId: string | null,
): {
	edited: FileEntry[];
	onOldPath: boolean;
	lcaId: string | null;
} {
	const { rootPathOf } = pathHelpers(entries);
	const edited = entries.filter((e) => pendingIds.has(e.id));
	const paths = edited.map((e) => rootPathOf(e.id));
	const depthOf = new Map<string, number>();
	for (const p of paths) {
		p.forEach((n, i) => {
			if (!depthOf.has(n.id)) depthOf.set(n.id, i);
		});
	}
	let lcaId: string | null = null;
	let lcaDepth = -1;
	if (paths.length > 0) {
		for (const n of paths[0]!) {
			const d = depthOf.get(n.id)!;
			if (
				d > lcaDepth &&
				paths.every((p) => p.some((m) => m.id === n.id))
			) {
				lcaId = n.id;
				lcaDepth = d;
			}
		}
	}
	const leafPath = leafId ? rootPathOf(leafId) : [];
	const leafIds = new Set(leafPath.map((n) => n.id));
	const onOldPath = edited.every((e) => leafIds.has(e.id));
	const sorted = [...edited].sort(
		(a, b) => depthOf.get(a.id)! - depthOf.get(b.id)!,
	);
	return { edited: sorted, onOldPath, lcaId };
}

function pathHelpers(entries: FileEntry[]) {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const rootPathOf = (id: string): FileEntry[] => {
		const chain: FileEntry[] = [];
		const seen = new Set<string>();
		let cursor: string | null = id;
		while (cursor !== null && !seen.has(cursor)) {
			const entry = byId.get(cursor);
			if (!entry) break;
			seen.add(cursor);
			chain.push(entry);
			cursor = entry.parentId;
		}
		return chain.reverse();
	};
	return { byId, rootPathOf };
}

/**
 * Null when `entryId` may join the staged edits: they must all live on one
 * root→leaf chain, i.e. every staged message must be an ancestor or a
 * descendant of the candidate. Otherwise returns a user-facing hint telling
 * them to save first and start a new pass for the other branch.
 */
export function chainConflict(
	entries: FileEntry[],
	pendingIds: ReadonlySet<string>,
	entryId: string,
): string | null {
	if (pendingIds.size === 0) return null;
	const { rootPathOf } = pathHelpers(entries);
	const candIds = new Set(rootPathOf(entryId).map((e) => e.id));
	for (const id of pendingIds) {
		if (candIds.has(id)) continue; // staged is an ancestor of the candidate
		if (rootPathOf(id).some((e) => e.id === entryId)) continue; // candidate is an ancestor
		return "Different branch — save these edits first (Ctrl+S), then edit that branch in a new pass";
	}
	return null;
}

/**
 * The new branch: the union of every edited message's root path below their
 * common ancestor, with edited messages rebuilt and everything else copied
 * verbatim (fresh ids, so thinking signatures of untouched messages stay
 * valid). With a single edited path this is exactly "copy from the first
 * edit down". `keepTail` additionally copies the ENTIRE descendant subtree
 * of the last edited message (all sub-branches). The copy that should
 * become the new leaf is returned LAST in `copies` (pi's index lands the
 * leaf on the last entry).
 */
export function buildEditedCopies(
	entries: FileEntry[],
	pendingIds: ReadonlySet<string>,
	keepTail: boolean,
	leafId: string | null,
	ids: Set<string>,
	pending: ReadonlyMap<string, string>,
): { copies: FileEntry[]; editedCopyIds: string[] } {
	const { rootPathOf } = pathHelpers(entries);
	const edited = entries.filter((e) => pendingIds.has(e.id));
	if (edited.length === 0) return { copies: [], editedCopyIds: [] };
	const paths = edited.map((e) => rootPathOf(e.id));

	// Deepest node common to all edited root paths.
	const depthOf = new Map<string, number>();
	for (const p of paths) {
		p.forEach((n, i) => {
			if (!depthOf.has(n.id)) depthOf.set(n.id, i);
		});
	}
	let lcaId: string | null = null;
	let lcaDepth = -1;
	for (const n of paths[0]!) {
		const d = depthOf.get(n.id)!;
		if (d > lcaDepth && paths.every((p) => p.some((m) => m.id === n.id))) {
			lcaId = n.id;
			lcaDepth = d;
		}
	}

	// Union of the edited root paths from the lca down.
	const selected = new Map<string, { entry: FileEntry; depth: number }>();
	for (const p of paths) {
		const start = p.findIndex((n) => n.id === lcaId);
		for (let i = start === -1 ? 0 : start; i < p.length; i++) {
			selected.set(p[i]!.id, { entry: p[i]!, depth: i });
		}
	}
	// Keep tail: pull in the ENTIRE descendant subtree of the last edited
	// message — all sub-branches, structure preserved.
	if (keepTail) {
		const childrenOf = new Map<string, string[]>();
		for (const e of entries) {
			const key = e.parentId ?? "";
			const list = childrenOf.get(key);
			if (list) list.push(e.id);
			else childrenOf.set(key, [e.id]);
		}
		const lastEdited = paths[paths.length - 1]!;
		const lastId = lastEdited[lastEdited.length - 1]!.id;
		const baseDepth = depthOf.get(lastId) ?? 0;
		const queue: Array<[id: string, depth: number]> = [[lastId, baseDepth]];
		while (queue.length > 0) {
			const [id, d] = queue.shift()!;
			if (d > baseDepth) {
				const entry = entries.find((e) => e.id === id);
				if (entry) selected.set(id, { entry, depth: d });
			}
			for (const child of childrenOf.get(id) ?? []) {
				queue.push([child, d + 1]);
			}
		}
	}

	// Deepest copied node on the active path becomes the new leaf; fall back
	// to the globally deepest copy when the edits lie entirely off-path.
	const { rootPathOf: rootPathInCopies } = pathHelpers(entries);
	const leafIds = new Set(rootPathInCopies(leafId ?? "").map((n) => n.id));
	let leafSel: { entry: FileEntry; depth: number } | null = null;
	let deepest: { entry: FileEntry; depth: number } | null = null;
	for (const sel of selected.values()) {
		if (!deepest || sel.depth > deepest.depth) deepest = sel;
		if (leafIds.has(sel.entry.id) && (!leafSel || sel.depth > leafSel.depth)) {
			leafSel = sel;
		}
	}
	const leafPick = leafSel ?? deepest;

	// Depth order = parents before children; the leaf pick moves last.
	const ordered = [...selected.values()].sort((a, b) => a.depth - b.depth);
	if (leafPick) {
		const idx = ordered.findIndex((s) => s.entry.id === leafPick.entry.id);
		if (idx !== -1 && idx !== ordered.length - 1) {
			ordered.push(...ordered.splice(idx, 1));
		}
	}

	const copies: FileEntry[] = [];
	const editedCopyIds: string[] = [];
	const copyIdByOrig = new Map<string, string>();
	for (const { entry: original } of ordered) {
		const parentId = copyIdByOrig.get(original.parentId ?? "") ?? original.parentId;
		const copy = { ...original, id: newId(ids), parentId } as FileEntry;
		ids.add(copy.id);
		copyIdByOrig.set(original.id, copy.id);
		const message = asMessageEntry(original);
		const editedText = pending.get(original.id);
		if (message && editedText !== undefined) {
			(copy as unknown as { message: SessionMessageEntry["message"] }).message = {
				...message.message,
				content: buildEditedContent(message.message, editedText),
			} as unknown as SessionMessageEntry["message"];
			editedCopyIds.push(copy.id);
		}
		copies.push(copy);
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
