# Sillage

Mistral Vibe integration for Obsidian. Drives the `vibe` CLI as a subprocess to add chat and predefined tasks to your vault.

Desktop only. The plugin spawns `vibe`, so Obsidian mobile is out of scope.

## Requirements

- [Mistral Vibe CLI](https://docs.mistral.ai/mistral-vibe/introduction) installed and authenticated (`vibe --setup`)
- Obsidian 1.5.0+ (desktop)

## Install (manual)

Sillage is not in the community plugins store. Install by copy or symlink:

```sh
git clone https://github.com/J3F3H/sillage.git
cd sillage
npm install
npm run build

# point your vault at the build
ln -s "$PWD" "/path/to/your/vault/.obsidian/plugins/sillage"
```

Then in Obsidian: Settings → Community plugins → enable **Sillage**.

## Features

- **Chat panel** — sidebar view that streams `vibe --output streaming` responses. Markdown-rendered, with tool-call visibility, Insert/Copy on each assistant bubble, and a Stop button to cancel runs.
- **Note commands** — Summarize, Extract action items (Obsidian Tasks plugin syntax), Rewrite selection, Translate selection (EN/FR).
- **Skill auto-discovery** — any `user-invocable: true` skill under `<vault>/.agents/skills/` is registered as a command. An `fs.watch` re-scans automatically when you add, edit, or remove skills.
- **Persisted chat + safe session resume** — chat history and `session_id` survive Obsidian reloads. Subsequent turns use `vibe --resume <id>` so a terminal session can't accidentally collide. If a session is aged out of `~/.vibe/logs/session/`, Sillage falls back to a fresh session and tells you.
- **Cost / turn / duration telemetry** — pulled from vibe's per-session `meta.json`, shown in the chat status line after each turn.
- **Editor context menu** — right-click in any note for inline Sillage commands.

## Commands

| Command                              | Default hotkey  | Notes                            |
|---                                   |---              |---                               |
| Open chat                            | Mod+Shift+L     | Opens the sidebar panel          |
| Summarize current note               | —               | Appends `## Summary`             |
| Extract action items from current note | —             | Appends `## Tasks` in Tasks-plugin syntax |
| Rewrite selection for clarity        | —               | Replaces selection               |
| Translate selection to English       | —               |                                  |
| Translate selection to French        | —               |                                  |
| _Skill-discovered commands_          | —               | One per `.agents/skills/*/SKILL.md` with `user-invocable: true` |

All commands are assignable in Settings → Hotkeys.

## Settings

- **Vibe binary path** — defaults to `vibe` (uses PATH). Set to an absolute path if Obsidian can't find it (common on macOS where `~/.local/bin` isn't on Obsidian's PATH).
- **Agent** — which vibe agent to run with. See **Security** below. Default: `accept-edits`.
- **Max turns** — agent loop cap per send (default 10). Note commands hard-cap to 1.
- **Max price (USD)** — per-send cost cap (default $0.50).
- **Timeout (seconds)** — kill the vibe subprocess if it runs longer (default 120s).

## Security

Sillage drives `vibe` with `--trust` (so vibe doesn't prompt to trust the vault each run) and an **Agent** setting that controls how much of vibe's tool use is auto-approved:

| Agent           | Auto-approves                          | Use when                                   |
|---              |---                                     |---                                         |
| `accept-edits`  | File reads/writes inside the workdir   | Default. Note commands and most chat.      |
| `auto-approve`  | All tools, **including bash / shell**  | You're running a skill you trust that needs to run scripts or `git commit` (e.g. `organize-daily` if it commits). |
| `default`       | Nothing — every tool call prompts      | Effectively unusable in programmatic mode; included for completeness. |

**Use `auto-approve` deliberately.** Every chat send and every user-invocable skill discovered under `.agents/skills/` will run with the configured agent. With `auto-approve`, vibe can execute arbitrary shell commands without confirmation — only enable it for skills you have read and trust.

## Development

```sh
npm install
npm run dev   # esbuild watch
npm run build # tsc check + production bundle
```

Symlink the project dir into a test vault's `.obsidian/plugins/sillage/`. Reload the plugin in Obsidian after each rebuild.

DevTools (Cmd/Ctrl+Opt+I) is the debugging surface — Sillage logs subprocess lifecycle, vibe stderr, skill discovery, and watcher events with the `[sillage]` prefix.

## Releases

Tag-push triggers `.github/workflows/release.yml`, which builds and creates a draft GitHub release with `main.js`, `manifest.json`, and `styles.css` attached.

```sh
# bump manifest.json and package.json versions, then:
git tag 0.2.0
git push origin 0.2.0
# review the draft on GitHub, edit notes, publish
```

## License

MIT — see [LICENSE](LICENSE).
