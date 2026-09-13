#!/usr/bin/env python3
"""Link a browser reactor against sc-pab's already built, patched Cardano graph."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
CACHE = Path(os.environ.get('SC_PAB_CACHE', Path.home() / '.cache/sc-pab'))
config = json.loads((CACHE / 'toolchains.json').read_text()) if (CACHE / 'toolchains.json').exists() else {}
PREFIX = Path(os.environ.get('GHC_WASM_PREFIX', config.get('ghcWasmPrefix', ''))).resolve()
if not (PREFIX / 'env').is_file():
    raise SystemExit('Set GHC_WASM_PREFIX to the sc-pab GHC WASM toolchain; see README.md.')

def tool(*args, **kwargs):
    return subprocess.run(['bash', '-c', 'source "$1/env"; shift; exec "$@"',
                           'wasm-cardano-node', str(PREFIX), *map(str, args)], check=True, **kwargs)

version = tool('wasm32-wasi-ghc', '--numeric-version', capture_output=True, text=True).stdout.strip()
if version != '9.12.4.20260731':
    raise SystemExit(f'Expected the sc-pab compiler 9.12.4.20260731, got {version}')
project_db = CACHE / 'build/packagedb' / f'ghc-{version}'
store_db = PREFIX / '.cabal/store' / f'ghc-{version}-inplace/package.db'
if not (project_db / 'cardano-api-11.0.0.0-inplace.conf').exists():
    raise SystemExit('Build the sc-pab example first to populate its patched dependency graph.')
(ROOT / 'build').mkdir(exist_ok=True)
(ROOT / 'dist').mkdir(exist_ok=True)
packages = ['base', 'ghc-experimental', 'aeson', 'bytestring', 'text', 'containers',
            'async', 'base16-bytestring', 'cborg', 'contra-tracer', 'cardano-api',
            'cardano-ledger-core', 'cardano-slotting', 'cardano-protocol-tpraos']
plan = json.loads((CACHE / 'build/cache/plan.json').read_text())
nodes = {(p['pkg-name'], p.get('component-name', 'lib')): p for p in plan['install-plan']}
components = [(name, 'lib') for name in packages if name != 'ghc-experimental'] + [
    ('ouroboros-consensus', 'lib'), ('ouroboros-consensus', 'lib:cardano'),
    ('cardano-diffusion', 'lib:api'), ('ouroboros-network', 'lib:api'),
    ('ouroboros-network', 'lib:framework'), ('ouroboros-network', 'lib:protocols')]
# Exact unit IDs prevent accidentally mixing a newer store package with the
# version used to build sc-pab (notably contra-tracer, whose types then differ).
units = [nodes[key]['id'] for key in components]
wasm = ROOT / 'dist/cardano-stream.wasm'
tool('wasm32-wasi-ghc', '--make', ROOT / 'src/Stream.hs', f'-i{ROOT / "src"}', '-O1', '-Wall', '-Werror',
     '-XGHC2021', '-hide-all-packages', f'-package-db={store_db}', f'-package-db={project_db}',
     '-package=ghc-experimental', *[f'-package-id={p}' for p in units],
     '-odir', ROOT / 'build', '-hidir', ROOT / 'build',
     '-stubdir', ROOT / 'build',
     '-no-hs-main', '-optl-mexec-model=reactor', '-optl-Wl,--export=cardanoStream',
     '-optl-Wl,--export=hs_init', '-optl-Wl,--max-memory=536870912',
     '-o', wasm)
libdir = tool('wasm32-wasi-ghc', '--print-libdir', capture_output=True, text=True).stdout.strip()
tool('node', Path(libdir) / 'post-link.mjs', '-i', wasm, '-o', ROOT / 'dist/ffi.mjs')
tool('wasm-tools', 'validate', wasm)
data = wasm.read_bytes()
(ROOT / 'dist/cardano-stream.wasm.gz').write_bytes(gzip.compress(data, mtime=0))
shutil.copytree(CACHE / 'deps/browser-wasi-shim-0.4.2/dist', ROOT / 'dist/wasi', dirs_exist_ok=True)
for license_file in ['LICENSE-MIT', 'LICENSE-APACHE']:
    shutil.copy2(CACHE / 'deps/browser-wasi-shim-0.4.2' / license_file, ROOT / 'dist/wasi' / license_file)
manifest = {'compiler': version, 'cardanoApi': '11.0.0.0', 'ouroborosConsensus': '3.0.1.0',
            'ouroborosNetwork': '1.1.0.0', 'sha256': hashlib.sha256(data).hexdigest(),
            'bytes': len(data), 'gzipBytes': (ROOT / 'dist/cardano-stream.wasm.gz').stat().st_size,
            'memoryLimitBytes': 536870912}
(ROOT / 'dist/manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
(ROOT / 'dist/dependencies.json').write_text(json.dumps([
    {k: nodes[key][k] for k in ['pkg-name', 'pkg-version', 'id']} for key in components
], indent=2) + '\n')
shutil.copy2(ROOT / 'LICENSE', ROOT / 'dist/LICENSE')
subprocess.run([sys.executable, ROOT / 'scripts/notices.py', PREFIX], check=True)
print(json.dumps(manifest, indent=2))
