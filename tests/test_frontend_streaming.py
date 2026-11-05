import shutil
import subprocess
from pathlib import Path

import pytest


def test_frontend_streaming_regressions():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js unavailable for frontend behavior checks')
    script = Path(__file__).with_name('frontend_streaming.cjs')
    result = subprocess.run([node, str(script)], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
