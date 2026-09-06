/**
 * Message content helpers: reading text/thinking parts, the [thinking] /
 * [reply] prefill format, and rebuilding edited content parts.
 */

import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";


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
export function textOf(message: SessionMessageEntry["message"]): string {
	const parts = partsOf(message).filter(
		(p): p is TextPart => p.type === "text" && typeof p.text === "string",
	);
	return parts.map((p) => p.text).join("\n\n");
}

export function thinkingOf(message: SessionMessageEntry["message"]): string {
	const parts = partsOf(message).filter(
		(p): p is ThinkingPart =>
			p.type === "thinking" && !p.redacted && typeof p.thinking === "string",
	);
	return parts.map((p) => p.thinking).join("\n\n");
}

export function hasText(message: SessionMessageEntry["message"]): boolean {
	return textOf(message).trim().length > 0;
}

export function hasThinking(message: SessionMessageEntry["message"]): boolean {
	return thinkingOf(message).trim().length > 0;
}

export function hasToolCalls(message: SessionMessageEntry["message"]): boolean {
	return partsOf(message).some((p) => p.type === "toolCall");
}

/**
 * Deep-clone the tree and tag messages: pending edits win (`edited`), then
 * thinking (`thinking`, so tool-call-only replies with reasoning stay
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
	// Headers are only recognized as WHOLE lines. A "[thinking]" or
	// "[reply]" appearing mid-prose is content, not a section marker — this
	// keeps prose that merely mentions the tags from silently re-splitting
	// the message into the wrong parts.
	const lines = edited.split("\n");
	const thinkIdx = lines.indexOf(THINKING_HEADER);
	const replyIdx = lines.indexOf(REPLY_HEADER);
	if (thinkIdx === -1) {
		// No thinking section. A [reply] header as the very first line means
		// the user deleted the thinking section but kept the reply one; plain
		// text (no headers at all) is the whole buffer.
		if (replyIdx === 0) {
			return {
				thinking: null,
				reply: norm(lines.slice(1).join("\n")),
			};
		}
		return { thinking: null, reply: norm(edited) };
	}
	const thinking =
		replyIdx > thinkIdx
			? lines.slice(thinkIdx + 1, replyIdx).join("\n")
			: lines.slice(thinkIdx + 1).join("\n");
	const reply = replyIdx > thinkIdx ? lines.slice(replyIdx + 1).join("\n") : null;
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
