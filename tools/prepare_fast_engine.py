r"""Prepare the tested Windows GGUF backend without modifying the CUDA venv.

Run with .venv\Scripts\python.exe tools\prepare_fast_engine.py.
Weights are converted locally from the existing official 0.6B CustomVoice model.
This preparation uses CPU only. Close the server before --rebuild.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import venv
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ACCEL = ROOT / 'acceleration'
SOURCE = ACCEL / 'Qwen3-TTS-GGUF'
ASSETS = ACCEL / 'model-custom-small'
MODEL = ROOT / 'models' / 'Qwen3-TTS-12Hz-0.6B-CustomVoice'
ENV = ACCEL / '.venv-fast'
PYTHON = ENV / 'Scripts' / 'python.exe'
SOURCE_COMMIT = '74feb581bc8cefb835fc608107e857036d7580a1'
LLAMA_RELEASE = 'b10621'
LLAMA_SHA256 = '2672d85bf87c8280d94dee01eb6a86280046878f70a07d786a93637fa9081163'
LLAMA_NAME = f'llama-{LLAMA_RELEASE}-bin-win-vulkan-x64.zip'
LLAMA_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/assets/529014165'


def download(url: str, path: Path, digest: str | None = None, binary_api=False):
    if path.exists() and (digest is None or sha256(path) == digest):
        return
    print(f'Downloading {path.name}', flush=True)
    headers = {'User-Agent': 'qwen-tts-lab-fast-setup'}
    if binary_api:
        headers['Accept'] = 'application/octet-stream'
    request = urllib.request.Request(url, headers=headers)
    temporary = path.with_suffix('.partial')
    with urllib.request.urlopen(request, timeout=180) as response, temporary.open('wb') as target:
        shutil.copyfileobj(response, target)
    if digest and sha256(temporary) != digest:
        temporary.unlink()
        raise RuntimeError(f'SHA256 mismatch: {path.name}')
    temporary.replace(path)


def sha256(path: Path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def run(args, cwd=ROOT):
    print('Running:', ' '.join(map(str, args)), flush=True)
    environment = dict(os.environ, PYTHONUTF8='1', OMP_NUM_THREADS='4', MKL_NUM_THREADS='4')
    subprocess.run(list(map(str, args)), cwd=cwd, env=environment, check=True)


def prepare_source():
    if not (SOURCE / 'qwen3_tts_gguf' / 'inference' / 'llama.py').exists():
        archive = ACCEL / f'source-{SOURCE_COMMIT}.zip'
        download(f'https://codeload.github.com/HaujetZhao/Qwen3-TTS-GGUF/zip/{SOURCE_COMMIT}', archive)
        # Strip the single upstream archive prefix and validate every destination.
        with zipfile.ZipFile(archive) as source:
            for entry in source.infolist():
                relative = Path(*Path(entry.filename).parts[1:])
                if not relative.parts or entry.is_dir():
                    continue
                target = (SOURCE / relative).resolve()
                if not target.is_relative_to(SOURCE.resolve()):
                    raise RuntimeError('Unsafe source archive path')
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(entry) as content, target.open('wb') as out:
                    shutil.copyfileobj(content, out)
    (SOURCE / 'export_config.py').write_text(
        f'from pathlib import Path\nMODEL_DIR=Path({str(MODEL)!r})\nEXPORT_DIR=Path({str(ASSETS)!r})\n',
        encoding='utf-8')
    predictor = SOURCE / '33-Convert-Predictor-GGUF.py'
    original = predictor.read_text(encoding='utf-8')
    lines = original.splitlines()
    for index, line in enumerate(lines):
        if line.startswith('CONVERT_LIB_DIR ='):
            lines[index] = 'CONVERT_LIB_DIR = os.path.join(PROJECT_ROOT, "qwen3_tts_gguf", "export")'
    predictor.write_text('\n'.join(lines) + '\n', encoding='utf-8')

    binary_dir = SOURCE / 'qwen3_tts_gguf' / 'inference' / 'bin'
    if not (binary_dir / 'llama.dll').exists():
        archive = ACCEL / LLAMA_NAME
        release_url = f'https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_RELEASE}/{LLAMA_NAME}'
        try:
            download(release_url, archive, LLAMA_SHA256)
        except Exception:
            download(LLAMA_API, archive, LLAMA_SHA256, binary_api=True)
        binary_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as source:
            for entry in source.infolist():
                if not entry.is_dir():
                    target = binary_dir / Path(entry.filename).name
                    with source.open(entry) as content, target.open('wb') as out:
                        shutil.copyfileobj(content, out)


def prepare_environment():
    if not PYTHON.exists():
        venv.create(ENV, with_pip=True)
    parent_site = ROOT / '.venv' / 'Lib' / 'site-packages'
    if not parent_site.exists():
        raise RuntimeError('Run setup.ps1 first to create the main CUDA .venv.')
    site = ENV / 'Lib' / 'site-packages'
    (site / 'qwen_lab_parent.pth').write_text(str(parent_site) + '\n', encoding='utf-8')
    run([PYTHON, '-m', 'pip', 'install', 'gguf==0.19.0', 'sounddevice==0.5.6',
         'onnxruntime-directml==1.24.4', 'sentencepiece==0.2.2'])
    # Exporting with a second CUDA torch would waste several GB of commit memory.
    # Only this isolated environment receives CPU torch; main CUDA torch stays intact.
    result = subprocess.run([str(PYTHON), '-c', 'import torch; print(torch.__version__)'],
                            capture_output=True, text=True)
    if result.returncode or '2.7.1+cpu' not in result.stdout:
        run([PYTHON, '-m', 'pip', 'install', '--ignore-installed', '--no-deps',
             'torch==2.7.1', '--index-url', 'https://download.pytorch.org/whl/cpu'])


def export_embeddings():
    """Bounded-memory FP32 CPU projection; avoids very slow CPU BF16 GEMM."""
    import numpy as np
    import torch
    from safetensors import safe_open
    torch.set_num_threads(4)
    folder = ASSETS / 'embeddings'
    folder.mkdir(parents=True, exist_ok=True)
    with safe_open(MODEL / 'model.safetensors', framework='pt', device='cpu') as weights:
        raw = weights.get_tensor('talker.model.text_embedding.weight')
        w1, b1, w2, b2 = [weights.get_tensor(f'talker.text_projection.{key}').float() for key in (
            'linear_fc1.weight', 'linear_fc1.bias', 'linear_fc2.weight', 'linear_fc2.bias')]
        table = np.lib.format.open_memmap(folder / 'text_embedding_projected.npy', mode='w+',
                                         dtype=np.float16, shape=(raw.shape[0], w2.shape[0]))
        with torch.inference_mode():
            for start in range(0, raw.shape[0], 1024):
                hidden = torch.nn.functional.linear(raw[start:start + 1024].float(), w1, b1)
                hidden = torch.nn.functional.silu(hidden)
                table[start:start + 1024] = torch.nn.functional.linear(hidden, w2, b2).numpy().astype(np.float16)
            table.flush()
            for index in range(16):
                key = ('talker.model.codec_embedding.weight' if index == 0 else
                       f'talker.code_predictor.model.codec_embedding.{index - 1}.weight')
                np.save(folder / f'codec_embedding_{index}.npy', weights.get_tensor(key).float().numpy())
    print('Text projection and all 16 codec tables exported.', flush=True)


def validate_assets():
    sys.path.insert(0, str(ROOT))
    from fast_engine import assets_ready
    if not assets_ready():
        raise RuntimeError('Missing fast backend files. Inspect preceding export errors.')
    # Validate array headers without pulling the large text table into RAM.
    import numpy as np
    table = np.load(ASSETS / 'embeddings' / 'text_embedding_projected.npy', mmap_mode='r')
    if table.shape[0] < 151674 or table.shape[1] != 1024:
        raise RuntimeError(f'Unexpected projected table shape: {table.shape}')
    for index in range(16):
        path = ASSETS / 'embeddings' / f'codec_embedding_{index}.npy'
        value = np.load(path, mmap_mode='r')
        if value.ndim != 2 or value.shape[1] != 1024:
            raise RuntimeError(f'Unexpected codec table: {path}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rebuild', action='store_true', help='Re-export existing assets; stop server first.')
    parser.add_argument('--check', action='store_true', help='Check prepared assets without downloading/exporting.')
    parser.add_argument('--embeddings', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.embeddings:
        export_embeddings()
        return
    if args.check:
        validate_assets()
        print('Fast backend assets are ready. Start the server with TTS_BACKEND=auto or fast.')
        return
    if sys.platform != 'win32' or sys.version_info[:2] != (3, 12):
        raise RuntimeError('This tested installer requires Windows x64 and the main Python 3.12 venv.')
    if not (MODEL / 'model.safetensors').exists():
        raise RuntimeError('Download the official 0.6B CustomVoice model with tools/download_model.py first.')
    ACCEL.mkdir(exist_ok=True)
    ASSETS.mkdir(exist_ok=True)
    prepare_source()
    prepare_environment()
    steps = [
        ('21-Extract-Talker-Weights.py', 'talker_hf/model.safetensors'),
        ('22-Prepare-Talker-Tokenizer.py', 'talker_hf/tokenizer.json'),
        ('23-Convert-Talker-GGUF.py', 'qwen3_tts_talker.f16.gguf'),
        ('24-Quantize-Talker-GGUF.py', 'qwen3_tts_talker.q5_k.gguf'),
        ('31-Extract-Predictor-Weights.py', 'predictor_hf/model.safetensors'),
        ('32-Prepare-Predictor-Tokenizer.py', 'predictor_hf/tokenizer.json'),
        ('33-Convert-Predictor-GGUF.py', 'qwen3_tts_predictor.f16.gguf'),
        ('34-Quantize-Predictor-GGUF.py', 'qwen3_tts_predictor.q8_0.gguf'),
        ('15-Copy-Tokenizer.py', 'tokenizer.json'),
    ]
    for script, output in steps:
        artifact = ASSETS / output
        if args.rebuild or not artifact.exists():
            run([PYTHON, SOURCE / script], cwd=SOURCE)
            if not artifact.is_file() or not artifact.stat().st_size:
                raise RuntimeError(f'Export step did not create {artifact}')
    if args.rebuild or not (ASSETS / 'embeddings' / 'codec_embedding_15.npy').exists():
        run([PYTHON, Path(__file__).resolve(), '--embeddings'])
    validate_assets()
    manifest = {'upstream': 'https://github.com/HaujetZhao/Qwen3-TTS-GGUF',
                'source_commit': SOURCE_COMMIT, 'llama_release': LLAMA_RELEASE,
                'llama_archive_sha256': LLAMA_SHA256, 'model': MODEL.name,
                'talker_quantization': 'Q5_K', 'predictor_quantization': 'Q8_0',
                'decoder': 'original stateful PyTorch codec', 'runtime': 'Vulkan worker + CUDA/CPU codec'}
    (ACCEL / 'backend-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Fast backend ready. Start the server with TTS_BACKEND=auto. Warmup once before measuring.')


if __name__ == '__main__':
    main()
