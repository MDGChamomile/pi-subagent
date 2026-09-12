# Offline evidence diagnostics

`offline_scoring.py` is a small, standard-library-only diagnostic evaluator. It reads a prepared local snapshot, one task rubric, and one final answer, then emits JSON to stdout. It makes no model/network calls and writes no result files. It neither imports nor modifies archived pilot evaluators or results.

This is **not** the confirmatory benchmark runner or its 100-point scorer. Its output is deliberately separate from `schemas/score-record.schema.json`: there is no judge, no quality total, and no non-inferiority decision. `total_score` is always `null`. Do not substitute these diagnostics for the protocol's quality endpoint.

## Run

From the repository root:

```bash
python3 -B live/extensions/pi-subagent/benchmark-v2/offline_scoring.py \
  --task /path/to/task.json \
  --answer /path/to/answer.md \
  --snapshot /path/to/frozen-snapshot

python3 -B -m unittest discover \
  -s live/extensions/pi-subagent/benchmark-v2/tests -v
```

All three input paths are explicit. A successful diagnostic run exits 0; an unreadable or malformed input exits 2 with an `invalid_input` JSON diagnostic on stderr and no result on stdout. An empty answer is a valid observation, not an input failure: it returns `status: "empty_answer"`, zero citation/coverage metrics, and no total score. Other answers return `status: "diagnostics_only"`; this is not a passing grade. Inspect `format_ok`, citations, and diagnostics separately.

## Task input

The evaluator consumes a subset of the existing task manifest fields. A minimal synthetic example is:

```json
{
  "task_id": "lookup-example",
  "evidence": [
    {
      "evidence_id": "ev_limit",
      "path": "src/queue.py",
      "line_start": 10,
      "line_end": 11
    }
  ],
  "required_claims": [
    {
      "claim_id": "queue_limit",
      "evidence_ids": ["ev_limit"],
      "matcher": {
        "type": "normalized_text_any",
        "accepted_values": ["bounded queue"]
      }
    }
  ]
}
```

Additional full-manifest fields are ignored. This module validates only the consumed subset: nonempty task ID, unique nonempty evidence and claim IDs, existing exact gold paths and line ranges, known claim-to-evidence references, and supported matcher shapes. It does **not** certify corpus balance, provenance, task hashes, weight totals, or the full task schema. Invalid gold data fails the run instead of scoring the answer against it.

Matchers:

- `normalized_text_any`: literal aliases after Unicode NFKC normalization, case folding, backtick removal, and whitespace folding. Word boundaries prevent `bounded queue` from matching `unbounded queue`. This is still lexical matching, not an assertion or negation check.
- `number`: finite `value` and nonnegative finite `absolute_tolerance`; optional `unit_aliases`. Units must immediately follow the numeric token after whitespace. Decimal and scientific notation are supported; grouped numbers, unit conversion, and numbers attached directly to letters are not. Numeric matching does not establish what the number describes.
- `relation`: validates `subject_aliases`, `relation_aliases`, and `object_aliases`, but returns `lexical_match: null`. Co-occurring words cannot establish a relation, its direction, or its negation. Semantic relation scoring is intentionally deferred.

Only `Conclusion` and `Findings` bodies feed lexical matching. Evidence explanations, uncertainty text, and section titles cannot earn lexical matches.

## Answer contract

Use the four headings in this order, each on its own line: `Conclusion`, `Findings`, `Evidence`, `Uncertainties`. ATX Markdown headings (`## Findings`) and a trailing colon are also accepted. Missing, repeated, or reordered headings make `format_ok` false; this does not award or subtract quality points.

Within `Evidence`, use one citation per line, optionally preceded by `-`, `*`, or `+`:

```text
- src/queue.py:10-11 — relevant lines
- `src/queue.py:10-11` — same citation with backticks
```

The explanation is optional. Supported explanation separators are whitespace-surrounded em dash, en dash, or hyphen. Paths use POSIX separators, with no spaces, backticks, colons, or brackets. Ranges are inclusive. Markdown links, GitHub `#L` anchors, multiple citations on one line, and fenced blocks are not parsed. Every nonempty, unparsed Evidence line produces an `unparsed_evidence_line` diagnostic instead of silently disappearing. Citations outside the Evidence section are not counted; this is a bounded answer-contract parser, not a general Markdown citation extractor.

Exact snapshot-relative paths take precedence. Otherwise a unique path-component suffix may resolve an abbreviated path. Multiple matches produce `ambiguous_path`, not a guessed file. Gold paths never use suffix resolution.

## Output interpretation

| Field | Meaning, not a semantic guarantee |
| --- | --- |
| `citations` | Parsed citation occurrences, canonical resolved paths, inclusive ranges, validity, and failure reasons |
| `diagnostics` | Answer line numbers for unparsed Evidence lines; no raw answer excerpts |
| `citation_validity` | Valid parsed occurrences divided by all parsed occurrences plus unparsed nonempty Evidence lines; zero when none exist |
| `evidence_span_recall` | Fraction of distinct gold evidence IDs with any overlapping valid citation |
| `unique_cited_lines` | Union of valid cited lines per canonical file, deduplicating repeated/overlapping ranges and path aliases |
| `gold_line_precision` | Cited unique lines overlapping the union of gold lines, divided by all unique cited lines; zero when no valid lines exist |
| `claims` | Separate lexical match and overlapping declared evidence IDs for each claim; `semantic_support` is always `not_assessed` |
| `format_ok` | Exact recognized heading sequence, independent of factual diagnostics |
| `not_assessed` | Causal logic, semantic support, completeness, unsupported claims, and quality non-inferiority |

A whole-file citation can have valid bounds and full span recall while having very low gold-line precision. No arbitrary maximum-range cutoff is imposed. Gold spans themselves may be incomplete or broad, so line precision is not semantic citation precision. A one-line overlap earns span recall but does not prove the full evidence was supplied. Duplicate citations cannot increase span recall or unique-line precision; `citation_validity` intentionally remains occurrence-based.

The evaluator records its own source hash and hashes of the answer and canonicalized rubric. The snapshot must be separately frozen and hashed by the caller; these diagnostics are not a complete reproducibility archive. Treat any later rescoring of pilot answers as a new exploratory analysis with separately stored outputs, never a replacement for the archived results.

## Read boundary and limitations

The snapshot is trusted, bounded, UTF-8 source data and must remain immutable during evaluation. The evaluator rejects absolute and parent-traversing citation paths, backslashes, colon-bearing paths, and `.git` components. Directory symlinks are never traversed and file symlinks are excluded, even when they point inside the snapshot. Files are rechecked for containment before text reads. This is not an OS sandbox or protection against a concurrent hostile filesystem mutation; do not run it over an actively edited or untrusted, concurrently writable tree. Gold and answer file arguments are explicitly supplied inputs outside this citation boundary.

Tests cover formatting equivalence, invalid and ambiguous references, traversal/symlink rejection without reading an outside fixture, duplicate/range deduplication, whole-file imprecision, unrelated valid evidence, visible parser failures, lexical false-positive limitations, numeric matching, unassessed relations, malformed rubrics, empty answers, and the CLI. These are synthetic contract tests, not evidence that an agent's quality improved.
