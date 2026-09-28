import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, fuzzyFilter, truncateToWidth, type KeybindingsManager, type SelectItem } from "@earendil-works/pi-tui";

import { sanitizeDisplayText } from "./shared.ts";

const oneLine = (text: string) => sanitizeDisplayText(text).replace(/\s+/g, " ");

export interface PickerOptions {
  title: string;
  context: string;
  items: SelectItem[];
  current?: string;
  selected?: string;
}

// A fresh component per step: no terminal ownership, provider requests, or writes.
export class SettingsPicker {
  readonly input = new Input();
  private list!: SelectList;
  private filtered: SelectItem[];
  private height = 0;
  private preferred?: string;
  readonly options: PickerOptions;
  private theme: Theme;
  private keys: KeybindingsManager;
  private rows: () => number;
  private redraw: () => void;
  private done: (value: string | null | undefined) => void;
  private tooSmall = false;
  constructor(options: PickerOptions, theme: Theme,
    keys: KeybindingsManager, rows: () => number,
    redraw: () => void, done: (value: string | null | undefined) => void) {
    this.options = options; this.theme = theme; this.keys = keys;
    this.rows = rows; this.redraw = redraw; this.done = done;
    this.filtered = options.items;
    this.preferred = options.selected ?? options.current;
    this.rebuild(5);
  }
  get focused() { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  private rebuild(height: number) {
    this.height = height;
    const items = this.filtered.map((item) => ({
      value: item.value, label: `${oneLine(item.label)}${item.value === this.options.current ? "  ✓ current" : ""}`,
    }));
    this.list = new SelectList(items, height, {
      selectedPrefix: (s) => this.theme.fg("accent", s),
      selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("muted", s),
      scrollInfo: (s) => this.theme.fg("muted", s),
      noMatch: (s) => this.theme.fg("muted", s),
    });
    this.list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === this.preferred)));
    this.list.onSelect = (item) => this.done(item.value);
    this.list.onSelectionChange = (item) => { this.preferred = item.value; };
  }
  invalidate() { this.input.invalidate(); this.list.invalidate(); }
  render(width: number): string[] {
    const rows = Math.max(1, this.rows() - 2);
    this.tooSmall = rows < 8 || width < 24;
    if (this.tooSmall) {
      return ["Enlarge terminal to select", "Esc back · Ctrl+C cancel"].slice(0, rows).map((s) => truncateToWidth(s, width));
    }
    const height = Math.max(1, Math.min(10, rows - 8));
    if (height !== this.height) this.rebuild(height);
    const selected = this.filtered.find((item) => item.value === this.list.getSelectedItem()?.value);
    const lines = [
      this.theme.fg("accent", this.theme.bold(oneLine(this.options.title))),
      this.theme.fg("muted", oneLine(this.options.context)),
      ...this.input.render(width),
      this.theme.fg("muted", `Type to search · ${this.filtered.length} results`),
      ...this.list.render(width),
    ];
    if (rows >= 10) lines.push(this.theme.fg("muted", oneLine(selected?.description ?? "")));
    lines.push(this.theme.fg("muted", "↑↓ move · Enter select · Esc back"),
      this.theme.fg("dim", "Ctrl+C cancel · Not saved until confirmed"));
    return lines.map((s) => truncateToWidth(s, width));
  }
  handleInput(data: string) {
    if (data === "\u0003") { this.done(null); return; }
    if (this.keys.matches(data, "tui.select.cancel")) { this.done(undefined); return; }
    if (this.tooSmall) return;
    if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.down") ||
      this.keys.matches(data, "tui.select.confirm")) {
      this.list.handleInput(data);
    } else {
      this.input.handleInput(data);
      this.filtered = fuzzyFilter(this.options.items, this.input.getValue(), (item) => `${item.value} ${item.label} ${item.description ?? ""}`);
      this.preferred = this.filtered[0]?.value;
      this.rebuild(this.height);
    }
    this.redraw();
  }
}

export function pickSetting(ctx: ExtensionCommandContext, options: PickerOptions): Promise<string | null | undefined> {
  return ctx.ui.custom((tui, theme, keys, done) => new SettingsPicker(
    options, theme, keys, () => tui.terminal.rows, () => tui.requestRender(), done,
  ));
}
