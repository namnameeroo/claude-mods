import { expect, test, mock } from "claude-code/testing";
import type { On, SessionMessage } from "claude-code";
import type { Engine } from "claude-code/testing";
import {
  applyDoc,
  applyIntent,
  jiraMatcher,
  layoutTree,
  scan,
} from "../hooks/register";

const KEYS = jiraMatcher("WEB, app,OPS,PM,DATA");

const Q_TOOL = "mcp__pinboard__pin_questions";
const DOC_TOOL = "mcp__pinboard__pin_doc";
const NEXT_TOOL = "mcp__pinboard__pin_next_steps";
const INTENT_TOOL = "mcp__pinboard__record_intent";

const BAND = {
  plugin: "pinboard",
  component: "AbovePrompt",
  surface: "terminal",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 60,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const;

// Nothing sits beneath the plugin in a test: these stand for the engine.
// The pane's refresh fails here (no session nouns) and is fire-and-forget.
const engine = (
  on: On,
  store: Record<string, unknown> = {},
  sid = () => "s1",
) => {
  mock.store(on, store);
  mock.clock(on);
  on("session.id", () => ({ value: sid() }));
  on("tool.register", () => ({ value: { tool: Q_TOOL } }));
  on("command.register", () => ({ value: { command: "pin-clear" } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine-band</Text>;
  });
};

const start = ($: Engine) =>
  $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
const call = ($: Engine, tool: string, input: Record<string, unknown>) =>
  $.tool.call({ tool, ...input } as never);

test("set → check → clear drives the band; docs survive", async ($, on) => {
  engine(on);
  await start($);
  await call($, DOC_TOOL, { ref: "/r/spec.md", title: "스펙" });

  const set = await call($, Q_TOOL, {
    action: "set",
    items: ["색상은?", "  ", "폰트는?"],
  });
  expect(set.text).toBe("pinned 2 item(s), 0 checked");

  let ui = await $.ui.mount(BAND);
  expect((await ui.find({ key: "q:0" }))?.text).toBe("[ ] 1. 색상은?");
  expect((await ui.find({ key: "q:1" }))?.text).toBe("[ ] 2. 폰트는?");
  expect(await ui.find({ text: /engine-band/ })).toBeDefined(); // other bands kept
  expect((await ui.find({ type: "Text", text: /답변 대기 질문/ }))?.text).toBe(
    "\uf08d 답변 대기 질문 0/2",
  );
  await ui.unmount();

  const checked = await call($, Q_TOOL, { action: "check", indexes: [2] });
  expect(checked.text).toBe("pinned 2 item(s), 1 checked");
  ui = await $.ui.mount(BAND);
  expect((await ui.find({ key: "q:1" }))?.text).toBe("[x] 2. 폰트는?");
  await ui.press({ key: "q:0" }); // a press toggles the item
  expect((await ui.find({ key: "q:0" }))?.text).toBe("[x] 1. 색상은?");
  await ui.unmount();

  const cleared = await call($, Q_TOOL, { action: "clear" });
  expect(cleared.text).toBe("pinned 0 item(s), 0 checked");
  ui = await $.ui.mount(BAND);
  expect(await ui.find({ key: "q:0" })).toBeUndefined();
  await ui.unmount();

  // the doc pinned before is still there
  const again = await call($, DOC_TOOL, { ref: "/r/plan.md" });
  expect(again.text).toBe("pinned /r/plan.md; 2 doc(s) pinned");
});

test("an unknown action is refused and changes nothing", async ($, on) => {
  engine(on);
  await start($);
  await call($, Q_TOOL, { action: "set", items: ["a"] });

  const bad = await call($, Q_TOOL, { action: "toggle", indexes: [1] });
  expect(typeof bad.deny).toBe("string");

  const ui = await $.ui.mount(BAND);
  expect((await ui.find({ key: "q:0" }))?.text).toBe("[ ] 1. a");
  await ui.unmount();
});

test("the fold button (hotkey 0) hides the list and shows it back; a new set unfolds; /pin-clear empties", async ($, on) => {
  engine(on);
  await start($);
  await call($, Q_TOOL, { action: "set", items: ["a"] });

  let ui = await $.ui.mount(BAND);
  expect((await ui.find({ key: "fold" }))?.props.hotkey).toBe("0");
  expect((await ui.find({ key: "fold" }))?.text).toBe("접기");
  await ui.press({ key: "fold" });
  expect(await ui.find({ key: "q:0" })).toBeUndefined(); // folded: the header stays
  expect(
    await ui.find({ type: "Text", text: /답변 대기 질문 0\/1/ }),
  ).toBeDefined();
  expect((await ui.find({ key: "fold" }))?.text).toBe("펼치기");
  await ui.press({ key: "fold" });
  expect((await ui.find({ key: "q:0" }))?.text).toBe("[ ] 1. a"); // nothing lost
  await ui.press({ key: "fold" });
  await ui.unmount();

  await call($, Q_TOOL, { action: "set", items: ["b"] }); // new questions show
  ui = await $.ui.mount(BAND);
  expect((await ui.find({ key: "q:0" }))?.text).toBe("[ ] 1. b");
  await ui.unmount();

  const ran = await $.command.run({
    command: "pin-clear",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 80 },
  });
  expect(ran.text).toBe("고정된 질문 목록을 지웠습니다.");
  ui = await $.ui.mount(BAND);
  expect(await ui.find({ key: "q:0" })).toBeUndefined();
  await ui.unmount();
});

test("pin_doc pins, retitles, unpins, and refuses an empty ref", async ($, on) => {
  engine(on);
  await start($);
  expect((await call($, DOC_TOOL, { ref: "  " })).deny).toBeDefined();

  const a = applyDoc([], { ref: "https://x.atlassian.net/wiki/1" });
  expect(a).toEqual([
    {
      kind: "doc",
      text: "https://x.atlassian.net/wiki/1",
      ref: "https://x.atlassian.net/wiki/1",
    },
  ]);
  const b = applyDoc(a as never, {
    ref: "https://x.atlassian.net/wiki/1",
    title: "기획서",
  });
  expect(b).toEqual([
    { kind: "doc", text: "기획서", ref: "https://x.atlassian.net/wiki/1" },
  ]);
  expect(
    applyDoc(b as never, {
      ref: "https://x.atlassian.net/wiki/1",
      remove: true,
    }),
  ).toEqual([]);

  const out = await call($, DOC_TOOL, { ref: "/r/spec.md", remove: true });
  expect(out.text).toBe("unpinned /r/spec.md; 0 doc(s) pinned");
});

test("pins come back from the store in a new process (--resume)", async ($, on) => {
  engine(on, {
    "pins:s1": [{ kind: "question", text: "이어서 할까?", isDone: false }],
  });
  await start($);
  const ui = await $.ui.mount(BAND);
  expect((await ui.find({ key: "q:0" }))?.text).toBe("[ ] 1. 이어서 할까?");
  await ui.unmount();
});

test("scan picks PRs, Jira keys, links and touched .md from the transcript", async () => {
  const msgs = [
    {
      role: "user",
      text: "https://github.com/acme/web/pull/45 리뷰 반영",
      toolUses: [],
    },
    { role: "user", text: "[Request interrupted by user]", toolUses: [] },
    {
      role: "assistant",
      text: "WEB-123 확인. ADR-0001 참고. https://acme.atlassian.net 기획: https://acme.atlassian.net/wiki/x 설명: https://claude.ai/code/artifact/f4fdbad9-4e01-4721-badc-bd472ceb755b",
      toolUses: [
        { tool: "Write", input: { file_path: "/repo/docs/plan.md" } },
        { tool: "Read", input: { file_path: "/repo/README.md" } },
        { tool: "Read", input: { file_path: "/repo/src/a.ts" } },
      ],
    },
  ] as unknown as SessionMessage[];
  const r = scan(msgs, "/repo", "feat/WEB-123-x", KEYS);
  expect(r.prRefs).toEqual(["acme/web#45"]);
  expect(r.jira).toEqual(["WEB-123"]);
  expect(r.links).toEqual([
    "https://acme.atlassian.net/wiki/x",
    "https://claude.ai/code/artifact/f4fdbad9-4e01-4721-badc-bd472ceb755b", // the current artifact URL form
  ]);
  expect(r.docs).toEqual([
    { path: "/repo/docs/plan.md", kind: "new", tag: "repo" },
    { path: "/repo/README.md", kind: "ref", tag: "repo" },
  ]);
  expect(r.prompts).toEqual(["https://github.com/acme/web/pull/45 리뷰 반영"]);
});

const PANE = {
  plugin: "pinboard",
  component: "Pane",
  requestId: "pinboard",
  surface: "terminal",
  props: {
    title: "pinboard",
    isFocused: false,
    bodyColumns: 80,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;

test("the pane: empty sections read 없음, a pinned doc shows title and path", async ($, on) => {
  engine(on);
  mock.env(on, { HOME: "/Users/me" });
  on("session.cwd", () => ({ value: "/Users/me/toys" }));
  on("session.root", () => ({ value: "/Users/me/toys" }));
  on("session.repo", () => ({ value: null }));
  on("session.messages", () => ({ value: [] }));
  on("fs.read", () => ({ value: "" }));
  await start($);
  await call($, DOC_TOOL, {
    ref: "/Users/me/toys/docs/spec.md",
    title: "스펙",
  });

  const ui = await $.ui.mount(PANE);
  expect((await ui.find({ key: "cp:cwd" }))?.text).toBe("~/toys");
  expect(await ui.find({ key: "cp:branch" })).toBeUndefined(); // no git, no row
  expect((await ui.findAll({ type: "Text", text: "없음" })).length).toBe(3); // 작업, 다음 할 일, PR · 링크
  expect((await ui.find({ key: "cp:pin0" }))?.text).toContain("스펙");
  expect((await ui.find({ key: "cp:pin0" }))?.text).toContain("docs/spec.md");
  expect(await ui.find({ text: /──/ })).toBeUndefined();
  await ui.unmount();
});

test("a local doc pin opens on press; where `open` fails, `open '<path>'` is copied", async ($, on) => {
  engine(on);
  mock.env(on, { HOME: "/Users/me" });
  on("session.cwd", () => ({ value: "/Users/me/toys" }));
  on("session.root", () => ({ value: "/Users/me/toys" }));
  on("session.repo", () => ({ value: null }));
  on("session.messages", () => ({ value: [] }));
  on("fs.read", () => ({ value: "" }));
  let exitCode = 0;
  const ran: string[][] = [];
  on("process.run", (_, e) => {
    ran.push([...e.argv]);
    return {
      value: { exitCode, stdout: "", stderr: "", isStdoutTruncated: false },
    } as never;
  });
  let copied = "";
  on("ui.copy", (_, e) => {
    copied = e.text;
    return { value: { isCopied: true } as never };
  });
  const toasts: string[] = [];
  on("ui.toast", (_, e) => {
    toasts.push(e.text);
    return { value: undefined as never };
  });
  await start($);
  await call($, DOC_TOOL, { ref: "/Users/me/toys/My Doc.html" });

  const ui = await $.ui.mount(PANE);
  await ui.press({ key: "cp:pin0" });
  expect(ran).toContainEqual(["open", "/Users/me/toys/My Doc.html"]);
  expect(copied).toBe(""); // opened: nothing copied
  expect(toasts.at(-1)).toBe("opened: toys/My Doc.html");

  exitCode = 1; // no app for it, or the file is gone
  await ui.press({ key: "cp:pin0" });
  expect(copied).toBe("open '/Users/me/toys/My Doc.html'");
  expect(toasts.at(-1)).toBe("copied: open '/Users/me/toys/My Doc.html'");
  await ui.unmount();
});

test("the memo docks to the bottom of a dock pane, not of an inline one", async ($, on) => {
  engine(on);
  mock.env(on, { HOME: "/Users/me" });
  on("session.cwd", () => ({ value: "/Users/me/toys" }));
  on("session.root", () => ({ value: "/Users/me/toys" }));
  on("session.repo", () => ({ value: null }));
  on("session.messages", () => ({ value: [] }));
  on("fs.read", () => ({ value: "" }));
  await start($);
  await call($, Q_TOOL, { action: "clear" }); // one settled act: the start's refresh has landed

  let ui = await $.ui.mount(PANE);
  expect((await ui.find({ type: "Box" }))?.props.minHeight).toBe(40);
  expect((await ui.find({ key: "memo-dock" }))?.text).toContain("메모");
  await ui.unmount();

  ui = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, placement: "inline" },
  });
  expect((await ui.find({ type: "Box" }))?.props.minHeight).toBeUndefined();
  await ui.unmount();
});

test("an inline pane: one row a section, empty ones left out, the memo folded until asked", async ($, on) => {
  engine(on);
  mock.env(on, { HOME: "/Users/me" });
  on("session.cwd", () => ({ value: "/Users/me/toys" }));
  on("session.root", () => ({ value: "/Users/me/toys" }));
  on("session.repo", () => ({ value: null }));
  on("session.messages", () => ({ value: [] }));
  on("fs.read", () => ({ value: "" }));
  await start($);
  await call($, NEXT_TOOL, { action: "set", items: ["테스트", "PR 올리기"] });
  await call($, NEXT_TOOL, { action: "check", indexes: [1] });
  await call($, DOC_TOOL, {
    ref: "/Users/me/toys/docs/spec.md",
    title: "스펙",
  });

  const ui = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, placement: "inline" },
  });
  expect((await ui.find({ key: "cp:cwd" }))?.text).toBe("~/toys");
  expect(await ui.find({ type: "Text", text: "없음" })).toBeUndefined(); // 작업 · PR left out
  expect(await ui.find({ type: "Text", text: "작업" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: "다음 할 일" })).toBeUndefined(); // no cards
  expect(await ui.find({ key: "n:0" })).toBeUndefined(); // only the first open step
  expect((await ui.find({ key: "n:1" }))?.text).toBe("[ ] 2. PR 올리기");
  expect(await ui.find({ type: "Text", text: "1/2" })).toBeDefined();
  expect((await ui.find({ key: "cp:pin0" }))?.text).toBe("스펙");

  expect(await ui.find({ key: "memo" })).toBeUndefined();
  await ui.press({ key: "memo-toggle" });
  expect(await ui.find({ key: "memo" })).toBeDefined();
  await ui.unmount();
});

test("layoutTree nests sub-steps, starts new topics at the left, keeps old records flat", () => {
  const rows = layoutTree({
    initial: { ts: "t0", label: "A 통합" },
    history: [
      { ts: "t1", label: "B UI", parent: "t0" },
      { ts: "t2", label: "C 카드", parent: "t0" },
      { ts: "t3", label: "D hover", parent: "t2" },
      { ts: "t4", label: "E 상시 로드", parent: null },
      { ts: "t5", label: "F 버그", parent: "t4" },
    ],
  });
  expect(rows.map((r) => r.pre + r.label)).toEqual([
    "● A 통합",
    "  ├ B UI",
    "  └ C 카드",
    "    └ D hover",
    "● E 상시 로드",
    "  └ F 버그",
  ]);
  expect(rows.filter((r) => r.isCurrent).map((r) => r.label)).toEqual([
    "F 버그",
  ]);

  // records written before `parent` existed: every update under the first topic
  const old = layoutTree({
    initial: { ts: "t0", label: "A" },
    history: [
      { ts: "t1", label: "B" },
      { ts: "t2", label: "C" },
    ],
  });
  expect(old.map((r) => r.pre + r.label)).toEqual(["● A", "  ├ B", "  └ C"]);
  expect(layoutTree(null)).toEqual([]);
});

test("pin_next_steps fills the 다음 할 일 card and leaves the questions alone", async ($, on) => {
  engine(on);
  mock.env(on, { HOME: "/Users/me" });
  on("session.cwd", () => ({ value: "/Users/me/toys" }));
  on("session.root", () => ({ value: "/Users/me/toys" }));
  on("session.repo", () => ({ value: null }));
  on("session.messages", () => ({ value: [] }));
  on("fs.read", () => ({ value: "" }));
  await start($);
  await call($, Q_TOOL, { action: "set", items: ["질문"] });

  const set = await call($, NEXT_TOOL, {
    action: "set",
    items: ["새 세션에서 확인", "레포에서 PR 확인"],
  });
  expect(set.text).toBe("pinned 2 item(s), 0 checked");
  expect(
    (await call($, NEXT_TOOL, { action: "check", indexes: [1] })).text,
  ).toBe("pinned 2 item(s), 1 checked");
  expect(typeof (await call($, NEXT_TOOL, { action: "toggle" })).deny).toBe(
    "string",
  );

  const pane = await $.ui.mount(PANE);
  expect((await pane.find({ key: "n:0" }))?.text).toBe(
    "[x] 1. 새 세션에서 확인",
  );
  expect((await pane.find({ key: "n:1" }))?.text).toBe(
    "[ ] 2. 레포에서 PR 확인",
  );
  await pane.unmount();

  const band = await $.ui.mount(BAND);
  expect((await band.find({ key: "q:0" }))?.text).toBe("[ ] 1. 질문");
  expect(await band.find({ key: "n:0" })).toBeUndefined();
  await band.unmount();
});

test("applyIntent: init once, parent from relation, initial never overwritten", () => {
  const step = (
    prev: Parameters<typeof applyIntent>[0],
    input: object,
    ts: string,
  ) => {
    const r = applyIntent(prev, input as never, "s1", ts);
    if ("deny" in r) throw new Error(r.deny);
    return r;
  };
  const a = step(null, { label: "A 통합", what: "w" }, "t0");
  expect([a.session_id, a.initial.label, a.current.label, a.history]).toEqual([
    "s1",
    "A 통합",
    "A 통합",
    [],
  ]);

  const e = step(
    step(
      step(
        step(a, { label: "B", relation: "sub", reason: "r" }, "t1"),
        { label: "C", relation: "sibling" },
        "t2",
      ),
      { label: "D", relation: "new" },
      "t3",
    ),
    { label: "E" },
    "t4",
  );
  expect(e.history.map((h) => [h.label, h.parent])).toEqual([
    ["B", "t0"],
    ["C", "t0"],
    ["D", null],
    ["E", undefined],
  ]);
  expect("parent" in e.history[3]!).toBe(false); // no relation: no key, drawn under the first topic
  expect([e.initial.label, e.current.label]).toEqual(["A 통합", "E"]);

  // a sibling of the first topic is a new topic; of an old entry without parent, under the first
  expect(
    step(a, { label: "X", relation: "sibling" }, "t1").history[0]!.parent,
  ).toBeNull();
  const legacy = { ...a, history: [{ ts: "t1", label: "old", reason: "" }] };
  expect(
    step(legacy, { label: "Y", relation: "sibling" }, "t2").history[1]!.parent,
  ).toBe("t0");

  expect(
    step(a, { label: "가".repeat(70) + "\n둘째 줄" }, "t1").current.label,
  ).toBe("가".repeat(59) + "…");
  expect("deny" in applyIntent(a, { label: "  " }, "s1", "t1")).toBe(true);
  expect(
    "deny" in
      applyIntent(a, { label: "Z", relation: "child" as never }, "s1", "t1"),
  ).toBe(true);
});

test("record_intent writes the intent file and never overwrites one it cannot read", async ($, on) => {
  engine(on);
  mock.env(on, { HOME: "/Users/me" });
  const files: Record<string, string> = {};
  on("fs.read", (_, e) => {
    const v = files[e.path];
    if (v === undefined) throw new Error("ENOENT");
    return { value: v };
  });
  on("fs.write", (_, e) => {
    files[e.path] = e.text;
    return { value: undefined };
  });
  await start($);
  const file = "/Users/me/.claude/intent/s1.json";

  expect((await call($, INTENT_TOOL, { label: "A", what: "w" })).text).toBe(
    "intent init 기록: A",
  );
  expect(
    (await call($, INTENT_TOOL, { label: "B", relation: "sub", reason: "r" }))
      .text,
  ).toBe("intent update 기록: B");
  const rec = JSON.parse(files[file]!);
  const t = "1970-01-01T00:00:00Z"; // the mocked clock, seconds like `date -u +%FT%TZ`
  expect([
    rec.session_id,
    rec.initial.label,
    rec.initial.ts,
    rec.current.label,
  ]).toEqual(["s1", "A", t, "B"]);
  expect(rec.history).toEqual([{ ts: t, label: "B", reason: "r", parent: t }]);

  files[file] = "{ broken";
  expect((await call($, INTENT_TOOL, { label: "C" })).deny).toContain(
    "not valid JSON",
  );
  expect(files[file]).toBe("{ broken");
});

test("a PR row: #number links, the title keeps its line, the state line shows what matters", async ($, on) => {
  engine(on);
  mock.env(on, { HOME: "/Users/me" });
  on("session.cwd", () => ({ value: "/Users/me/toys" }));
  on("session.root", () => ({ value: "/Users/me/toys" }));
  on("session.repo", () => ({ value: null }));
  on("session.messages", () => ({
    value: [
      {
        role: "user",
        text: "https://github.com/o/r/pull/45 https://github.com/o/r/pull/57",
        toolUses: [],
      },
    ],
  }));
  on("fs.read", () => ({ value: "" }));
  const gh: Record<string, object> = {
    "45": {
      number: 45,
      title: "APP-2222 Story title",
      state: "MERGED",
      isDraft: false,
      reviewDecision: "REVIEW_REQUIRED",
      statusCheckRollup: [],
      url: "https://github.com/o/r/pull/45",
      comments: [],
    },
    "57": {
      number: 57,
      title: "WEB-12 결제 화면 리팩토링",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ conclusion: "FAILURE" }],
      url: "https://github.com/o/r/pull/57",
      comments: [{}, {}],
    },
  };
  // the stand-in answers { value } at runtime; its typing wants the bare result
  on(
    "process.run",
    (_, e) =>
      ({
        value: {
          exitCode: 0,
          stdout: JSON.stringify(gh[e.argv[3] ?? ""]),
          stderr: "",
          isStdoutTruncated: false,
        },
      }) as never,
  );
  await start($);
  await call($, Q_TOOL, { action: "clear" }); // the start's refresh has landed

  const ui = await $.ui.mount(PANE);
  const links = await ui.findAll({ type: "Link" });
  expect(links.map((l) => [l.props.href, l.children])).toEqual([
    ["https://github.com/o/r/pull/45", ["#45"]],
    ["https://github.com/o/r/pull/57", ["#57"]],
  ]);

  // merged: the badge alone — no review (U+F06E), no "0 comments" (U+F075)
  const merged = (await ui.find({ key: "pr:45" }))?.text ?? "";
  expect(merged).toContain("#45  APP-2222 Story title");
  expect(merged).toContain("[merged]");
  expect(merged).not.toContain("");
  expect(merged).not.toContain("");
  expect((await ui.find({ type: "Text", text: "[merged]" }))?.props.color).toBe(
    "merged",
  );

  // open: failing CI in red, approved in green, 2 comments
  const open = (await ui.find({ key: "pr:57" }))?.text ?? "";
  expect(open).toContain("#57  WEB-12 결제 화면 리팩토링");
  expect(open).toContain("[open]");
  expect((await ui.find({ type: "Text", text: "" }))?.props.color).toBe(
    "error",
  );
  expect((await ui.find({ type: "Text", text: "" }))?.props.color).toBe(
    "success",
  );
  expect(open).toContain("  2");
  await ui.unmount();
});

// a background Bash as the transcript holds it: the call, its result, its notification
const bgUse = (id: string, command: string, description?: string) => ({
  tool: "Bash",
  tool_use_id: `tu-${id}`,
  input: { command, description, run_in_background: true },
  text: `Command running in background with ID: ${id}. Output is being written to: /t/${id}.output. You will be notified when it completes.`,
});
const notice = (id: string, status: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>tu-${id}</tool-use-id>\n<output-file>/t/${id}.output</output-file>\n<status>${status}</status>\n</task-notification>`;

test("scan pairs a background Bash with its notification; a foreground one is not a task", () => {
  const msgs = [
    {
      role: "assistant",
      text: "",
      toolUses: [
        bgUse("b1", "pnpm dev", "dev 서버"),
        bgUse("b2", "pnpm test\n--watch"),
        {
          tool: "Bash",
          tool_use_id: "tu-x",
          input: { command: "ls" },
          text: "a.md",
        },
      ],
    },
    { role: "user", text: notice("b2", "failed"), toolUses: [] },
  ] as unknown as SessionMessage[];
  expect(scan(msgs, "/repo", "main").bg).toEqual([
    {
      id: "b1",
      out: "/t/b1.output",
      command: "pnpm dev",
      label: "dev 서버",
      status: "running",
    },
    {
      id: "b2",
      out: "/t/b2.output",
      command: "pnpm test\n--watch",
      label: "pnpm test",
      status: "failed",
    },
  ]);
});

test("the 백그라운드 card: a running server's port links, an exit line ends it, none = no card", async ($, on) => {
  engine(on);
  mock.env(on, { HOME: "/Users/me" });
  on("session.cwd", () => ({ value: "/Users/me/toys" }));
  on("session.root", () => ({ value: "/Users/me/toys" }));
  on("session.repo", () => ({ value: null }));
  let msgs: unknown[] = [];
  on("session.messages", () => ({ value: msgs as never }));
  const files: Record<string, string> = {
    "/t/b1.output": "  VITE ready\n  ➜  Local:   http://localhost:5173/\n",
    "/t/b2.output": "ok\n[exited with code 0]\n",
  };
  on("fs.read", (_, e) => ({ value: files[e.path] ?? "" }));
  let copied = "";
  on("ui.copy", (_, e) => {
    copied = e.text;
    return { value: { isCopied: true } as never };
  });
  on("ui.toast", () => ({ value: undefined as never }));
  await start($);
  await call($, Q_TOOL, { action: "clear" }); // the start's refresh has landed

  let ui = await $.ui.mount(PANE);
  expect(await ui.find({ key: "card:bg" })).toBeUndefined(); // nothing ran: no card
  await ui.unmount();

  msgs = [
    {
      role: "assistant",
      text: "",
      toolUses: [
        bgUse("b1", "pnpm dev", "dev 서버"),
        bgUse("b2", "pnpm build", "빌드"),
      ],
    },
  ];
  await $.command.run({
    command: "pinboard", // /pinboard refreshes the snapshot
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 80 },
  });
  await call($, Q_TOOL, { action: "clear" });

  ui = await $.ui.mount(PANE);
  expect((await ui.find({ key: "card:bg" }))?.text).toContain("실행 1/2");
  const port = await ui.find({ type: "Link" });
  expect([port?.props.href, port?.children]).toEqual([
    "http://localhost:5173",
    ["localhost:5173"],
  ]);
  expect((await ui.find({ key: "cp:bg:b1" }))?.text).toBe("dev 서버");
  expect((await ui.find({ key: "cp:bg:b2" }))?.props.dimColor).toBe(true); // exited 0 = completed
  await ui.press({ key: "cp:bg:b1" });
  expect(copied).toBe("pnpm dev"); // press copies the command, not the label
  await ui.unmount();
});

// ---------- review fixes (R1~R5): each failed before its fix ----------

test("R1 a broken intent file empties the work card alone, not the whole pane", async ($, on) => {
  engine(on);
  mock.env(on, { HOME: "/Users/me" });
  on("session.cwd", () => ({ value: "/Users/me/toys" }));
  on("session.root", () => ({ value: "/Users/me/toys" }));
  on("session.repo", () => ({ value: null }));
  on("session.messages", () => ({ value: [] }));
  on("fs.read", () => ({ value: "{ broken" }));
  await start($);
  await call($, Q_TOOL, { action: "clear" }); // the start's refresh has landed

  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ text: /불러오는 중/ })).toBeUndefined();
  expect((await ui.find({ key: "cp:cwd" }))?.text).toBe("~/toys");
  expect((await ui.find({ key: "card:work" }))?.text).toContain("없음");
  await ui.unmount();
});

test("R2 pin tools called in parallel all land", async ($, on) => {
  engine(on);
  await start($);
  await Promise.all([
    call($, Q_TOOL, { action: "set", items: ["질문"] }),
    call($, NEXT_TOOL, { action: "set", items: ["다음"] }),
    call($, DOC_TOOL, { ref: "/r/a.md" }),
  ]);
  const band = await $.ui.mount(BAND);
  expect((await band.find({ key: "q:0" }))?.text).toBe("[ ] 1. 질문");
  await band.unmount();
  expect(
    (await call($, NEXT_TOOL, { action: "check", indexes: [1] })).text,
  ).toBe("pinned 1 item(s), 1 checked");
  expect((await call($, DOC_TOOL, { ref: "/r/b.md" })).text).toBe(
    "pinned /r/b.md; 2 doc(s) pinned",
  );
});

const say = (text: string) =>
  ({ role: "assistant", text, toolUses: [] }) as unknown as SessionMessage;

test("R3 PRs, Jira keys and links keep the most recent; the branch's key always stays", () => {
  const msgs = [
    say("https://github.com/o/r/pull/1 WEB-1 https://x.atlassian.net/wiki/1"),
    ...[2, 3, 4, 5, 6].map((n) =>
      say(
        `https://github.com/o/r/pull/${n} WEB-${n} https://x.atlassian.net/wiki/${n}`,
      ),
    ),
    say("https://github.com/o/r/pull/1 again"), // mentioned again: recent now
  ];
  const r = scan(msgs, "/repo", "feat/APP-9-x", KEYS);
  expect(r.prRefs).toEqual(["o/r#3", "o/r#4", "o/r#5", "o/r#6", "o/r#1"]);
  expect(r.jira).toEqual(["WEB-5", "WEB-6", "APP-9"]);
  expect(r.links.at(-1)).toBe("https://x.atlassian.net/wiki/6");
});

test("R4 Jira keys: the configured projects only; none configured, none picked", () => {
  const msgs = [
    say("GPT-4, CVE-2024-1234, ECMA-262, UTF-8 vs DATA-1476 · OPS-7 · PM-8"),
  ];
  expect(scan(msgs, "/repo", "main", KEYS).jira).toEqual([
    "DATA-1476",
    "OPS-7",
    "PM-8",
  ]);
  expect(scan(msgs, "/repo", "main").jira).toEqual([]);
  expect(jiraMatcher(" , 1A, a-b")).toBeNull(); // nothing a project key can be
});

test("R5 /clear starts the pins over; an in-app resume brings that session's back", async ($, on) => {
  // mod events only: a managed guard keeps classic.* (SessionStart) from user mods
  let sid = "s1";
  engine(
    on,
    { "pins:s2": [{ kind: "question", text: "s2 질문", isDone: false }] },
    () => sid,
  );
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  const switchTo = async (reason: "clear" | "resume", next: string) => {
    await $.session.end({
      reason,
      sessionId: sid,
      resume: { id: sid, sessionId: sid } as never,
    });
    sid = next;
    await $.turn.start({ text: "다음 프롬프트", turnId: `t-${next}` });
  };
  await start($);
  await call($, Q_TOOL, { action: "set", items: ["s1 질문"] });

  await switchTo("clear", "s3");
  let ui = await $.ui.mount(BAND);
  expect(await ui.find({ key: "q:0" })).toBeUndefined();
  await ui.unmount();

  await switchTo("resume", "s2");
  ui = await $.ui.mount(BAND);
  expect((await ui.find({ key: "q:0" }))?.text).toBe("[ ] 1. s2 질문");
  await ui.unmount();
});
