#!/usr/bin/env python3
"""Add reproducible post-run resource metrics to the frozen pilot summary.

The frozen score_pilot.py owns normalization and quality scoring. This separate
step derives only aggregate context, usage, cost, latency, and tool metrics from
its normalized run records, so the scoring freeze remains unchanged.
"""
from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent


def ratio_change(before: float, after: float) -> float:
    if before == 0:
        raise ValueError("cannot derive a ratio from a zero direct-arm value")
    return after / before - 1


def ratio_reduction(before: float, after: float) -> float:
    return -ratio_change(before, after)


def load_records() -> list[dict[str, Any]]:
    schedule = json.load(open(ROOT / "schedule.json"))["runs"]
    records: list[dict[str, Any]] = []
    for assigned in schedule:
        path = ROOT / "normalized" / f"{assigned['run_id']}.json"
        if not path.is_file():
            raise FileNotFoundError(f"normalized record missing: {path}")
        record = json.load(open(path))
        for field in ("run_id", "task_id", "arm", "repetition"):
            if record[field] != assigned[field]:
                raise ValueError(f"{path}: {field} does not match the frozen schedule")
        records.append(record)
    return records


def derive_metrics(records: list[dict[str, Any]]) -> dict[str, int | float]:
    direct = [record for record in records if record["arm"] == "A"]
    delegated = [record for record in records if record["arm"] == "B"]
    if len(direct) != 36 or len(delegated) != 36:
        raise ValueError("expected exactly 36 direct and 36 delegated records")

    parent_prompt_a = sum(record["parent"]["prompt_cumulative"] for record in direct)
    parent_prompt_b = sum(record["parent"]["prompt_cumulative"] for record in delegated)
    combined_tokens_a = sum(record["combined"]["totalTokens"] for record in direct)
    combined_tokens_b = sum(record["combined"]["totalTokens"] for record in delegated)
    reported_cost_a = sum(record["combined"]["cost"] for record in direct)
    reported_cost_b = sum(record["combined"]["cost"] for record in delegated)
    parent_peak_a = statistics.median(record["parent"]["prompt_peak"] for record in direct)
    parent_peak_b = statistics.median(record["parent"]["prompt_peak"] for record in delegated)
    wall_a = statistics.median(record["process"]["wall_ms"] for record in direct)
    wall_b = statistics.median(record["process"]["wall_ms"] for record in delegated)

    return {
        "corpus_combined_token_reduction": ratio_reduction(combined_tokens_a, combined_tokens_b),
        "corpus_parent_prompt_reduction": ratio_reduction(parent_prompt_a, parent_prompt_b),
        "corpus_reported_cost_reduction": ratio_reduction(reported_cost_a, reported_cost_b),
        "median_parent_peak_A": parent_peak_a,
        "median_parent_peak_B": parent_peak_b,
        "median_parent_peak_reduction": ratio_reduction(parent_peak_a, parent_peak_b),
        "median_wall_change_B_vs_A": ratio_change(wall_a, wall_b),
        "parent_tool_calls_A": sum(record["parent"]["tool_calls"] for record in direct),
        "parent_tool_calls_B": sum(record["parent"]["tool_calls"] for record in delegated),
        "parent_tool_result_bytes_A": sum(record["parent"]["tool_result_bytes"] for record in direct),
        "parent_tool_result_bytes_B": sum(record["parent"]["tool_result_bytes"] for record in delegated),
    }


def augmented_summary(summary: dict[str, Any], records: list[dict[str, Any]]) -> dict[str, Any]:
    result = json.loads(json.dumps(summary))
    result["overall"].update(derive_metrics(records))
    return result


def encoded_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify that summary.json already contains the derived metrics")
    args = parser.parse_args()

    summary_path = ROOT / "summary.json"
    current = json.load(open(summary_path))
    expected = augmented_summary(current, load_records())
    encoded = encoded_json(expected)

    if args.check:
        if summary_path.read_text() != encoded:
            raise SystemExit("summary.json does not match the reproducible post-run derivation")
        print("summary.json: reproducible post-run metrics verified")
        return

    summary_path.write_text(encoded)
    print("summary.json: reproducible post-run metrics written")


if __name__ == "__main__":
    main()
