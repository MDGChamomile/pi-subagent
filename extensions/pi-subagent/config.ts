import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
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
        typeof override.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,255}$/.test(override.model)) {
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

// Only the user's agent directory is consulted, never project files or tool arguments.
export async function loadPresetSettings(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): Promise<PresetSelections> {
  if (agentDir === "~") agentDir = homedir();
  else if (agentDir.startsWith("~/")) agentDir = join(homedir(), agentDir.slice(2));
  let text: string;
  try {
    text = await readFile(join(agentDir, "pi-subagent.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parsePresetSettings({});
    throw new Error(`Could not read subagent settings. ${HELP}`);
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid subagent settings JSON. ${HELP}`); }
  return parsePresetSettings(value);
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
