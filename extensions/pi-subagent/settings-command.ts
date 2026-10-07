import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  isValidProviderModel, parsePresetSettings, readPresetSettingsSnapshot, THINKING_LEVELS, validatePresetSelection,
  type PresetSettings, type SettingsSnapshot,
} from "./config.ts";
import { PRESET_NAMES, type Preset, type Thinking } from "./shared.ts";
import { pickSetting } from "./settings-picker.ts";

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
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("/pi-subagent-settings requires TUI mode; edit pi-subagent.json instead.", "warning");
    return;
  }
  try {
    const snapshot = await readPresetSettingsSnapshot();
    const current = parsePresetSettings(snapshot.settings);
    // Availability is Pi's local authentication view, not a live access probe.
    const models = ctx.modelRegistry.getAvailable()
      .filter((model) => isValidProviderModel(model.provider, model.id))
      .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
    if (!models.length) {
      ctx.ui.notify("No available models. Authenticate a provider in Pi or edit pi-subagent.json for a registered model.", "warning");
      return;
    }
    let stage = 0;
    let preset: Preset = PRESET_NAMES[0];
    let provider: string | undefined;
    let model = models[0];
    let thinking: Thinking = "off";
    while (true) {
      if (stage === 0) {
        const value = await pickSetting(ctx, {
          title: "Subagent defaults · Preset · 1/5", context: "Choose the default to configure",
          selected: preset,
          items: PRESET_NAMES.map((name) => ({ value: name, label: name, description: `${current[name].model} (${current[name].thinking})` })),
        });
        if (value == null) return;
        if (preset !== value) provider = undefined;
        preset = value as Preset;
      } else if (stage === 1) {
        const value = await pickSetting(ctx, {
          title: "Subagent defaults · Provider · 2/5", context: `${preset} · Current: ${current[preset].model}`,
          current: current[preset].model.split("/")[0], selected: provider,
          items: [...new Set(models.map((m) => m.provider))].map((name) => ({ value: name, label: name,
            description: "Authentication detected; model access and child availability are not guaranteed." })),
        });
        if (value === null) return;
        if (value === undefined) { stage--; continue; }
        if (provider !== value) {
          provider = value;
          model = models.find((m) => m.provider === provider && `${m.provider}/${m.id}` === current[preset].model)
            ?? models.find((m) => m.provider === provider)!;
        }
      } else if (stage === 2) {
        const value = await pickSetting(ctx, {
          title: "Subagent defaults · Model · 3/5", context: `${preset} · ${provider} · Current: ${current[preset].model}`,
          current: current[preset].model, selected: `${model.provider}/${model.id}`,
          items: models.filter((m) => m.provider === provider).map((m) => ({ value: `${m.provider}/${m.id}`, label: m.id, description: m.name })),
        });
        if (value === null) return;
        if (value === undefined) { stage--; continue; }
        model = models.find((m) => `${m.provider}/${m.id}` === value)!;
      } else {
        const levels = getSupportedThinkingLevels(model).filter((level) => THINKING_LEVELS.includes(level));
        const value = await pickSetting(ctx, {
          title: "Subagent defaults · Thinking · 4/5", context: `${preset} · ${model.provider}/${model.id}`,
          current: current[preset].thinking,
          items: levels.map((level) => ({ value: level, label: level })),
        });
        if (value === null) return;
        if (value === undefined) { stage--; continue; }
        if (!levels.includes(value as Thinking)) return;
        thinking = value as Thinking;
        break;
      }
      stage++;
    }
    const selection = { model: `${model.provider}/${model.id}`, thinking: thinking as Thinking };
    validatePresetSelection(selection, ctx.modelRegistry);
    if (!await ctx.ui.confirm("Save subagent defaults? · 5/5", [
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
