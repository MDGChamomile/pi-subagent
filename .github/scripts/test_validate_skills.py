from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from validate_skills import has_required_frontmatter, validate_skills


class SkillValidationTests(unittest.TestCase):
    def test_accepts_required_fields_inside_closed_frontmatter(self):
        for description in (
            'Non-empty description',
            '"Quoted description" # comment',
            "'Quoted description'",
            '"# is text, not a comment"',
            '>\n  Folded description\n  with another line',
            '|-\n\n  Literal description',
        ):
            with self.subTest(description=description):
                text = f'---\nname: synthetic\ndescription: {description}\n---\n# Body\n'
                self.assertTrue(has_required_frontmatter(text))
                self.assertTrue(has_required_frontmatter(text.replace('\n', '\r\n')))

    def test_rejects_missing_or_misplaced_delimiters(self):
        for text in (
            'name: synthetic\ndescription: text\n',
            '---\nname: synthetic\ndescription: text\n# No closing delimiter\n',
            '# Body\n---\nname: synthetic\ndescription: text\n---\n',
        ):
            with self.subTest(text=text):
                self.assertFalse(has_required_frontmatter(text))

    def test_body_fields_cannot_satisfy_frontmatter(self):
        for field in ('name', 'description'):
            with self.subTest(field=field):
                other = 'description' if field == 'name' else 'name'
                text = f'---\n{other}: text\n---\n# Body\n{field}: synthetic\n'
                self.assertFalse(has_required_frontmatter(text))

    def test_rejects_empty_missing_nested_and_duplicate_required_fields(self):
        for field in ('name', 'description'):
            other = 'description' if field == 'name' else 'name'
            for declaration in (
                '', f'{field}:', f'{field}: # comment',
                f'{field}: ""', f"{field}: '  '", f'{field}: null',
                f'{field}: ~', f'{field}: >', f'{field}: |-\n  ',
                f'metadata:\n  {field}: nested',
                f'{field}: first\n{field}: second',
            ):
                with self.subTest(field=field, declaration=declaration):
                    text = f'---\n{declaration}\n{other}: text\n---\n'
                    self.assertFalse(has_required_frontmatter(text))

    def test_checks_links_without_treating_remote_urls_as_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            skill = root / 'synthetic' / 'SKILL.md'
            skill.parent.mkdir()
            linked = skill.parent / 'reference.md'
            linked.write_text('# Reference\n', encoding='utf-8')
            text = (
                '---\nname: synthetic\ndescription: text\n---\n'
                '[reference](reference.md#reference) [local](#body) '
                '[remote](https://example.test/reference)\n'
            )
            skill.write_text(text, encoding='utf-8')
            self.assertEqual(validate_skills(root), [])
            skill.write_text(text + '[missing](missing.md)\n', encoding='utf-8')
            self.assertEqual(validate_skills(root), [f'broken link: {skill} -> missing.md'])


if __name__ == '__main__':
    unittest.main()
