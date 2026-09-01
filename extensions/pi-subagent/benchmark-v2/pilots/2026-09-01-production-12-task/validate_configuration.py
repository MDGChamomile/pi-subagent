#!/usr/bin/env python3
"""Validate actual pilot arm/model configuration from normalized run telemetry."""
from __future__ import annotations
import hashlib, json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXPECTED = {
    "lookup": ("lookup-standard", "openai-codex/gpt-5.6-luna", "medium"),
    "analysis": ("analysis-standard", "openai-codex/gpt-5.6-terra", "medium"),
    "review": ("review-standard", "openai-codex/gpt-5.6-sol", "medium"),
}

def main() -> None:
    schedule = json.load(open(ROOT / "schedule.json"))["runs"]
    tasks = {task["id"]: task for task in json.load(open(ROOT / "tasks.json"))["tasks"]}
    mismatches: list[dict[str, object]] = []
    observed: Counter[tuple[str, str, str, str]] = Counter()
    for assigned in schedule:
        run_id = assigned["run_id"]
        path = ROOT / "normalized" / f"{run_id}.json"
        if not path.is_file():
            mismatches.append({"run_id": run_id, "reason": "normalized record missing"})
            continue
        run = json.load(open(path))
        profile = tasks[assigned["task_id"]]["profile"]
        calls = run["parent"]["tool_names"].count("pi_subagent")
        if assigned["arm"] == "A":
            if calls != 0 or run["child"] is not None:
                mismatches.append({"run_id": run_id, "reason": "direct arm used or reported a child"})
            continue
        if calls != 1 or not run["child"]:
            mismatches.append({"run_id": run_id, "reason": "delegated arm did not report exactly one child"})
            continue
        child = run["child"]
        expected = EXPECTED[profile]
        actual = (child["preset"], child["model"], child["thinking"])
        observed[(profile, *actual)] += 1
        if actual != expected:
            mismatches.append({"run_id": run_id, "reason": "child configuration mismatch", "expected": expected, "actual": actual})
    result = {
        "status": "pass" if not mismatches else "fail",
        "assigned_parent_runs": len(schedule),
        "validated_direct_runs": sum(run["arm"] == "A" for run in schedule),
        "validated_delegated_runs": sum(run["arm"] == "B" for run in schedule),
        "expected": {profile: {"preset": value[0], "model": value[1], "thinking": value[2]} for profile, value in EXPECTED.items()},
        "observed": [
            {"profile": key[0], "preset": key[1], "model": key[2], "thinking": key[3], "runs": count}
            for key, count in sorted(observed.items())
        ],
        "mismatches": mismatches,
        "validator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }
    (ROOT / "CONFIGURATION_VALIDATION.json").write_text(json.dumps(result, sort_keys=True, indent=2) + "\n")
    print(json.dumps(result, sort_keys=True))
    if mismatches:
        raise SystemExit(1)

if __name__ == "__main__":
    main()
