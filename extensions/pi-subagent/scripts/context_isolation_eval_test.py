from __future__ import annotations

import argparse
import copy
import io
import json
import unittest
from contextlib import redirect_stdout, redirect_stderr
from types import SimpleNamespace
from unittest.mock import patch

import context_isolation_eval as evaluator
from eval_runtime import json_events, load_presets, runtime_checks


SELECTION = {"model": "openai-codex/gpt-5.6-luna", "thinking": "medium"}
PRESET = "lookup-standard"


def observations(selection=None):
    selection = selection or SELECTION
    return [
        {"actor": "child", "kind": "request", **selection,
         "wireModel": selection["model"].split("/", 1)[1], "wireThinking": selection["thinking"]},
        {"actor": "child", "kind": "assistant", "model": selection["model"], "stopReason": "stop"},
    ]


def smoke_messages(capability="local", preset=PRESET, selection=None):
    selection = selection or SELECTION
    return [
        {"role": "assistant", "content": [{"type": "toolCall", "name": "pi_subagent", "arguments": {
            "capability": capability, "preset": preset, "scope": ["fixture.txt"] if capability == "local" else [],
        }}]},
        {"role": "toolResult", "toolName": "pi_subagent", "isError": False,
         "content": [{"type": "text", "text": "plain-final-answer (fixture.txt:1)" if capability == "local"
                      else f"{evaluator.SMOKE_WEB_PURPOSE}; {evaluator.SMOKE_WEB_QUOTE} — {evaluator.SMOKE_WEB_URL}"}],
         "details": {"capability": capability, "preset": preset, **selection, "status": "complete",
                     "outputTruncated": False, "usage": {"totalTokens": 42}, "durationMs": 10}},
    ]


def wire(messages):
    return "\n".join(json.dumps({"type": "message_end", "message": row}, ensure_ascii=False) for row in messages)


def check(messages=None, observed=None, capability="local"):
    return evaluator.evaluate_smoke(wire(messages if messages is not None else smoke_messages(capability)),
                                    observations() if observed is None else observed,
                                    capability=capability, preset=PRESET, selection=SELECTION)


class RuntimeObservationTests(unittest.TestCase):
    def test_runtime_catalog_is_loaded_from_typescript(self):
        presets = load_presets()
        self.assertEqual(presets[PRESET], SELECTION)
        self.assertIn("review-standard", presets)

    def test_lf_framing_preserves_unicode_line_and_paragraph_separators(self):
        item = {"text": "one\u2028two\u2029three"}
        self.assertEqual(list(json_events("noise\n" + json.dumps(item, ensure_ascii=False) + "\n")), [item])

    def test_missing_child_observations_fail_closed(self):
        self.assertFalse(all(runtime_checks([], **SELECTION).values()))
        self.assertEqual(check(observed=[])["status"], "fail")

    def test_planned_metadata_cannot_hide_thinking_clamping_or_model_fallback(self):
        for key, wrong in [("thinking", "high"), ("wireThinking", "high"), ("model", "openai-codex/gpt-6-astra"),
                           ("wireModel", "gpt-6-astra")]:
            with self.subTest(key=key):
                rows = observations()
                rows[0][key] = wrong
                self.assertEqual(check(observed=rows)["status"], "fail")
        rows = observations()
        rows[1]["model"] = "openai-codex/gpt-6-astra"
        self.assertEqual(check(observed=rows)["status"], "fail")

    def test_every_child_request_is_checked(self):
        rows = observations()
        rows.append({**rows[0], "wireThinking": "low"})
        self.assertEqual(check(observed=rows)["status"], "fail")


class SmokeContractTests(unittest.TestCase):
    def test_local_and_web_success(self):
        for capability in ("local", "web"):
            with self.subTest(capability=capability):
                self.assertEqual(check(capability=capability)["status"], "pass")

    def test_web_title_alone_is_not_sufficient(self):
        messages = smoke_messages("web")
        messages[1]["content"][0]["text"] = f"Example Domains — {evaluator.SMOKE_WEB_URL}"
        self.assertEqual(check(messages, capability="web")["status"], "fail")

    def test_web_body_evidence_does_not_require_an_extractor_heading(self):
        messages = smoke_messages("web")
        self.assertNotIn("Example Domains", messages[1]["content"][0]["text"])
        self.assertEqual(check(messages, capability="web")["status"], "pass")
        messages[1]["content"][0]["text"] = f"{evaluator.SMOKE_WEB_QUOTE} — {evaluator.SMOKE_WEB_URL}"
        self.assertEqual(check(messages, capability="web")["status"], "fail")

    def test_rejects_missing_or_wrong_result_metadata(self):
        for key, wrong in [("model", "wrong/model"), ("thinking", "low"), ("preset", "review-standard"),
                           ("capability", "web"), ("status", "partial"), ("outputTruncated", True), ("usage", {})]:
            with self.subTest(key=key):
                messages = smoke_messages()
                messages[1]["details"][key] = wrong
                self.assertEqual(check(messages)["status"], "fail")
        messages = smoke_messages()
        del messages[1]["details"]
        self.assertEqual(check(messages)["status"], "fail")

    def test_rejects_wrong_call_arguments(self):
        for key, wrong in [("preset", "review-standard"), ("capability", "web"), ("scope", ["."])]:
            with self.subTest(key=key):
                messages = smoke_messages()
                messages[0]["content"][0]["arguments"][key] = wrong
                self.assertEqual(check(messages)["status"], "fail")

    def test_rejects_duplicate_calls_and_results(self):
        for index in (0, 1):
            messages = smoke_messages()
            messages.append(copy.deepcopy(messages[index]))
            self.assertEqual(check(messages)["status"], "fail")

    def test_rejects_parent_investigation_and_web_loader(self):
        for tool in ("read", "grep", "fetch_content", "load_web_tools"):
            messages = smoke_messages()
            messages[0]["content"].append({"type": "toolCall", "name": tool, "arguments": {}})
            self.assertEqual(check(messages)["status"], "fail")

    def test_rejects_error_empty_missing_evidence_and_oversized_answers(self):
        messages = smoke_messages()
        messages[1]["isError"] = True
        self.assertEqual(check(messages)["status"], "fail")
        for answer in ("", "plain-final-answer", "functions.read fixture.txt:1 plain-final-answer", "한" * 5000):
            messages = smoke_messages()
            messages[1]["content"][0]["text"] = answer
            self.assertEqual(check(messages)["status"], "fail")

    @patch.object(evaluator, "load_presets", return_value={PRESET: SELECTION, "future-preset": SELECTION})
    def test_all_presets_are_run_in_fresh_parents(self, _presets):
        seen = []
        def run(_command, *, cwd, prompt, timeout, **selection):
            self.assertEqual(_command[:2], ["--mode", "json"])
            preset = PRESET if f"preset={PRESET}." in prompt else "future-preset"
            seen.append((preset, str(cwd)))
            return SimpleNamespace(stdout=wire(smoke_messages(preset=preset, selection=selection)), returncode=0), observations(selection)
        args = argparse.Namespace(capability="local", preset="all", main_model="openai-codex/gpt-6-astra",
                                  main_thinking="medium", timeout_seconds=60)
        with patch.object(evaluator, "observe_run", side_effect=run), redirect_stdout(io.StringIO()) as output:
            self.assertEqual(evaluator.run_smoke(args), 0)
        self.assertEqual([row[0] for row in seen], [PRESET, "future-preset"])
        self.assertEqual(len(set(row[1] for row in seen)), 2)
        self.assertEqual(len(json.loads(output.getvalue())["results"]), 2)

    @patch.object(evaluator, "load_presets", return_value={PRESET: SELECTION})
    def test_cli_defaults_to_all_and_bounds_timeout(self, _presets):
        self.assertEqual(evaluator.parse_args([]).preset, "all")
        self.assertEqual(evaluator.parse_args(["--preset", PRESET]).preset, PRESET)
        for value in ("0", "1201", "not-a-number"):
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                evaluator.parse_args(["--timeout-seconds", value])


if __name__ == "__main__":
    unittest.main()
