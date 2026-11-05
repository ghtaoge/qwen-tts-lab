"""Resumable parallel download of the official CUDA wheel; verify S3 SHA256."""
import concurrent.futures
import hashlib
import re
import threading
import time
import urllib.request
from pathlib import Path

URL = 'https://download.pytorch.org/whl/cu126/torch-2.7.1%2Bcu126-cp312-cp312-win_amd64.whl'
DEST = Path(__file__).resolve().parents[1] / '.downloads'
DEST.mkdir(exist_ok=True)
TARGET = DEST / 'torch-2.7.1+cu126-cp312-cp312-win_amd64.whl'

def main():
    with urllib.request.urlopen(urllib.request.Request(URL, headers={'Range':'bytes=0-0'}), timeout=90) as response:
        size = int(response.headers['Content-Range'].split('/')[-1])
        checksum = response.headers['x-amz-meta-checksum-sha256']
    chunk = 16 * 1024 * 1024
    total = (size + chunk - 1) // chunk
    done = 0
    guard = threading.Lock()
    def fetch(index):
        nonlocal done
        start, end = index*chunk, min(size, (index+1)*chunk)-1
        part = DEST / f'torch.part{index:04d}'
        if not part.exists() or part.stat().st_size != end-start+1:
            for attempt in range(6):
                try:
                    existing = part.stat().st_size if part.exists() else 0
                    if existing > end-start+1:
                        part.unlink(); existing=0
                    req = urllib.request.Request(URL, headers={'Range':f'bytes={start+existing}-{end}'})
                    with urllib.request.urlopen(req, timeout=120) as response:
                        if response.status != 206 or not response.headers.get('Content-Range','').startswith(f'bytes {start+existing}-'):
                            raise RuntimeError('Server did not honor range')
                        with part.open('ab') as output:
                            while data := response.read(1024*1024): output.write(data)
                    if part.stat().st_size != end-start+1: raise RuntimeError('Incomplete range')
                    break
                except Exception:
                    if attempt == 5: raise
                    time.sleep(2+attempt)
        with guard:
            done += 1
            if done % 10 == 0 or done == total: print(f'Wheel: {done}/{total} chunks', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(fetch, range(total)))
    digest = hashlib.sha256()
    with TARGET.open('wb') as output:
        for index in range(total):
            with (DEST / f'torch.part{index:04d}').open('rb') as part:
                while data := part.read(4*1024*1024):
                    output.write(data); digest.update(data)
    if digest.hexdigest() != checksum: raise RuntimeError('SHA256 mismatch')
    for part in DEST.glob('torch.part*'): part.unlink()
    print(f'Verified SHA256 {checksum}\n{TARGET}', flush=True)

if __name__ == '__main__': main()
