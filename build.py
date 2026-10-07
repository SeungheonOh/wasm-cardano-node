#!/usr/bin/env python3
"""Build the complete Cardano WASM dependency graph and package the browser reactor."""
from pathlib import Path
import fcntl
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'wasm'))
from paths import CACHE_ROOT, CABAL, DEPS, BUILD, PROJECT, TOOLCHAIN
from setup import PIN, setup


def write_changed(path, content):
    if not path.exists() or path.read_text() != content:
        path.write_text(content)


def build():
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    with (CACHE_ROOT / 'build.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        setup()
        tmp = CACHE_ROOT / 'tmp'
        tmp.mkdir(exist_ok=True)
        env = dict(os.environ, CABAL_DIR=str(CABAL), TMPDIR=str(tmp),
                   GHC_ENVIRONMENT='-', PYTHONDONTWRITEBYTECODE='1')
        env.pop('GHC_PACKAGE_PATH', None)

        def tool(*args, **kwargs):
            return subprocess.run(['bash', '-c', 'source "$1/env"; shift; exec "$@"',
                                   'wasm-cardano-node', str(TOOLCHAIN), *map(str, args)],
                                  env=env, check=True, **kwargs)

        subprocess.run([sys.executable, '-B', str(ROOT / 'wasm/prepare-dependencies.py')], env=env, check=True)
        CABAL.mkdir(parents=True, exist_ok=True)
        config = (ROOT / 'wasm/cabal.config.in').read_text().replace('@CABAL@', str(CABAL))
        write_changed(CABAL / 'config', config)

        def cabal(*args, **kwargs):
            return tool(TOOLCHAIN / 'cabal/bin/cabal', f'--config-file={CABAL / "config"}',
                        f'--store-dir={CABAL / "store"}',
                        f'--with-compiler={TOOLCHAIN / "wasm32-wasi-ghc/bin/wasm32-wasi-ghc"}',
                        f'--with-hc-pkg={TOOLCHAIN / "wasm32-wasi-ghc/bin/wasm32-wasi-ghc-pkg"}',
                        f'--with-hsc2hs={TOOLCHAIN / "wasm32-wasi-ghc/bin/wasm32-wasi-hsc2hs"}',
                        f'--with-haddock={TOOLCHAIN / "wasm32-wasi-ghc/bin/wasm32-wasi-haddock"}',
                        *args, **kwargs)

        indexes = [CABAL / 'packages' / repo / '01-index.tar' for repo in
                   ['hackage.haskell.org', 'cardano-haskell-packages']]
        if any(not index.exists() for index in indexes):
            cabal('update', f'--project-file={PROJECT}')
        # This Cabal bindist can race when unpacking multiple components from
        # one source archive. Serialize by default, including on a fresh cache.
        jobs = int(os.environ.get('BUILD_JOBS', '1'))
        if jobs < 1:
            raise ValueError('BUILD_JOBS must be a positive integer')
        cabal('build', f'--project-file={PROJECT}', f'--builddir={BUILD}', f'-j{jobs}', 'exe:cardano-stream')
        executable = Path(cabal('list-bin', f'--project-file={PROJECT}', f'--builddir={BUILD}',
                                'exe:cardano-stream', capture_output=True, text=True).stdout.strip())
        plan = json.loads((BUILD / 'cache/plan.json').read_text())
        component = next(p for p in plan['install-plan'] if p['pkg-name'] == 'wasm-cardano-node'
                         and p.get('component-name') == 'exe:cardano-stream')
        nodes = {p['id']: p for p in plan['install-plan']}
        dependencies = [{key: nodes[unit][key] for key in ['pkg-name', 'pkg-version', 'id']}
                        for unit in component['depends']]
        libdir = tool('wasm32-wasi-ghc', '--print-libdir', capture_output=True, text=True).stdout.strip()
        # Finish all generated files before replacing the running preview's assets.
        with tempfile.TemporaryDirectory(prefix='artifacts-', dir=CACHE_ROOT) as temp:
            staging = Path(temp)
            wasm = staging / 'cardano-stream.wasm'
            shutil.copy2(executable, wasm)
            tool('node', Path(libdir) / 'post-link.mjs', '-i', wasm, '-o', staging / 'ffi.mjs')
            tool('wasm-tools', 'validate', wasm)
            data = wasm.read_bytes()
            (staging / 'cardano-stream.wasm.gz').write_bytes(gzip.compress(data, mtime=0))
            shim = DEPS / 'browser-wasi-shim-0.4.2'
            shutil.copytree(shim / 'dist', staging / 'wasi')
            for filename in ['LICENSE-MIT', 'LICENSE-APACHE']:
                shutil.copy2(shim / filename, staging / 'wasi' / filename)
            manifest = {'compiler': PIN['compiler'], 'cardanoApi': '11.0.0.0',
                        'ouroborosConsensus': '3.0.1.0', 'ouroborosNetwork': '1.1.0.0',
                        'toolchainRevision': PIN['revision'],
                        'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
                        'gzipBytes': (staging / 'cardano-stream.wasm.gz').stat().st_size,
                        'memoryLimitBytes': 536870912}
            (staging / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            (staging / 'dependencies.json').write_text(json.dumps(dependencies, indent=2) + '\n')
            shutil.copy2(ROOT / 'LICENSE', staging / 'LICENSE')
            subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/notices.py'), str(staging)], env=env, check=True)
            destination = ROOT / 'dist'
            destination.mkdir(exist_ok=True)
            for source in staging.rglob('*'):
                target = destination / source.relative_to(staging)
                if source.is_dir():
                    target.mkdir(exist_ok=True)
                else:
                    # os.replace needs a same-filesystem temporary file when the
                    # build cache is overridden to another volume.
                    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
                        pending = Path(output.name)
                    try:
                        shutil.copy2(source, pending)
                        os.replace(pending, target)
                    finally:
                        pending.unlink(missing_ok=True)
        print(json.dumps(manifest, indent=2), flush=True)


if __name__ == '__main__':
    try:
        build()
    except (RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
