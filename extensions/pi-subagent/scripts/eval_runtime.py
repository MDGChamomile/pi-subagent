"""Shared, content-free runtime observation for opt-in Codex evaluations."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

EXTENSION_DIR = Path(__file__).resolve().parents[1]
OBSERVER = Path(__file__).with_name("observe-runtime.ts")


def json_events(output: str):
    # Pi's wire framing is LF only; splitlines() also splits valid U+2028/U+2029 in JSON strings.
    for line in output.split("\n"):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            yield event


def load_presets() -> dict[str, dict[str, str]]:
    completed = subprocess.run([
        "node", "--experimental-strip-types", "--input-type=module", "--eval",
        "const {SUBAGENT_PRESETS}=await import(process.argv[1]); console.log(JSON.stringify(SUBAGENT_PRESETS));",
        (EXTENSION_DIR / "shared.ts").as_uri(),
    ], text=True, capture_output=True, check=True, timeout=15)
    presets = json.loads(completed.stdout)
    if not isinstance(presets, dict) or not presets:
        raise ValueError("Runtime presets are unavailable")
    for value in presets.values():
        if not isinstance(value, dict) or not all(isinstance(value.get(key), str) for key in ("model", "thinking")):
            raise ValueError("Malformed runtime preset")
    return presets


def observed_cli(root: Path) -> list[str]:
    executable = shutil.which("pi")
    if not executable:
        raise RuntimeError("pi executable is unavailable")
    entry = Path(executable).resolve()
    if entry.suffix not in (".js", ".mjs"):
        raise RuntimeError("Observed live evaluations currently require the Node.js Pi installation")
    wrapper = root / "observed-pi.mjs"
    # runChild relaunches process.argv[1], so every child reuses this wrapper.
    # The observer loads BEFORE the production guard and has no tool policy hooks.
    wrapper.write_text(
        f"process.argv.splice(2,0,'--extension',{json.dumps(str(OBSERVER))});\n"
        f"await import({json.dumps(entry.as_uri())});\n", encoding="utf-8",
    )
    return ["node", str(wrapper)]


def observation_env(trace: Path, model: str | None = None, thinking: str | None = None) -> dict[str, str]:
    env = {**os.environ, "PI_OFFLINE": "1", "PI_TELEMETRY": "0", "PI_SKIP_VERSION_CHECK": "1",
           "PI_SUBAGENT_EVAL_TRACE_FILE": str(trace)}
    for key in ("PI_SUBAGENT_EVAL_EXPECT_MODEL", "PI_SUBAGENT_EVAL_EXPECT_THINKING"):
        env.pop(key, None)
    if model is not None:
        env["PI_SUBAGENT_EVAL_EXPECT_MODEL"] = model
    if thinking is not None:
        env["PI_SUBAGENT_EVAL_EXPECT_THINKING"] = thinking
    return env


def observe_run(args: list[str], *, cwd: Path, prompt: str, timeout: int,
                model: str | None = None, thinking: str | None = None):
    with tempfile.TemporaryDirectory(prefix="pi-subagent-observe-") as directory:
        root = Path(directory)
        trace = root / "runtime.jsonl"
        completed = subprocess.run(
            [*observed_cli(root), *args], cwd=cwd, input=prompt, text=True, capture_output=True,
            timeout=timeout, check=False, env=observation_env(trace, model, thinking),
        )
        observations = list(json_events(trace.read_text(encoding="utf-8"))) if trace.exists() else []
    return completed, observations


def runtime_checks(observations: list[dict[str, Any]], model: str, thinking: str) -> dict[str, bool]:
    requests = [row for row in observations if row.get("actor") == "child" and row.get("kind") == "request"]
    responses = [row for row in observations if row.get("actor") == "child" and row.get("kind") == "assistant"]
    return {
        "observed_child_requests": bool(requests),
        "effective_child_model": bool(requests) and all(row.get("model") == model for row in requests),
        "effective_child_thinking": bool(requests) and all(row.get("thinking") == thinking for row in requests),
        "wire_child_model": bool(requests) and all(row.get("wireModel") == model.split("/", 1)[1] for row in requests),
        "wire_child_thinking": bool(requests) and all(row.get("wireThinking") == thinking for row in requests),
        "response_child_model": bool(responses) and all(row.get("model") == model for row in responses),
    }
