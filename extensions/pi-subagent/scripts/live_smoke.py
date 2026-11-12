#!/usr/bin/env python3
"""Opt-in local/web live smoke checks for pi-subagent."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from eval_runtime import json_events, load_presets, observe_run, runtime_checks

EXTENSION_DIR = Path(__file__).resolve().parents[1]
EXTENSION_ENTRY = EXTENSION_DIR / "index.ts"
WEB_SMOKE_PARENT = Path(__file__).with_name("web-smoke-parent.ts")
SMOKE_WEB_URL = "https://www.iana.org/help/example-domains"
SMOKE_WEB_QUOTE = "not available for registration or transfer"
SMOKE_WEB_PURPOSE = "maintained for documentation purposes"
MAX_RESULT_BYTES = 12 * 1024
TOOL_SYNTAX_RE = re.compile(r"(?:^|\s)(?:to=|functions\.)\w+", re.I)


def text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
    )


def parse_result_envelope(body: str, details: dict[str, Any]) -> dict[str, Any] | None:
    """Validate the model-visible result independently, then compare host metadata."""
    try:
        envelope = json.loads(body)
    except json.JSONDecodeError:
        return None
    if not isinstance(envelope, dict) or set(envelope) != {"status", "partialReason", "outputTruncated", "answer"}:
        return None
    status, reason = envelope["status"], envelope["partialReason"]
    if (status not in ("complete", "partial")
            or reason not in (None, "tool_budget", "time_limit", "model_length")
            or (status == "complete") != (reason is None)
            or not isinstance(envelope["outputTruncated"], bool)
            or not isinstance(envelope["answer"], str)
            or len(body.encode("utf-8")) > MAX_RESULT_BYTES):
        return None
    if (details.get("status") != status or details.get("partialReason") != reason
            or details.get("outputTruncated") is not envelope["outputTruncated"]):
        return None
    return envelope


def base_command(main_model: str, main_thinking: str) -> list[str]:
    return [
        "--mode", "json",
        "--print",
        "--no-session",
        "--model", main_model,
        "--thinking", main_thinking,
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "--offline",
    ]


@dataclass(frozen=True)
class SubagentResult:
    body: str
    is_error: bool
    details: dict[str, Any]


@dataclass
class ParentTranscript:
    subagent_calls: list[Any] = field(default_factory=list)
    other_calls: list[str] = field(default_factory=list)
    subagent_results: list[SubagentResult] = field(default_factory=list)

    def last_answer(self) -> SubagentResult | None:
        return next((result for result in reversed(self.subagent_results) if not result.is_error), None)


def parent_transcript(output: str) -> ParentTranscript:
    transcript = ParentTranscript()
    for event in json_events(output):
        message = event.get("message") if event.get("type") == "message_end" else None
        if not isinstance(message, dict):
            continue
        if message.get("role") == "assistant":
            content = message.get("content")
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict) or block.get("type") != "toolCall":
                    continue
                name = block.get("name")
                if name == "pi_subagent":
                    transcript.subagent_calls.append(block.get("arguments"))
                else:
                    transcript.other_calls.append(str(name))
        elif message.get("role") == "toolResult" and message.get("toolName") == "pi_subagent":
            details = message.get("details")
            transcript.subagent_results.append(SubagentResult(
                text_content(message.get("content")), bool(message.get("isError")),
                details if isinstance(details, dict) else {}))
    return transcript


def requested_call_matches(calls: list[Any], *, capability: str, preset: str, scope: list[str]) -> bool:
    return (len(calls) == 1 and isinstance(calls[0], dict)
            and calls[0].get("capability") == capability and calls[0].get("preset") == preset
            and calls[0].get("scope") == scope)


def evaluate_smoke(output: str, observations: list[dict[str, Any]], *, capability: str,
                   preset: str, selection: dict[str, str]) -> dict[str, Any]:
    transcript = parent_transcript(output)
    answers = [result.body for result in transcript.subagent_results if not result.is_error]
    errors = [result.body[:500] for result in transcript.subagent_results if result.is_error]
    last_answer = transcript.last_answer()
    details = last_answer.details if last_answer else {}
    result_text = answers[0] if len(answers) == 1 else ""
    envelope = parse_result_envelope(result_text, details)
    answer = envelope["answer"] if envelope is not None else ""
    scope = ["fixture.txt"] if capability == "local" else []
    usage = details.get("usage") if isinstance(details.get("usage"), dict) else {}
    reported_tokens = usage.get("totalTokens")
    checks = {
        "exactly_one_call": len(transcript.subagent_calls) == 1,
        "requested_preset_and_scope": requested_call_matches(
            transcript.subagent_calls, capability=capability, preset=preset, scope=scope),
        "exactly_one_result": len(answers) == 1,
        "no_tool_error": not errors,
        "valid_result_envelope": envelope is not None,
        "non_empty_answer": bool(answer.strip()),
        "within_12_kib": bool(result_text) and len(result_text.encode("utf-8")) <= MAX_RESULT_BYTES,
        "no_raw_tool_syntax": bool(answer) and not bool(TOOL_SYNTAX_RE.search(answer)),
        "expected_fact": (capability == "local" and "plain-final-answer" in answer)
            or (capability == "web" and SMOKE_WEB_PURPOSE in answer.casefold() and SMOKE_WEB_QUOTE in answer.casefold()),
        "evidence_present": "fixture.txt:1" in answer if capability == "local" else SMOKE_WEB_URL in answer,
        "no_parent_investigation_or_loader_calls": not transcript.other_calls,
        "observed_successful_target_fetch": capability != "web" or any(
            row.get("actor") == "child" and row.get("kind") == "web_fetch"
            and row.get("targetMatch") is True and row.get("success") is True
            for row in observations
        ),
        "reported_preset": details.get("preset") == preset,
        "reported_model": details.get("model") == selection["model"],
        "reported_thinking": details.get("thinking") == selection["thinking"],
        "reported_capability": details.get("capability") == capability,
        "complete_untruncated_result": envelope is not None and envelope["status"] == "complete"
            and envelope["outputTruncated"] is False,
        "reported_usage": isinstance(reported_tokens, (int, float)) and not isinstance(reported_tokens, bool) and reported_tokens > 0,
        **runtime_checks(observations, **selection),
    }
    return {
        "capability": capability, "preset": preset, "expected": selection,
        "status": "pass" if all(checks.values()) else "fail", "checks": checks,
        "result_bytes": len(result_text.encode("utf-8")), "errors": errors,
        "parent_other_calls": transcript.other_calls, "child_usage": usage,
        "child_duration_ms": details.get("durationMs"),
        # Fixed synthetic/public smoke targets only; retain bounded final text to diagnose failures.
        **({"failure_answer_excerpt": answer[:1500]} if not all(checks.values()) else {}),
    }


def web_smoke_extension(raw_path: Path | None) -> Path:
    if raw_path is None:
        raise SystemExit("web smoke requires --web-extension pointing to the installed pi-web-access package entry file")
    path = raw_path.expanduser().resolve()
    if not path.is_file():
        raise SystemExit("--web-extension must name an existing pi-web-access package entry file")
    if not WEB_SMOKE_PARENT.is_file():
        raise SystemExit("source checkout is missing scripts/web-smoke-parent.ts")
    return path


def run_smoke(args: argparse.Namespace) -> int:
    web_extension = web_smoke_extension(args.web_extension) if args.capability == "web" else None
    presets = load_presets()
    selected = list(presets) if args.preset == "all" else [args.preset]
    results = []
    for preset in selected:
        selection = presets[preset]
        with tempfile.TemporaryDirectory(prefix="pi-subagent-live-") as temporary:
            cwd = Path(temporary)
            command = [*base_command(args.main_model, args.main_thinking), "--extension", str(EXTENSION_ENTRY)]
            if args.capability == "local":
                (cwd / "fixture.txt").write_text("SMOKE_MARKER=plain-final-answer\n", encoding="utf-8")
                command += ["--tools", "pi_subagent"]
                prompt = (
                    "Call pi_subagent exactly once with capability=local, scope=[\"fixture.txt\"], "
                    f"preset={preset}. Have the child report the exact SMOKE_MARKER value with fixture.txt:1 as evidence. "
                    "Do not read the file in the parent."
                )
            else:
                # A CLI --tools allowlist also removes registry entries needed for
                # provenance checks. The helper narrows active tools instead.
                command += ["--extension", str(web_extension), "--extension", str(WEB_SMOKE_PARENT)]
                prompt = (
                    f"Call pi_subagent exactly once with capability=web, scope=[], preset={preset}. "
                    f"Have the child fetch {SMOKE_WEB_URL} with fetch_content, retrieve the stored content if needed, "
                    f"and quote verbatim both the documentation-purpose clause and the registration/transfer restriction from the body. Cite {SMOKE_WEB_URL}. "
                    "Do not search: the URL is supplied. Do not guess from prior knowledge if extraction fails. "
                    "Do not use parent web tools and do not repeat the child investigation."
                )
            try:
                completed, observations = observe_run(
                    command, cwd=cwd, prompt=prompt, timeout=args.timeout_seconds,
                    **({"fetch_url": SMOKE_WEB_URL} if args.capability == "web" else {}),
                )
                result = evaluate_smoke(completed.stdout, observations, capability=args.capability, preset=preset, selection=selection)
                result["exit_code"] = completed.returncode
                if completed.returncode != 0:
                    result["status"] = "fail"
            except subprocess.TimeoutExpired:
                result = {"capability": args.capability, "preset": preset, "status": "fail", "error": "timeout"}
        results.append(result)
    passed = all(result["status"] == "pass" for result in results)
    print(json.dumps({"status": "pass" if passed else "fail", "results": results}, ensure_ascii=False, indent=2))
    return 0 if passed else 1


def positive_timeout(value: str) -> int:
    seconds = int(value)
    if not 1 <= seconds <= 1200:
        raise argparse.ArgumentTypeError("timeout must be between 1 and 1200 seconds")
    return seconds


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--main-model", default=f"{os.getenv('PI_PROVIDER', '')}/{os.getenv('PI_MODEL', '')}".strip("/"))
    parser.add_argument("--main-thinking", default=os.getenv("PI_REASONING_LEVEL", "high"))
    parser.add_argument("--capability", choices=("local", "web"), default="local")
    parser.add_argument("--web-extension", type=Path,
                        help="installed pi-web-access package entry file (required only for web smoke)")
    parser.add_argument("--preset", choices=("all", *load_presets()), default="all", help="smoke presets; all runs one fresh parent per preset")
    parser.add_argument("--timeout-seconds", type=positive_timeout, default=1200)
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    if not args.main_model or "/" not in args.main_model:
        raise SystemExit("--main-model provider/model is required when PI_PROVIDER and PI_MODEL are unavailable")
    return run_smoke(args)


if __name__ == "__main__":
    raise SystemExit(main())
