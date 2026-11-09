// ponytail: no "link" kind — pin_doc takes URLs too, other links are auto-detected
export type Pin = {
  kind: "question" | "next" | "doc" | "note";
  text: string;
  ref?: string;
  isDone?: boolean;
};

export type PinInput = {
  action: "set" | "check" | "uncheck" | "clear";
  items?: string[];
  indexes?: number[];
};

export type DocInput = { ref: string; title?: string; remove?: boolean };

// ~/.claude/intent/<sid>.json: what record_intent writes and the work card reads
export type IntentInput = {
  label: string;
  what?: string;
  why?: string;
  scope_in?: string[];
  scope_out?: string[];
  constraints?: string[];
  reason?: string;
  relation?: "sub" | "sibling" | "new";
};
export type IntentCurrent = {
  ts: string;
  label: string;
  what: string;
  why: string;
  scope_in: string[];
  scope_out: string[];
  constraints: string[];
};
export type IntentHistory = {
  ts: string;
  label: string;
  reason: string;
  parent?: string | null; // ts of the entry it refines; null = a new topic
};
export type IntentRecord = {
  session_id: string;
  initial: IntentCurrent;
  current: IntentCurrent;
  history: IntentHistory[];
};

export type Pr = {
  number: number;
  title: string;
  state: "OPEN" | "DRAFT" | "MERGED" | "CLOSED";
  review: string;
  checks: string;
  comments: number;
  url: string;
};
// one row of the topic tree: `pre` is its drawn rail ("● ", "  ├ ", "    └ "…)
export type Node = {
  pre: string;
  label: string;
  ts: string;
  isCurrent: boolean;
};
export type Doc = {
  path: string;
  kind: "new" | "ref";
  tag: "tmp" | "repo" | "out";
};
// a Bash the session ran with run_in_background (a dev server, a watcher…)
export type Bg = {
  id: string; // the task id, as its notification names it
  label: string; // the call's description, else the command's first line
  command: string;
  status: string; // "running", else the notification's: completed | failed | killed
  out: string; // the output file
  port?: number; // a running one's, from its output or command
};

export type Snap = {
  cwd: string;
  sid: string;
  branch: string;
  worktree: string;
  prs: Pr[];
  jira: string[];
  links: string[];
  tree: Node[];
  prompts: string[];
  docs: Doc[];
  bg: Bg[];
  at: number;
};

declare module "claude-code" {
  interface PluginState {
    pinboard: {
      pins: Shaped<Pin[]>;
      snap: Shaped<Snap | null>;
      history: boolean;
      folded: boolean; // the questions band shows its header alone
      memo: boolean; // an inline pane shows the memo
    };
  }
}
