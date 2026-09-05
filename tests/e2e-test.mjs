// E2E tests for /edittree. Run:
//   npx tsc extensions/edit-reply.ts --outDir /tmp/edittree-out --module esnext --target es2022 --moduleResolution bundler --strict --skipLibCheck --types node
//   mv /tmp/edittree-out/edit-reply.js /tmp/edittree-out/edit-reply.mjs
//   node tests/e2e-test.mjs
// Requires @earendil-works/pi-coding-agent + @earendil-works/pi-tui to be
// resolvable from the repo root (npm i, or symlink the global install).
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import * as mod from "../out/edit-reply.mjs";

let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? "ok" : "FAIL"}: ${msg}`);
  if (!cond) failures++;
};

const commands = {};
// The editor/tree components read the module-level theme via keyHint().
const { initTheme } = await import("@earendil-works/pi-coding-agent");
try { initTheme("dark"); } catch {}
mod.default({ registerCommand: (name, cmd) => { commands[name] = cmd; } });
const handler = commands["edittree"].handler;
check(commands["edittree"] !== undefined, "registers /edittree");

const DIR = "/tmp/tc/fixt";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const ts = "2026-01-01T00:00:00.000Z";
function baseSession(name) {
  const file = `${DIR}/${name}`;
  const u1 = "u1", a1 = "a1", tr1 = "tr1", a2 = "a2";
  const lines = [
    { type: "session", version: 3, id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", timestamp: ts, cwd: DIR },
    { type: "message", id: u1, parentId: null, timestamp: ts, message: { role: "user", content: "hello", usage } },
    { type: "message", id: a1, parentId: u1, timestamp: ts, message: { role: "assistant", content: [{ type: "thinking", thinking: "t1", thinkingSignature: "sig" }, { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse", usage } },
    { type: "message", id: tr1, parentId: a1, timestamp: ts, message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "out" }], isError: false, usage } },
    { type: "message", id: a2, parentId: tr1, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "answer2" }], stopReason: "stop", usage } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}
const parse = (file) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// mock ctx: steps are consumed per ctx.ui.custom call.
// step: object -> resolved as the custom result; function -> called as the
// component factory (fake tui/theme/keybindings); undefined -> resolved undefined.
function makeCtx(file, steps) {
  const it = { i: 0, switched: null };
  const next = () => steps[it.i++];
  const ctx = {
    sessionManager: {
      getTree: () => {
        // same resolution pi uses: labels resolved from the file
        const entries = parse(file);
        const byId = new Map(entries.map((e) => [e.id, e]));
        const nodes = new Map();
        const roots = [];
        for (const e of entries) {
          if (e.type === "label") continue;
          nodes.set(e.id, { entry: e, children: [] });
        }
        for (const e of entries) {
          if (e.type === "label") continue;
          const p = e.parentId && nodes.get(e.parentId);
          p ? p.children.push(nodes.get(e.id)) : roots.push(nodes.get(e.id));
        }
        return roots;
      },
      getLeafId: () => "a2",
      setLeafId: () => {},
      getSessionFile: () => file,
    },
    ui: {
      custom: async (factory) => {
        const step = next();
        if (typeof step === "function") return step(factory);
        return step;
      },
      setStatus: () => {},
      notify: () => {},
      confirm: async () => true,
      select: async () => undefined,
    },
    navigateTree: async () => {},
    switchSession: async (f) => { it.switched = f; },
    isSensitive: async () => false,
    isIdle: () => true,
  };
  ctx._it = it;
  return ctx;
}

// --- test 1: Esc in the editor discards — nothing staged, nothing written ---
console.log("test 1: editor Esc discards");
{
  const file = baseSession("t1.jsonl");
  const before = readFileSync(file, "utf8");
  const ctx = makeCtx(file, [
    { kind: "edit", entryId: "a1" },
    (factory) => new Promise((resolve) => {
      const comp = factory({ terminal: { rows: 24 } }, { fg: (_c, t) => t, bold: (t) => t }, { matches: (d, n) => n === "tui.select.cancel" && d === "\u001b" }, resolve);
      comp.handleInput("X");
      comp.handleInput("\u001b");
    }),
    undefined, // tree again; exit
  ]);
  await handler("", ctx);
  check(readFileSync(file, "utf8") === before, "nothing written after Esc discard");
}

// --- test 2: Ctrl+S stages, dialog branch-cut commits with labels ----------
console.log("test 2: stage + branch-cut commit");
{
  const file = baseSession("t2.jsonl");
  const ctx = makeCtx(file, [
    { kind: "edit", entryId: "a1" },
    (factory) => new Promise((resolve) => {
      const comp = factory({ terminal: { rows: 24 } }, { fg: (_c, t) => t, bold: (t) => t }, { matches: (d, n) => n === "tui.select.cancel" && d === "\u001b" }, resolve);
      comp.handleInput("Z");
      comp.handleInput("\u0013");
    }),
    { kind: "commit" },
    "branch-cut",
  ]);
  await handler("", ctx);
  const all = parse(file);
  const labels = all.filter((e) => e.type === "label");
  const copy = all[all.length - 1];
  check(labels.length === 1 && labels[0].label === "edited" && labels[0].targetId === copy.id, "label entry targets the edited copy");
  check(copy.message.content.some((p) => p.type === "thinking" && p.thinking === "t1Z"), "copy carries edited thinking");
  check(copy.message.content.some((p) => p.type === "toolCall" && p.id === "tc1"), "copy keeps the toolCall");
  check(copy.message.content[0].thinkingSignature === "", "edited copy clears the thinking signature");
  check(copy.parentId === "u1", "fork point is the parent of the first edit");
  const orig = all.find((e) => e.id === "a1");
  check(orig.message.content[0].thinking === "t1" && orig.message.content[0].thinkingSignature === "sig", "original untouched");
}

// --- test 3: fork-cut writes a new session file with parentSession ---------
console.log("test 3: fork-cut");
{
  const file = baseSession("t3.jsonl");
  const ctx = makeCtx(file, [
    { kind: "edit", entryId: "a1" },
    (factory) => new Promise((resolve) => {
      const comp = factory({ terminal: { rows: 24 } }, { fg: (_c, t) => t, bold: (t) => t }, { matches: (d, n) => n === "tui.select.cancel" && d === "\u001b" }, resolve);
      comp.handleInput("F");
      comp.handleInput("\u0013");
    }),
    { kind: "commit" },
    "fork-cut",
  ]);
  await handler("", ctx);
  const forkFile = ctx._it.switched;
  check(forkFile && forkFile !== file, "switched to a new session file");
  const lines = parse(forkFile);
  check(lines[0].type === "session" && lines[0].parentSession === file, "fork header links parentSession");
  check(lines.some((e) => e.type === "message" && e.message.content?.[0]?.thinking === "t1F"), "fork carries the edited copy");
  check(!lines.some((e) => e.type === "label"), "fork writes no labels");
}

// --- test 4: Discard returns to the tree and clears pending ----------------
console.log("test 4: discard");
{
  const file = baseSession("t4.jsonl");
  const before = readFileSync(file, "utf8");
  const ctx = makeCtx(file, [
    { kind: "edit", entryId: "a1" },
    (factory) => new Promise((resolve) => {
      const comp = factory({ terminal: { rows: 24 } }, { fg: (_c, t) => t, bold: (t) => t }, { matches: (d, n) => n === "tui.select.cancel" && d === "\u001b" }, resolve);
      comp.handleInput("D");
      comp.handleInput("\u0013");
    }),
    { kind: "commit" },
    "discard",           // back to the tree
    undefined,           // exit the tree
  ]);
  await handler("", ctx);
  check(readFileSync(file, "utf8") === before, "discard writes nothing");
}

// --- test 5: Ctrl+C on the dialog aborts to the main conversation ----------
console.log("test 5: dialog ctrl+c aborts");
{
  const file = baseSession("t5.jsonl");
  const before = readFileSync(file, "utf8");
  const ctx = makeCtx(file, [
    { kind: "edit", entryId: "a1" },
    (factory) => new Promise((resolve) => {
      const comp = factory({ terminal: { rows: 24 } }, { fg: (_c, t) => t, bold: (t) => t }, { matches: (d, n) => n === "tui.select.cancel" && d === "\u001b" }, resolve);
      comp.handleInput("A");
      comp.handleInput("\u0013");
    }),
    { kind: "commit" },
    (factory) => new Promise((resolve) => {
      // CommitDialog factory; ctrl+c must resolve "abort"
      const comp = factory({ terminal: { rows: 24 } }, { fg: (_c, t) => t, bold: (t) => t }, { matches: (d, n) => n === "tui.select.cancel" && d === "\u001b" }, resolve);
      comp.handleInput("\u0003");
    }),
  ]);
  await handler("", ctx);
  check(readFileSync(file, "utf8") === before, "abort writes nothing");
}

// --- test 6: parseEdited header safety -------------------------------------
console.log("test 6: parseEdited section headers");
{
  const r1 = mod.parseEdited("[thinking]\nt1\n\n[reply]\nr1");
  check(r1.thinking === "t1" && r1.reply === "r1", "canonical two-section parse");
  const r2 = mod.parseEdited("the tag [thinking] appears in prose");
  check(r2.thinking === null && r2.reply.includes("[thinking]"), "mid-prose header is content");
  const r3 = mod.parseEdited("[thinkingx]\ntext");
  check(r3.thinking === null && r3.reply.includes("[thinkingx]"), "mangled header stays in reply text");
  const r4 = mod.parseEdited("[reply]\nonly reply");
  check(r4.thinking === null && r4.reply === "only reply", "[reply] at start drops thinking");
}

// --- test 7: buildPrefill / buildPath / buildForkSession sanity ------------
console.log("test 7: helpers");
{
  const file = baseSession("t7.jsonl");
  const { entries } = mod.readSessionFile(file);
  const path = mod.buildPath(entries, "a2");
  check(path.map((e) => e.id).join(",") === "u1,a1,tr1,a2", "buildPath walks leaf to root");
  const prefill = mod.buildPrefill(entries.find((e) => e.id === "a1").message);
  check(prefill.startsWith("[thinking]"), "prefill opens with the thinking section");
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
