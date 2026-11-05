"""History-tab replay and lifecycle regressions without a real WeChat session."""
import shutil
import subprocess
from pathlib import Path

import pytest


def test_mini_history_replay_and_lifecycle():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js unavailable')
    result = subprocess.run(
        [node, str(Path(__file__).with_name('mini_history.cjs'))],
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
