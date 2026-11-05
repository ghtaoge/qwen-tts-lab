"""Run device/settings mini-program behavior checks without a device session."""
import shutil
import subprocess
from pathlib import Path

import pytest


def test_device_and_connection_settings_behaviors():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js unavailable')
    result = subprocess.run([node, str(Path(__file__).with_name('mini_device.cjs'))],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
