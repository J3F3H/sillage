import { ChildProcess, spawn } from "child_process";
import { promises as fsp, FSWatcher, watch as fsWatch } from "fs";
import { homedir } from "os";
import { join as pathJoin } from "path";
import {
  App,
  Editor,
  ItemView,
  MarkdownFileInfo,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Notice,
  parseYaml,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from "obsidian";

export const VIEW_TYPE_SILLAGE_CHAT = "sillage-chat-view";

interface VibeStreamMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: unknown;
  injected?: boolean;
  message_id?: string;
  name?: string | null;
}

interface VibeStreamingOptions {
  resumeSessionId?: string;
  onMessage: (m: VibeStreamMessage) => void;
  onProcess?: (p: ChildProcess) => void;
}

interface VibeStreamResult {
  stopReason?: string;
  turns: number;
  durationMs: number;
  sessionId: string | null;
  costUsd: number | null;
}

interface VibeTextResult {
  text: string;
  durationMs: number;
}

const VIBE_STOP_EVENT_RE = /<vibe_stop_event>(.*?)<\/vibe_stop_event>/;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem}s`;
}

type VibeAgent = "default" | "accept-edits" | "auto-approve";

interface SillageSettings {
  vibePath: string;
  agent: VibeAgent;
  maxTurns: number;
  maxPrice: number;
  timeoutSeconds: number;
  debug: boolean;
}

const DEFAULT_SETTINGS: SillageSettings = {
  vibePath: "vibe",
  agent: "accept-edits",
  maxTurns: 10,
  maxPrice: 0.5,
  timeoutSeconds: 120,
  debug: false,
};

interface VibeRunOptions {
  maxTurnsOverride?: number;
  onProcess?: (p: ChildProcess) => void;
}

interface DiscoveredSkill {
  name: string;
  description: string;
}

interface SessionInfo {
  sessionId: string;
  costUsd: number;
  totalMessages: number;
}

type PersistedChatEntry =
  | { kind: "bubble"; role: "user" | "assistant" | "error"; content: string; messageId?: string }
  | { kind: "tool"; label: string };

interface PersistedChatState {
  sessionId: string | null;
  entries: PersistedChatEntry[];
  seenMessageIds: string[];
  previousSessionCost?: number;
}

interface PluginData {
  settings?: Partial<SillageSettings>;
  chatState?: PersistedChatState;
}

export default class SillagePlugin extends Plugin {
  settings: SillageSettings = DEFAULT_SETTINGS;
  lastMarkdownView: MarkdownView | null = null;
  private activeProcesses = new Set<ChildProcess>();
  private knownSkillCommandIds = new Set<string>();
  private skillWatcher: FSWatcher | null = null;
  private rescanTimer: number | null = null;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_SILLAGE_CHAT, (leaf) => new SillageChatView(leaf, this));

    this.addRibbonIcon("wind", "Open Sillage chat", () => this.activateChatView());

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.activateChatView(),
    });

    this.addCommand({
      id: "summarize-current-note",
      name: "Summarize current note",
      editorCallback: (editor, view) => this.summarizeCurrentNote(editor, view),
    });

    this.addCommand({
      id: "extract-action-items",
      name: "Extract action items from current note",
      editorCallback: (editor, view) => this.extractActionItems(editor, view),
    });

    this.addCommand({
      id: "rewrite-selection",
      name: "Rewrite selection for clarity",
      editorCallback: (editor) => this.rewriteSelection(editor),
    });

    this.addCommand({
      id: "translate-selection-en",
      name: "Translate selection to English",
      editorCallback: (editor) => this.translateSelection(editor, "English"),
    });

    this.addCommand({
      id: "translate-selection-fr",
      name: "Translate selection to French",
      editorCallback: (editor) => this.translateSelection(editor, "French"),
    });

    this.addSettingTab(new SillageSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) =>
        this.addEditorMenuItems(menu, editor, view)
      )
    );

    this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.lastMarkdownView = leaf.view;
        }
      })
    );

    await this.registerSkillCommands();
    this.startSkillWatcher();
  }

  private addEditorMenuItems(menu: Menu, editor: Editor, view: MarkdownView | MarkdownFileInfo) {
    const hasSelection = !!editor.getSelection().trim();

    if (hasSelection) {
      menu.addItem((item) =>
        item
          .setTitle("Sillage: Rewrite selection")
          .setIcon("wind")
          .onClick(() => this.rewriteSelection(editor))
      );
      menu.addItem((item) =>
        item
          .setTitle("Sillage: Translate selection to English")
          .setIcon("wind")
          .onClick(() => this.translateSelection(editor, "English"))
      );
      menu.addItem((item) =>
        item
          .setTitle("Sillage: Translate selection to French")
          .setIcon("wind")
          .onClick(() => this.translateSelection(editor, "French"))
      );
    }

    if (view.file) {
      menu.addItem((item) =>
        item
          .setTitle("Sillage: Extract action items")
          .setIcon("wind")
          .onClick(() => this.extractActionItems(editor, view))
      );
      menu.addItem((item) =>
        item
          .setTitle("Sillage: Summarize note")
          .setIcon("wind")
          .onClick(() => this.summarizeCurrentNote(editor, view))
      );
    }
  }

  onunload() {
    if (this.skillWatcher) {
      this.skillWatcher.close();
      this.skillWatcher = null;
    }
    if (this.rescanTimer !== null) {
      window.clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    for (const proc of this.activeProcesses) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already dead
      }
    }
    this.activeProcesses.clear();
  }

  dlog(...args: unknown[]) {
    if (this.settings.debug) console.log(...args);
  }

  private trackProcess(proc: ChildProcess) {
    this.activeProcesses.add(proc);
    const cleanup = () => this.activeProcesses.delete(proc);
    proc.on("close", cleanup);
    proc.on("error", cleanup);
  }

  private async registerSkillCommands() {
    const skills = await this.discoverSkills();
    const newIds = new Set(skills.map((s) => `skill-${s.name}`));

    for (const oldId of this.knownSkillCommandIds) {
      if (!newIds.has(oldId)) this.removeCommandSafe(oldId);
    }
    this.knownSkillCommandIds = newIds;

    this.dlog(
      `[sillage] registered ${skills.length} user-invocable skills:`,
      skills.map((s) => s.name)
    );
    for (const skill of skills) {
      const display = skill.name
        .split("-")
        .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
        .join(" ");
      this.addCommand({
        id: `skill-${skill.name}`,
        name: display,
        callback: () => this.runSkillInChat(skill.name),
      });
    }
  }

  private removeCommandSafe(id: string) {
    const fullId = `${this.manifest.id}:${id}`;
    try {
      const commands = (this.app as unknown as {
        commands?: { removeCommand?: (id: string) => void };
      }).commands;
      commands?.removeCommand?.(fullId);
    } catch (err) {
      console.warn(`[sillage] could not remove command ${id}:`, err);
    }
  }

  private startSkillWatcher() {
    const base = (this.app.vault.adapter as unknown as { basePath: string }).basePath;
    const skillsDir = `${base}/.agents/skills`;
    try {
      this.skillWatcher = fsWatch(skillsDir, { recursive: true }, () =>
        this.scheduleSkillRescan()
      );
      this.skillWatcher.on("error", (err) => {
        console.warn("[sillage] skill watcher error:", err);
      });
      this.dlog(`[sillage] watching ${skillsDir} for skill changes`);
    } catch (err) {
      console.warn(
        `[sillage] could not watch ${skillsDir} (does it exist?):`,
        (err as Error).message
      );
    }
  }

  private scheduleSkillRescan() {
    if (this.rescanTimer !== null) window.clearTimeout(this.rescanTimer);
    this.rescanTimer = window.setTimeout(() => {
      this.rescanTimer = null;
      this.dlog("[sillage] rescanning skills…");
      this.registerSkillCommands().catch((err) =>
        console.warn("[sillage] rescan failed:", err)
      );
    }, 500);
  }

  private async discoverSkills(): Promise<DiscoveredSkill[]> {
    const skills: DiscoveredSkill[] = [];
    const dir = ".agents/skills";
    try {
      const exists = await this.app.vault.adapter.exists(dir);
      if (!exists) return skills;
      const listing = await this.app.vault.adapter.list(dir);
      for (const folder of listing.folders) {
        const skillPath = `${folder}/SKILL.md`;
        if (!(await this.app.vault.adapter.exists(skillPath))) continue;
        try {
          const content = await this.app.vault.adapter.read(skillPath);
          const fm = content.match(/^---\n([\s\S]*?)\n---/);
          if (!fm) continue;
          const parsed = parseYaml(fm[1]) as Record<string, unknown>;
          const name = String(parsed.name ?? "");
          if (!name) continue;
          if (parsed["user-invocable"] !== true) continue;
          skills.push({
            name,
            description: String(parsed.description ?? ""),
          });
        } catch (err) {
          console.warn(`[sillage] failed to parse ${skillPath}:`, err);
        }
      }
    } catch (err) {
      console.warn("[sillage] discoverSkills failed:", err);
    }
    return skills;
  }

  private async runSkillInChat(skillName: string) {
    const view = await this.activateChatView();
    if (!view) return;
    await view.runFresh(`Use the ${skillName} skill.`);
  }

  async activateChatView(): Promise<SillageChatView | null> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_SILLAGE_CHAT)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) {
        new Notice("Sillage: could not open chat panel");
        return null;
      }
      leaf = right;
      await leaf.setViewState({ type: VIEW_TYPE_SILLAGE_CHAT, active: true });
    }
    await workspace.revealLeaf(leaf);
    const view = leaf.view;
    return view instanceof SillageChatView ? view : null;
  }

  private async extractActionItems(editor: Editor, view: MarkdownView | MarkdownFileInfo) {
    if (!view.file) {
      new Notice("Sillage: no active file");
      return;
    }
    const noteContent = editor.getValue();
    if (!noteContent.trim()) {
      new Notice("Sillage: note is empty");
      return;
    }
    const cwd = (this.app.vault.adapter as unknown as { basePath: string }).basePath;
    const prompt =
      "Extract action items from the note below as Obsidian Tasks plugin syntax.\n\n" +
      "Rules:\n" +
      "- Only include actionable items the reader personally owns. Skip tasks assigned to other people.\n" +
      "- Format each item as `- [ ] <task>` on its own line.\n" +
      "- Add `📅 YYYY-MM-DD` ONLY if the source explicitly states a date. Never invent a due date.\n" +
      "- Add `#project/<kebab-name>` only if the project is unambiguous from the note.\n" +
      "- Leave priority empty unless the source explicitly signals urgency (⏫ high / 🔼 medium / 🔽 low).\n" +
      "- Output only the markdown list of tasks. No preamble, no heading, no commentary.\n" +
      "- If there are no actionable items for the reader, output exactly: NONE\n\n" +
      "---\n\n" +
      noteContent;
    const { result, cancelled, error } = await this.runVibeWithCancellableNotice(
      "Sillage: extracting action items…", prompt, cwd, { maxTurnsOverride: 1 }
    );
    if (cancelled) { new Notice("Sillage: cancelled"); return; }
    if (error || !result) { new Notice(`Sillage error: ${error?.message ?? "unknown"}`); return; }
    const trimmed = result.text.trim();
    if (!trimmed || trimmed === "NONE") {
      new Notice(`Sillage: no action items found (${formatDuration(result.durationMs)})`);
      return;
    }
    const block = `\n\n## Tasks\n${trimmed}\n`;
    editor.replaceRange(block, { line: editor.lastLine() + 1, ch: 0 });
    new Notice(`Sillage: action items appended (${formatDuration(result.durationMs)})`);
  }

  private async rewriteSelection(editor: Editor) {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice("Sillage: select some text first");
      return;
    }
    const cwd = (this.app.vault.adapter as unknown as { basePath: string }).basePath;
    const prompt =
      "Rewrite the following text for clarity and concision. Keep the same intent, voice, and meaning. " +
      "Output only the rewritten text, no preamble or commentary.\n\n---\n\n" +
      selection;
    const { result, cancelled, error } = await this.runVibeWithCancellableNotice(
      "Sillage: rewriting…", prompt, cwd, { maxTurnsOverride: 1 }
    );
    if (cancelled) { new Notice("Sillage: cancelled"); return; }
    if (error || !result) { new Notice(`Sillage error: ${error?.message ?? "unknown"}`); return; }
    const trimmed = result.text.trim();
    if (!trimmed) {
      new Notice("Sillage: empty result, selection unchanged");
      return;
    }
    editor.replaceSelection(trimmed);
    new Notice(`Sillage: selection rewritten (${formatDuration(result.durationMs)})`);
  }

  private async translateSelection(editor: Editor, targetLanguage: string) {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice("Sillage: select some text first");
      return;
    }
    const cwd = (this.app.vault.adapter as unknown as { basePath: string }).basePath;
    const prompt =
      `Translate the following text to ${targetLanguage}. ` +
      "Preserve markdown formatting (links, lists, code blocks). " +
      "Output only the translation, no preamble or commentary.\n\n---\n\n" +
      selection;
    const { result, cancelled, error } = await this.runVibeWithCancellableNotice(
      `Sillage: translating to ${targetLanguage}…`, prompt, cwd, { maxTurnsOverride: 1 }
    );
    if (cancelled) { new Notice("Sillage: cancelled"); return; }
    if (error || !result) { new Notice(`Sillage error: ${error?.message ?? "unknown"}`); return; }
    const trimmed = result.text.trim();
    if (!trimmed) {
      new Notice("Sillage: empty result, selection unchanged");
      return;
    }
    editor.replaceSelection(trimmed);
    new Notice(`Sillage: translated to ${targetLanguage} (${formatDuration(result.durationMs)})`);
  }

  private async runVibeWithCancellableNotice(
    noticeText: string,
    prompt: string,
    cwd: string,
    opts: VibeRunOptions = {}
  ): Promise<{ result: VibeTextResult | null; cancelled: boolean; error: Error | null }> {
    const state = { cancelled: false, proc: null as ChildProcess | null };
    const notice = new Notice(`${noticeText} (click to cancel)`, 0);
    notice.messageEl.addEventListener("click", () => {
      if (state.proc && !state.cancelled) {
        state.cancelled = true;
        const proc = state.proc;
        proc.kill("SIGTERM");
        window.setTimeout(() => proc.kill("SIGKILL"), 2000);
      }
    });
    try {
      const result = await this.runVibe(prompt, cwd, {
        ...opts,
        onProcess: (p) => {
          state.proc = p;
          opts.onProcess?.(p);
        },
      });
      notice.hide();
      return { result, cancelled: state.cancelled, error: null };
    } catch (err) {
      notice.hide();
      return { result: null, cancelled: state.cancelled, error: err as Error };
    }
  }

  private async summarizeCurrentNote(editor: Editor, view: MarkdownView | MarkdownFileInfo) {
    if (!view.file) {
      new Notice("Sillage: no active file");
      return;
    }
    const noteContent = editor.getValue();
    if (!noteContent.trim()) {
      new Notice("Sillage: note is empty");
      return;
    }
    const cwd = (this.app.vault.adapter as unknown as { basePath: string }).basePath;
    const prompt =
      "Summarize the following note in 3-5 concise bullet points. " +
      "Output only the bullets, no preamble or trailing commentary.\n\n---\n\n" +
      noteContent;
    const { result, cancelled, error } = await this.runVibeWithCancellableNotice(
      "Sillage: summarizing…", prompt, cwd, { maxTurnsOverride: 1 }
    );
    if (cancelled) { new Notice("Sillage: cancelled"); return; }
    if (error || !result) { new Notice(`Sillage error: ${error?.message ?? "unknown"}`); return; }
    const block = `\n\n## Summary\n${result.text.trim()}\n`;
    editor.replaceRange(block, { line: editor.lastLine() + 1, ch: 0 });
    new Notice(`Sillage: summary appended (${formatDuration(result.durationMs)})`);
  }

  private runVibe(prompt: string, cwd: string, opts: VibeRunOptions = {}): Promise<VibeTextResult> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const maxTurns = opts.maxTurnsOverride ?? this.settings.maxTurns;
      const args = [
        "--agent", this.settings.agent,
        "--trust",
        "--prompt", prompt,
        "--max-turns", String(maxTurns),
        "--max-price", String(this.settings.maxPrice),
        "--output", "text",
      ];
      const extraPaths = [
        `${homedir()}/.local/bin`,
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ];
      const env = {
        ...process.env,
        PATH: [process.env.PATH, ...extraPaths].filter(Boolean).join(":"),
      };
      this.dlog(
        `[sillage] spawning vibe path=${this.settings.vibePath} ` +
        `max-turns=${maxTurns} prompt-bytes=${prompt.length} cwd=${cwd}`
      );
      const proc = spawn(this.settings.vibePath, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.trackProcess(proc);
      opts.onProcess?.(proc);
      let stdout = "";
      let stderr = "";
      let settled = false;
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => {
        const chunk = d.toString();
        stderr += chunk;
        this.dlog("[sillage] vibe stderr:", chunk.trimEnd());
      });
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn(`[sillage] vibe timeout after ${this.settings.timeoutSeconds}s — killing`);
        proc.kill("SIGTERM");
        window.setTimeout(() => proc.kill("SIGKILL"), 2000);
        reject(new Error(`vibe timed out after ${this.settings.timeoutSeconds}s`));
      }, this.settings.timeoutSeconds * 1000);
      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (err.code === "ENOENT") {
          reject(new Error(
            `vibe binary not found (tried "${this.settings.vibePath}"). ` +
            `Set an absolute path in Sillage settings.`
          ));
          return;
        }
        reject(err);
      });
      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        const durationMs = Date.now() - startedAt;
        this.dlog(`[sillage] vibe exited code=${code}, stdout=${stdout.length}b, ${durationMs}ms`);
        if (code !== 0) {
          reject(new Error(`vibe exited ${code}: ${stderr.slice(0, 300).trim()}`));
          return;
        }
        resolve({ text: stdout, durationMs });
      });
    });
  }

  runVibeStreaming(prompt: string, cwd: string, opts: VibeStreamingOptions): Promise<VibeStreamResult> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let stopReason: string | undefined;
      let turns = 0;
      const args: string[] = ["--agent", this.settings.agent, "--trust"];
      if (opts.resumeSessionId) {
        args.push("--resume", opts.resumeSessionId);
      }
      args.push(
        "--prompt", prompt,
        "--max-turns", String(this.settings.maxTurns),
        "--max-price", String(this.settings.maxPrice),
        "--output", "streaming",
      );
      const extraPaths = [
        `${homedir()}/.local/bin`,
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ];
      const env = {
        ...process.env,
        PATH: [process.env.PATH, ...extraPaths].filter(Boolean).join(":"),
      };
      this.dlog(
        `[sillage] streaming vibe path=${this.settings.vibePath} ` +
        `resume=${opts.resumeSessionId ?? "none"} prompt-bytes=${prompt.length} cwd=${cwd}`
      );
      const proc = spawn(this.settings.vibePath, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.trackProcess(proc);
      opts.onProcess?.(proc);

      let stdoutBuf = "";
      let stderr = "";
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        fn();
      };

      proc.stdout!.on("data", (d) => {
        stdoutBuf += d.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as VibeStreamMessage;
            if (msg.role === "assistant" && !msg.injected) turns++;
            opts.onMessage(msg);
          } catch {
            console.warn("[sillage] failed to parse stream line:", line.slice(0, 200));
          }
        }
      });
      proc.stderr!.on("data", (d) => {
        const chunk = d.toString();
        stderr += chunk;
        const m = chunk.match(VIBE_STOP_EVENT_RE);
        if (m) stopReason = m[1];
        this.dlog("[sillage] vibe stderr:", chunk.trimEnd());
      });

      const timer = window.setTimeout(() => {
        settle(() => {
          console.warn(`[sillage] vibe stream timeout after ${this.settings.timeoutSeconds}s`);
          proc.kill("SIGTERM");
          window.setTimeout(() => proc.kill("SIGKILL"), 2000);
          reject(new Error(`vibe timed out after ${this.settings.timeoutSeconds}s`));
        });
      }, this.settings.timeoutSeconds * 1000);

      proc.on("error", (err: NodeJS.ErrnoException) => {
        settle(() => {
          if (err.code === "ENOENT") {
            reject(new Error(
              `vibe binary not found (tried "${this.settings.vibePath}"). ` +
              `Set an absolute path in Sillage settings.`
            ));
            return;
          }
          reject(err);
        });
      });

      proc.on("close", (code) => {
        settle(() => {
          const durationMs = Date.now() - startedAt;
          this.dlog(
            `[sillage] vibe stream exited code=${code} turns=${turns} ` +
            `${durationMs}ms stopReason=${stopReason ?? "none"}`
          );
          if (code !== null && code !== 0 && !stopReason) {
            reject(new Error(`vibe exited ${code}: ${stderr.slice(0, 300).trim()}`));
            return;
          }
          this.findRecentSessionForCwd(cwd, startedAt)
            .then((session) => {
              resolve({
                stopReason,
                turns,
                durationMs,
                sessionId: session?.sessionId ?? null,
                costUsd: session?.costUsd ?? null,
              });
            })
            .catch(() => {
              resolve({ stopReason, turns, durationMs, sessionId: null, costUsd: null });
            });
        });
      });
    });
  }

  private cachedData: PluginData = {};

  private vibeHomeDir(): string {
    return process.env.VIBE_HOME || pathJoin(homedir(), ".vibe");
  }

  private vibeSessionsDir(): string {
    return pathJoin(this.vibeHomeDir(), "logs", "session");
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    const sessionsDir = this.vibeSessionsDir();
    const shortId = sessionId.split("-")[0];
    try {
      const entries = await fsp.readdir(sessionsDir);
      for (const name of entries) {
        if (!name.startsWith("session_")) continue;
        if (!name.endsWith(`_${shortId}`)) continue;
        try {
          const raw = await fsp.readFile(pathJoin(sessionsDir, name, "meta.json"), "utf-8");
          const meta = JSON.parse(raw);
          if (meta?.session_id === sessionId) return true;
        } catch {
          // unreadable meta, treat as not-this-one
        }
      }
    } catch (err) {
      console.warn("[sillage] sessionExists scan failed:", err);
    }
    return false;
  }

  async findRecentSessionForCwd(cwd: string, sinceMs: number): Promise<SessionInfo | null> {
    const sessionsDir = this.vibeSessionsDir();
    try {
      const entries = await fsp.readdir(sessionsDir);
      const candidates: { dir: string; mtimeMs: number }[] = [];
      for (const name of entries) {
        if (!name.startsWith("session_")) continue;
        const dir = pathJoin(sessionsDir, name);
        try {
          const st = await fsp.stat(dir);
          if (st.mtimeMs < sinceMs - 2000) continue;
          candidates.push({ dir, mtimeMs: st.mtimeMs });
        } catch {
          // skip unreadable
        }
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const c of candidates) {
        try {
          const raw = await fsp.readFile(pathJoin(c.dir, "meta.json"), "utf-8");
          const meta = JSON.parse(raw);
          if (meta?.environment?.working_directory !== cwd) continue;
          return {
            sessionId: String(meta.session_id),
            costUsd: Number(meta.stats?.session_cost ?? 0),
            totalMessages: Number(meta.total_messages ?? 0),
          };
        } catch {
          // meta unreadable, try next
        }
      }
    } catch (err) {
      console.warn("[sillage] findRecentSessionForCwd failed:", err);
    }
    return null;
  }

  async loadSettings() {
    const raw = (await this.loadData()) as PluginData | (Partial<SillageSettings> & PluginData) | null;
    if (raw && typeof raw === "object" && ("settings" in raw || "chatState" in raw)) {
      this.cachedData = raw as PluginData;
    } else if (raw && typeof raw === "object") {
      this.cachedData = { settings: raw as Partial<SillageSettings> };
    } else {
      this.cachedData = {};
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, this.cachedData.settings ?? {});
  }

  async saveSettings() {
    this.cachedData.settings = this.settings;
    await this.saveData(this.cachedData);
  }

  getChatState(): PersistedChatState | null {
    return this.cachedData.chatState ?? null;
  }

  async saveChatState(state: PersistedChatState | null) {
    if (state === null) {
      delete this.cachedData.chatState;
    } else {
      this.cachedData.chatState = state;
    }
    await this.saveData(this.cachedData);
  }
}

class SillageSettingTab extends PluginSettingTab {
  plugin: SillagePlugin;

  constructor(app: App, plugin: SillagePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Sillage settings").setHeading();

    new Setting(containerEl)
      .setName("Vibe binary path")
      .setDesc("Path to the Mistral Vibe CLI. Bare `vibe` uses your PATH.")
      .addText((t) =>
        t
          .setPlaceholder("/usr/local/bin/vibe")
          .setValue(this.plugin.settings.vibePath)
          .onChange(async (v) => {
            this.plugin.settings.vibePath = v.trim() || "vibe";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Agent")
      .setDesc(
        "Vibe agent. accept-edits auto-approves file edits in the vault (safe default); " +
        "auto-approve also auto-approves bash / shell (needed for skills that commit, run scripts, etc.); " +
        "default prompts for everything — usable but every tool call would hang in programmatic mode."
      )
      .addDropdown((d) =>
        d
          .addOption("accept-edits", "accept-edits (recommended)")
          .addOption("auto-approve", "auto-approve (file edits + bash)")
          .addOption("default", "default (prompts everything — not usable for chat)")
          .setValue(this.plugin.settings.agent)
          .onChange(async (v) => {
            this.plugin.settings.agent = v as VibeAgent;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max turns")
      .setDesc("Maximum assistant turns per command.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxTurns)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.maxTurns = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Max price (USD)")
      .setDesc("Maximum cost in dollars per command.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxPrice)).onChange(async (v) => {
          const n = parseFloat(v);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.maxPrice = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Timeout (seconds)")
      .setDesc("Kill the vibe subprocess if it runs longer than this.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.timeoutSeconds)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.timeoutSeconds = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc(
        "Log subprocess lifecycle, vibe stderr, skill discovery, and watcher events to the DevTools console with the [sillage] prefix. Off in shipping builds."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debug).onChange(async (v) => {
          this.plugin.settings.debug = v;
          await this.plugin.saveSettings();
        })
      );
  }
}

class SillageChatView extends ItemView {
  plugin: SillagePlugin;
  private sessionId: string | null = null;
  private currentProc: ChildProcess | null = null;
  private cancelled = false;
  private seenMessageIds = new Set<string>();
  private entries: PersistedChatEntry[] = [];
  private previousSessionCost = 0;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: SillagePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_SILLAGE_CHAT;
  }
  getDisplayText() {
    return "Sillage chat";
  }
  getIcon() {
    return "wind";
  }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("sillage-chat-root");

    const header = root.createDiv({ cls: "sillage-chat-header" });
    header.createEl("h4", { text: "Sillage", cls: "sillage-chat-title" });
    const newBtn = header.createEl("button", {
      text: "New chat",
      cls: "sillage-new-btn",
    });
    newBtn.addEventListener("click", () => this.newSession());

    this.messagesEl = root.createDiv({ cls: "sillage-messages" });

    const inputWrap = root.createDiv({ cls: "sillage-input-wrap" });
    this.inputEl = inputWrap.createEl("textarea", {
      cls: "sillage-input",
      attr: { rows: "3", placeholder: "Ask vibe about your vault… (Cmd/Ctrl+Enter to send)" },
    });
    const buttonRow = inputWrap.createDiv({ cls: "sillage-button-row" });
    this.statusEl = buttonRow.createDiv({ cls: "sillage-status" });
    this.sendBtn = buttonRow.createEl("button", {
      text: "Send",
      cls: "mod-cta sillage-send-btn",
    });
    this.sendBtn.addEventListener("click", () => {
      if (this.currentProc) this.cancel();
      else this.send();
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.send();
      }
    });

    void this.restoreState();
  }

  private async restoreState() {
    const state = this.plugin.getChatState();
    if (!state) return;
    this.sessionId = state.sessionId ?? null;
    this.seenMessageIds = new Set(state.seenMessageIds ?? []);
    this.entries = [...(state.entries ?? [])];
    this.previousSessionCost = state.previousSessionCost ?? 0;
    for (const entry of this.entries) {
      if (entry.kind === "bubble") {
        this.renderBubble(entry.role, entry.content);
      } else {
        this.renderToolLabel(entry.label);
      }
    }
    if (this.sessionId) {
      const exists = await this.plugin.sessionExists(this.sessionId);
      if (exists) {
        this.statusEl.setText(`Resumed session ${this.sessionId.slice(0, 8)}…`);
      } else {
        this.plugin.dlog(`[sillage] persisted session ${this.sessionId} aged out`);
        this.sessionId = null;
        this.persistState();
        this.statusEl.setText("Previous session aged out — next send will start fresh.");
      }
    }
  }

  private persistState() {
    void this.plugin.saveChatState({
      sessionId: this.sessionId,
      entries: this.entries,
      seenMessageIds: Array.from(this.seenMessageIds),
      previousSessionCost: this.previousSessionCost,
    });
  }

  async onClose() {
    if (this.currentProc) {
      this.currentProc.kill("SIGTERM");
      this.currentProc = null;
    }
  }

  private newSession() {
    if (this.currentProc) {
      this.currentProc.kill("SIGTERM");
      this.currentProc = null;
    }
    this.sessionId = null;
    this.seenMessageIds.clear();
    this.entries = [];
    this.previousSessionCost = 0;
    this.messagesEl.empty();
    this.statusEl.setText("");
    this.setRunning(false);
    this.persistState();
  }

  private appendBubble(
    role: "user" | "assistant" | "error",
    content: string,
    messageId?: string
  ) {
    this.renderBubble(role, content);
    this.entries.push({ kind: "bubble", role, content, messageId });
    this.persistState();
  }

  private renderBubble(role: "user" | "assistant" | "error", content: string) {
    const el = this.messagesEl.createDiv({ cls: `sillage-msg sillage-msg-${role}` });
    el.createDiv({ cls: "sillage-msg-role", text: role });
    const body = el.createDiv({ cls: "sillage-msg-body" });
    if (role === "assistant") {
      MarkdownRenderer.render(this.plugin.app, content, body, "", this.plugin);
      const footer = el.createDiv({ cls: "sillage-msg-footer" });
      const insertBtn = footer.createEl("button", { text: "Insert", cls: "sillage-insert-btn" });
      insertBtn.addEventListener("click", () => this.insertIntoActiveNote(content));
      const copyBtn = footer.createEl("button", { text: "Copy", cls: "sillage-copy-btn" });
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(content);
        new Notice("Sillage: copied");
      });
    } else {
      body.setText(content);
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private insertIntoActiveNote(content: string) {
    const view = this.resolveMarkdownView();
    if (!view) {
      new Notice("Sillage: no open note to insert into");
      return;
    }
    view.editor.replaceSelection(content);
    new Notice("Sillage: inserted");
  }

  private resolveMarkdownView(): MarkdownView | null {
    const active = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;

    const tracked = this.plugin.lastMarkdownView;
    if (tracked && tracked.file) return tracked;

    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView) return leaf.view;
    }
    return null;
  }

  private appendToolCall(tc: unknown) {
    const obj = tc as Record<string, unknown>;
    const fn = (obj?.function ?? obj) as Record<string, unknown>;
    const name = (fn?.name as string) ?? "tool";
    let argStr = "";
    try {
      const raw = fn?.arguments;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === "object") {
        const keys = Object.keys(parsed);
        if (keys.length) {
          const first = (parsed as Record<string, unknown>)[keys[0]];
          argStr =
            typeof first === "string"
              ? ` ${first}`
              : ` ${JSON.stringify(first).slice(0, 60)}`;
        }
      }
    } catch {
      // best-effort display
    }
    const label = `→ ${name}${argStr}`;
    this.renderToolLabel(label);
    this.entries.push({ kind: "tool", label });
    this.persistState();
  }

  private renderToolLabel(label: string) {
    const el = this.messagesEl.createDiv({ cls: "sillage-tool-call" });
    el.setText(label);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  async runFresh(prompt: string) {
    this.newSession();
    await this.sendPromptText(prompt);
  }

  private async send() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    await this.sendPromptText(text);
  }

  private async sendPromptText(text: string) {
    if (this.currentProc) return;

    this.appendBubble("user", text);
    this.statusEl.setText("Thinking…");
    this.cancelled = false;
    this.setRunning(true);

    const cwd = (this.plugin.app.vault.adapter as unknown as { basePath: string }).basePath;
    let resumeId = this.sessionId ?? undefined;
    if (resumeId && !(await this.plugin.sessionExists(resumeId))) {
      this.plugin.dlog(`[sillage] session ${resumeId} aged out — starting fresh`);
      new Notice("Sillage: previous session aged out, starting fresh (vibe loses prior context)");
      this.sessionId = null;
      this.persistState();
      resumeId = undefined;
    }
    try {
      const result = await this.plugin.runVibeStreaming(text, cwd, {
        resumeSessionId: resumeId,
        onProcess: (p) => {
          this.currentProc = p;
        },
        onMessage: (msg) => {
          if (msg.role !== "assistant") return;
          if (msg.injected) return;
          if (msg.message_id && this.seenMessageIds.has(msg.message_id)) return;
          if (msg.message_id) this.seenMessageIds.add(msg.message_id);
          if (Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) this.appendToolCall(tc);
          }
          if (msg.content) this.appendBubble("assistant", msg.content, msg.message_id);
        },
      });
      if (result.sessionId) this.sessionId = result.sessionId;
      let turnCost: number | null = null;
      if (result.costUsd !== null) {
        turnCost = Math.max(0, result.costUsd - this.previousSessionCost);
        this.previousSessionCost = result.costUsd;
      }
      const parts = [
        `${result.turns} turn${result.turns === 1 ? "" : "s"}`,
        formatDuration(result.durationMs),
      ];
      if (turnCost !== null && turnCost > 0) {
        parts.push(`$${turnCost.toFixed(4)}`);
      }
      const telemetry = parts.join(" · ");
      if (this.cancelled) {
        this.statusEl.setText(`Cancelled (${telemetry}).`);
      } else if (result.stopReason) {
        this.statusEl.setText(
          `Stopped: ${result.stopReason} (${telemetry}). Send again or "New chat".`
        );
      } else {
        this.statusEl.setText(telemetry);
      }
      this.persistState();
    } catch (err) {
      if (this.cancelled) {
        this.statusEl.setText("Cancelled.");
      } else {
        this.appendBubble("error", (err as Error).message);
        this.statusEl.setText("");
      }
    } finally {
      this.currentProc = null;
      this.setRunning(false);
    }
  }

  private cancel() {
    if (!this.currentProc) return;
    this.cancelled = true;
    this.statusEl.setText("Cancelling…");
    this.currentProc.kill("SIGTERM");
    const proc = this.currentProc;
    window.setTimeout(() => proc.kill("SIGKILL"), 2000);
  }

  private setRunning(running: boolean) {
    this.sendBtn.setText(running ? "Stop" : "Send");
    if (running) {
      this.sendBtn.removeClass("mod-cta");
      this.sendBtn.addClass("mod-warning");
    } else {
      this.sendBtn.removeClass("mod-warning");
      this.sendBtn.addClass("mod-cta");
    }
  }
}
