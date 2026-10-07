"""Paths owned by this checkout; no discovery of sibling projects or caches."""
from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parent.parent
CACHE_ROOT = Path(os.environ.get('WASM_CARDANO_CACHE', ROOT / '.wasm-build')).expanduser().resolve()
DEPS = CACHE_ROOT / 'deps'
DOWNLOADS = CACHE_ROOT / 'downloads'
BUILD = CACHE_ROOT / 'build'
PROJECT = CACHE_ROOT / 'cabal.project'
TOOLCHAIN = Path(os.environ.get('GHC_WASM_PREFIX', CACHE_ROOT / 'toolchain')).expanduser().resolve()
CABAL = CACHE_ROOT / 'cabal'
OUTPUT = ROOT / 'dist'

if __name__ == '__main__':
    print({'cache': CACHE_ROOT, 'deps': DEPS, 'downloads': DOWNLOADS, 'build': BUILD,
           'project': PROJECT, 'toolchain': TOOLCHAIN, 'cabal': CABAL, 'output': OUTPUT}[sys.argv[1]])
