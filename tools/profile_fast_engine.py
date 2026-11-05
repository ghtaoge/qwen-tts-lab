"""Single-model A/B profiler. Stop the web server before running this tool.

Measures the same fixed-seed utterance; verifies codec codes and waveforms.
Does not change model quantization or output sampling settings.
"""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import random
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    import numpy as np
    from fast_engine import FastQwenEngine
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs', type=int, default=3)
    parser.add_argument('--idle-seconds', type=float, default=12)
    parser.add_argument('--variants', help='Comma-separated subset for repeated controls.')
    parser.add_argument('--coverage-only', action='store_true')
    parser.add_argument('--coverage', action='store_true', help='Also compare changed text and built-in voices.')
    parser.add_argument('--output', type=Path, default=ROOT / 'logs' / 'fast-profile.json')
    args = parser.parse_args()
    rows = []
    engine = FastQwenEngine(state_callback=lambda **state: print('STATE', state, flush=True))
    reference = None
    expected_codes = {}
    base = dict(metadata_only=False, bounded_sampler=False, profile=True, threads=6, batch_threads=12,
                host_valid=False, codec_attention='eager')
    variants = [('baseline', {}), ('metadata_only', {'metadata_only': True}),
                ('bounded_sampler', {'bounded_sampler': True}), ('threads_1', {'threads': 1, 'batch_threads': 1}),
                ('threads_2', {'threads': 2, 'batch_threads': 2}), ('host_valid', {'host_valid': True}),
                ('codec_sdpa', {'codec_attention': 'sdpa'}),
                ('combined_native', {'metadata_only': True, 'bounded_sampler': True}),
                ('combined', {'metadata_only': True, 'bounded_sampler': True, 'host_valid': True})]
    if args.variants:
        variants = [item for item in variants if item[0] in args.variants.split(',')]
    try:
        engine.ensure_loaded()
        # Upstream export wrapper emits a float32 mask; BF16 SDPA requires
        # matching dtype. Keep this experimental hook confined to the profiler.
        def sdpa_mask_dtype(module, arguments, kwargs):
            if module.config._attn_implementation == 'sdpa' and kwargs.get('attention_mask') is not None:
                hidden = kwargs.get('hidden_states', arguments[0] if arguments else None)
                kwargs['attention_mask'] = kwargs['attention_mask'].to(hidden.dtype)
            return arguments, kwargs
        for layer in engine.decoder.part2.trans.layers:
            layer.self_attn.register_forward_pre_hook(sdpa_mask_dtype, with_kwargs=True)
        original_decode = engine._decode
        decode_times = []
        def timed_decode(*values, **kwargs):
            started = time.perf_counter()
            result = original_decode(*values, **kwargs)
            decode_times.append(time.perf_counter() - started)
            return result
        engine._decode = timed_decode

        def run(name, options, index, text='你好，欢迎来到语音实验室。', voice='Serena'):
            nonlocal reference
            engine.configure_for_benchmark(**{**base, **options})
            decode_times.clear()
            started = time.perf_counter()
            first = None
            audio = []
            for chunk, rate, _, _ in engine.generate_stream(text, voice, 'Chinese', threading.Event()):
                if first is None:
                    first = time.perf_counter() - started
                audio.append(chunk)
            elapsed = time.perf_counter() - started
            audio = np.concatenate(audio)
            if reference is None:
                reference = audio.copy()
            error = audio - reference if audio.shape == reference.shape else None
            row = dict(variant=name, run=index, text=text, voice=voice, seconds=elapsed, first_seconds=first,
                       duration=len(audio) / rate, codec_seconds=sum(decode_times),
                       waveform_sha256=hashlib.sha256(audio.tobytes()).hexdigest(),
                       waveform_equal=bool(np.array_equal(reference, audio)),
                       waveform_max_abs_error=float(np.max(np.abs(error))) if error is not None else None,
                       profile=engine.last_profile)
            if error is not None:
                noise=float(np.mean(error ** 2))
                row['waveform_snr_db'] = None if noise == 0 else float(10 * np.log10(np.mean(reference ** 2) / noise))
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
            args.output.parent.mkdir(exist_ok=True)
            args.output.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
            code_hash = row['profile']['codes_sha256']
            expected = expected_codes.setdefault((text, voice), code_hash)
            if code_hash != expected:
                raise AssertionError(f'Audio codes changed: {name}, {voice}, {text}')
            if name != 'codec_sdpa' and not row['waveform_equal']:
                raise AssertionError(f'Waveform changed: {name}, {voice}, {text}')
        run('warmup', {}, -1)
        reference = None
        def coverage():
            nonlocal reference
            for index, (voice, text) in enumerate([
                ('Serena', '早上好，新的一天开始了。请记得按时吃饭，保持愉快的心情。'),
                ('Uncle_Fu', '请注意，设备即将开始工作。'),
                ('Eric', '你好，欢迎来到语音实验室。'),
                ('Dylan', '现在是下午三点，请及时休息。'),
            ]):
                reference = None
                run('coverage_baseline', {}, index, text, voice)
                run('coverage_combined', {'metadata_only': True, 'bounded_sampler': True, 'host_valid': True},
                    index, text, voice)
        if args.coverage_only:
            coverage()
            return
        # Interleave baseline controls, avoiding thermal/order bias in long runs.
        ordering = random.Random(20261105)
        for index in range(args.runs):
            order = list(variants)
            ordering.shuffle(order)
            for name, options in order:
                run(name, options, index)
        if args.idle_seconds:
            for name, options in [variants[0], variants[-1]]:
                print('IDLE', args.idle_seconds, name, flush=True)
                time.sleep(args.idle_seconds)
                run(name + '_idle', options, 0)
        for name, _ in variants:
            values=[row for row in rows if row['variant'] == name]
            print('MEDIAN', name, statistics.median(row['seconds'] for row in values),
                  statistics.median(row['first_seconds'] for row in values),
                  'exact', all(row['waveform_equal'] for row in values), flush=True)
        if args.coverage:
            coverage()
    finally:
        engine.close()


if __name__ == '__main__':
    main()
