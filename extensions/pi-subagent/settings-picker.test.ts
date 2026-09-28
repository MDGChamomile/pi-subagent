import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { SettingsPicker } from "./settings-picker.ts";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
function harness() {
  let rows = 24;
  const results: (string | null | undefined)[] = [];
  const picker = new SettingsPicker({ title: "Model · 3/5", context: "analysis-standard · provider",
    current: "m150", items: Array.from({ length: 300 }, (_, i) => ({ value: `m${i}`, label: `model-${i}`,
      description: i === 299 ? "Unique searchable name" : "Long 日本語 모델 description ".repeat(8) })),
  }, theme, getKeybindings(), () => rows, () => {}, (value) => results.push(value));
  return { picker, results, resize: (n: number) => { rows = n; } };
}

test("large model lists start on current and scroll with real keyboard input", () => {
  const { picker, results } = harness();
  let lines = picker.render(80);
  assert.ok(lines.length <= 22);
  assert.ok(lines.some((s) => s.includes("model-150") && s.includes("current")));
  for (let i = 0; i < 120; i++) picker.handleInput("\x1b[B");
  lines = picker.render(80);
  assert.ok(lines.some((s) => s.includes("model-270")));
  picker.handleInput("\r");
  assert.deepEqual(results, ["m270"]);
});

test("typing filters display names, empty matches cannot select, clearing restores list", () => {
  const { picker, results } = harness();
  picker.focused = true;
  assert.equal(picker.input.focused, true);
  for (const char of "Unique") picker.handleInput(char);
  assert.ok(picker.render(80).some((s) => s.includes("model-299")));
  picker.handleInput("\r");
  assert.deepEqual(results, ["m299"]);
  for (const char of "zzzzzz") picker.handleInput(char);
  picker.handleInput("\r");
  assert.equal(results.length, 1);
  assert.ok(picker.render(80).some((s) => s.includes("0 results")));
  for (let i = 0; i < 12; i++) picker.handleInput("\x7f");
  assert.ok(picker.render(80).some((s) => s.includes("300 results")));
});

test("resize bounds lines and widths, including wide labels, without losing selection", () => {
  const { picker, resize, results } = harness();
  for (const rows of [40, 16, 12, 10, 8, 5]) {
    resize(rows);
    for (const width of [100, 40, 24, 15]) {
      const lines = picker.render(width);
      assert.ok(lines.length <= rows - 2, `rows ${rows}: ${lines.length}`);
      assert.ok(lines.every((s) => visibleWidth(s) <= width));
    }
  }
  picker.handleInput("\r");
  assert.equal(results.length, 0);
  resize(24); picker.render(80); picker.handleInput("\r");
  assert.deepEqual(results, ["m150"]);
});

test("metadata is single-line and control-free while selection preserves the exact ID", () => {
  const results: unknown[] = [];
  const value = "exact/model-id";
  const picker = new SettingsPicker({ title: "Model", context: "Context\nnext", items: [{
    value, label: "模型".repeat(60) + "\n\x1b[31mend", description: "Description\nnext\x1b[2J",
  }] }, theme, getKeybindings(), () => 24, () => {}, (result) => results.push(result));
  const lines = picker.render(35);
  assert.ok(lines.every((s) => visibleWidth(s) <= 35 && !/[\n\r]/.test(s)));
  assert.ok(lines.every((s) => !s.includes("\x1b[31m") && !s.includes("\x1b[2J")));
  picker.handleInput("\r");
  assert.deepEqual(results, [value]);
});

test("qualified provider/model IDs match even when absent from label and display name", () => {
  const results: unknown[] = [];
  const id = "openai-codex/gpt-6-sol";
  const picker = new SettingsPicker({ title: "Model", context: "openai-codex", items: [
    { value: id, label: "gpt-6-sol", description: "Sol" },
    { value: "openai-codex/gpt-5.6-luna", label: "gpt-5.6-luna", description: "Luna" },
  ] }, theme, getKeybindings(), () => 24, () => {}, (result) => results.push(result));
  for (const char of id) picker.handleInput(char);
  assert.ok(picker.render(80).some((s) => s.includes("1 results")));
  picker.handleInput("\r");
  assert.deepEqual(results, [id]);
});

test("escape goes back and Ctrl+C cancels even on tiny screens", () => {
  const { picker, resize, results } = harness();
  resize(4); picker.render(12);
  picker.handleInput("\x1b"); picker.handleInput("\x03");
  assert.deepEqual(results, [undefined, null]);
});
