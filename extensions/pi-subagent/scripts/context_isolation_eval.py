#!/usr/bin/env python3
"""Controlled Pi A/B evaluation and local/web live smoke checks for pi-subagent."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

EXTENSION_DIR = Path(__file__).resolve().parents[1]
EXTENSION_ENTRY = EXTENSION_DIR / "index.ts"
AGENT_ROOT = Path(os.getenv("PI_CODING_AGENT_DIR", Path.home() / ".pi" / "agent")).expanduser()
WEB_EXTENSION = AGENT_ROOT / "npm" / "node_modules" / "pi-web-access" / "index.ts"
WEB_TOOL_LOADER = AGENT_ROOT / "extensions" / "web-tool-loader.ts"
WEB_TOOL_NAMES = {"web_search", "source_check", "fetch_content", "get_search_content"}
INVESTIGATION_TOOLS = {"read", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content", "source_check"}
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


def json_events(output: str):
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            yield event


def base_command(main_model: str, main_thinking: str) -> list[str]:
    pi = shutil.which("pi")
    if not pi:
        raise RuntimeError("pi executable is unavailable")
    return [
        pi,
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
    completed = subprocess.run(
        command,
        cwd=cwd,
        input=prompt,
        text=True,
        capture_output=True,
        timeout=timeout_seconds,
        check=False,
    )
    duration_ms = round((time.monotonic() - started) * 1000)
    if completed.returncode != 0:
        diagnostic = re.sub(r"\s+", " ", completed.stderr).strip()[:500]
        raise RuntimeError(f"Pi {arm} arm exited with {completed.returncode}: {diagnostic}")

    assistant_prompts: list[int] = []
    tool_result_bytes = 0
    investigative_tool_result_bytes = 0
    investigative_calls = 0
    post_subagent_investigative_calls = 0
    subagent_finished = False
    result_text = ""
    final_text = ""
    for event in json_events(completed.stdout):
        if event.get("type") != "message_end" or not isinstance(event.get("message"), dict):
            continue
        message = event["message"]
        role = message.get("role")
        if role == "assistant":
            usage = message.get("usage") or {}
            prompt_tokens = sum(
                value if isinstance(value, (int, float)) else 0
                for value in (usage.get("input"), usage.get("cacheRead"), usage.get("cacheWrite"))
            )
            assistant_prompts.append(int(prompt_tokens))
            text = text_content(message.get("content"))
            if text:
                final_text = text
            for block in message.get("content") or []:
                if not isinstance(block, dict) or block.get("type") != "toolCall":
                    continue
                name = block.get("name")
                if name in INVESTIGATION_TOOLS:
                    investigative_calls += 1
                    if subagent_finished:
                        post_subagent_investigative_calls += 1
        elif role == "toolResult":
            body = text_content(message.get("content"))
            size = len(body.encode("utf-8"))
            tool_result_bytes += size
            if message.get("toolName") in INVESTIGATION_TOOLS:
                investigative_tool_result_bytes += size
            if message.get("toolName") == "pi_subagent":
                subagent_finished = True
                if not message.get("isError"):
                    result_text = body

    quality_text = result_text if arm == "subagent" and result_text else final_text
    normalize = lambda value: " ".join(re.sub(r"[^0-9a-z가-힣]+", " ", value.casefold()).split())
    normalized_quality = normalize(quality_text)
    matched = sum(any(normalize(candidate) in normalized_quality for candidate in group) for group in case.expected_groups)
    return {
        "case": case.name,
        "profile": case.profile,
        "arm": arm,
        "child_preset": child_preset if arm == "subagent" else None,
        "duration_ms": duration_ms,
        "max_parent_prompt_tokens": max(assistant_prompts, default=0),
        "parent_tool_result_bytes": tool_result_bytes,
        "parent_investigative_tool_result_bytes": investigative_tool_result_bytes,
        "parent_investigative_calls": investigative_calls,
        "post_subagent_investigative_calls": post_subagent_investigative_calls,
        "result_bytes": len(result_text.encode("utf-8")),
        "final_bytes": len(final_text.encode("utf-8")),
        "expected_facts_matched": matched,
        "expected_facts_total": len(case.expected_groups),
        "fact_recall": round(matched / len(case.expected_groups), 3),
        "has_evidence_location": bool(EVIDENCE_RE.search(quality_text)),
        "has_raw_tool_syntax": bool(TOOL_SYNTAX_RE.search(quality_text)),
        "subagent_result_received": bool(result_text),
        "result_text": result_text,
    }


def run_smoke(args: argparse.Namespace) -> int:
    if args.capability == "web":
        for path in (WEB_EXTENSION, WEB_TOOL_LOADER):
            if not path.is_file():
                raise SystemExit(f"web smoke dependency is unavailable: {path}")

    with tempfile.TemporaryDirectory(prefix="pi-subagent-live-") as temporary:
        cwd = Path(temporary)
        command = [*base_command(args.main_model, args.main_thinking), "--extension", str(EXTENSION_ENTRY)]
        if args.capability == "local":
            (cwd / "fixture.txt").write_text("SMOKE_MARKER=plain-final-answer\n", encoding="utf-8")
            command += ["--tools", "pi_subagent"]
            prompt = (
                "Call pi_subagent exactly once with capability=local, scope=[\"fixture.txt\"], "
                "preset=lookup-standard. Report the exact SMOKE_MARKER value with fixture.txt:1 as evidence. "
                "Do not read the file in the parent."
            )
        else:
            command += [
                "--extension", str(WEB_EXTENSION),
                "--extension", str(WEB_TOOL_LOADER),
            ]
            prompt = (
                "Call pi_subagent exactly once with capability=web, scope=[], preset=lookup-standard. "
                "Verify the public page https://example.com and report its page title or primary heading with the URL "
                "as evidence. Do not use parent web tools and do not repeat the child investigation."
            )
        completed = subprocess.run(
            command,
            cwd=cwd,
            input=prompt,
            text=True,
            capture_output=True,
            timeout=args.timeout_seconds,
            check=False,
        )
    if completed.returncode != 0:
        diagnostic = re.sub(r"\s+", " ", completed.stderr).strip()[:500]
        raise SystemExit(f"live smoke process failed with {completed.returncode}: {diagnostic}")

    answers: list[str] = []
    errors: list[str] = []
    parent_web_calls: list[str] = []
    for event in json_events(completed.stdout):
        message = event.get("message") if event.get("type") == "message_end" else None
        if not isinstance(message, dict):
            continue
        if message.get("role") == "assistant":
            for block in message.get("content") or []:
                if not isinstance(block, dict) or block.get("type") != "toolCall":
                    continue
                name = block.get("name")
                if name in WEB_TOOL_NAMES or name == "load_web_tools":
                    parent_web_calls.append(str(name))
        elif message.get("role") == "toolResult" and message.get("toolName") == "pi_subagent":
            body = text_content(message.get("content"))
            (errors if message.get("isError") else answers).append(body[:500] if message.get("isError") else body)

    checks = {
        "exactly_one_result": len(answers) == 1,
        "no_tool_error": not errors,
        "non_empty_answer": len(answers) == 1 and bool(answers[0].strip()),
        "within_12_kib": len(answers) == 1 and len(answers[0].encode("utf-8")) <= 12 * 1024,
        "no_raw_tool_syntax": len(answers) == 1 and not TOOL_SYNTAX_RE.search(answers[0]),
        "expected_fact": len(answers) == 1 and (
            (args.capability == "local" and "plain-final-answer" in answers[0])
            or (args.capability == "web" and "example domain" in answers[0].casefold())
        ),
        "no_parent_web_activation_or_calls": not parent_web_calls,
    }
    passed = all(checks.values())
    print(json.dumps({
        "capability": args.capability,
        "status": "pass" if passed else "fail",
        "checks": checks,
        "result_bytes": len(answers[0].encode("utf-8")) if len(answers) == 1 else 0,
        "errors": errors,
        "parent_web_calls": parent_web_calls,
    }, ensure_ascii=False, indent=2))
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("context", "smoke"), default="context")
    parser.add_argument("--main-model", default=f"{os.getenv('PI_PROVIDER', '')}/{os.getenv('PI_MODEL', '')}".strip("/"))
    parser.add_argument("--main-thinking", default=os.getenv("PI_REASONING_LEVEL", "high"))
    parser.add_argument("--case", choices=("all", *(case.name for case in CASES)), default="all")
    parser.add_argument("--capability", choices=("local", "web"), default="local")
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--timeout-seconds", type=int, default=1200)
    parser.add_argument("--include-results", action="store_true", help="include deterministic fixture results for evaluator diagnostics")
    return parser.parse_args()


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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
