"""Download the official model and its codec into a portable local directory."""
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = [
    ("Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", ROOT / "models" / "Qwen3-TTS-12Hz-0.6B-CustomVoice"),
]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', choices=['modelscope', 'huggingface'], default='modelscope')
    args = parser.parse_args()
    for model_id, destination in MODELS:
        print(f'Downloading {model_id} -> {destination}', flush=True)
        if args.source == 'modelscope':
            from modelscope import snapshot_download
            snapshot_download(model_id, local_dir=str(destination), ignore_patterns=[r'.*\.bin$', r'.*\.pt$'])
        else:
            from huggingface_hub import snapshot_download
            snapshot_download(model_id, local_dir=destination, ignore_patterns=['*.bin', '*.pt'])
    print('模型下载完成。运行 start.ps1 后，在页面点击「加载并预热」。', flush=True)

if __name__ == '__main__':
    main()
