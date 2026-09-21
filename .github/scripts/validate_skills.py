#!/usr/bin/env python3
"""Check skill frontmatter boundaries, required text, and relative Markdown links.

This is a lightweight repository check, not a general YAML schema validator.
"""

from __future__ import annotations

import re
from pathlib import Path


def has_required_frontmatter(text: str) -> bool:
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        return False
    try:
        end = lines.index("---", 1)
    except ValueError:
        return False
    header = lines[1:end]
    for field in ("name", "description"):
        declarations = [
            (index, line.partition(":")[2].strip())
            for index, line in enumerate(header)
            if line.startswith(field + ":")
        ]
        if len(declarations) != 1:
            return False
        index, value = declarations[0]
        if value.startswith(('"', "'")):
            quoted = re.fullmatch(r'''(?:"((?:\\.|[^"\\])*)"|'((?:''|[^'])*)')(?:[ \t]+#.*)?''', value)
            if not quoted or not (quoted.group(1) or quoted.group(2) or "").strip():
                return False
        elif re.fullmatch(r"[>|](?:[1-9][+-]?|[+-][1-9]?)?(?:[ \t]+#.*)?", value):
            # A block marker alone is not a value. Only its indented content counts.
            content = []
            for line in header[index + 1:]:
                if line and not line.startswith((" ", "\t")):
                    break
                content.append(line)
            if not "".join(content).strip():
                return False
        else:
            value = re.split(r"[ \t]+#", value, maxsplit=1)[0].strip()
            if not value or value.startswith("#") or value.casefold() in {"null", "~"}:
                return False
    return True


def validate_skills(root: Path) -> list[str]:
    failures = []
    for skill in sorted(root.glob("**/SKILL.md")):
        text = skill.read_text(encoding="utf-8")
        if not has_required_frontmatter(text):
            failures.append(f"invalid frontmatter: {skill}")
        for target in re.findall(r"\[[^]]*\]\(([^)]+)\)", text):
            if "://" in target or target.startswith("#"):
                continue
            path = (skill.parent / target.split("#", 1)[0]).resolve()
            if not path.exists():
                failures.append(f"broken link: {skill} -> {target}")
    return failures


if __name__ == "__main__":
    failures = validate_skills(Path(__file__).resolve().parents[2] / "skills")
    if failures:
        raise SystemExit("\n".join(failures))
