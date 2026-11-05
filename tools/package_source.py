"""Package reviewable source without models, virtualenvs, generated credentials or history."""
import os
import zipfile
from pathlib import Path

root=Path(__file__).resolve().parents[1]
excluded={'.venv','.pio','.pytest_cache','__pycache__','models','outputs','logs','.downloads','dist','.git','acceleration'}
private={'server.local.json','miniprogram/config.local.js','firmware/include/secrets.h'}
target=root/'dist'/'qwen-tts-lab-source.zip'
target.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as archive:
    for directory, folders, filenames in os.walk(root):
        folders[:]=sorted(folder for folder in folders if folder not in excluded)
        for name in sorted(filenames):
            file=Path(directory)/name
            relative=file.relative_to(root)
            if relative.as_posix() in private or file.suffix in {'.pyc','.wav'}:
                continue
            archive.write(file,'qwen-tts-lab/'+relative.as_posix())
print(target)
