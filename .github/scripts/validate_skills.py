#!/usr/bin/env python3
"""Check skill frontmatter and maintained Markdown relative links.

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


def validate_relative_links(documents: list[Path]) -> list[str]:
    failures = []
    for document in documents:
        text = document.read_text(encoding="utf-8")
        for target in re.findall(r"\[[^]]*\]\(([^)]+)\)", text):
            if "://" in target or target.startswith("#"):
                continue
            path = (document.parent / target.split("#", 1)[0]).resolve()
            if not path.exists():
                failures.append(f"broken link: {document} -> {target}")
    return failures


def validate_skills(root: Path) -> list[str]:
    failures = []
    skills = sorted(root.glob("**/SKILL.md"))
    for skill in skills:
        text = skill.read_text(encoding="utf-8")
        if not has_required_frontmatter(text):
            failures.append(f"invalid frontmatter: {skill}")
    return failures + validate_relative_links(skills)


if __name__ == "__main__":
    root = Path(".")
    failures = validate_skills(root / "skills")
    failures += validate_relative_links(
        [root / name for name in (
            "README.md", "AGENTS.md", "MIGRATION.md", "CONTRIBUTING.md", "PRINCIPLE.md",
            "packaging/pi-subagent/DEVELOPMENT.md",
        )]
    )
    if failures:
        raise SystemExit("\n".join(failures))
