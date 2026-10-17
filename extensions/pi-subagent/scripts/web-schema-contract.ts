import assert from "node:assert/strict";
import type { Tool } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import { prepareWebCall } from "../child-guard.ts";
import {
  ALLOWED_WEB_TOOLS, MAX_FETCH_URLS_PER_CALL, MAX_WEB_QUERIES_PER_CALL, MAX_WEB_RESULTS_PER_QUERY, WEB_INPUT_KEYS,
} from "../shared.ts";

type WebTool = (typeof ALLOWED_WEB_TOOLS)[number];
const url = "https://example.invalid/evidence";
// Deliberately representative, not an exhaustive inclusion proof. Minimal inputs
// catch newly required fields; populated inputs cover every allowlisted key.
const inputs: Record<WebTool, Record<string, unknown>[]> = {
  web_search: [
    { query: "synthetic query" },
    { queries: Array.from({ length: MAX_WEB_QUERIES_PER_CALL }, (_, i) => `query ${i}`),
      numResults: MAX_WEB_RESULTS_PER_QUERY, recencyFilter: "week", domainFilter: ["example.invalid"], workflow: "none" },
  ],
  source_check: [
    { claim: "Synthetic claim" },
    { claim: "Synthetic claim", queries: ["synthetic query"], numResults: MAX_WEB_RESULTS_PER_QUERY,
      fetchContent: true, recencyFilter: "month", domainFilter: ["example.invalid"] },
  ],
  fetch_content: [
    { url },
    { urls: Array.from({ length: MAX_FETCH_URLS_PER_CALL }, (_, i) => `${url}/${i}`), mode: "readable" },
  ],
  get_search_content: [
    { responseId: "synthetic-response" },
    { responseId: "synthetic-response", query: "synthetic query", queryIndex: 0, url, urlIndex: 0,
      offset: 0, limit: 100, findText: "synthetic", findMode: "exact" },
    { responseId: "synthetic-response", findText: ["synthetic", "evidence"], findMode: "case-insensitive" },
    { responseId: "synthetic-response", findText: "synthetic", findMode: "fuzzy" },
  ],
};

export function checkWebSchemas(tools: readonly Tool[]): { tools: number; samples: number } {
  let samples = 0;
  for (const name of ALLOWED_WEB_TOOLS) {
    const matches = tools.filter((tool) => tool.name === name);
    assert.equal(matches.length, 1, `${name}: expected exactly one registered tool`);
    const schema = matches[0]!.parameters as TSchema & { type?: unknown; properties?: Record<string, TSchema> };
    assert.equal(schema.type, "object", `${name}: expected an object schema`);
    for (const key of WEB_INPUT_KEYS[name]) {
      assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${name}: missing allowlisted key ${key}`);
    }
    const validator = Compile(schema);
    const covered = new Set<string>();
    for (const [index, input] of inputs[name].entries()) {
      // Pi validates before the guard; also check the exact normalized input the
      // guard forwards. No defaults/coercions may hide a typed fixture mismatch.
      assert.ok(validator.Check(input), `${name}: upstream rejects input sample ${index}`);
      const prepared = prepareWebCall(name, input);
      assert.ok(!("violation" in prepared), `${name}: guard rejects input sample ${index}`);
      assert.ok(validator.Check(prepared.input), `${name}: upstream rejects normalized sample ${index}`);
      if (name === "web_search") assert.equal(prepared.input.workflow, "none");
      if (name === "fetch_content") assert.equal(prepared.input.mode, "readable");
      for (const key of Object.keys(prepared.input)) covered.add(key);
      samples++;
    }
    for (const key of WEB_INPUT_KEYS[name]) {
      assert.ok(covered.has(key), `${name}: add a representative sample for ${key}`);
    }
  }
  return { tools: ALLOWED_WEB_TOOLS.length, samples };
}
