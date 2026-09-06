/**
 * Tree rendering: labeling the session tree with pending edits, and the
 * patched TreeSelectorComponent that keeps thinking-only rows visible.
 */

import type { SessionMessageEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { buildEditedContent, hasText, hasThinking } from "./content.js";
import { TreeSelectorComponent } from "@earendil-works/pi-coding-agent";

/**
 * Deep-clone the tree and tag messages: pending edits win (`edited`), then
 * thinking (`thinking`, so tool-call-only replies with reasoning stay
 * recognizable — their preview text is empty). Pending messages also get
 * their EDITED content swapped into the clone, so the row preview (and
 * search) reflects what will be committed, not the stale original.
 */
export function withLabels(
	nodes: SessionTreeNode[],
	pending: ReadonlyMap<string, string>,
): SessionTreeNode[] {
	// Iterative on purpose: long sessions are effectively linear trees, so a
	// recursive walk would overflow the call stack (depth = message count,
	// amplified by every branch commit copying the path).
	const clone = (node: SessionTreeNode): SessionTreeNode => ({
		entry: node.entry,
		label: node.label,
		labelTimestamp: node.labelTimestamp,
		children: [],
	});
	const result = nodes.map(clone);
	const work: Array<{ src: SessionTreeNode; dst: SessionTreeNode }> = nodes.map(
		(node, i) => ({ src: node, dst: result[i] }),
	);
	while (work.length > 0) {
		const { src, dst } = work.pop()!;
		const entry = src.entry;
		let msg =
			entry.type === "message" ? (entry as SessionMessageEntry).message : null;
		const staged = pending.get(entry.id);
		if (msg && staged !== undefined) {
			// Swap in the edited content so the row preview matches the draft.
			msg = {
				...msg,
				content: buildEditedContent(msg, staged),
			} as typeof msg;
			(dst as { entry: unknown }).entry = {
				...entry,
				message: msg,
			};
		}
		if (msg && (msg.role === "assistant" || msg.role === "user")) {
			if (staged !== undefined) dst.label = "edited";
			else if (msg.role === "assistant" && hasThinking(msg) && !hasText(msg))
				dst.label = "thinking";
		}
		dst.children = src.children.map(clone);
		for (let i = src.children.length - 1; i >= 0; i--) {
			work.push({ src: src.children[i], dst: dst.children[i] });
		}
	}
	return result;
}

/**
 * Build a TreeSelectorComponent over a labeled tree, patching pi's
 * "hide assistant rows without text" filter to count thinking as content,
 * so pre-tool reasoning rows stay visible (and show their [thinking] label).
 */
export function makeTreeSelector(
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
		extractFullContent: (c: unknown) => string;
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
	// Thinking preview: pi's extractFullContent only reads text blocks, so
	// thinking-only rows render as "(no content)" and are unidentifiable.
	// Fall back to the thinking text — this also feeds the row display and
	// the search index (thinking becomes searchable).
	const origExtractFullContent = treeList.extractFullContent.bind(treeList);
	treeList.extractFullContent = (content: unknown) => {
		const base = origExtractFullContent(content);
		if (base.trim().length > 0 || !Array.isArray(content)) return base;
		const thinking = content
			.map((part) =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: string }).type === "thinking" &&
				(part as { redacted?: boolean }).redacted !== true &&
				typeof (part as { thinking?: unknown }).thinking === "string"
					? (part as { thinking: string }).thinking
					: "",
			)
			.filter((t) => t.length > 0)
			.join("\n\n");
		if (thinking.length > 0) return thinking;
		return "";
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
