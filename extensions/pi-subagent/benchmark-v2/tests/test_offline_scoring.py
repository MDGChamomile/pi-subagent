"""Synthetic offline contracts; no provider calls or archived pilot records."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "offline_scoring.py"
spec = importlib.util.spec_from_file_location("offline_scoring", MODULE)
scorer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scorer)


class OfflineScoringTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / "snapshot"
        (self.root / "src").mkdir(parents=True)
        (self.root / "src/main.py").write_text("\n".join(f"line {i}" for i in range(1, 101)) + "\n")
        self.task = {
            "task_id": "lookup-fixture",
            "evidence": [{"evidence_id": "ev", "path": "src/main.py", "line_start": 10, "line_end": 11}],
            "required_claims": [{"claim_id": "limit", "evidence_ids": ["ev"],
                                 "matcher": {"type": "normalized_text_any", "accepted_values": ["bounded queue"]}}],
        }

    def answer(self, citations="- src/main.py:10-11 — source", findings="A bounded queue is used."):
        return f"Conclusion\nResult.\n\nFindings\n{findings}\n\nEvidence\n{citations}\n\nUncertainties\nNone.\n"

    def score(self, citations="- src/main.py:10-11 — source", findings="A bounded queue is used."):
        return scorer.evaluate(self.task, self.answer(citations, findings), self.root)

    def test_backticks_and_heading_markup_are_equivalent(self):
        plain = self.score()
        decorated = scorer.evaluate(self.task, self.answer("- `src/main.py:10-11` — source").replace("Findings\n", "## Findings\n"), self.root)
        for key in ("citations", "citation_validity", "evidence_span_recall", "gold_line_precision", "format_ok", "claims"):
            self.assertEqual(plain[key], decorated[key])

    def test_invalid_paths_ranges_and_malformed_citations(self):
        for citation in ("missing.py:1", "src/main.py:0", "src/main.py:101", "src/main.py:11-10"):
            with self.subTest(citation=citation):
                result = self.score(f"- {citation} — source")
                self.assertFalse(result["citations"][0]["valid"])
                self.assertEqual(result["evidence_span_recall"], 0)
        for citation in ("src/main.py:ten", "src/main.py:10-", "`src/main.py:10", "src/main.py:10, src/main.py:11"):
            with self.subTest(citation=citation):
                result = self.score(f"- {citation} — source")
                self.assertEqual(len(result["diagnostics"]), 1)
                self.assertEqual(result["citation_validity"], 0)

    def test_ambiguous_basename_and_exact_resolution(self):
        (self.root / "other").mkdir()
        (self.root / "other/main.py").write_text("other\n")
        self.assertEqual(self.score("- main.py:1 — x")["citations"][0]["reason"], "ambiguous_path")
        self.assertTrue(self.score()["citations"][0]["valid"])

    def test_unique_suffix_resolves(self):
        self.assertEqual(self.score("- main.py:10-11 — x")["evidence_span_recall"], 1)

    def test_outside_and_symlinks_are_never_read(self):
        outside = self.base / "outside.txt"
        outside.write_text("private\n")
        (self.root / "link.txt").symlink_to(outside)
        (self.root / "dirlink").symlink_to(self.base, target_is_directory=True)
        original = Path.read_text
        reads = []

        def checked(path, *args, **kwargs):
            reads.append(path)
            self.assertNotEqual(path.resolve(), outside.resolve())
            return original(path, *args, **kwargs)

        with patch.object(Path, "read_text", checked):
            for path in (str(outside), "../outside.txt", "src/../../outside.txt", "link.txt", "dirlink/outside.txt", "C:\\outside.txt"):
                result = self.score(f"- {path}:1 — source")
                self.assertEqual(result["citation_validity"], 0)
                self.assertEqual(result["evidence_span_recall"], 0)
        self.assertNotIn(outside, reads)

    def test_internal_symlink_is_also_rejected(self):
        (self.root / "alias.py").symlink_to(self.root / "src/main.py")
        self.assertFalse(self.score("- alias.py:10 — x")["citations"][0]["valid"])

    def test_repeated_and_overlapping_ranges_do_not_inflate_coverage(self):
        result = self.score("- src/main.py:10-11 — x\n- main.py:10-11 — x\n- src/main.py:11 — x")
        self.assertEqual(result["evidence_span_recall"], 1)
        self.assertEqual(result["unique_cited_lines"], 2)
        self.assertEqual(result["gold_line_precision"], 1)

    def test_whole_file_has_low_line_precision_not_semantic_credit(self):
        result = self.score("- src/main.py:1-100 — x")
        self.assertEqual(result["citation_validity"], 1)
        self.assertEqual(result["evidence_span_recall"], 1)
        self.assertEqual(result["gold_line_precision"], 0.02)
        self.assertEqual(result["claims"][0]["semantic_support"], "not_assessed")
        self.assertIsNone(result["total_score"])

    def test_valid_but_unrelated_citation(self):
        result = self.score("- src/main.py:50 — x")
        self.assertEqual(result["citation_validity"], 1)
        self.assertEqual(result["evidence_span_recall"], 0)
        self.assertEqual(result["claims"][0]["overlapping_evidence_ids"], [])

    def test_unparsed_lines_are_visible_and_not_dropped_from_denominator(self):
        result = self.score("- src/main.py:10 — x\n- src/main.py:unknown — y")
        self.assertEqual(result["citation_validity"], 0.5)
        self.assertEqual(len(result["diagnostics"]), 1)

    def test_claims_do_not_match_evidence_commentary_or_word_fragments(self):
        result = self.score("- src/main.py:10 — bounded queue", "An unbounded queue exists.")
        self.assertFalse(result["claims"][0]["lexical_match"])
        self.assertTrue(self.score(findings="A `BOUNDED`   queue exists.")["claims"][0]["lexical_match"])

    def test_negation_is_not_misrepresented_as_semantically_validated(self):
        result = self.score(findings="There is no bounded queue.")
        self.assertTrue(result["claims"][0]["lexical_match"])
        self.assertEqual(result["claims"][0]["semantic_support"], "not_assessed")
        self.assertIn("unsupported_claims", result["not_assessed"])

    def test_number_tolerance_units_and_citation_exclusion(self):
        self.task["required_claims"][0]["matcher"] = {"type": "number", "value": 10, "absolute_tolerance": 0.1, "unit_aliases": ["ms"]}
        for text, expected in (("10.05 ms", True), ("1e1 ms", True), ("10.2 ms", False), ("10 seconds", False), ("110 ms", False), ("1,010 ms", False), ("-10 ms", False), ("No number", False)):
            self.assertEqual(self.score(findings=text)["claims"][0]["lexical_match"], expected)

    def test_unreadable_citation_is_invalid_but_bad_gold_fails(self):
        (self.root / "binary.txt").write_bytes(b"\xff\xfe")
        result = self.score("- binary.txt:1 — x")
        self.assertEqual(result["citations"][0]["reason"], "unreadable_or_changed_file")
        self.task["evidence"][0].update(path="binary.txt", line_start=1, line_end=1)
        with self.assertRaises(UnicodeError):
            self.score()

    def test_relation_is_explicitly_unassessed(self):
        self.task["required_claims"][0]["matcher"] = {"type": "relation", "subject_aliases": ["queue"], "relation_aliases": ["limits"], "object_aliases": ["calls"]}
        self.assertIsNone(self.score(findings="queue limits calls")["claims"][0]["lexical_match"])

    def test_empty_and_invalid_format(self):
        result = scorer.evaluate(self.task, "", self.root)
        self.assertEqual(result["status"], "empty_answer")
        self.assertFalse(result["format_ok"])
        self.assertEqual(result["evidence_span_recall"], 0)
        self.assertIsNone(result["total_score"])
        result = scorer.evaluate(self.task, "Some Findings text\n- src/main.py:10", self.root)
        self.assertFalse(result["format_ok"])
        self.assertEqual(result["citations"], [])

    def test_bad_rubrics_raise_instead_of_scoring(self):
        mutations = [lambda t: t.update(evidence=[]),
                     lambda t: t["evidence"][0].update(line_end=500),
                     lambda t: t["evidence"][0].update(line_start=True),
                     lambda t: t["evidence"][0].update(path="../outside.txt"),
                     lambda t: t["evidence"].append(copy.deepcopy(t["evidence"][0])),
                     lambda t: t["required_claims"][0].update(evidence_ids=["unknown"]),
                     lambda t: t["required_claims"][0].update(matcher={"type": "unknown"}),
                     lambda t: t["required_claims"][0].update(matcher={"type": "number", "value": float("nan"), "absolute_tolerance": 0}),
                     lambda t: t["required_claims"][0].update(matcher={"type": "normalized_text_any", "accepted_values": [" "]})]
        for mutate in mutations:
            task = copy.deepcopy(self.task)
            mutate(task)
            with self.assertRaises(ValueError):
                scorer.evaluate(task, self.answer(), self.root)
        for task in (None, [], {}, {"task_id": "x", "evidence": [None]}):
            with self.assertRaises(ValueError):
                scorer.evaluate(task, self.answer(), self.root)
        with self.assertRaises(ValueError):
            scorer.evaluate(self.task, None, self.root)

    def test_cli_success_and_invalid_input(self):
        task_file = self.base / "task.json"
        answer_file = self.base / "answer.md"
        task_file.write_text(json.dumps(self.task))
        answer_file.write_text(self.answer())
        args = [sys.executable, "-B", str(MODULE), "--task", str(task_file), "--answer", str(answer_file), "--snapshot", str(self.root)]
        run = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), scorer.evaluate(self.task, self.answer(), self.root))
        task_file.write_text("invalid json")
        run = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)
        self.assertEqual(run.stdout, "")
        self.assertEqual(json.loads(run.stderr)["status"], "invalid_input")


if __name__ == "__main__":
    unittest.main()
