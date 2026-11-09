# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): hooks modules that change its interface.

## pinboard

A session pinboard. The UI labels are in Korean.

- **Questions band**: when Claude asks you two or more questions in one reply, they stay above the prompt as a checklist. Press an item to check it; `접기`/`펼치기` (or `0` from an empty prompt) folds the list to its header; `/pin-clear` empties it.
- **Pane**: the session's branch and folder, background tasks (with their ports), the work tree Claude records, next steps, PRs with CI and review state, Jira keys and links, pinned and touched docs, and a memo. It opens beside the chat in a wide fullscreen terminal (144 columns and up), or with `/pinboard` at any width. Where the terminal is narrow it sits above the prompt as one row per section.
- **Tools it gives Claude**: `pin_questions`, `pin_next_steps`, `pin_doc` and `record_intent`. `record_intent` writes the session's work tree to `~/.claude/intent/<session id>.json`.

Requirements: a [Nerd Font](https://www.nerdfonts.com/) in your terminal for the icons; the `gh` CLI, signed in, for PR state. Pressing a pinned local doc runs macOS `open`; elsewhere it copies `open <path>` instead.

### Options

Set them when installing, or later in `/config`. All are empty by default.

| Option | What it does |
| --- | --- |
| `jiraBase` | Your Jira site, e.g. `https://your-team.atlassian.net`. Issue keys link there. |
| `jiraProjects` | Comma-separated project keys to pick up, e.g. `WEB,APP`. Needs `jiraBase`. |
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

## Develop

```
claude --plugin-dir ./pinboard     # run a session with the mod loaded from this folder
claude plugin test ./pinboard      # run its tests
claude plugin validate ./pinboard
```
