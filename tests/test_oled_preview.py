"""OLED preview behavior checks run in Node without a browser or TTS model."""
import shutil
import subprocess
from pathlib import Path

import pytest


def test_oled_preview_controls_and_frame_budget():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js unavailable')
    script = Path(__file__).with_name('oled_preview.cjs')
    result = subprocess.run([node, str(script)], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
