#!/usr/bin/env python3
"""Fetch pinned sources and apply the reviewed WASM patches. Python 3.12+."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

sys.dont_write_bytecode = True
from paths import DEPS, DOWNLOADS, PROJECT, ROOT

HERE = ROOT / 'wasm'


def run(*args, cwd=None, quiet=False):
    return subprocess.run(args, cwd=cwd, check=True,
                          stdout=subprocess.DEVNULL if quiet else None)


def prepare(dep):
    dest = DEPS / dep['directory']
    patch = HERE / dep['patch'] if dep.get('patch') else None
    fingerprint = hashlib.sha256(json.dumps(dep, sort_keys=True).encode() +
                                 (patch.read_bytes() if patch else b'')).hexdigest()
    stamp = dest / '.wasm-source-fingerprint'
    if stamp.exists() and stamp.read_text().strip() == fingerprint:
        print('Ready:', dep['directory'], flush=True)
        return
    if dest.exists():
        raise RuntimeError(f'{dest} has incomplete or different source pins/patches; '
                           'preserve any changes and move it aside before retrying')
    if not dest.exists():
        with tempfile.TemporaryDirectory(dir=DOWNLOADS) as temporary:
            temp = Path(temporary)
            if 'url' in dep:
                archive = DOWNLOADS / (dep['directory'] + '.tar.gz')
                if not archive.exists():
                    print('Download:', dep['url'], flush=True)
                    partial = archive.with_suffix('.partial')
                    urllib.request.urlretrieve(dep['url'], partial)
                    partial.rename(archive)
                if hashlib.sha256(archive.read_bytes()).hexdigest() != dep['sha256']:
                    raise RuntimeError(f'Archive checksum mismatch: {archive}')
                with tarfile.open(archive) as source:
                    source.extractall(temp, filter='data')
                shutil.move(str(temp / dep['archiveRoot']), dest)
            else:
                checkout = temp / 'checkout'
                run('git', 'init', '-q', str(checkout))
                run('git', '-C', str(checkout), 'fetch', '-q', '--depth=1', dep['git'], dep['revision'])
                archive = temp / 'source.tar'
                tree = 'FETCH_HEAD' + (':' + dep['subdirectory'] if dep['subdirectory'] else '')
                with archive.open('wb') as output:
                    subprocess.run(['git', '-C', str(checkout), 'archive', tree], stdout=output, check=True)
                dest.mkdir()
                with tarfile.open(archive) as source:
                    source.extractall(dest, filter='data')
    if patch:
        command = ['patch', '--batch', '--silent', '-p1', '-i', str(patch)]
        forward = subprocess.run(command + ['--forward', '--dry-run'], cwd=dest, capture_output=True)
        if forward.returncode == 0:
            run(*command, '--forward', cwd=dest)
        else:
            reverse = subprocess.run(command + ['--reverse', '--dry-run'], cwd=dest, capture_output=True)
            if reverse.returncode:
                raise RuntimeError(f'{dest} differs from the pinned source and patch; preserve your changes and move it aside before retrying')
    if dep.get('autoreconf') and not (dest / 'configure').exists():
        run('autoreconf', '--force', '--install', cwd=dest)
    stamp.write_text(fingerprint + '\n')
    print('Prepared:', dep['directory'], flush=True)


if __name__ == '__main__':
    DEPS.mkdir(parents=True, exist_ok=True)
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    for dependency in json.loads((HERE / 'dependencies.json').read_text()):
        prepare(dependency)
    # Cabal receives absolute paths to this project's downloaded dependencies
    # and application entry point, including when its cache is relocated.
    lines = []
    for line in (ROOT / 'cabal.wasm.project.in').read_text().splitlines():
        path = line.strip()
        if path.startswith('@DEPS@/'):
            line = '  ' + json.dumps(str(DEPS / path[len('@DEPS@/'):]))
        elif path == '@APP@':
            line = '  ' + json.dumps(str(ROOT))
        lines.append(line)
    PROJECT.write_text('\n'.join(lines) + '\n')
    print('Cabal project:', PROJECT)
