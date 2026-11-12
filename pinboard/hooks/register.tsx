// pinboard: open questions Claude asked stay above the prompt as a checklist;
// a pane keeps the session's branch, PRs, links, pinned docs and a memo.
// Pins (question/doc/note) live in one atom, saved per session for --resume.
import { atom, read, update } from "claude-code";
import type {
  Color,
  Register,
  EngineInterface,
  ResolveInput,
  SessionMessage,
} from "claude-code";
import type {
  Pin,
  PinInput,
  DocInput,
  IntentInput,
  IntentRecord,
  IntentCurrent,
  IntentHistory,
  Snap,
  Pr,
  Doc,
  Node,
  Bg,
} from "../types";

const PANE = "pinboard";
// Left out, the surface paints a fixed light gray that stays in dark mode.
// userMessageBackground is the theme's tint under your prompts in the
// transcript (dark rgb(55,55,55), light rgb(240,240,240)): it follows the theme.
const PANE_OPEN = {
  id: PANE,
  title: "pinboard",
  backgroundColor: "userMessageBackground",
} as const;
// section titles: the card's hover border color, since Hangul bold barely shows
const TITLE: Color = "suggestion";
// Our own tools as RegExp matchers: the generated types list a plugin's MCP tools
// only as connected at the load that wrote them, before session.start registers ours
const Q_TOOL = /^mcp__pinboard__pin_questions$/;
const DOC_TOOL = /^mcp__pinboard__pin_doc$/;
const NEXT_TOOL = /^mcp__pinboard__pin_next_steps$/;
const INTENT_TOOL = /^mcp__pinboard__record_intent$/;
// a comma-list option as its entries, a leading / dropped
const list = (v: unknown) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^\//, ""))
    .filter(Boolean);
// the jiraProjects option as one matcher, the listed projects only: any other
// KEY-123 is a model, a CVE, a spec (GPT-4, CVE-2024, ECMA-262). None = null.
export const jiraMatcher = (projects: string) => {
  const keys = list(projects)
    .map((k) => k.toUpperCase())
    .filter((k) => /^[A-Z][A-Z0-9_]+$/.test(k));
  return keys.length
    ? new RegExp(`\\b(?:${keys.join("|")})-\\d{1,6}\\b`, "g")
    : null;
};

// Nerd Font glyphs (FontAwesome/Octicons/Devicons ranges, stable in NF v3)
const I = {
  branch: "",
  pr: "",
  jira: "",
  doc: "",
  newDoc: "",
  link: "",
  memo: "",
  folder: "",
  comment: "",
  approved: "",
  changes: "",
  eye: "",
  pin: "",
  // CI, same FontAwesome family so every status cell is one glyph wide
  ciRun: "",
  ciOk: "",
  ciFail: "",
};

// plugin/key must be string literals: the validator's scan reads them
const pinsA = atom({ plugin: "pinboard", key: "pins" } as const, [] as Pin[], {
  shape: "pins-1",
});
const snapA = atom(
  { plugin: "pinboard", key: "snap" } as const,
  null as Snap | null,
  { shape: "snap-3" },
);
const historyA = atom({ plugin: "pinboard", key: "history" } as const, false);
const foldedA = atom({ plugin: "pinboard", key: "folded" } as const, false);
const memoA = atom({ plugin: "pinboard", key: "memo" } as const, false);
// the field draws it back, so a memo folded or a pane reopened keeps unsaved text
const draftA = atom(
  { plugin: "pinboard", key: "draft" } as const,
  null as string | null,
);
// Enter empties the field and the saved text is the one it last drew, so only
// a new field (a new key) shows the memo again
const memoSavesA = atom({ plugin: "pinboard", key: "memoSaves" } as const, 0);
const memoFocusA = atom(
  { plugin: "pinboard", key: "memoFocus" } as const,
  false,
);
const paneFoldedA = atom(
  { plugin: "pinboard", key: "paneFolded" } as const,
  false,
);

// Pure: whether a close folds the pane instead. The person's close mark (or
// ctrl+x x) on an inline pane, which sits over the transcript, folds it to one
// row first and closes it once folded; docked, or a plugin's own close, closes.
export const markFolds = (
  origin: string,
  isInline: boolean,
  isFolded: boolean,
) => origin === "person" && isInline && !isFolded;

// ---------- tools ----------

const Q_DESCRIPTION = `Pin the open questions/decisions you asked the user, as a checklist shown above their prompt box.

Rules:
- When one reply asks the user 2+ separate questions or decisions, call this with action "set" BEFORE ending the turn: one short line per item, in the user's language, same order and numbering as in the reply.
- When a later user message answers some of them, call action "check" with those 1-based indexes (action "uncheck" reverts).
- Use action "clear" ONLY when the user asks to cancel/remove the list. Do NOT clear just because every item is answered; the user closes it.
- Do not use this for a single question, or when you use the AskUserQuestion dialog.`;

const Q_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["set", "check", "uncheck", "clear"] },
    items: {
      type: "array",
      items: { type: "string" },
      description: 'for "set": the questions, one per entry',
    },
    indexes: {
      type: "array",
      items: { type: "integer", minimum: 1 },
      description: 'for "check"/"uncheck": 1-based positions',
    },
  },
  required: ["action"],
};

const DOC_DESCRIPTION = `Pin a document that has become a shared reference for this session (a spec, plan or design doc: a file path or a URL) to the user's pinboard pane.

Rules:
- Pin it when the user points you at a doc to work from, or when you write a plan/spec the user will keep coming back to. Not every file you read.
- Pinning the same ref again updates its title. "remove": true unpins it.`;

const DOC_SCHEMA = {
  type: "object",
  properties: {
    ref: { type: "string", description: "absolute file path or URL" },
    title: {
      type: "string",
      description: "short label, in the user's language",
    },
    remove: { type: "boolean" },
  },
  required: ["ref"],
};

const NEXT_DESCRIPTION = `Pin the next steps you suggest to the user, as a checklist in the "다음 할 일" card of their pinboard pane.

Rules:
- When you finish a unit of work (a fix, a feature, a decision) and your reply suggests what comes next, call action "set" BEFORE ending the turn: 2-5 short items in the user's language, each one concrete action.
- When a step is done (by you or the user), call "check" with its 1-based index ("uncheck" reverts). "set" replaces the list.
- Use "clear" only when the user asks. Questions waiting for the user's answer go to pin_questions, not here.`;

const INTENT_DESCRIPTION = `Record how you understand what the user wants in this session. It is saved to ~/.claude/intent/<session id>.json and drawn as the topic tree in their pinboard pane.

Rules:
- On the first real work request of a session (not a greeting or a simple question), call it once BEFORE answering.
- After that, call it only when a user message changes or sharpens the what/scope/constraints; not for "go ahead" or confirmations.
- On an update give relation ("sub" = a sub-task of the current intent, "sibling" = the next task at the same level, "new" = a new topic) and reason (one line: what changed and why).
- Write label (one line, 60 chars or fewer), what, why and the lists in the user's language.`;

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", description: "one line, 60 chars or fewer" },
    what: { type: "string" },
    why: { type: "string" },
    scope_in: { type: "array", items: { type: "string" } },
    scope_out: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    reason: { type: "string", description: "update: what changed and why" },
    relation: { type: "string", enum: ["sub", "sibling", "new"] },
  },
  required: ["label"],
};

// The two checklists: open questions (the band) and next steps (a pane card)
type ListKind = "question" | "next";
const TOOL_NAME: Record<ListKind, string> = {
  question: "pin_questions",
  next: "pin_next_steps",
};
const ofKind = (pins: Pin[], kind: ListKind) =>
  pins.filter((p) => p.kind === kind);
const questions = (pins: Pin[]) => ofKind(pins, "question");

export const summary = (pins: Pin[], kind: ListKind = "question") => {
  const q = ofKind(pins, kind);
  return `pinned ${q.length} item(s), ${q.filter((i) => i.isDone).length} checked`;
};

// Pure: the next pins, or why the call is refused. Indexes count that kind only.
export function applyList(
  pins: Pin[],
  kind: ListKind,
  input: PinInput,
): Pin[] | { deny: string } {
  const rest = pins.filter((p) => p.kind !== kind);
  switch (input.action) {
    case "set":
      return [
        ...(input.items ?? [])
          .map((t) => t.trim())
          .filter(Boolean)
          .map((text): Pin => ({ kind, text, isDone: false })),
        ...rest,
      ];
    case "check":
    case "uncheck": {
      const on = new Set(input.indexes ?? []);
      return [
        ...ofKind(pins, kind).map((p, i) =>
          on.has(i + 1) ? { ...p, isDone: input.action === "check" } : p,
        ),
        ...rest,
      ];
    }
    case "clear":
      return rest;
    default:
      return {
        deny: `${TOOL_NAME[kind]}: unknown action "${String(input.action)}" (set|check|uncheck|clear)`,
      };
  }
}
export const applyQuestions = (pins: Pin[], input: PinInput) =>
  applyList(pins, "question", input);

export function applyDoc(
  pins: Pin[],
  input: DocInput,
): Pin[] | { deny: string } {
  const ref = String(input.ref ?? "").trim();
  if (!ref) return { deny: "pin_doc: ref (a file path or URL) is required" };
  // a press opens it: nothing relative, no option (-a App), no app scheme (vscode://)
  if (!/^(https?:\/\/|\/)/.test(ref))
    return {
      deny: "pin_doc: ref must be an absolute file path or an http(s) URL",
    };
  const rest = pins.filter((p) => !(p.kind === "doc" && p.ref === ref));
  if (input.remove) return rest;
  return [...rest, { kind: "doc", text: input.title?.trim() || ref, ref }];
}

// ponytail: one memo; a list of notes when one isn't enough
export const setNote = (pins: Pin[], text: string): Pin[] => {
  const rest = pins.filter((p) => p.kind !== "note");
  return text.trim() ? [...rest, { kind: "note", text: text.trim() }] : rest;
};

const toggleItem = (pins: Pin[], kind: ListKind, i: number): Pin[] => {
  const out = applyList(pins, kind, {
    action: ofKind(pins, kind)[i]?.isDone ? "uncheck" : "check",
    indexes: [i + 1],
  });
  return Array.isArray(out) ? out : pins;
};

// fn runs on the latest pins (update retries it when another write lands first),
// then the store mirrors them for --resume. One key per session; prune drops old ones.
// Two racing edits may land their store writes out of order (the atom stays right):
// chain the writes if a resumed session ever shows a stale list.
async function editPins($: EngineInterface, fn: (cur: Pin[]) => Pin[]) {
  const next = await update($, pinsA, fn);
  const key = `pins:${await $.session.id()}`;
  await (next.length ? $.store.set(key, next) : $.store.delete(key));
  return next;
}

// The memo as typed outlives a restart: written on each change, chained so the
// last keystroke lands last; null (Enter) deletes it.
let draftWrites: Promise<unknown> = Promise.resolve();
async function storeDraft($: EngineInterface, text: string | null) {
  const key = `draft:${await $.session.id()}`;
  draftWrites = draftWrites
    .then(() => (text === null ? $.store.delete(key) : $.store.set(key, text)))
    .catch(() => undefined);
  return draftWrites;
}

// Each session's keys go once it has gone unstarted for KEEP_DAYS.
// ponytail: aged from the session's last start; a key never seen starts its clock now
const KEEP_DAYS = 30;
async function prune($: EngineInterface, now: number) {
  const sid = await $.session.id();
  const old = ((await $.store.get("seen")) ?? {}) as Record<string, number>;
  const seen: Record<string, number> = {};
  for (const k of await $.store.keys()) {
    const s = /^(?:pins|draft):(.+)$/.exec(k)?.[1];
    if (!s) continue;
    const at = s === sid ? now : (old[s] ?? now);
    if (now - at > KEEP_DAYS * 86_400_000) await $.store.delete(k);
    else seen[s] = at;
  }
  seen[sid] = now;
  await $.store.set("seen", seen);
}

// A tool's edit: its refusal depends on the input alone, so it is judged on no
// pins first, and the edit itself runs on the latest ones.
async function applyPins(
  $: EngineInterface,
  apply: (cur: Pin[]) => Pin[] | { deny: string },
): Promise<Pin[] | { deny: string }> {
  const judged = apply([]);
  if (!Array.isArray(judged)) return judged;
  return editPins($, (cur) => apply(cur) as Pin[]);
}

const clearQuestions = ($: EngineInterface) =>
  editPins($, (cur) => cur.filter((p) => p.kind !== "question"));

// a hot reload keeps the atoms; a new process (--resume) reads the store
async function restore($: EngineInterface) {
  const sid = await $.session.id();
  if ((await read($, draftA)) === null) {
    const d = await $.store.get(`draft:${sid}`);
    if (typeof d === "string") await update($, draftA, () => d);
  }
  if ((await read($, pinsA)).length) return;
  const saved = await $.store.get(`pins:${sid}`);
  if (Array.isArray(saved)) await update($, pinsA, () => saved as Pin[]);
}

// Terminal cells a text takes: Hangul, CJK, fullwidth forms and emoji are two.
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u;
const cells = (s: string) =>
  [...s].reduce((n, c) => n + (WIDE.test(c) ? 2 : 1), 0);
// Rows a text wraps to at width, word by word as the field wraps it; a word
// wider than a row breaks across rows.
export const wrapRows = (text: string, width: number) => {
  const w = Math.max(1, width);
  let n = 0; // not `rows`: the loader reads that name as the drawing helper
  for (const line of text.split("\n")) {
    n++;
    let col = 0;
    for (const word of line.split(" ")) {
      const c = cells(word);
      if ((col ? col + 1 : 0) + c <= w) {
        col += (col ? 1 : 0) + c;
        continue;
      }
      if (col) n++;
      n += Math.max(0, Math.ceil(c / w) - 1);
      col = c % w || (c ? w : 0);
    }
  }
  return n;
};

// ---------- data ----------

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
// the last n distinct, ranked by their latest mention, oldest first
const recent = <T,>(xs: T[], n: number) =>
  uniq([...xs].reverse())
    .slice(0, n)
    .reverse();

export const rollup = (checks: unknown): string => {
  if (!Array.isArray(checks) || checks.length === 0) return " ";
  const st = checks.map((c: any) => c.conclusion ?? c.state ?? "");
  // GitHub's conclusions that are not a pass: FAILURE, STARTUP_FAILURE, ERROR, TIMED_OUT,
  // CANCELLED, ACTION_REQUIRED (SKIPPED and NEUTRAL pass)
  if (st.some((s) => /FAIL|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED/i.test(s)))
    return I.ciFail;
  if (st.some((s) => /PENDING|IN_PROGRESS|QUEUED|^$/i.test(s))) return I.ciRun;
  return I.ciOk;
};

// Pure: what the transcript mentions — PRs, Jira keys, links, .md files, prompts.
export function scan(
  msgs: readonly SessionMessage[],
  root: string,
  branch: string,
  jiraKey: RegExp | null = null,
) {
  // prompts and replies: what the session talked about. Tool output (a grep over
  // fixtures, a branch list) is text that flowed past and would crowd it out.
  const said = msgs.map((m) => m.text).join("\n");
  const corpus = msgs
    .flatMap((m) => [
      m.text,
      ...m.toolUses.map((t) => t.text ?? ""),
      ...(m.toolResults ?? []).map((r) => r.text ?? ""),
    ])
    .join("\n");

  // every PR this session mentioned: URLs in prompts and replies
  const prRefs = recent(
    [...said.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)].map(
      (m) => `${m[1]}#${m[2]}`,
    ),
    5,
  );
  // the branch last: the latest mention, so its key always stays
  const jira = jiraKey
    ? recent(`${said} ${branch}`.match(jiraKey) ?? [], 3)
    : [];
  const links = recent(
    [...said.matchAll(/https?:\/\/[^\s)>\]"'`]+/g)]
      .map((m) => m[0])
      .filter(
        (u) =>
          /claude\.ai\/(code\/)?artifact|atlassian\.net|figma\.com|notion\.so/.test(
            u,
          ) &&
          /^https?:\/\/[^/]+\/[^/]/.test(u) && // a bare domain is not a link worth pinning
          !/[<>{}]/.test(u),
      ),
    5,
  );

  const prompts = msgs
    .filter(
      (m) =>
        m.role === "user" &&
        !m.toolResults?.length &&
        m.text &&
        !/^(<|\[Request interrupted)/.test(m.text), // engine-written, not typed
    )
    .map((m) => m.text.split("\n")[0] ?? "") // the row truncates to its width
    .slice(-20);

  const tag = (p: string): Doc["tag"] =>
    /scratchpad|^\/(private\/)?tmp\//.test(p)
      ? "tmp"
      : p.startsWith(root)
        ? "repo"
        : "out";
  const docMap = new Map<string, Doc>();
  for (const m of msgs)
    for (const t of m.toolUses) {
      const p = String(t.input.file_path ?? "");
      if (!p.endsWith(".md")) continue;
      if (t.tool === "Write")
        docMap.set(p, { path: p, kind: "new", tag: tag(p) });
      else if (t.tool === "Read" && !docMap.has(p))
        docMap.set(p, { path: p, kind: "ref", tag: tag(p) });
    }
  const docs = [...docMap.values()].slice(-6);

  // background Bash: its result names the task and output file; a later
  // <task-notification> carrying its tool-use-id says how it ended
  const ended = new Map<string, string>(
    [
      ...corpus.matchAll(
        /<tool-use-id>(\S+?)<\/tool-use-id>[\s\S]{0,600}?<status>(\w+)<\/status>/g,
      ),
    ].map((n) => [n[1]!, n[2]!]),
  );
  const bg = msgs
    .flatMap((m) => m.toolUses)
    .flatMap((t): Bg[] => {
      const r =
        /background with ID: (\S+?)\. Output is being written to: (\S+?)\.(?:\s|$)/.exec(
          t.text ?? "",
        );
      if (t.tool !== "Bash" || t.input.run_in_background !== true || !r)
        return [];
      const command = String(t.input.command ?? "");
      return [
        {
          id: r[1]!,
          out: r[2]!,
          command,
          label: String(t.input.description || command.split("\n")[0]),
          status: ended.get(t.tool_use_id) ?? "running",
        },
      ];
    })
    .slice(-6);

  return { prRefs, jira, links, prompts, docs, bg };
}

type IntentEntry = { ts: string; label: string; parent?: string | null };

// Pure: the intent record as tree rows, depth-first, siblings in time order.
// `parent` (written by intent-recorder) is the ts of the entry this one refines,
// null for a new topic; absent, as in records written before it, = under the first topic.
export function layoutTree(
  intent: { initial?: IntentEntry; history?: IntentEntry[] } | null,
): Node[] {
  if (!intent?.initial) return [];
  const all = [intent.initial, ...(intent.history ?? [])];
  // parent by index, always an earlier entry: no cycle even if two ts collide
  const parentIdx = all.map((n, i) => {
    if (i === 0 || n.parent === null) return -1;
    const j = all
      .slice(0, i)
      .map((m) => m.ts)
      .lastIndexOf(n.parent ?? "");
    return j >= 0 ? j : 0;
  });
  const kids = (p: number) =>
    all.map((_, i) => i).filter((i) => parentIdx[i] === p);
  const rows: Node[] = [];
  const walk = (i: number, rails: string, isLast: boolean, depth: number) => {
    const n = all[i]!;
    rows.push({
      pre: depth === 0 ? "● " : `  ${rails}${isLast ? "└ " : "├ "}`,
      label: n.label,
      ts: n.ts,
      isCurrent: i === all.length - 1,
    });
    const cs = kids(i);
    const below = depth === 0 ? "" : rails + (isLast ? "  " : "│ ");
    cs.forEach((c, k) => walk(c, below, k === cs.length - 1, depth + 1));
  };
  kids(-1).forEach((r) => walk(r, "", true, 0));
  return rows;
}

const RELATIONS = ["sub", "sibling", "new"];

// Pure: the intent record after one record_intent call, or why it is refused.
// No record yet = init; after that `initial` is never overwritten. `parent` comes
// from `relation` against the current node (the last history entry, else initial).
export function applyIntent(
  prev: IntentRecord | null,
  input: IntentInput,
  sid: string,
  ts: string,
): IntentRecord | { deny: string } {
  const line =
    String(input.label ?? "")
      .split("\n")[0]
      ?.trim() ?? "";
  if (!line) return { deny: "record_intent: label is required" };
  if (input.relation !== undefined && !RELATIONS.includes(input.relation))
    return {
      deny: `record_intent: unknown relation "${String(input.relation)}" (sub|sibling|new)`,
    };
  const entry: IntentCurrent = {
    ts,
    label: line.length > 60 ? line.slice(0, 59) + "…" : line,
    what: input.what ?? "",
    why: input.why ?? "",
    scope_in: input.scope_in ?? [],
    scope_out: input.scope_out ?? [],
    constraints: input.constraints ?? [],
  };
  if (!prev?.initial)
    return { session_id: sid, initial: entry, current: entry, history: [] };

  const history = prev.history ?? [];
  const cur = history[history.length - 1];
  const item: IntentHistory = {
    ts,
    label: entry.label,
    reason: input.reason ?? "",
  };
  if (input.relation === "sub") item.parent = (cur ?? prev.initial).ts;
  else if (input.relation === "new") item.parent = null;
  else if (input.relation === "sibling")
    // a sibling of the first topic is a new topic; an old entry without parent sits under it
    item.parent = !cur
      ? null
      : cur.parent === undefined
        ? prev.initial.ts
        : cur.parent;
  return { ...prev, current: entry, history: [...history, item] };
}

async function collect(
  $: EngineInterface,
  jiraKey: RegExp | null,
): Promise<Snap> {
  const [cwd, root, sid, repo, msgs, home, at] = await Promise.all([
    $.session.cwd(),
    $.session.root(),
    $.session.id(),
    $.session.repo(),
    $.session.messages(),
    $.env.get("HOME"),
    $.clock.now(),
  ]);
  const git = async (...a: string[]) => {
    try {
      const r = await $.process.run(["git", ...a], { cwd });
      return r.exitCode === 0 ? r.stdout.trim() : "";
    } catch {
      return "";
    }
  };
  const branch = repo ? await git("rev-parse", "--abbrev-ref", "HEAD") : "";
  const top = repo ? await git("rev-parse", "--show-toplevel") : "";
  const worktree =
    repo && top && top !== repo.root ? (top.split("/").pop() ?? "") : "";

  const {
    prRefs,
    jira,
    links,
    prompts,
    docs,
    bg: found,
  } = scan(msgs, root, branch, jiraKey);
  // a running one: an exit its notification has not told yet, else its port.
  // ponytail: no notification and no exit line = running, so a shell lost with
  // its process (a restart) still reads running; a log over 4 MiB yields no port
  const bg = await Promise.all(
    found.map(async (b): Promise<Bg> => {
      if (b.status !== "running") return b;
      const log = await $.fs.read(b.out).catch(() => "");
      const exit = /\[exited with code (\d+)\]\s*$/.exec(log);
      if (exit)
        return { ...b, status: exit[1] === "0" ? "completed" : "failed" };
      const p =
        /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})|--port[= ](\d{2,5})|\bPORT=(\d{2,5})/.exec(
          `${log}\n${b.command}`,
        );
      return p ? { ...b, port: Number(p[1] ?? p[2] ?? p[3]) } : b;
    }),
  );
  // a merged or closed PR stays so: its last answer stands and gh is not asked
  // again; a failed ask (offline, signed out, a timeout) keeps the last answer too
  const prev = (await read($, snapA))?.prs ?? [];
  const prs = (
    await Promise.all(
      prRefs.map(async (ref): Promise<Pr | null> => {
        const [r = "", n = ""] = ref.split("#");
        const url = `https://github.com/${r}/pull/${n}`.toLowerCase();
        const last = prev.find((p) => p.url.toLowerCase() === url) ?? null;
        if (last?.state === "MERGED" || last?.state === "CLOSED") return last;
        try {
          const out = await $.process.run(
            [
              "gh",
              "pr",
              "view",
              n,
              "--repo",
              r,
              "--json",
              "number,title,state,isDraft,reviewDecision,statusCheckRollup,url,comments",
            ],
            { cwd, timeoutMs: 15_000 },
          );
          if (out.exitCode !== 0) return last;
          const j = JSON.parse(out.stdout);
          return {
            number: j.number,
            title: j.title,
            state: j.isDraft ? "DRAFT" : j.state,
            review: j.reviewDecision ?? "",
            checks: rollup(j.statusCheckRollup),
            comments: j.comments?.length ?? 0,
            url: j.url,
          };
        } catch {
          return last;
        }
      }),
    )
  ).filter((p): p is Pr => p !== null);

  const intentRaw = home
    ? await $.fs.read(`${home}/.claude/intent/${sid}.json`).catch(() => "")
    : "";
  // none, broken or odd: the work card reads 없음, the rest of the pane goes on
  let tree: Node[] = [];
  try {
    tree = layoutTree(JSON.parse(intentRaw));
  } catch {}

  return {
    cwd,
    sid,
    branch,
    worktree,
    prs,
    jira,
    links,
    tree,
    prompts,
    docs,
    bg,
    at,
  };
}

// a failed refresh keeps the last snapshot; the next turn or tick retries
async function refresh($: EngineInterface, jiraKey: RegExp | null) {
  const s = await collect($, jiraKey).catch(() => null);
  // refreshes may overlap: an older one finishing late does not undo a newer
  if (s) await update($, snapA, (cur) => (cur && cur.at > s.at ? cur : s));
}

// The pane's data is gathered only while a surface draws the pane: no gh or
// git runs with the pane closed or unplaced, nor in a headless run.
async function sync($: EngineInterface, jiraKey: RegExp | null) {
  const panes = await $.ui.panes().catch(() => []);
  if (panes.some((p) => p.id === PANE && p.isPlaced)) await refresh($, jiraKey);
}

// ---------- glyphs ----------

const STATE: Record<Pr["state"], string> = {
  OPEN: "[open]",
  DRAFT: "[draft]",
  MERGED: "[merged]",
  CLOSED: "[closed]",
};
const REVIEW: Record<string, string> = {
  APPROVED: I.approved,
  CHANGES_REQUESTED: I.changes,
  REVIEW_REQUIRED: I.eye,
};
// GitHub's own state colors; absent = dim
const STATE_COLOR: Partial<Record<Pr["state"], Color>> = {
  OPEN: "success",
  MERGED: "merged",
  CLOSED: "error",
};
const REVIEW_COLOR: Record<string, Color> = {
  APPROVED: "success",
  CHANGES_REQUESTED: "error",
};
const CI_COLOR: Record<string, Color> = {
  [I.ciOk]: "success",
  [I.ciRun]: "warning",
  [I.ciFail]: "error",
};
// a background task's mark by status, the CI family; no color = dim
const BG_MARK: Record<string, [string, Color?]> = {
  running: [I.ciRun, "warning"],
  completed: [I.ciOk],
  failed: [I.ciFail, "error"],
};
// home as ~, only where the path starts with it (/Users/meow is not under /Users/me)
const tilde = (p: string, home: string) =>
  home && (p === home || p.startsWith(home + "/"))
    ? "~" + p.slice(home.length)
    : p;
const short = (p: string, home: string) =>
  tilde(p, home).replace(/^.*\/(.+\/.+)$/, "$1");
// a URL pin shows its host beside the title the model gave it
const urlLabel = (p: Pin) =>
  p.text === p.ref
    ? p.text
    : `${p.text} (${(p.ref ?? "").replace(/^https?:\/\/([^/]+).*$/, "$1")})`;
// what a press may open in its app; anything else is only shown in Finder
const DOC_EXT =
  /\.(md|markdown|txt|pdf|html?|png|jpe?g|gif|svg|webp|json|csv|ya?ml|log)$/i;
// a POSIX shell word: bare when plain, else single-quoted (' as '\'')
const shq = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
const cut = (s: string, n: number) =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

// ---------- band: open questions ----------

// One Button per item (question or next step): pressing it toggles done.
function rows(
  $: EngineInterface,
  e: ResolveInput,
  list: Pin[],
  kind: ListKind,
) {
  const { Button, Text } = $.ui.resolve(e);
  return list.map((it, i) => (
    <Button
      key={`${kind === "question" ? "q" : "n"}:${i}`}
      plain
      dimColor={it.isDone}
      onPress={() => void editPins($, (cur) => toggleItem(cur, kind, i))}
    >
      {it.isDone ? (
        <Text color="success" dimColor strikethrough>
          [x] {i + 1}. {it.text}
        </Text>
      ) : (
        <Text>
          [ ] {i + 1}. {it.text}
        </Text>
      )}
    </Button>
  ));
}

// warning-colored frame, header with the count and a fold button
// (hotkey 0 works from an empty prompt), then the questions unless folded.
// Folding keeps them; /pin-clear empties the list.
function board(
  $: EngineInterface,
  e: ResolveInput,
  list: Pin[],
  folded: boolean,
) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const done = list.filter((i) => i.isDone).length;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="warning"
      paddingX={1}
    >
      <Box gap={1} marginBottom={folded ? 0 : 1}>
        <Text>
          {I.pin} 답변 대기 질문 {done}/{list.length}
        </Text>
        <Button
          key="fold"
          hotkey="0"
          plain
          onPress={() => void update($, foldedA, (f) => !f)}
        >
          {folded ? "펼치기" : "접기"}
        </Button>
        <Text dimColor>(빈 프롬프트에서 0 · 지우기 /pin-clear)</Text>
      </Box>
      {folded ? null : rows($, e, list, "question")}
    </Box>
  );
}

// ---------- register ----------

export const register: Register = (on, options) => {
  // userConfig: Jira links need the site; the toolbar fills these commands
  const jiraBase = String(options.jiraBase ?? "")
    .trim()
    .replace(/\/+$/, "");
  const jiraKey = jiraBase
    ? jiraMatcher(String(options.jiraProjects ?? ""))
    : null;
  const commands = uniq(list(options.commands));

  // the pin tools serve the main conversation: a subagent's list would replace
  // the person's, and a subagent cannot hear the answers to its questions
  const SUBAGENT = {
    deny: "pinboard tools are for the main conversation, not a subagent",
  };
  // ponytail: one open a load; a reload (an option change) may open it again
  let autoOpened = false;
  // where the pane was last drawn; ponytail: one value for every surface
  let isInlineNow = false;

  on("session.start", async ($, e, next) => {
    // headless (claude -p, the SDK): no one sees a pane, so no tools, no polling
    if (!e.isInteractive) return next(e);
    await $.tool.register({
      name: "pin_questions",
      description: Q_DESCRIPTION,
      inputSchema: Q_SCHEMA,
      isDeferred: false,
    });
    await $.tool.register({
      name: "pin_doc",
      description: DOC_DESCRIPTION,
      inputSchema: DOC_SCHEMA,
      isDeferred: false,
    });
    await $.tool.register({
      name: "pin_next_steps",
      description: NEXT_DESCRIPTION,
      inputSchema: Q_SCHEMA,
      isDeferred: false,
    });
    await $.tool.register({
      name: "record_intent",
      description: INTENT_DESCRIPTION,
      inputSchema: INTENT_SCHEMA,
      isDeferred: false,
    });
    await $.command.register({
      name: "pinboard",
      description: "Open the pinboard pane",
    });
    await $.command.register({
      name: "pin-clear",
      description: "Delete the pinned questions list",
    });
    await restore($);
    await prune($, await $.clock.now());
    void sync($, jiraKey);
    $.clock.every(60_000, () => void sync($, jiraKey));
    return next(e);
  });

  on("tool.call", { tool: Q_TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return SUBAGENT;
    const input = e as unknown as PinInput;
    const out = await applyPins($, (cur) => applyQuestions(cur, input));
    if (!Array.isArray(out)) return { deny: out.deny };
    if (input.action === "set") await update($, foldedA, () => false); // new questions show
    const text = summary(out);
    // result must be a string or content blocks, not an MCP envelope
    return { result: text, text };
  });

  on("tool.call", { tool: NEXT_TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return SUBAGENT;
    const input = e as unknown as PinInput;
    const out = await applyPins($, (cur) => applyList(cur, "next", input));
    if (!Array.isArray(out)) return { deny: out.deny };
    const text = summary(out, "next");
    return { result: text, text };
  });

  // record_intent: replaces the intent-recorder subagent (about 21k tokens a call)
  on("tool.call", { tool: INTENT_TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return SUBAGENT;
    const [sid, home, now] = await Promise.all([
      $.session.id(),
      $.env.get("HOME"),
      $.clock.now(),
    ]);
    // unset, the path would be relative: a stray undefined/ in the project
    if (!home) return { deny: "record_intent: HOME is not set" };
    const file = `${home}/.claude/intent/${sid}.json`;
    const raw = await $.fs.read(file).catch(() => null);
    let prev: IntentRecord | null = null;
    if (typeof raw === "string") {
      try {
        prev = JSON.parse(raw) as IntentRecord;
      } catch {
        // never overwrite a record we cannot read: that would drop its history
        return {
          deny: `record_intent: ${file} is not valid JSON; fix or move it first`,
        };
      }
    }
    const ts = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
    const out = applyIntent(prev, e as unknown as IntentInput, sid, ts);
    if ("deny" in out) return { deny: out.deny };
    await $.fs.write(file, JSON.stringify(out, null, 2) + "\n");
    void sync($, jiraKey);
    const text = `intent ${prev ? "update" : "init"} 기록: ${out.current.label}`;
    return { result: text, text };
  });

  on("tool.call", { tool: DOC_TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return SUBAGENT;
    const input = e as unknown as DocInput;
    const out = await applyPins($, (cur) => applyDoc(cur, input));
    if (!Array.isArray(out)) return { deny: out.deny };
    const n = out.filter((p) => p.kind === "doc").length;
    const text = `${input.remove ? "unpinned" : "pinned"} ${input.ref}; ${n} doc(s) pinned`;
    return { result: text, text };
  });

  // answered without next, the pane stays open, folded instead
  on("ui.close", { id: PANE }, async ($, e, next) => {
    const isFolded = await read($, paneFoldedA);
    if (!markFolds(e.origin.kind, isInlineNow, isFolded)) return next(e);
    await update($, paneFoldedA, () => true);
    return { value: undefined };
  });

  // where the pane's ring goes: the memo draws as an editor while it holds it
  on("ui.focus", { requestId: PANE }, async ($, e, next) => {
    const r = await next(e);
    if (!r.deny)
      await update($, memoFocusA, () => !!e.element?.startsWith("memo:"));
    return r;
  });

  on("command.run", { command: "pinboard" }, async ($) => {
    await update($, paneFoldedA, () => false);
    await $.ui.open(PANE_OPEN);
    void refresh($, jiraKey);
    return { text: "pinboard pane opened." };
  });

  on("command.run", { command: "pin-clear" }, async ($) => {
    await clearQuestions($);
    return { text: "고정된 질문 목록을 지웠습니다." };
  });

  // /clear and an in-app resume go on under another session id with no
  // session.start, and the atom outlives them. Not classic.SessionStart: a
  // managed guard can keep classic.* from user mods.
  // So the end empties the pins and the next turn loads the new session's.
  // ponytail: a resumed session's pins show from its first prompt on, not before
  on("session.end", async ($, e, next) => {
    if (e.reason === "clear" || e.reason === "resume") {
      await update($, pinsA, () => []);
      await update($, draftA, () => null);
    }
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) await restore($);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) void sync($, jiraKey);
    return next(e);
  });

  // The band: open questions only. Other mods' band stays beneath ours.
  // It also opens the pane unasked, once, where the pane is a sidebar: a
  // fullscreen terminal (placed from 144 columns, 110 once opened by hand).
  // On the main screen it would sit over the transcript: /pinboard opens it.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (!autoOpened && e.viewport?.isFullscreen === true) {
      autoOpened = true;
      void $.ui
        .open(PANE_OPEN)
        .then((r) => (r.isPlaced ? sync($, jiraKey) : undefined))
        .catch(() => {});
    }
    const [pins, folded] = await Promise.all([
      read($, pinsA),
      read($, foldedA),
    ]);
    const list = questions(pins);
    if (list.length === 0 || e.props.hasSurvey) return next(e);
    const { Box } = $.ui.resolve(e);
    const below = await next(e);
    return (
      <Box flexDirection="column">
        {board($, e, list, folded)}
        {below}
      </Box>
    );
  });

  // The pane: cards (세션 · 작업 · PR·링크 · 문서), a dim toolbar of skills and
  // history, then the memo docked to the pane's bottom edge, drawn apart.
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    if (e.surface === "mobile") {
      const { Text } = $.ui.resolve(e);
      return <Text dimColor>pinboard: no mobile layout</Text>;
    }
    const { Box, Text, Button, Input, Link } = $.ui.resolve(e);
    const [
      s,
      pins,
      history,
      memoOpen,
      paneFolded,
      draft,
      memoSaves,
      memoFocus,
    ] = await Promise.all([
      read($, snapA),
      read($, pinsA),
      read($, historyA),
      read($, memoA),
      read($, paneFoldedA),
      read($, draftA),
      read($, memoSavesA),
      read($, memoFocusA),
    ]);
    if (!s)
      return (
        <Box>
          <Text dimColor>불러오는 중…</Text>
        </Box>
      );
    const w = e.props.bodyColumns - 6; // inside a card's border, padding and body indent
    const isDock = e.props.placement === "dock";
    isInlineNow = !isDock;
    const home = (await $.env.get("HOME")) ?? "";
    const docPins = pins.filter((p) => p.kind === "doc");
    const nexts = pins.filter((p) => p.kind === "next");
    const autoDocs = s.docs.filter(
      (d) => !docPins.some((p) => p.ref === d.path),
    );
    const note = pins.find((p) => p.kind === "note")?.text ?? "";
    const memo = draft ?? note; // what the field holds
    const memoLen = [...memo].length; // code points: an emoji is one
    const isUnsaved = draft !== null && draft.trim() !== note;
    const isEditing = e.props.isFocused && memoFocus;
    // grows with the text up to a cap; the field scrolls past it.
    // ponytail: fixed caps; from bodyRows if a short window needs less
    // A focused field sizes its text to the pane's whole width, less the
    // engine's hint beside it (` ⏎ 저장 · \⏎ new line`, about 21 cells),
    // whatever holds it: inside a frame its rows overflow and draw as one cut
    // row (claude-code#106637). So it is framed like a card only while not
    // focused, and the height is sized for the focused width and never changes
    // on focus: a field whose rows change as it takes the ring loses the keyboard.
    const editRows = wrapRows(memo, e.props.bodyColumns - 21);
    const viewRows = wrapRows(memo, e.props.bodyColumns - 4); // in the frame
    const memoRows = Math.min(isDock ? 10 : 6, Math.max(3, editRows));
    const nLinks = s.prs.length + s.jira.length + s.links.length;
    const nDocs = docPins.length + autoDocs.length;

    const flow = (name: string) => () => {
      void $.prompt.fill({ text: `/${name} ` });
    };
    // Nerd glyphs draw about 2 cells in the non-Mono font: two spaces keep the text clear
    const g = (glyph: string) => `${glyph}  `;

    // A section: dim rounded frame (lit under the pointer), title left, meta right.
    // The title is colored and the body indented: Hangul bold barely shows here.
    const card = (
      id: string,
      t: string,
      meta: string | undefined,
      body?: JSX.Element,
    ) => (
      <Box
        key={`card:${id}`}
        flexDirection="column"
        borderStyle="round"
        borderDimColor
        paddingX={1}
        hover={{
          borderColor: "suggestion",
          borderDimColor: false,
        }}
      >
        <Box justifyContent="space-between">
          <Text bold color={TITLE}>
            {t}
          </Text>
          {meta ? <Text dimColor>{meta}</Text> : null}
        </Box>
        {body ? (
          <Box flexDirection="column" paddingLeft={2}>
            {body}
          </Box>
        ) : null}
      </Box>
    );
    // each identifier is a plain Button: press = copy to clipboard; `open` (a
    // local doc) opens it in its app instead, copying `open <path>` where it can't
    const Copy = ({
      k,
      text,
      label,
      dim,
      open,
    }: {
      k: string;
      text: string;
      label: string | JSX.Element;
      dim?: boolean;
      open?: boolean;
    }) => (
      <Button
        key={`cp:${k}`}
        plain
        dimColor={dim}
        onPress={async (press) => {
          // ponytail: macOS `open` alone; xdg-open/start if the pane runs elsewhere.
          // A document opens in its app; anything else (an app, a script, a link
          // to one) is only shown in Finder: a pin the model made never runs code
          if (open) {
            const st = await $.fs
              .stat(text, { resolve: true })
              .catch(() => null);
            const isDoc = DOC_EXT.test(st?.realPath ?? text);
            const o = await $.process
              .run(isDoc ? ["open", text] : ["open", "-R", text])
              .catch(() => null);
            if (o?.exitCode === 0)
              return $.ui.toast(
                `${isDoc ? "opened" : "shown in Finder"}: ${short(text, home)}`,
              );
          }
          const t = open ? `open ${shq(text)}` : text;
          const r = await $.ui.copy({ text: t, surface: press.surface });
          $.ui.toast(r.isCopied ? `copied: ${t}` : `copy failed: ${r.reason}`);
        }}
      >
        {label}
      </Button>
    );
    // a PR's cells that say something — CI and review only while open
    const prCells = (p: Pr) => {
      const isOpen = p.state === "OPEN" || p.state === "DRAFT";
      const ci = isOpen ? p.checks.trim() : "";
      const review = isOpen ? REVIEW[p.review] : undefined;
      return [
        <Text color={STATE_COLOR[p.state]} dimColor={!STATE_COLOR[p.state]}>
          {STATE[p.state]}
        </Text>,
        ci ? <Text color={CI_COLOR[ci]}>{ci}</Text> : null,
        review ? (
          <Text
            color={REVIEW_COLOR[p.review]}
            dimColor={!REVIEW_COLOR[p.review]}
          >
            {review}
          </Text>
        ) : null,
        p.comments ? (
          <Text dimColor>{`${g(I.comment)}${p.comments}`}</Text>
        ) : null,
      ];
    };
    // two lines: #number (the only link) and the title over the full width,
    // then the cells under the #
    const PrRow = ({ p }: { p: Pr }) => (
      <Box key={`pr:${p.number}`} flexDirection="column">
        <Text wrap="truncate-end">
          {g(I.pr)}
          <Link href={p.url}>{`#${p.number}`}</Link>
          {`  ${p.title}`}
        </Text>
        <Box paddingLeft={3} gap={2}>
          {prCells(p)}
        </Box>
      </Box>
    );

    const running = s.bg.filter((b) => b.status === "running").length;
    const nextMeta = `${nexts.filter((n) => n.isDone).length}/${nexts.length}`;
    const toolbar = (
      <Box
        marginTop={isDock ? 1 : 0}
        paddingX={isDock ? 1 : 0}
        justifyContent="space-between"
      >
        <Box columnGap={2} flexWrap="wrap">
          {commands.map((n) => (
            <Button key={`cmd:${n}`} plain dimColor onPress={flow(n)}>
              {`/${n}`}
            </Button>
          ))}
        </Box>
        <Box columnGap={2}>
          {isDock ? null : (
            <Button
              key="memo-toggle"
              plain
              dimColor
              onPress={() => void update($, memoA, (o) => !o)}
            >
              {`${memoOpen ? "▾" : "▸"} 한줄메모${note ? "*" : ""}`}
            </Button>
          )}
          <Button
            key="hist"
            plain
            dimColor
            onPress={() => void update($, historyA, (o) => !o)}
          >
            {`${history ? "▾" : "▸"} 히스토리 ${s.prompts.length}`}
          </Button>
        </Box>
      </Box>
    );
    const histCard =
      history &&
      card(
        "hist",
        "프롬프트 히스토리",
        s.prompts.length > 10 ? "최근 10" : undefined,
        <>
          {s.prompts.slice(-10).map((p, i, xs) => (
            <Text dimColor wrap="truncate-end">
              {`${String(s.prompts.length - xs.length + i + 1).padStart(2)}  ${p}`}
            </Text>
          ))}
        </>,
      );
    // A card's frame while viewing; editing (the ring on the field), heavy lit
    // rules above and below and the pane's whole width (see editRows). The copy
    // button is always drawn: an element appearing before the field as the
    // first letter lands (or leaving as the last goes) takes the keyboard off it.
    const memoRule = (
      <Text
        color={isEditing ? "suggestion" : "remember"}
        dimColor={!isEditing}
        wrap="truncate-end"
      >
        {(isEditing ? "━" : "─").repeat(e.props.bodyColumns)}
      </Text>
    );
    const memoBox = (
      <Box
        key="memo-dock"
        flexDirection="column"
        marginTop={1}
        {...(isEditing
          ? {}
          : { borderStyle: "round", borderDimColor: true, paddingX: 1 })}
      >
        {isEditing ? memoRule : null}
        <Box justifyContent="space-between">
          <Box gap={2}>
            <Text bold color={isEditing ? "suggestion" : TITLE}>
              {isEditing ? "한줄메모 편집 중" : "한줄메모"}
            </Text>
            {memoLen ? <Text dimColor>{`${memoLen}자`}</Text> : null}
          </Box>
          <Box gap={2}>
            {isUnsaved ? <Text color="warning">저장 안 됨</Text> : null}
            {isEditing ? <Text dimColor>Esc 나가기</Text> : null}
            <Button
              key="memo-copy"
              plain
              dimColor
              onPress={async (press) => {
                if (!memoLen) return $.ui.toast("복사할 한줄메모가 없음");
                const r = await $.ui.copy({
                  text: memo,
                  surface: press.surface,
                });
                $.ui.toast(
                  r.isCopied
                    ? `한줄메모 복사됨 · ${memoLen}자`
                    : `copy failed: ${r.reason}`,
                );
              }}
            >
              복사
            </Button>
          </Box>
        </Box>
        <Input
          key={`memo:${memoSaves}`}
          rows={memoRows}
          // the pane's keyboard lands here: the ring's move then says so
          // (ui.focus), where an Esc and a return raise nothing
          autoFocus
          submitLabel="저장"
          placeholder="이 세션에서 기억할 것…"
          value={memo}
          onInput={(t) => {
            void update($, draftA, () => t);
            void storeDraft($, t);
          }}
          onSubmit={async (t) => {
            await editPins($, (cur) => setNote(cur, t));
            await storeDraft($, null);
            await update($, draftA, () => null);
            await update($, memoSavesA, (n) => n + 1);
            $.ui.toast(t.trim() ? "한줄메모 저장됨" : "한줄메모 지움");
          }}
        />
        {!isEditing && viewRows > memoRows ? (
          <Box justifyContent="flex-end">
            <Text dimColor>{`▾ ${viewRows - memoRows}줄 더`}</Text>
          </Box>
        ) : null}
        {isEditing ? memoRule : null}
      </Box>
    );

    // Inline (above the prompt: a narrow or non-fullscreen terminal) the pane
    // takes the transcript's rows, so each section is one row, its name in a
    // fixed column; an empty one is left out, the memo shown on its toggle.
    if (!isDock) {
      const line = (id: string, name: string, body: JSX.Element) => (
        <Box key={`line:${id}`} gap={1}>
          <Box width={4} flexShrink={0}>
            <Text color={TITLE}>{name}</Text>
          </Box>
          <Box flexGrow={1}>{body}</Box>
        </Box>
      );
      const cur = s.tree.find((n) => n.isCurrent);
      const firstOpen = nexts.findIndex((n) => !n.isDone);
      // folded (접기 or the close mark): one row, where and what; 펼치기 at the
      // right end under the close mark, which now closes the pane
      if (paneFolded)
        return (
          <Box justifyContent="space-between" columnGap={2}>
            <Text dimColor wrap="truncate-end">
              {[s.branch || tilde(s.cwd, home), cur?.label]
                .filter(Boolean)
                .join("  ·  ")}
            </Text>
            <Box flexShrink={0}>
              <Button
                key="pane-unfold"
                plain
                onPress={() => void update($, paneFoldedA, () => false)}
              >
                ▸ 펼치기
              </Button>
            </Box>
          </Box>
        );
      return (
        <Box flexDirection="column">
          {line(
            "session",
            "세션",
            // 접기 at the top row's right end, under the frame's close mark
            <Box flexGrow={1} justifyContent="space-between" columnGap={2}>
              <Box columnGap={2}>
                {s.branch ? (
                  <Copy
                    k="branch"
                    text={s.branch}
                    label={`${g(I.branch)}${s.branch}`}
                  />
                ) : null}
                <Copy
                  k="cwd"
                  text={s.cwd}
                  label={tilde(s.cwd, home)}
                  dim={!!s.branch}
                />
              </Box>
              <Box flexShrink={0}>
                <Button
                  key="pane-fold"
                  plain
                  dimColor
                  onPress={() => void update($, paneFoldedA, () => true)}
                >
                  ▾ 접기
                </Button>
              </Box>
            </Box>,
          )}
          {s.bg.length > 0 &&
            line(
              "bg",
              "bg",
              <Box columnGap={2}>
                <Text dimColor>{`실행 ${running}/${s.bg.length}`}</Text>
                {s.bg
                  .filter((b) => b.port)
                  .map((b) => (
                    <Link
                      key={`bg:${b.id}`}
                      href={`http://localhost:${b.port}`}
                    >
                      {`localhost:${b.port}`}
                    </Link>
                  ))}
              </Box>,
            )}
          {cur &&
            line(
              "work",
              "작업",
              <Text wrap="truncate-end">
                <Text color="warning">● </Text>
                {cur.label}
              </Text>,
            )}
          {nexts.length > 0 &&
            line(
              "next",
              "다음",
              <Box flexGrow={1} justifyContent="space-between">
                {firstOpen >= 0 ? (
                  rows($, e, nexts, "next")[firstOpen]
                ) : (
                  <Text dimColor>모두 완료</Text>
                )}
                <Text dimColor>{nextMeta}</Text>
              </Box>,
            )}
          {nLinks > 0 &&
            line(
              "links",
              "PR",
              <Box columnGap={2} flexWrap="wrap">
                {s.prs.map((p) => (
                  <Box key={`pr:${p.number}`} gap={1}>
                    <Link href={p.url}>{`#${p.number}`}</Link>
                    {prCells(p)}
                  </Box>
                ))}
                {s.jira.map((k) => (
                  <Link key={k} href={`${jiraBase}/browse/${k}`} label={k} />
                ))}
                {s.links.length ? (
                  <Text dimColor>{`링크 ${s.links.length}`}</Text>
                ) : null}
              </Box>,
            )}
          {nDocs > 0 &&
            line(
              "docs",
              "문서",
              <Box columnGap={2} flexWrap="wrap">
                {docPins.map((p, i) =>
                  /^https?:\/\//.test(p.ref ?? "") ? (
                    <Link href={p.ref ?? ""} label={urlLabel(p)} />
                  ) : (
                    <Copy
                      k={`pin${i}`}
                      text={p.ref ?? ""}
                      open
                      label={p.text === p.ref ? short(p.text, home) : p.text}
                    />
                  ),
                )}
                {autoDocs.length ? (
                  <Text dimColor>{`자동 ${autoDocs.length}`}</Text>
                ) : null}
              </Box>,
            )}
          {toolbar}
          {histCard}
          {memoOpen && memoBox}
        </Box>
      );
    }

    // ponytail: the memo docks by filling the window (minHeight = bodyRows);
    // a tree taller than the window scrolls it along — self-scroll the cards via ui.scroll then
    return (
      <Box flexDirection="column" minHeight={e.props.scroll.bodyRows}>
        {card(
          "session",
          "세션",
          `⟳ ${new Date(s.at).toTimeString().slice(0, 5)}`,
          <Box flexDirection="column">
            {s.branch ? (
              <Box gap={2}>
                <Copy
                  k="branch"
                  text={s.branch}
                  label={`${g(I.branch)}${s.branch}`}
                />
                {s.worktree ? (
                  <Copy
                    k="wt"
                    text={s.worktree}
                    label={`wt ${s.worktree}`}
                    dim
                  />
                ) : null}
              </Box>
            ) : null}
            <Box columnGap={2} flexWrap="wrap">
              <Copy k="cwd" text={s.cwd} label={tilde(s.cwd, home)} />
              <Copy k="sid" text={s.sid} label={`sid ${s.sid}`} dim />
            </Box>
          </Box>,
        )}

        {/* only when the session ran one: mark · port (a link) · label (press = copy the command) */}
        {s.bg.length > 0 &&
          card(
            "bg",
            "백그라운드",
            `실행 ${running}/${s.bg.length}`,
            <Box flexDirection="column">
              {s.bg.map((b) => {
                const [glyph, color] = BG_MARK[b.status] ?? [I.ciFail]; // killed
                return (
                  <Box key={`bg:${b.id}`} gap={2}>
                    <Text color={color} dimColor={!color}>
                      {glyph}
                    </Text>
                    {b.port ? (
                      <Link href={`http://localhost:${b.port}`}>
                        {`localhost:${b.port}`}
                      </Link>
                    ) : null}
                    <Copy
                      k={`bg:${b.id}`}
                      text={b.command}
                      dim={!color}
                      label={<Text wrap="truncate-end">{b.label}</Text>}
                    />
                  </Box>
                );
              })}
            </Box>,
          )}

        {card(
          "work",
          "작업",
          s.tree.length ? undefined : "없음",
          <>
            {s.tree.map((n) =>
              // the current one: full color, its rail in warning
              n.isCurrent ? (
                <Text wrap="truncate-end">
                  <Text color="warning">{n.pre}</Text>
                  {n.label}
                </Text>
              ) : (
                <Text dimColor wrap="truncate-end">
                  {n.pre}
                  {n.label}
                </Text>
              ),
            )}
          </>,
        )}

        {card(
          "next",
          "다음 할 일",
          nexts.length ? nextMeta : "없음",
          <>{rows($, e, nexts, "next")}</>,
        )}

        {card(
          "links",
          "PR · 링크",
          nLinks ? String(nLinks) : "없음",
          <Box flexDirection="column">
            {s.prs.map((p) => (
              <PrRow p={p} />
            ))}
            {s.jira.length > 0 && (
              <Box gap={2}>
                <Text dimColor>{I.jira}</Text>
                {s.jira.map((k) => (
                  <Link key={k} href={`${jiraBase}/browse/${k}`} label={k} />
                ))}
              </Box>
            )}
            {s.links.map((l) => (
              <Link
                href={l}
                label={`${g(I.link)}${cut(l.replace(/^https?:\/\//, ""), w - 3)}`}
              />
            ))}
          </Box>,
        )}

        {card(
          "docs",
          "문서",
          nDocs ? String(nDocs) : "없음",
          <Box flexDirection="column">
            {docPins.map((p, i) =>
              /^https?:\/\//.test(p.ref ?? "") ? (
                <Link href={p.ref ?? ""} label={`${g(I.pin)}${urlLabel(p)}`} />
              ) : (
                <Copy
                  k={`pin${i}`}
                  text={p.ref ?? ""}
                  open
                  label={
                    <Text wrap="truncate-end">
                      {g(I.pin)}
                      {p.text === p.ref ? short(p.text, home) : p.text}
                      {p.text !== p.ref ? (
                        <Text dimColor>{`  ${short(p.ref ?? "", home)}`}</Text>
                      ) : null}
                    </Text>
                  }
                />
              ),
            )}
            {autoDocs.map((d) => (
              <Text wrap="truncate-end">
                <Text dimColor>{g(d.kind === "new" ? I.newDoc : I.doc)}</Text>
                {short(d.path, home)}
                <Text dimColor>{`  ${d.tag}`}</Text>
              </Text>
            ))}
          </Box>,
        )}

        {toolbar}
        {histCard}
        <Box flexGrow={1} />
        {memoBox}
      </Box>
    );
  });
};
