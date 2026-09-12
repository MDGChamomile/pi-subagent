#!/usr/bin/env python3
"""Offline evidence diagnostics, not a semantic or confirmatory quality scorer."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import sys
import unicodedata

HEADERS = ("Conclusion", "Findings", "Evidence", "Uncertainties")
CITATION = re.compile(r"(?P<path>[^\s`:\[\]]+):(?P<start>[0-9]+)(?:-(?P<end>[0-9]+))?")
NUMBER = re.compile(r"(?<![\w.,+-])[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?(?![\w.,])")


def normalize(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).replace("`", "").casefold().split())


def safe_path(text: str) -> bool:
    return bool(text) and not (text.startswith("/") or "\\" in text or ":" in text
                              or any(p in ("..", ".git") for p in text.split("/")))


class Snapshot:
    """Read only contained regular files; never traverse directory symlinks."""

    def __init__(self, root: Path):
        self.root = root.resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("snapshot must be a directory")
        self.files: dict[str, Path] = {}
        pending = [self.root]
        while pending:
            directory = pending.pop()
            for path in sorted(directory.iterdir()):
                if path.name == ".git" or path.is_symlink():
                    continue
                if path.is_dir():
                    pending.append(path)
                elif path.is_file():
                    self.files[path.relative_to(self.root).as_posix()] = path

    def resolve(self, text: str, *, exact: bool = False) -> tuple[str | None, str | None]:
        if not safe_path(text):
            return None, "unsafe_path"
        key = PurePosixPath(text).as_posix()
        if key in self.files:
            return key, None
        if exact:
            return None, "missing_file"
        matches = [p for p in self.files if p.endswith("/" + key)]
        if len(matches) > 1:
            return None, "ambiguous_path"
        return (matches[0], None) if matches else (None, "missing_file")

    def line_count(self, key: str) -> int:
        path = self.files[key]
        # Recheck containment before reading. Inputs must remain immutable during scoring.
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(self.root) or any(
            p.is_symlink() for p in (path, *path.parents) if p != self.root and p.is_relative_to(self.root)
        ):
            raise ValueError("snapshot changed or contains a symlink")
        return len(path.read_text(encoding="utf-8").splitlines())


def integer(value: object) -> bool:
    return type(value) is int


def aliases(value: object) -> bool:
    return isinstance(value, list) and bool(value) and all(isinstance(x, str) and normalize(x) for x in value)


def validate_rubric(task: dict, snapshot: Snapshot) -> None:
    if not isinstance(task, dict) or not isinstance(task.get("task_id"), str) or not task["task_id"].strip():
        raise ValueError("task_id must be a nonempty string")
    for collection, id_key in (("evidence", "evidence_id"), ("required_claims", "claim_id")):
        rows = task.get(collection)
        if not isinstance(rows, list) or not rows:
            raise ValueError(f"{collection} must be a nonempty list")
        seen = set()
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get(id_key), str) or not row[id_key].strip():
                raise ValueError(f"invalid {id_key}")
            if row[id_key] in seen:
                raise ValueError(f"duplicate {id_key}")
            seen.add(row[id_key])
    evidence_ids = {e["evidence_id"] for e in task["evidence"]}
    for evidence in task["evidence"]:
        path = evidence.get("path")
        if not isinstance(path, str):
            raise ValueError("evidence path must be a string")
        key, error = snapshot.resolve(path, exact=True)
        start, end = evidence.get("line_start"), evidence.get("line_end")
        if error or not integer(start) or not integer(end) or not 1 <= start <= end <= snapshot.line_count(key):
            raise ValueError("invalid gold evidence path or range")
    for claim in task["required_claims"]:
        ids = claim.get("evidence_ids")
        if not isinstance(ids, list) or not ids or any(not isinstance(i, str) or i not in evidence_ids for i in ids):
            raise ValueError("claim must reference known evidence_ids")
        matcher = claim.get("matcher")
        if not isinstance(matcher, dict):
            raise ValueError("invalid matcher")
        kind = matcher.get("type")
        if kind == "normalized_text_any":
            valid = aliases(matcher.get("accepted_values"))
        elif kind == "number":
            valid = all(type(matcher.get(k)) in (int, float) and math.isfinite(matcher[k])
                        for k in ("value", "absolute_tolerance"))
            valid = valid and matcher["absolute_tolerance"] >= 0
            units = matcher.get("unit_aliases", [])
            valid = valid and isinstance(units, list) and (not units or aliases(units))
        elif kind == "relation":
            valid = all(aliases(matcher.get(k)) for k in ("subject_aliases", "relation_aliases", "object_aliases"))
        else:
            valid = False
        if not valid:
            raise ValueError("unsupported or malformed matcher")


def phrase_present(text: str, alias: str) -> bool:
    return re.search(r"(?<!\w)" + re.escape(normalize(alias)) + r"(?!\w)", text) is not None


def lexical_match(text: str, matcher: dict) -> bool | None:
    kind = matcher["type"]
    if kind == "relation":
        # Word co-occurrence cannot establish a relation, direction, or negation.
        return None
    if kind == "normalized_text_any":
        return any(phrase_present(text, alias) for alias in matcher["accepted_values"])
    for match in NUMBER.finditer(text):
        number = float(match.group())
        if not math.isfinite(number) or abs(number - matcher["value"]) > matcher["absolute_tolerance"]:
            continue
        units = matcher.get("unit_aliases", [])
        tail = text[match.end():].lstrip()
        if not units or any(re.match(re.escape(normalize(u)) + r"(?!\w)", tail) for u in units):
            return True
    return False


def evaluate(task: dict, answer: str, root: Path) -> dict:
    if not isinstance(answer, str):
        raise ValueError("answer must be a string")
    snapshot = Snapshot(root)
    validate_rubric(task, snapshot)
    citations, diagnostics, prose, headings = [], [], [], []
    section = None
    for line_number, line in enumerate(answer.splitlines(), 1):
        heading = re.sub(r"^#{1,6}\s+", "", line.strip()).rstrip(":").strip()
        if heading in HEADERS:
            section = heading
            headings.append(heading)
            continue
        if section != "Evidence" or not line.strip():
            if section in ("Conclusion", "Findings"):
                prose.append(line)
            continue
        # A deliberately bounded grammar: one bullet, one citation, a separator and explanation.
        body = re.sub(r"^[-*+]\s+", "", line.strip())
        citation_text = re.split(r"\s+[—–-]\s+", body, maxsplit=1)[0].strip()
        if citation_text.startswith("`") and citation_text.endswith("`"):
            citation_text = citation_text[1:-1]
        match = CITATION.fullmatch(citation_text)
        if match is None:
            diagnostics.append({"answer_line": line_number, "reason": "unparsed_evidence_line"})
            continue
        path = match["path"]
        start, end = int(match["start"]), int(match["end"] or match["start"])
        key, error = snapshot.resolve(path)
        if error is None:
            try:
                if not 1 <= start <= end <= snapshot.line_count(key):
                    error = "invalid_line_range"
            except (OSError, UnicodeError, ValueError):
                error = "unreadable_or_changed_file"
        citations.append({"path": path, "resolved": key, "start": start, "end": end,
                          "valid": error is None, "reason": error})
    # Unique canonical ranges, not repeated citation occurrences, determine coverage.
    valid = {(c["resolved"], c["start"], c["end"]) for c in citations if c["valid"]}
    gold: dict[str, set[int]] = {}
    hits = []
    for e in task["evidence"]:
        key, _ = snapshot.resolve(e["path"], exact=True)
        gold.setdefault(key, set()).update(range(e["line_start"], e["line_end"] + 1))
        if any(p == key and start <= e["line_end"] and end >= e["line_start"] for p, start, end in valid):
            hits.append(e["evidence_id"])
    cited: dict[str, set[int]] = {}
    for path, start, end in valid:
        cited.setdefault(path, set()).update(range(start, end + 1))
    total_lines = sum(len(lines) for lines in cited.values())
    overlap = sum(len(lines & gold.get(path, set())) for path, lines in cited.items())
    text = normalize("\n".join(prose))
    claims = [{"claim_id": c["claim_id"], "lexical_match": lexical_match(text, c["matcher"]),
               "overlapping_evidence_ids": [i for i in c["evidence_ids"] if i in hits],
               "semantic_support": "not_assessed"} for c in task["required_claims"]]
    denominator = len(citations) + len(diagnostics)
    return {
        "schema_version": 1, "task_id": task["task_id"],
        "status": "empty_answer" if not answer.strip() else "diagnostics_only",
        "scorer_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "answer_sha256": hashlib.sha256(answer.encode()).hexdigest(),
        "rubric_sha256": hashlib.sha256(json.dumps(task, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest(),
        "format_ok": headings == list(HEADERS), "citations": citations, "diagnostics": diagnostics,
        "citation_validity": sum(c["valid"] for c in citations) / denominator if denominator else 0,
        "overlapping_evidence_ids": hits, "evidence_span_recall": len(hits) / len(task["evidence"]),
        "unique_cited_lines": total_lines,
        "gold_line_precision": overlap / total_lines if total_lines else 0,
        "claims": claims, "total_score": None,
        "not_assessed": ["causal_logic", "semantic_support", "completeness", "unsupported_claims", "quality_non_inferiority"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", type=Path, required=True)
    parser.add_argument("--answer", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = evaluate(json.loads(args.task.read_text(encoding="utf-8")),
                          args.answer.read_text(encoding="utf-8"), args.snapshot)
    except (ValueError, OSError, UnicodeError, OverflowError) as error:
        print(json.dumps({"status": "invalid_input", "error_type": type(error).__name__}), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
