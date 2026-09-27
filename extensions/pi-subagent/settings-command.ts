import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  parsePresetSettings, readPresetSettingsSnapshot, THINKING_LEVELS, validatePresetSelection,
  type PresetSettings, type SettingsSnapshot,
} from "./config.ts";
import { PRESET_NAMES, type Preset, type Thinking } from "./shared.ts";

// A short synchronous transaction serializes commands across Pi processes. Never
// hold a lock while waiting for UI, and never reclaim another process's lock.
export function savePresetSettings(snapshot: SettingsSnapshot, preset: Preset, override: {
  provider: string; model: string; thinking: Thinking;
}): void {
  const settings: PresetSettings = {
    ...snapshot.settings, presets: { ...snapshot.settings.presets, [preset]: override },
  };
  parsePresetSettings(settings);
  const path = snapshot.path;
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch { throw new Error("Subagent settings are locked or not writable. Retry after checking the settings file and its .lock file."); }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  const checkUnchanged = () => {
    let current: string | null = null;
    try {
      if (!lstatSync(path).isFile()) throw new Error("not a regular file");
      current = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Subagent settings must be a readable regular file, not a symlink or directory.");
      }
    }
    if (current !== snapshot.text) throw new Error("Subagent settings changed while the dialog was open. Reopen /pi-subagent-settings.");
  };
  try {
    checkUnchanged();
    const descriptor = openSync(temporary, "wx", 0o600);
    temporaryCreated = true;
    try { writeFileSync(descriptor, `${JSON.stringify(settings, null, 2)}\n`, "utf8"); }
    finally { closeSync(descriptor); }
    checkUnchanged();
    renameSync(temporary, path);
    temporaryCreated = false;
  } finally {
    try { if (temporaryCreated) unlinkSync(temporary); }
    finally { closeSync(lock); unlinkSync(lockPath); }
  }
}

export async function configureSubagentSettings(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/pi-subagent-settings requires an interactive UI; edit pi-subagent.json instead.", "warning");
    return;
  }
  try {
    const snapshot = await readPresetSettingsSnapshot();
    const current = parsePresetSettings(snapshot.settings);
    const presetLabels = PRESET_NAMES.map((name) => `${name}: ${current[name].model} (${current[name].thinking})`);
    const presetLabel = await ctx.ui.select("Subagent defaults — select a preset", presetLabels);
    const preset = PRESET_NAMES[presetLabels.indexOf(presetLabel ?? "")];
    if (!preset) return;

    // List registered models, not only authenticated ones; saving never contacts
    // a provider. Parent-only extension providers may still fail in the child.
    const models = ctx.modelRegistry.getAll().filter((model) => {
      try {
        parsePresetSettings({ presets: { [preset]: { provider: model.provider, model: model.id } } });
        return true;
      } catch { return false; }
    }).sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
    const labels = models.map((model) => `${model.provider}/${model.id}`);
    if (!labels.length) {
      ctx.ui.notify("No registered models can be configured for subagents.", "warning");
      return;
    }
    const label = await ctx.ui.select(`Model — current: ${current[preset].model}`, labels);
    const model = models[labels.indexOf(label ?? "")];
    if (!model) return;
    const levels = getSupportedThinkingLevels(model).filter((level) => THINKING_LEVELS.includes(level));
    const thinking = await ctx.ui.select(`Thinking — current: ${current[preset].thinking}`, levels);
    if (!thinking || !levels.includes(thinking as Thinking)) return;
    const selection = { model: `${model.provider}/${model.id}`, thinking: thinking as Thinking };
    validatePresetSelection(selection, ctx.modelRegistry);
    if (!await ctx.ui.confirm("Save subagent defaults?", [
      preset,
      `Before: ${current[preset].model} (${current[preset].thinking})`,
      `After: ${selection.model} (${selection.thinking})`,
      `File: ${snapshot.path}`,
      "Applies to future subagent calls across sessions, not the parent or running children.",
      "Provider access and child availability are not guaranteed; future calls may incur provider charges.",
    ].join("\n"))) return;
    // Registry metadata can change while the confirmation dialog is open.
    validatePresetSelection(selection, ctx.modelRegistry);
    savePresetSettings(snapshot, preset, { provider: model.provider, model: model.id, thinking: selection.thinking });
    ctx.ui.notify("Subagent defaults saved. They apply to the next call; no reload is needed.", "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : "Could not save subagent settings.", "error");
  }
}

export function registerSubagentSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("pi-subagent-settings", {
    description: "Configure persistent per-preset subagent model and thinking defaults",
    handler: async (_args, ctx) => configureSubagentSettings(ctx),
  });
}
