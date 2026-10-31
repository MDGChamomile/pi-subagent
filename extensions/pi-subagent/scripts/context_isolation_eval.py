#!/usr/bin/env python3
"""Controlled Pi A/B evaluation and local/web live smoke checks for pi-subagent."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from eval_runtime import investigation_tools, json_events, load_presets, observe_run, runtime_checks

EXTENSION_DIR = Path(__file__).resolve().parents[1]
EXTENSION_ENTRY = EXTENSION_DIR / "index.ts"
WEB_SMOKE_PARENT = Path(__file__).with_name("web-smoke-parent.ts")
SMOKE_WEB_URL = "https://www.iana.org/help/example-domains"
SMOKE_WEB_QUOTE = "not available for registration or transfer"
SMOKE_WEB_PURPOSE = "maintained for documentation purposes"
TOOL_SYNTAX_RE = re.compile(r"(?:^|\s)(?:to=|functions\.)\w+", re.I)
EVIDENCE_RE = re.compile(r"(?:fixture[/\\][^\s`:]+(?::\d+(?:-\d+)?)?|(?:incident|metrics|production|transfer)\.[a-z]+(?::\d+(?:-\d+)?)?)", re.I)


@dataclass(frozen=True)
class EvalCase:
    name: str
    profile: str
    task: str
    expected_groups: tuple[tuple[str, ...], ...]


CASES = (
    EvalCase(
        name="lookup",
        profile="lookup",
        task=(
            "Inspect the fixture logs and report the incident id, exact root cause, first failure UTC timestamp, "
            "and affected service. Cite the evidence file and line locations."
        ),
        expected_groups=(
            ("inc-7421",),
            ("expired service certificate", "expired certificate", "인증서 만료"),
            ("2026-08-25t03:14:15z", "03:14:15"),
            ("ledger-writer",),
        ),
    ),
    EvalCase(
        name="analysis",
        profile="analysis",
        task=(
            "Analyze the fixture configuration and metrics. Explain the capacity mismatch that caused timeouts, "
            "state the observed peak, and give the documented remediation. Cite evidence locations."
        ),
        expected_groups=(
            ("pool_limit=8", "pool limit 8", "풀 제한 8", "pool=8"),
            ("peak_concurrency=17", "peak concurrency 17", "최대 동시 17", "concurrency 17"),
            ("pool_limit=20", "increase pool limit to 20", "풀 제한을 20", "pool=20"),
        ),
    ),
    EvalCase(
        name="review",
        profile="review",
        task=(
            "Review the fixture transfer implementation for the most material concurrency defect. Explain the "
            "failure mode and the required class of fix, with file and line evidence."
        ),
        expected_groups=(
            ("race condition", "race", "경쟁 상태", "동시성 결함"),
            ("lost update", "업데이트 유실", "갱신 유실"),
            ("lock", "transaction", "mutex", "잠금", "트랜잭션"),
        ),
    ),
)


def write_fixture(root: Path) -> None:
    fixture = root / "fixture"
    fixture.mkdir(parents=True)
    noise = "\n".join(f"2026-08-25T03:{minute:02d}:00Z INFO heartbeat ok sequence={minute}" for minute in range(60))
    for index in range(1, 21):
        (fixture / f"worker-{index:02d}.log").write_text(noise + "\n", encoding="utf-8")
    (fixture / "incident.log").write_text(
        "2026-08-25T03:14:14Z INFO ledger-writer renewal check\n"
        "2026-08-25T03:14:15Z ERROR INCIDENT_ID=INC-7421\n"
        "2026-08-25T03:14:15Z ERROR ROOT_CAUSE=expired service certificate\n"
        "2026-08-25T03:14:15Z ERROR FIRST_FAILURE_UTC=2026-08-25T03:14:15Z\n"
        "2026-08-25T03:14:15Z ERROR AFFECTED_SERVICE=ledger-writer\n",
        encoding="utf-8",
    )
    (fixture / "production.conf").write_text("POOL_LIMIT=8\nREQUEST_TIMEOUT_SECONDS=30\n", encoding="utf-8")
    (fixture / "metrics.txt").write_text(
        "PEAK_CONCURRENCY=17\nTIMEOUTS_BEGIN_WHEN_ACTIVE_REQUESTS_EXCEED=8\n",
        encoding="utf-8",
    )
    (fixture / "runbook.md").write_text(
        "For sustained concurrency above 12, set POOL_LIMIT=20 and restart the worker pool.\n",
        encoding="utf-8",
    )
    (fixture / "transfer.ts").write_text(
        "const balances = new Map<string, number>();\n"
        "\n"
        "export async function transfer(id: string, amount: number) {\n"
        "  const before = balances.get(id) ?? 0;\n"
        "  await persistAuditRecord(id, amount);\n"
        "  balances.set(id, before - amount);\n"
        "}\n"
        "\n"
        "// Concurrent calls for one id are currently permitted.\n",
        encoding="utf-8",
    )


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
            or len(body.encode("utf-8")) > 12 * 1024):
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


def run_pi(
    *,
    cwd: Path,
    main_model: str,
    main_thinking: str,
    case: EvalCase,
    arm: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    child_preset = f"{case.profile}-standard"
    common = base_command(main_model, main_thinking)
    if arm == "direct":
        command = [*common, "--tools", "read,grep,find,ls"]
        prompt = (
            f"Investigate directly with the available local tools. Do not use a subagent.\n\nObjective:\n{case.task}\n\n"
            "Authorized fixture: fixture\nReturn a concise conclusion, material findings, and evidence locations."
        )
    else:
        command = [
            *common,
            "--extension", str(EXTENSION_ENTRY),
            "--tools", "read,grep,find,ls,pi_subagent",
        ]
        prompt = (
            "Use pi_subagent exactly once for the investigation. Pass capability=local, scope=[\"fixture\"], "
            f"and preset={child_preset}. Do not broadly re-read the delegated scope after "
            f"the result; only synthesize it.\n\nObjective:\n{case.task}"
        )
    started = time.monotonic()
    selection = load_presets()[child_preset]
    completed, observations = observe_run(
        command, cwd=cwd, prompt=prompt, timeout=timeout_seconds,
    )
    duration_ms = round((time.monotonic() - started) * 1000)
    if completed.returncode != 0:
        diagnostic = re.sub(r"\s+", " ", completed.stderr).strip()[:500]
        raise RuntimeError(f"Pi {arm} arm exited with {completed.returncode}: {diagnostic}")
    return _evaluate_context_output(
        completed.stdout, observations, case=case, arm=arm, child_preset=child_preset,
        selection=selection, duration_ms=duration_ms,
    )


@dataclass(frozen=True)
class SubagentResult:
    body: str
    is_error: bool
    details: dict[str, Any]


@dataclass
class ParentTranscript:
    prompt_tokens: list[int] = field(default_factory=list)
    final_text: str = ""
    subagent_calls: list[Any] = field(default_factory=list)
    other_calls: list[str] = field(default_factory=list)
    investigative_calls: int = 0
    post_subagent_investigative_calls: int = 0
    tool_result_bytes: int = 0
    investigative_tool_result_bytes: int = 0
    subagent_results: list[SubagentResult] = field(default_factory=list)

    def last_answer(self) -> SubagentResult | None:
        return next((result for result in reversed(self.subagent_results) if not result.is_error), None)


def parent_transcript(output: str) -> ParentTranscript:
    tools = investigation_tools()
    transcript = ParentTranscript()
    for event in json_events(output):
        message = event.get("message") if event.get("type") == "message_end" else None
        if not isinstance(message, dict):
            continue
        if message.get("role") == "assistant":
            usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
            transcript.prompt_tokens.append(int(sum(
                value if isinstance(value, (int, float)) else 0
                for value in (usage.get("input"), usage.get("cacheRead"), usage.get("cacheWrite"))
            )))
            text = text_content(message.get("content"))
            if text:
                transcript.final_text = text
            for block in message.get("content") or []:
                if not isinstance(block, dict) or block.get("type") != "toolCall":
                    continue
                name = block.get("name")
                if name == "pi_subagent":
                    transcript.subagent_calls.append(block.get("arguments"))
                else:
                    transcript.other_calls.append(str(name))
                if name in tools:
                    transcript.investigative_calls += 1
                    if transcript.subagent_results:
                        transcript.post_subagent_investigative_calls += 1
        elif message.get("role") == "toolResult":
            body = text_content(message.get("content"))
            size = len(body.encode("utf-8"))
            transcript.tool_result_bytes += size
            if message.get("toolName") in tools:
                transcript.investigative_tool_result_bytes += size
            if message.get("toolName") == "pi_subagent":
                details = message.get("details")
                transcript.subagent_results.append(SubagentResult(
                    body, bool(message.get("isError")), details if isinstance(details, dict) else {}))
    return transcript


def requested_call_matches(calls: list[Any], *, capability: str, preset: str, scope: list[str]) -> bool:
    return (len(calls) == 1 and isinstance(calls[0], dict)
            and calls[0].get("capability") == capability and calls[0].get("preset") == preset
            and calls[0].get("scope") == scope)


def _evaluate_context_output(
    output: str,
    observations: list[dict[str, Any]],
    *,
    case: EvalCase,
    arm: str,
    child_preset: str,
    selection: dict[str, str],
    duration_ms: int,
) -> dict[str, Any]:
    transcript = parent_transcript(output)
    last_answer = transcript.last_answer()
    result_text = last_answer.body if last_answer else ""
    child_details = last_answer.details if last_answer else {}
    delegation_checks = {
        "exactly_one_call": len(transcript.subagent_calls) == 1,
        "requested_preset_and_scope": requested_call_matches(
            transcript.subagent_calls, capability="local", preset=child_preset, scope=["fixture"]),
        "exactly_one_result": len(transcript.subagent_results) == 1,
        "no_tool_error": not any(result.is_error for result in transcript.subagent_results),
        "reported_preset": child_details.get("preset") == child_preset,
        "reported_capability": child_details.get("capability") == "local",
    } if arm == "subagent" else {
        "no_subagent_call_or_result": not transcript.subagent_calls and not transcript.subagent_results,
    }
    observed_checks = runtime_checks(observations, **selection) if arm == "subagent" else {}
    envelope = parse_result_envelope(result_text, child_details) if arm == "subagent" else None
    # Never substitute a parent answer for a missing or malformed delegated result.
    quality_text = (envelope["answer"] if envelope is not None else "") if arm == "subagent" else transcript.final_text
    matched = _count_expected_facts(quality_text, case.expected_groups)
    return {
        "case": case.name,
        "profile": case.profile,
        "arm": arm,
        "child_preset": child_preset if arm == "subagent" else None,
        "child_model": child_details.get("model"),
        "child_thinking": child_details.get("thinking"),
        "child_status": child_details.get("status"),
        "child_usage": child_details.get("usage"),
        "runtime_checks": observed_checks,
        "delegation_checks": delegation_checks,
        "delegation_contract_verified": all(delegation_checks.values()),
        "result_contract_verified": arm == "direct" or envelope is not None,
        "runtime_configuration_verified": arm == "direct" or (
            all(observed_checks.values()) and child_details.get("model") == selection["model"]
            and child_details.get("thinking") == selection["thinking"]
        ),
        "duration_ms": duration_ms,
        "max_parent_prompt_tokens": max(transcript.prompt_tokens, default=0),
        "parent_tool_result_bytes": transcript.tool_result_bytes,
        "parent_investigative_tool_result_bytes": transcript.investigative_tool_result_bytes,
        "parent_investigative_calls": transcript.investigative_calls,
        "post_subagent_investigative_calls": transcript.post_subagent_investigative_calls,
        "result_bytes": len(result_text.encode("utf-8")),
        "final_bytes": len(transcript.final_text.encode("utf-8")),
        "expected_facts_matched": matched,
        "expected_facts_total": len(case.expected_groups),
        "fact_recall": round(matched / len(case.expected_groups), 3),
        "has_evidence_location": bool(EVIDENCE_RE.search(quality_text)),
        "has_raw_tool_syntax": bool(TOOL_SYNTAX_RE.search(quality_text)),
        "subagent_result_received": bool(result_text),
        "result_text": result_text,
    }


def _count_expected_facts(answer: str, expected_groups: tuple[tuple[str, ...], ...]) -> int:
    normalize = lambda value: " ".join(re.sub(r"[^0-9a-z가-힣]+", " ", value.casefold()).split())
    normalized_quality = normalize(answer)
    return sum(any(normalize(candidate) in normalized_quality for candidate in group) for group in expected_groups)


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
        "within_12_kib": bool(result_text) and len(result_text.encode("utf-8")) <= 12 * 1024,
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


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    def mean(key: str, rows: list[dict[str, Any]]) -> float:
        return round(sum(float(row[key]) for row in rows) / len(rows), 3) if rows else 0.0

    direct = [row for row in results if row["arm"] == "direct"]
    subagent = [row for row in results if row["arm"] == "subagent"]
    summary: dict[str, Any] = {
        "runs": len(results),
        "direct_runs": len(direct),
        "subagent_runs": len(subagent),
        "mean_fact_recall": {
            "direct": mean("fact_recall", direct),
            "subagent": mean("fact_recall", subagent),
        },
        "mean_max_parent_prompt_tokens": {
            "direct": mean("max_parent_prompt_tokens", direct),
            "subagent": mean("max_parent_prompt_tokens", subagent),
        },
        "mean_parent_investigative_tool_result_bytes": {
            "direct": mean("parent_investigative_tool_result_bytes", direct),
            "subagent": mean("parent_investigative_tool_result_bytes", subagent),
        },
        "subagent_results_received": sum(bool(row["subagent_result_received"]) for row in subagent),
        "raw_tool_syntax_results": sum(bool(row["has_raw_tool_syntax"]) for row in results),
        "post_subagent_investigative_calls": sum(int(row["post_subagent_investigative_calls"]) for row in subagent),
    }
    direct_context = summary["mean_max_parent_prompt_tokens"]["direct"]
    sub_context = summary["mean_max_parent_prompt_tokens"]["subagent"]
    direct_bytes = summary["mean_parent_investigative_tool_result_bytes"]["direct"]
    sub_bytes = summary["mean_parent_investigative_tool_result_bytes"]["subagent"]
    summary["parent_context_reduction_pct"] = round(100 * (direct_context - sub_context) / direct_context, 1) if direct_context else None
    summary["parent_investigative_output_reduction_pct"] = round(100 * (direct_bytes - sub_bytes) / direct_bytes, 1) if direct_bytes else None
    return summary


def positive_timeout(value: str) -> int:
    seconds = int(value)
    if not 1 <= seconds <= 1200:
        raise argparse.ArgumentTypeError("timeout must be between 1 and 1200 seconds")
    return seconds


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("context", "smoke"), default="context")
    parser.add_argument("--main-model", default=f"{os.getenv('PI_PROVIDER', '')}/{os.getenv('PI_MODEL', '')}".strip("/"))
    parser.add_argument("--main-thinking", default=os.getenv("PI_REASONING_LEVEL", "high"))
    parser.add_argument("--case", choices=("all", *(case.name for case in CASES)), default="all")
    parser.add_argument("--capability", choices=("local", "web"), default="local")
    parser.add_argument("--web-extension", type=Path,
                        help="installed pi-web-access package entry file (required only for web smoke)")
    parser.add_argument("--preset", choices=("all", *load_presets()), default="all", help="smoke presets; all runs one fresh parent per preset")
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--timeout-seconds", type=positive_timeout, default=1200)
    parser.add_argument("--include-results", action="store_true", help="include deterministic fixture results for evaluator diagnostics")
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    if not args.main_model or "/" not in args.main_model:
        raise SystemExit("--main-model provider/model is required when PI_PROVIDER and PI_MODEL are unavailable")
    if args.mode == "smoke":
        return run_smoke(args)
    if args.repetitions < 1 or args.repetitions > 5:
        raise SystemExit("--repetitions must be between 1 and 5")
    selected = list(CASES if args.case == "all" else (next(case for case in CASES if case.name == args.case),))
    results: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="pi-subagent-ab-") as temporary:
        cwd = Path(temporary)
        write_fixture(cwd)
        for _ in range(args.repetitions):
            for case in selected:
                results.append(run_pi(
                    cwd=cwd,
                    main_model=args.main_model,
                    main_thinking=args.main_thinking,
                    case=case,
                    arm="direct",
                    timeout_seconds=args.timeout_seconds,
                ))
                results.append(run_pi(
                    cwd=cwd,
                    main_model=args.main_model,
                    main_thinking=args.main_thinking,
                    case=case,
                    arm="subagent",
                    timeout_seconds=args.timeout_seconds,
                ))
    if not args.include_results:
        for result in results:
            result.pop("result_text", None)
    print(json.dumps({"scope": {
        "mode": args.mode,
        "main_model": args.main_model,
        "main_thinking": args.main_thinking,
        "cases": [case.name for case in selected],
        "repetitions": args.repetitions,
    }, "summary": summarize(results), "results": results}, ensure_ascii=False, indent=2))
    return 0 if all(row["runtime_configuration_verified"] and row["result_contract_verified"]
                    and row["delegation_contract_verified"] for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
