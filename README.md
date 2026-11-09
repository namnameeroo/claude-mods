# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): hooks modules that change its interface.

## pinboard

A session pinboard. The UI labels are in Korean.

- **Questions band**: when Claude asks you two or more questions in one reply, they stay above the prompt as a checklist. Press an item to check it; `접기`/`펼치기` (or `0` from an empty prompt) folds the list to its header; `/pin-clear` deletes it.
- **Pane**: the session's branch and folder, background tasks (with their ports), the work tree Claude records, next steps, PRs with CI and review state, Jira keys and links, pinned and touched docs, and a memo.
  - It opens by itself only in a fullscreen terminal wide enough to sit beside the chat (144 columns, or 110 once you have opened it with `/pinboard`). Anywhere else `/pinboard` opens it: on the main screen (tmux, `CLAUDE_CODE_NO_FLICKER=0`) it sits above the prompt, one row per section.
  - Its data (git, `gh pr view` for the PRs the session mentions) is refreshed after each turn and every minute, only while the pane is drawn. A merged or closed PR is not asked again.
- **Pinned docs**: pressing a local document (md, txt, pdf, html, images, json, csv, yaml) opens it with macOS `open`; anything else is only shown in Finder, never run. Elsewhere, or when `open` fails, it copies `open <path>`.

Requirements: macOS for opening pinned docs; a [Nerd Font](https://www.nerdfonts.com/) in your terminal for the icons; the `gh` CLI, signed in, for PR state (without it PRs do not show). Tested on Claude Code 2.1.319.

### What it asks of Claude

It adds four tools to every request of the main conversation (about 1k tokens of tool descriptions). They run without a permission prompt, refuse calls from subagents, and are not registered in headless runs (`claude -p`, the SDK).

- `record_intent`: Claude is asked to call it at the first work request of a session and when the task changes.
- `pin_questions`: when one reply asks you two or more questions.
- `pin_next_steps`: when Claude finishes a unit of work and suggests what comes next.
- `pin_doc`: when a doc becomes the session's reference (an absolute path or an http(s) URL only).

### What it keeps

- `~/.claude/intent/<session id>.json`: the work tree `record_intent` writes (your task descriptions, in plain text).
- The plugin's store, a JSON file under Claude Code's configuration folder: each session's pins and memo, so `--resume` brings them back.

Neither is cleaned up automatically; delete the files or uninstall the plugin when you no longer want them.

### Options

Set them when installing, or later in `/config`. All are empty by default.

| Option | What it does |
| --- | --- |
| `jiraBase` | Your Jira site, e.g. `https://your-team.atlassian.net`. Issue keys link there. |
| `jiraProjects` | Comma-separated project keys to pick up, e.g. `WEB,APP`. The Jira row needs both this and `jiraBase`. |
| `commands` | Comma-separated slash commands (without `/`) for the pane's toolbar, e.g. `review,commit`. |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pinboard --marketplace namnameeroo/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install pinboard --marketplace namnameeroo/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `namnameeroo/claude-mods`, then Add plugin.

Update with `claude plugin update pinboard@claude-mods` (restart Claude Code to apply); remove with `claude plugin uninstall pinboard@claude-mods`.

If nothing shows, start `claude --debug` and look for lines beginning `pinboard:`.

## Develop

```
claude --plugin-dir ./pinboard     # run a session with the mod loaded from this folder
claude plugin test ./pinboard      # run its tests
claude plugin validate ./pinboard
```

Disable an installed copy first: two plugins named `pinboard` would register the same tools. Type-checking (`tsc -p pinboard`) needs the engine's types, which Claude Code writes to `pinboard/.claude-plugin/types/` the first time it loads the folder with `--plugin-dir`.
