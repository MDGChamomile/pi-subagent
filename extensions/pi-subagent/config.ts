import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { PRESET_NAMES, SUBAGENT_PRESETS, type Preset, type Thinking } from "./shared.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PresetSelection = { model: string; thinking: Thinking };
export type PresetSelections = Record<Preset, PresetSelection>;
const HELP = "Check presets in pi-subagent.json in the Pi agent directory; configure provider and model together, and a supported thinking level";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const keysAllowed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

export function parsePresetSettings(value: unknown): PresetSelections {
  if (!record(value) || !keysAllowed(value, ["presets"]) ||
    (value.presets !== undefined && (!record(value.presets) || !keysAllowed(value.presets, PRESET_NAMES)))) {
    throw new Error(`Invalid subagent settings. ${HELP}`);
  }
  const selections = Object.fromEntries(PRESET_NAMES.map((name) => [name, { ...SUBAGENT_PRESETS[name] }])) as PresetSelections;
  for (const name of PRESET_NAMES) {
    const override = (value.presets as Record<string, unknown> | undefined)?.[name];
    if (override === undefined) continue;
    if (!record(override) || !keysAllowed(override, ["provider", "model", "thinking"])) {
      throw new Error(`Invalid subagent preset settings. ${HELP}`);
    }
    if (override.provider !== undefined || override.model !== undefined) {
      if (typeof override.provider !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(override.provider) ||
        typeof override.model !== "string" || override.model.length === 0 || override.model.trim() !== override.model || override.model.length > 256 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(override.model)) {
        throw new Error(`Invalid subagent provider/model settings. ${HELP}`);
      }
      selections[name].model = `${override.provider}/${override.model}`;
    }
    if (override.thinking !== undefined) {
      if (!THINKING_LEVELS.includes(override.thinking as Thinking)) {
        throw new Error(`Invalid subagent thinking setting. ${HELP}`);
      }
      selections[name].thinking = override.thinking as Thinking;
    }
  }
  return selections;
}

export type PresetSettings = {
  presets?: Partial<Record<Preset, { provider?: string; model?: string; thinking?: Thinking }>>;
};
export type SettingsSnapshot = { path: string; text: string | null; settings: PresetSettings };

// Only the user's agent directory is consulted, never project files or tool arguments.
export function presetSettingsPath(agentDir = getAgentDir()): string {
  // Preserve explicit directory injection, including its historical tilde support.
  if (agentDir === "~") agentDir = homedir();
  else if (agentDir.startsWith("~/")) agentDir = join(homedir(), agentDir.slice(2));
  return join(agentDir, "pi-subagent.json");
}

export async function readPresetSettingsSnapshot(path = presetSettingsPath()): Promise<SettingsSnapshot> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, text: null, settings: {} };
    throw new Error(`Could not read subagent settings. ${HELP}`);
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid subagent settings JSON. ${HELP}`); }
  parsePresetSettings(value);
  return { path, text, settings: value as PresetSettings };
}

export async function loadPresetSettings(agentDir = getAgentDir()): Promise<PresetSelections> {
  return parsePresetSettings((await readPresetSettingsSnapshot(presetSettingsPath(agentDir))).settings);
}

export function validatePresetSelection(
  selection: PresetSelection,
  registry: { find(provider: string, model: string): Model<Api> | undefined },
): void {
  const separator = selection.model.indexOf("/");
  const model = registry.find(selection.model.slice(0, separator), selection.model.slice(separator + 1));
  if (!model) throw new Error(`Configured subagent model is unavailable. ${HELP}`);
  if (!getSupportedThinkingLevels(model).includes(selection.thinking)) {
    throw new Error(`Configured subagent thinking level is unsupported. ${HELP}`);
  }
}
