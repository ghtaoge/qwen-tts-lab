import shutil
import subprocess
from pathlib import Path

import pytest


def test_web_complete_playback():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js unavailable for browser playback checks')
    result = subprocess.run(
        [node, str(Path(__file__).with_name('web_complete.cjs'))],
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
