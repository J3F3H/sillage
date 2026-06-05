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
- **Skill auto-discovery** — any `user-invocable: true` skill under `<vault>/.agents/skills/` is registered as a command. Obsidian vault events trigger a rescan when you add, edit, or remove skills; run **Reload skills** from the command palette if your vault doesn't index `.agents/`.
- **Persisted chat + safe session resume** — chat history and `session_id` survive Obsidian reloads. Subsequent turns use `vibe --resume <id>` so a terminal session can't accidentally collide. If a session is aged out of `~/.vibe/logs/session/`, Sillage falls back to a fresh session and tells you.
- **Cost / turn / duration telemetry** — pulled from vibe's per-session `meta.json`, shown in the chat status line after each turn.
- **Editor context menu** — right-click in any note for inline Sillage commands.

## Commands

| Command                                | Notes                                                      |
|---                                     |---                                                         |
| Open chat                              | Opens the sidebar panel                                    |
| Summarize current note                 | Appends `## Summary`                                       |
| Extract action items from current note | Appends `## Tasks` in Tasks-plugin syntax                  |
| Rewrite selection for clarity          | Replaces selection                                         |
| Translate selection to English         |                                                            |
| Translate selection to French          |                                                            |
| Reload skills                          | Force a rescan of `.agents/skills/` (fallback if vault events don't fire)  |
| _Skill-discovered commands_            | One per `.agents/skills/*/SKILL.md` with `user-invocable: true` |

Sillage ships with no default hotkeys to avoid conflicts. Assign keys in Settings → Hotkeys.

## Settings

- **Vibe binary path** — defaults to `vibe` (uses PATH). Set to an absolute path if Obsidian can't find it (common on macOS where `~/.local/bin` isn't on Obsidian's PATH).
- **Agent** — which vibe agent to run with. See **Security** below. Default: `accept-edits`.
- **Max turns** — agent loop cap per send (default 10). Note commands hard-cap to 1.
- **Max price (USD)** — per-send cost cap (default $0.50).
- **Timeout (seconds)** — kill the vibe subprocess if it runs longer (default 120s).
- **Debug logging** — when on, prints subprocess lifecycle, vibe stderr, skill discovery, and watcher events to the DevTools console with the `[sillage]` prefix. Off by default.

## Security

Sillage drives `vibe` with `--trust` (so vibe doesn't prompt to trust the vault each run) and an **Agent** setting that controls how much of vibe's tool use is auto-approved:

| Agent           | Auto-approves                          | Use when                                   |
|---              |---                                     |---                                         |
| `accept-edits`  | File reads/writes inside the workdir   | Default. Note commands and most chat.      |
| `auto-approve`  | All tools, **including bash / shell**  | You're running a skill you trust that needs to run scripts or `git commit` (e.g. `organize-daily` if it commits). |
| `default`       | Nothing — every tool call prompts      | Effectively unusable in programmatic mode; included for completeness. |

**Use `auto-approve` deliberately.** Every chat send and every user-invocable skill discovered under `.agents/skills/` will run with the configured agent. With `auto-approve`, vibe can execute arbitrary shell commands without confirmation — only enable it for skills you have read and trust.

## Host access (Obsidian review disclosures)

Sillage's integration with the `vibe` CLI requires capabilities beyond the standard Obsidian plugin sandbox. The full list:

- **Shell execution (`child_process.spawn`).** Sillage spawns the user-configured `vibe` binary as a subprocess. The argv is built from settings and the user's prompt; the prompt is passed as a single `--prompt` argument and is never interpolated into a shell command line. See [How Sillage runs vibe](#how-sillage-runs-vibe) for the exact arguments and environment. No other binary is ever launched.
- **Filesystem access outside the vault (`fs.promises`).** Sillage reads (never writes) `$VIBE_HOME/logs/session/*/meta.json` — defaults to `~/.vibe/logs/session/` — to recover the most recent `session_id` and per-session cost after a chat send. This is the only filesystem path outside the vault that Sillage touches. All in-vault file access goes through the Obsidian vault API.
- **Clipboard write (`navigator.clipboard.writeText`).** The "Copy" button on each assistant chat bubble writes that bubble's text to the system clipboard. It only fires from an explicit user click and only copies content already visible in the chat panel.

Sillage does not open network connections, install or update binaries, modify host configuration, or read the clipboard.

## Privacy / data flow

Sillage runs locally and never opens its own network connection. But every command shells out to `vibe`, and **`vibe` sends the prompt (and any tool-read file content) to Mistral's API**. Concretely:

- Note commands (Summarize, Extract action items, Rewrite, Translate): the **entire active note or selection** is sent as part of the prompt.
- Chat: each message you type is sent, and any file `vibe` reads via its tools is sent as tool output.
- Skill commands: whatever the skill reads or includes ends up in the prompt.

If you keep secrets in your vault (credentials, private journals), be deliberate about which commands you run on which notes. The `Max price` setting caps cost; it does not cap what data is shared.

Session metadata and full transcripts are also written locally to `$VIBE_HOME/logs/session/` by vibe itself (defaults to `~/.vibe/logs/session/`). Sillage reads from this directory to capture `session_id` and cost; it does not write there.

## How Sillage runs vibe

Sillage invokes `vibe` via Node's `child_process.spawn`. The argv is deterministic and never includes shell metacharacters from note content — the prompt is passed as a single `--prompt` argument, not through a shell.

**Flags always passed:**
- `--agent <setting value>` — see [Security](#security).
- `--trust` — skips vibe's per-invocation "trust this folder?" prompt. The vault is implicitly trusted by being open in Obsidian.
- `--max-turns N`, `--max-price $D` — agent loop and cost caps from settings.
- `--output text` for one-shot note commands; `--output streaming` (NDJSON, one JSON message per line) for chat.
- `--prompt "<text>"` — the prompt body, including your note or selection content.
- `--resume <session_id>` for chat continuation when a prior session is still on disk; absent on the first turn or when the prior session has aged out.

**Subprocess behavior:**
- `cwd` is the vault root, so vibe's file tools resolve to vault paths.
- `stdio: ["ignore", "pipe", "pipe"]` — stdin is closed (vibe hangs indefinitely if left open in `--prompt` mode).
- `env` inherits the user's environment, with `PATH` augmented to include `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` so a bare `vibe` resolves on macOS even when Obsidian launches without a login-shell PATH.
- Every spawned process is tracked; `onunload` sends `SIGTERM` to any still running, then `SIGKILL` 2 seconds later.
- A per-send timeout (configurable, default 120s) kills the process if it doesn't exit on its own.

**What Sillage does NOT do:**
- No network connections of its own. All network traffic originates from `vibe`.
- No telemetry collection or reporting.
- No writes to `$VIBE_HOME` or vibe's config. It only reads `$VIBE_HOME/logs/session/*/meta.json` for `session_id` and cost.
- No auto-update. Releases are tag-driven (see [Releases](#releases)).

If `vibe` is missing (`ENOENT`), the user gets a Notice naming the configured path and pointing to settings. Non-zero exits with an unrecognized stop event surface as error bubbles in chat or error notices for note commands.

## Development

```sh
npm install
npm run dev   # esbuild watch
npm run build # tsc check + production bundle
```

Symlink the project dir into a test vault's `.obsidian/plugins/sillage/`. Reload the plugin in Obsidian after each rebuild.

DevTools (Cmd/Ctrl+Opt+I) is the debugging surface — Sillage logs subprocess lifecycle, vibe stderr, skill discovery, and watcher events with the `[sillage]` prefix.

## Known limitations

- **Desktop only.** Plugin spawns a subprocess; Obsidian mobile doesn't allow that.
- **Skill hot-reload depends on Obsidian indexing `.agents/`.** Some vault configurations skip dotfolders, in which case vault events won't fire for `.agents/skills/*/SKILL.md`. Run **Reload skills** from the command palette after editing skills to force a rescan.
- **`session_id` is captured by scanning `$VIBE_HOME/logs/session/`.** If a session ages out of that directory between runs, Sillage falls back to a fresh `vibe` session (your visible chat history is preserved, but vibe loses its memory of the prior turns).
- **Cost telemetry is per-turn, computed as a delta** from vibe's cumulative `session_cost`. If you mix `vibe --resume` from a terminal with the chat panel, the delta can briefly look wrong on the next turn.

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
