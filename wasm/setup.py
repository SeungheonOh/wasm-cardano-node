#!/usr/bin/env python3
"""Install the pinned GHC WASM toolchain into this project's own build cache."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
from paths import CACHE_ROOT, DOWNLOADS, ROOT, TOOLCHAIN

PIN = json.loads((ROOT / 'wasm/toolchain.json').read_text())


def tool(*args, **kwargs):
    return subprocess.run(['bash', '-c', 'source "$1/env"; shift; exec "$@"',
                           'wasm-cardano-node', str(TOOLCHAIN), *map(str, args)], check=True, **kwargs)


def setup():
    if sys.version_info < (3, 12):
        raise RuntimeError('Python 3.12 or newer is required')
    required = ['bash', 'git', 'curl', 'jq', 'tar', 'unzip', 'xz', 'zstd', 'make',
                'gcc', 'g++', 'pkg-config', 'patch', 'autoreconf', 'automake', 'libtoolize',
                'happy', 'alex']
    missing = [name for name in required if not shutil.which(name)]
    if missing:
        raise RuntimeError('Missing build tools: ' + ', '.join(missing) +
                           '. See README.md for native prerequisites.')
    if not (TOOLCHAIN / 'env').is_file():
        if TOOLCHAIN.exists():
            raise RuntimeError(f'{TOOLCHAIN} already exists without a complete toolchain. '
                               'Move it aside before retrying; setup never overwrites it.')
        meta = DOWNLOADS / 'ghc-wasm-meta'
        meta.mkdir(parents=True, exist_ok=True)
        if not (meta / '.git').is_dir():
            subprocess.run(['git', 'init', '-q', str(meta)], check=True)
        actual = subprocess.run(['git', '-C', str(meta), 'rev-parse', '--verify', 'HEAD'],
                                capture_output=True, text=True)
        if actual.returncode:
            subprocess.run(['git', '-C', str(meta), 'fetch', '--depth=1', PIN['repository'], PIN['revision']], check=True)
            subprocess.run(['git', '-C', str(meta), 'checkout', '--detach', 'FETCH_HEAD'], check=True)
        actual = subprocess.check_output(['git', '-C', str(meta), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != PIN['revision']:
            raise RuntimeError(f'Unexpected toolchain installer revision: {actual}')
        if subprocess.check_output(['git', '-C', str(meta), 'status', '--porcelain'], text=True).strip():
            raise RuntimeError('Toolchain installer has local changes; preserve them and move it aside before retrying')
        temp = CACHE_ROOT / 'tmp'
        temp.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, PREFIX=str(TOOLCHAIN), FLAVOUR=PIN['flavour'], TMPDIR=str(temp),
                   XZ_DEFAULTS='--threads=1', XZ_OPT='')
        for key in ['SKIP_GHC', 'PLAYWRIGHT', 'UPSTREAM_WASI_SDK_PIPELINE_ID',
                    'UPSTREAM_GHC_PIPELINE_ID', 'UPSTREAM_GHC_PROJECT_ID', 'UPSTREAM_GHC_JOB_NAME']:
            env.pop(key, None)
        subprocess.run(['bash', str(meta / 'setup.sh')], env=env, check=True)
    expected = ['wasm32-wasi-ghc/bin/wasm32-wasi-ghc', 'cabal/bin/cabal', 'wasi-sdk/bin/wasm32-wasi-clang']
    if any(not (TOOLCHAIN / path).is_file() for path in expected):
        raise RuntimeError(f'Incomplete toolchain at {TOOLCHAIN}; preserve it and move it aside before retrying')
    version = tool('wasm32-wasi-ghc', '--numeric-version', capture_output=True, text=True).stdout.strip()
    if version != PIN['compiler']:
        raise RuntimeError(f'Expected GHC WASM {PIN["compiler"]}, got {version}')
    print(f'Toolchain ready: {TOOLCHAIN} ({version})', flush=True)


if __name__ == '__main__':
    try:
        setup()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
