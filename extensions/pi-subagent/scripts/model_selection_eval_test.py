import copy
import json
import unittest

from model_selection_eval import api_equivalent_cost, schedule, score_answer, task_prompt

TASK = {
    "id": "example", "profile": "review", "objective": "Review the documented behavior.",
    "expected": {"safe": False, "attempts": 2},
    "files": {"fixture/example.ts": "first\nsecond\nthird\n"},
    "evidence_groups": [{"path": "fixture/example.ts", "lines": [2, 3]}],
    "candidates": ["a", "b"],
}
ANSWER = {"answer": {"safe": False, "attempts": 2},
          "evidence": [{"path": "fixture/example.ts", "start": 2, "end": 3}],
          "explanation": "The documented contract determines these results."}


class ModelPilotTests(unittest.TestCase):
    def test_answer_contract(self):
        self.assertTrue(score_answer(TASK, json.dumps(ANSWER))["answer_contract_pass"])
        self.assertTrue(score_answer(TASK, "```json\n" + json.dumps(ANSWER) + "\n```")["answer_contract_pass"])
        self.assertTrue(score_answer(TASK, "```\n" + json.dumps(ANSWER) + "\n```")["answer_contract_pass"])

    def test_boolean_is_not_an_integer_answer(self):
        answer = copy.deepcopy(ANSWER)
        answer["answer"]["safe"] = 0
        self.assertFalse(score_answer(TASK, json.dumps(answer))["answer_contract_pass"])

    def test_missing_invented_or_out_of_bounds_evidence_fails(self):
        for evidence in ([], [{"path": "fixture/unknown", "start": 1, "end": 3}],
                         [{"path": "fixture/example.ts", "start": 2, "end": 4}],
                         [{"path": "fixture/example.ts", "start": 1, "end": 1}]):
            answer = copy.deepcopy(ANSWER)
            answer["evidence"] = evidence
            self.assertFalse(score_answer(TASK, json.dumps(answer))["answer_contract_pass"])

    def test_partial_answers_and_extra_claim_fields_fail(self):
        for changes in ({"safe": False}, {"safe": False, "attempts": 2, "extra": "claim"}):
            answer = {**ANSWER, "answer": changes}
            self.assertFalse(score_answer(TASK, json.dumps(answer))["answer_contract_pass"])
        self.assertFalse(score_answer(TASK, "not JSON")["answer_contract_pass"])

    def test_prompts_do_not_include_expected_values(self):
        prompt = task_prompt({**TASK, "expected": {"secret_ground_truth": "SHOULD_NOT_BE_IN_PROMPT"}})
        self.assertIn("secret_ground_truth", prompt)
        self.assertNotIn("SHOULD_NOT_BE_IN_PROMPT", prompt)

    def test_schedule_is_reproducible_and_complete(self):
        candidates = {"a": {"model": "test/a", "thinking": "low"}, "b": {"model": "test/b", "thinking": "medium"}}
        first = schedule([TASK], candidates, 2, 42)
        self.assertEqual(first, schedule([TASK], candidates, 2, 42))
        self.assertEqual(len(first), 4)
        self.assertEqual(len({row["run_id"] for row in first}), 4)

    def test_api_equivalent_prices_are_not_catalog_cost_or_billing(self):
        self.assertAlmostEqual(api_equivalent_cost({"input": 1000, "output": 100, "cacheRead": 500,
            "cost": {"total": 99}}, {"input": 4, "output": 20, "cacheRead": 0.4, "cacheWrite": 5}), 0.0062)


if __name__ == "__main__":
    unittest.main()
