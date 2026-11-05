"""Stop only uvicorn app:app processes whose working directory is this project."""
from pathlib import Path
import psutil

root=Path(__file__).resolve().parents[1]
stopped=[]
for process in psutil.process_iter(['pid','cmdline','cwd']):
    try:
        command=process.info['cmdline'] or []
        if 'uvicorn' not in command or 'app:app' not in command:
            continue
        directory=process.info['cwd']
        if not directory or Path(directory).resolve()!=root:
            continue
        process.terminate()
        stopped.append(process.pid)
    except (psutil.NoSuchProcess,psutil.AccessDenied,OSError):
        continue
print('Stopped local Qwen server process(es): '+', '.join(map(str,stopped)) if stopped else 'No running server owned by this project was found.')
