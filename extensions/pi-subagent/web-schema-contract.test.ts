import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { checkWebSchemas } from "./scripts/web-schema-contract.ts";

type Tool = PiTool & { parameters: { properties: Record<string, TSchema>; required?: string[] } };

// Synthetic schemas test the checker itself without installing pi-web-access in
// ordinary validation. Only the opt-in canary discovers the upstream schemas.
function schemas(): Tool[] {
  const optionalString = () => Type.Optional(Type.String());
  const optionalStrings = () => Type.Optional(Type.Array(Type.String()));
  const optionalInteger = () => Type.Optional(Type.Integer());
  return [
    { name: "web_search", parameters: Type.Object({
      query: optionalString(), queries: optionalStrings(), numResults: optionalInteger(),
      recencyFilter: optionalString(), domainFilter: optionalStrings(),
      workflow: Type.Optional(Type.Literal("none")),
    }) },
    { name: "source_check", parameters: Type.Object({
      claim: Type.String(), queries: optionalStrings(), numResults: optionalInteger(),
      fetchContent: Type.Optional(Type.Boolean()), recencyFilter: optionalString(), domainFilter: optionalStrings(),
    }) },
    { name: "fetch_content", parameters: Type.Object({
      url: optionalString(), urls: optionalStrings(), mode: Type.Optional(Type.Literal("readable")),
    }) },
    { name: "get_search_content", parameters: Type.Object({
      responseId: Type.String(), query: optionalString(), queryIndex: optionalInteger(), url: optionalString(),
      urlIndex: optionalInteger(), offset: optionalInteger(), limit: optionalInteger(),
      findText: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])), findMode: optionalString(),
    }) },
  ].map((tool) => ({ ...tool, description: "Synthetic schema" }));
}

test("web schema checker accepts compatible schemas and harmless added optional keys", () => {
  const tools = schemas();
  tools[0]!.parameters.properties.newOptionalKey = Type.Optional(Type.String());
  assert.deepEqual(checkWebSchemas(tools), { tools: 4, samples: 10 });
});

for (const [name, mutate, expected] of [
  ["missing tool", (tools: Tool[]) => { tools.pop(); }, /get_search_content: expected exactly one/],
  ["duplicate tool", (tools: Tool[]) => { tools.push(tools[0]!); }, /web_search: expected exactly one/],
  ["removed key", (tools: Tool[]) => { delete tools[0]!.parameters.properties.query; }, /web_search: missing allowlisted key query/],
  ["new required key", (tools: Tool[]) => {
    tools[0]!.parameters.properties.token = Type.String();
    tools[0]!.parameters.required = ["token"];
  }, /web_search: upstream rejects input sample 0/],
  ["changed field type", (tools: Tool[]) => {
    tools[0]!.parameters.properties.queries = Type.Optional(Type.String());
  }, /web_search: upstream rejects input sample 1/],
  ["removed workflow enum", (tools: Tool[]) => {
    tools[0]!.parameters.properties.workflow = Type.Optional(Type.Literal("summary-review"));
  }, /web_search: upstream rejects normalized sample 0/],
  ["removed readable enum", (tools: Tool[]) => {
    tools[2]!.parameters.properties.mode = Type.Optional(Type.Literal("raw"));
  }, /fetch_content: upstream rejects normalized sample 0/],
  ["reduced query limit", (tools: Tool[]) => {
    tools[0]!.parameters.properties.queries = Type.Optional(Type.Array(Type.String(), { maxItems: 3 }));
  }, /web_search: upstream rejects input sample 1/],
  ["removed findText array", (tools: Tool[]) => {
    tools[3]!.parameters.properties.findText = Type.Optional(Type.String());
  }, /get_search_content: upstream rejects input sample 2/],
] as const) {
  test(`web schema checker detects ${name}`, () => {
    const tools = schemas();
    mutate(tools);
    assert.throws(() => checkWebSchemas(tools), expected);
  });
}
