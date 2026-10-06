from __future__ import annotations

import argparse
import copy
import io
import json
import unittest
import tempfile
from pathlib import Path
from contextlib import redirect_stdout, redirect_stderr
from types import SimpleNamespace
from unittest.mock import patch

import context_isolation_eval as evaluator
from eval_runtime import json_events, load_presets, observation_env, runtime_checks


SELECTION = {"model": "openai-codex/gpt-6-luna", "thinking": "medium"}
PRESET = "lookup-standard"


def observations(selection=None, web=False):
    selection = selection or SELECTION
    rows = [
        {"actor": "child", "kind": "request", **selection,
         "wireModel": selection["model"].split("/", 1)[1], "wireThinking": selection["thinking"]},
        {"actor": "child", "kind": "assistant", "model": selection["model"], "stopReason": "stop"},
    ]
    if web:
        rows.append({"actor": "child", "kind": "web_fetch", "targetMatch": True, "success": True})
    return rows


def envelope(answer, **overrides):
    return json.dumps({"status": "complete", "partialReason": None, "outputTruncated": False,
                       "answer": answer, **overrides}, ensure_ascii=False)


def set_answer(messages, answer):
    messages[1]["content"][0]["text"] = envelope(answer)


def smoke_messages(capability="local", preset=PRESET, selection=None):
    selection = selection or SELECTION
    return [
        {"role": "assistant", "content": [{"type": "toolCall", "name": "pi_subagent", "arguments": {
            "capability": capability, "preset": preset, "scope": ["fixture.txt"] if capability == "local" else [],
        }}]},
        {"role": "toolResult", "toolName": "pi_subagent", "isError": False,
         "content": [{"type": "text", "text": envelope("plain-final-answer (fixture.txt:1)" if capability == "local"
                      else f"{evaluator.SMOKE_WEB_PURPOSE}; {evaluator.SMOKE_WEB_QUOTE} — {evaluator.SMOKE_WEB_URL}")}],
         "details": {"capability": capability, "preset": preset, **selection, "status": "complete",
                     "outputTruncated": False, "usage": {"totalTokens": 42}, "durationMs": 10}},
    ]


def wire(messages):
    return "\n".join(json.dumps({"type": "message_end", "message": row}, ensure_ascii=False) for row in messages)


def check(messages=None, observed=None, capability="local"):
    return evaluator.evaluate_smoke(wire(messages if messages is not None else smoke_messages(capability)),
                                    observations(web=capability == "web") if observed is None else observed,
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


class ResultEnvelopeTests(unittest.TestCase):
    def test_rejects_old_output_and_malformed_envelopes(self):
        valid = json.loads(smoke_messages()[1]["content"][0]["text"])
        bodies = ["plain-final-answer (fixture.txt:1)", "{", "[]", "null"]
        for key in valid:
            changed = dict(valid)
            del changed[key]
            bodies.append(json.dumps(changed))
        for key, value in [("status", "unknown"), ("partialReason", "unknown"),
                           ("outputTruncated", 0), ("answer", []), ("unexpected", True)]:
            bodies.append(json.dumps({**valid, key: value}))
        for body in bodies:
            with self.subTest(body=body):
                messages = smoke_messages()
                messages[1]["content"][0]["text"] = body
                self.assertEqual(check(messages)["status"], "fail")

    def test_checks_status_reason_and_metadata_agreement(self):
        for reason in ("tool_budget", "time_limit", "model_length"):
            messages = smoke_messages()
            body = envelope("plain-final-answer (fixture.txt:1)", status="partial", partialReason=reason)
            self.assertIsNone(evaluator.parse_result_envelope(body, messages[1]["details"]))
            messages[1]["details"].update(status="partial", partialReason=reason)
            self.assertIsNotNone(evaluator.parse_result_envelope(body, messages[1]["details"]))
            messages[1]["content"][0]["text"] = body
            self.assertEqual(check(messages)["status"], "fail", "smoke requires complete output")
        for status, reason in [("complete", "tool_budget"), ("partial", None)]:
            self.assertIsNone(evaluator.parse_result_envelope(envelope("answer", status=status, partialReason=reason),
                             {"status": status, "partialReason": reason, "outputTruncated": False}))
        messages = smoke_messages()
        messages[1]["content"][0]["text"] = envelope("plain-final-answer (fixture.txt:1)", outputTruncated=True)
        self.assertEqual(check(messages)["status"], "fail")

    def test_decodes_tool_syntax_after_json_escaping(self):
        for prefix in ("", "\n", "\t", " "):
            for syntax in ("to=functions.read", "functions.read"):
                messages = smoke_messages()
                set_answer(messages, f"{prefix}{syntax}\nplain-final-answer (fixture.txt:1)")
                self.assertFalse(check(messages)["checks"]["no_raw_tool_syntax"])

    def test_bounds_serialized_envelope_not_only_answer(self):
        messages = smoke_messages()
        answer = 'plain-final-answer (fixture.txt:1) ' + '"' * 6200
        self.assertLess(len(answer.encode("utf-8")), 12 * 1024)
        set_answer(messages, answer)
        self.assertFalse(check(messages)["checks"]["within_12_kib"])

    def test_context_scores_only_decoded_child_answer_and_never_parent_fallback(self):
        case = evaluator.EvalCase("fixture", "lookup", "Synthetic task", (("complete",),))
        messages = smoke_messages()
        set_answer(messages, "Evidence fixture/incident.log:1\nto=functions.read")
        with patch.object(evaluator, "load_presets", return_value={PRESET: SELECTION}), \
                patch.object(evaluator, "observe_run", return_value=(
                    SimpleNamespace(stdout=wire(messages), stderr="", returncode=0), observations())):
            row = evaluator.run_pi(cwd=Path("."), main_model="offline/parent", main_thinking="off",
                                   case=case, arm="subagent", timeout_seconds=1)
        self.assertTrue(row["result_contract_verified"])
        self.assertEqual(row["expected_facts_matched"], 0, "envelope status must not count as an answer fact")
        self.assertTrue(row["has_evidence_location"])
        self.assertTrue(row["has_raw_tool_syntax"])
        messages[1]["content"][0]["text"] = "old-format answer"
        messages.append({"role": "assistant", "content": [{"type": "text", "text": "complete fixture/incident.log:1"}]})
        with patch.object(evaluator, "load_presets", return_value={PRESET: SELECTION}), \
                patch.object(evaluator, "observe_run", return_value=(
                    SimpleNamespace(stdout=wire(messages), stderr="", returncode=0), observations())):
            row = evaluator.run_pi(cwd=Path("."), main_model="offline/parent", main_thinking="off",
                                   case=case, arm="subagent", timeout_seconds=1)
        self.assertFalse(row["result_contract_verified"])
        self.assertEqual(row["expected_facts_matched"], 0)
        self.assertFalse(row["has_evidence_location"])


class PortableWebSmokeTests(unittest.TestCase):
    def test_web_requires_explicit_existing_entry_before_any_session(self):
        with tempfile.TemporaryDirectory() as directory:
            for path in (None, Path(directory), Path(directory) / "missing.ts"):
                args = argparse.Namespace(capability="web", web_extension=path)
                with patch.object(evaluator, "observe_run") as run, self.assertRaises(SystemExit):
                    evaluator.run_smoke(args)
                run.assert_not_called()

    @patch.object(evaluator, "load_presets", return_value={PRESET: SELECTION})
    def test_web_uses_supplied_entry_and_source_helper_without_personal_loader(self, _presets):
        with tempfile.TemporaryDirectory() as directory:
            entry = Path(directory) / "custom-install" / "web.ts"
            entry.parent.mkdir()
            entry.write_text("// offline fixture; never executed\n", encoding="utf-8")
            args = argparse.Namespace(capability="web", web_extension=entry, preset="all",
                                      main_model="openai-codex/gpt-6-astra", main_thinking="medium", timeout_seconds=60)
            def run(command, **kwargs):
                extensions = [command[i + 1] for i, item in enumerate(command) if item == "--extension"]
                self.assertEqual(extensions, [str(evaluator.EXTENSION_ENTRY), str(entry.resolve()),
                                              str(evaluator.WEB_SMOKE_PARENT)])
                self.assertNotIn("--tools", command, "CLI allowlist must not strip web provenance entries")
                self.assertNotIn("web-tool-loader.ts", " ".join(command))
                self.assertEqual(kwargs["fetch_url"], evaluator.SMOKE_WEB_URL)
                return SimpleNamespace(stdout=wire(smoke_messages("web")), returncode=0), observations(web=True)
            with patch.object(evaluator, "observe_run", side_effect=run) as observed, redirect_stdout(io.StringIO()):
                self.assertEqual(evaluator.run_smoke(args), 0)
            observed.assert_called_once()

    @patch.object(evaluator, "load_presets", return_value={PRESET: SELECTION})
    def test_web_entry_cli_is_optional_for_local(self, _presets):
        self.assertIsNone(evaluator.parse_args([]).web_extension)
        self.assertEqual(evaluator.parse_args(["--web-extension", "somewhere/web.ts"]).web_extension,
                         Path("somewhere/web.ts"))


class SmokeContractTests(unittest.TestCase):
    def test_local_and_web_success(self):
        for capability in ("local", "web"):
            with self.subTest(capability=capability):
                self.assertEqual(check(capability=capability)["status"], "pass")

    def test_web_answer_cannot_replace_a_successful_child_target_fetch(self):
        self.assertEqual(check(observed=observations(), capability="web")["status"], "fail")
        for key, wrong in [("actor", "parent"), ("kind", "request"), ("targetMatch", False),
                           ("success", False), ("success", "true"), ("targetMatch", 1)]:
            with self.subTest(key=key, wrong=wrong):
                rows = observations(web=True)
                rows[-1][key] = wrong
                self.assertEqual(check(observed=rows, capability="web")["status"], "fail")
        rows = observations(web=True)
        rows.insert(-1, {"actor": "child", "kind": "web_fetch", "targetMatch": True, "success": False})
        self.assertEqual(check(observed=rows, capability="web")["status"], "pass", "a successful recovery is allowed")

    def test_fetch_target_environment_is_explicit_and_not_inherited(self):
        with patch.dict("os.environ", {"PI_SUBAGENT_EVAL_FETCH_URL": "https://fixture.invalid/private"}):
            self.assertNotIn("PI_SUBAGENT_EVAL_FETCH_URL", observation_env(Path("fixture-trace")))
            self.assertEqual(observation_env(Path("fixture-trace"), fetch_url=evaluator.SMOKE_WEB_URL)
                             ["PI_SUBAGENT_EVAL_FETCH_URL"], evaluator.SMOKE_WEB_URL)

    def test_web_title_alone_is_not_sufficient(self):
        messages = smoke_messages("web")
        set_answer(messages, f"Example Domains — {evaluator.SMOKE_WEB_URL}")
        self.assertEqual(check(messages, capability="web")["status"], "fail")

    def test_web_body_evidence_does_not_require_an_extractor_heading(self):
        messages = smoke_messages("web")
        self.assertNotIn("Example Domains", messages[1]["content"][0]["text"])
        self.assertEqual(check(messages, capability="web")["status"], "pass")
        set_answer(messages, f"{evaluator.SMOKE_WEB_QUOTE} — {evaluator.SMOKE_WEB_URL}")
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
            set_answer(messages, answer)
            self.assertEqual(check(messages)["status"], "fail")

    @patch.object(evaluator, "load_presets", return_value={PRESET: SELECTION, "future-preset": SELECTION})
    def test_all_presets_are_run_in_fresh_parents(self, _presets):
        seen = []
        def run(_command, *, cwd, prompt, timeout):
            self.assertEqual(_command[:2], ["--mode", "json"])
            preset = PRESET if f"preset={PRESET}." in prompt else "future-preset"
            seen.append((preset, str(cwd)))
            return SimpleNamespace(stdout=wire(smoke_messages(preset=preset)), returncode=0), observations()
        args = argparse.Namespace(capability="local", preset="all", main_model="openai-codex/gpt-6-astra",
                                  main_thinking="medium", timeout_seconds=60)
        with patch.object(evaluator, "observe_run", side_effect=run), \
                patch.object(evaluator, "web_smoke_extension", side_effect=AssertionError("local must not resolve web")), \
                redirect_stdout(io.StringIO()) as output:
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
