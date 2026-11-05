import shutil
import subprocess
from pathlib import Path

import pytest


def test_generation_replay_and_shared_preferences():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js unavailable')
    result = subprocess.run([node, str(Path(__file__).with_name('mini_generation.cjs'))],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
