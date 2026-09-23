"""Exercise the publish workflow's actual inline version gate without publishing."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/npm-publish.yml"


class ReleaseTagTests(unittest.TestCase):
    def run_gate(self, version, tag):
        workflow = WORKFLOW.read_text()
        match = re.search(r"node <<'NODE'\n(.*?)\n\s+NODE", workflow, re.S)
        self.assertIsNotNone(match)
        script = textwrap.dedent(match.group(1))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "packaging/pi-subagent/manifest.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({"version": version}))
            output = root / "output"
            result = subprocess.run(
                ["node", "-"], input=script, text=True, capture_output=True,
                cwd=root, env={**os.environ, "RELEASE_TAG": tag, "GITHUB_OUTPUT": str(output)},
                timeout=10,
            )
            return result, output.read_text() if output.exists() else ""

    def test_matching_stable_tag_enables_publish(self):
        result, output = self.run_gate("0.4.1", "v0.4.1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, "publish=true\n")

    def test_mismatch_fails_without_enabling_publish(self):
        for tag in ("v0.4.2", "v0.4.1-rc.1", "vother"):
            with self.subTest(tag=tag):
                result, output = self.run_gate("0.4.1", tag)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("does not match package version v0.4.1", result.stderr)
                self.assertEqual(output, "")

    def test_nonstable_manifest_fails(self):
        for version in ("0.4.1-rc.1", "invalid"):
            with self.subTest(version=version):
                result, output = self.run_gate(version, f"v{version}")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("npm releases require a stable semver version", result.stderr)
                self.assertEqual(output, "")


if __name__ == "__main__":
    unittest.main()
