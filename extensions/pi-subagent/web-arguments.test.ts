import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { prepareWebCall } from "./web-arguments.ts";

describe("pi-subagent web arguments", () => {
  test("prepares normalized web inputs without mutating caller arguments", () => {
    const cases = [
      { tool: "web_search", input: { query: '["one","two"]', workflow: "summary-review" } },
      { tool: "source_check", input: { claim: "claim", queries: ["one", "two"], numResults: 2, fetchContent: true } },
      { tool: "fetch_content", input: { urls: ["https://example.com", "https://example.com"] } },
      { tool: "get_search_content", input: { responseId: "response", urlIndex: 0 } },
    ];
    for (const { tool, input } of cases) {
      const original = structuredClone(input);
      const prepared = prepareWebCall(tool, Object.freeze(input));
      assert.ok("input" in prepared, tool);
      assert.deepEqual(input, original);
      assert.notEqual(prepared.input, input);
      assert.deepEqual(prepared.input, tool === "web_search"
        ? { ...original, workflow: "none" }
        : tool === "fetch_content" ? { ...original, mode: "readable" } : original);
    }
    const denied = Object.freeze({ query: "one", workflow: "summary-review", numResults: 11 });
    const prepared = prepareWebCall("web_search", denied);
    assert.ok("violation" in prepared);
    assert.match(prepared.violation, /at most 10 results/);
    assert.equal("input" in prepared, false);
    assert.equal(denied.workflow, "summary-review");
  });

  test("pins omitted fetch mode to readable and rejects explicit unsupported modes", () => {
    for (const mode of [undefined, "readable", "raw", "answer"]) {
      const input = Object.freeze({ url: "https://example.com", ...(mode === undefined ? {} : { mode }) });
      const prepared = prepareWebCall("fetch_content", input);
      if (mode === "raw" || mode === "answer") {
        assert.ok("violation" in prepared);
        assert.match(prepared.violation, /only readable mode/);
        assert.equal("input" in prepared, false);
      } else {
        assert.ok("input" in prepared);
        assert.deepEqual(prepared.input, { url: input.url, mode: "readable" });
      }
      assert.equal(input.mode, mode);
    }
  });

  test("rejects non-web and prototype-named tools as unsupported web calls", () => {
    for (const tool of ["read", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      assert.deepEqual(prepareWebCall(tool, { url: "https://example.com" }), {
        violation: `${tool} is not supported in the subagent`,
      });
    }
  });
});
