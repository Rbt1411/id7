#!/usr/bin/env python3
"""Build each upstream app and publish the archive exactly where mgu-repo.json specifies.

MGU Store reads dist/<id>@<version>.tgz from the checkout. An upstream build
inside vendors/ doesn't make that file visible. We keep output in both the
checkout's dist/ and the optional MGU_OUT location used by the store.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
VENDOR = {'dpf': 'dpf_core', 'iconix_sounds': 'iconix_core'}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in VENDOR:
        sys.exit('Usage: python kit/tools/build.py <dpf|iconix_sounds> [--preview-only]')
    app = sys.argv[1]
    root = ROOT / 'vendors' / VENDOR[app]
    spec = json.loads((ROOT / 'apps' / app / 'app.json').read_text(encoding='utf-8'))
    version = spec['version']
    name = '{}@{}.tgz'.format(app, version)
    dist = ROOT / 'dist'
    dist.mkdir(parents=True, exist_ok=True)
    expected = dist / name
    preview = '--preview-only' in sys.argv[2:]

    # Upstream builds run from their own source trees. MGU_OUT indicates a store
    # build; make it absolute and point it at the directory the Store checks.
    # This also allows builds without a redistributed BMW SDK.
    provided_out = os.environ.get('MGU_OUT')
    env = os.environ.copy()
    if provided_out:
        env['MGU_OUT'] = str(dist.resolve())
    sdk = ROOT / 'oap-sdk'
    vendor_sdk = root / 'oap-sdk'
    if sdk.is_dir() and not vendor_sdk.exists():
        vendor_sdk.symlink_to(sdk.resolve(), target_is_directory=True)
    if not preview and expected.exists():
        expected.unlink()  # a prior build must not hide missing output

    cmd = [sys.executable, str(root / 'kit' / 'tools' / 'build.py'), app] + sys.argv[2:]
    subprocess.run(cmd, cwd=str(root), env=env, check=True)
    if preview:
        print('Preview only: no installable archive produced')
        return

    # Builds without MGU_OUT emit into vendor/dist. Store-mode builds emit into
    # checkout dist. Support both and do not silently report a successful build
    # if the archive is missing or corrupt.
    if not expected.exists():
        src = root / 'dist' / name
        if not src.is_file():
            sys.exit('Build did not create {}'.format(name))
        shutil.copy2(str(src), str(expected))
    if expected.stat().st_size < 1024:
        sys.exit('Incomplete build artifact: {}'.format(expected))
    with tarfile.open(str(expected), 'r:gz') as archive:
        members = set(archive.getnames())
        if 'package/package.json' not in members or 'package/javascript/app.js' not in members:
            sys.exit('Invalid MGU app tgz: {}'.format(expected))
        pkg = json.load(archive.extractfile('package/package.json'))
        if pkg.get('name') != app or pkg.get('version') != version:
            sys.exit('App identity/version mismatch in {}'.format(expected))

    if provided_out:
        external = pathlib.Path(provided_out)
        if not external.is_absolute():
            external = ROOT / external
        external = external.resolve()
        if external != dist.resolve():
            external.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(expected), str(external / name))
    print('MGU Store artifact ready: {} ({} bytes)'.format(expected.relative_to(ROOT), expected.stat().st_size))

if __name__ == '__main__':
    main()
