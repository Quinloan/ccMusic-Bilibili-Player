"""Install/verify the pinned audio-only FFmpeg. Developer/CI only.

Download the artifact from the recorded Actions run, then use
--from-artifact DIRECTORY or --artifact-zip ZIP. No full FFmpeg fallback.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

sys.stdout.reconfigure(encoding='utf-8')
root = Path(__file__).resolve().parent.parent
destination = root / 'resources/download-audio'
pinfile = root / 'resources/ffmpeg-audio-manifest.json'
parser = argparse.ArgumentParser()
parser.add_argument('--inspect', action='store_true')
inputs = parser.add_mutually_exclusive_group()
inputs.add_argument('--from-artifact', type=Path)
inputs.add_argument('--artifact-zip', type=Path)
args = parser.parse_args()
pin = json.loads(pinfile.read_text(encoding='utf-8'))
if args.inspect:
    print(json.dumps(pin, ensure_ascii=False, indent=2))
    raise SystemExit()

def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def verify_executable(directory):
    executable = directory / 'ffmpeg.exe'
    if digest(executable) != pin['exe_sha256']:
        raise RuntimeError('FFmpeg executable SHA256 mismatch')
    version = subprocess.check_output([str(executable), '-version'], text=True, stderr=subprocess.DEVNULL).splitlines()[0]
    if pin['revision'] not in version:
        raise RuntimeError('FFmpeg version does not identify the pinned source')
    return version

def install(source):
    manifest = json.loads((source / 'download-manifest.json').read_text(encoding='utf-8'))
    for key in ['revision', 'exe_sha256', 'source_archive_sha256', 'license', 'run_url']:
        if manifest[key] != pin[key]:
            raise RuntimeError('Artifact does not match the pinned build: ' + key)
    for name, expected in pin['files'].items():
        if Path(name).name != name or digest(source / name) != expected:
            raise RuntimeError('Artifact file missing or changed: ' + name)
    verify_executable(source)
    backup = root / 'build-tools/download-audio-original'
    if destination.exists() and not backup.exists():
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(destination, backup)
    destination.mkdir(parents=True, exist_ok=True)
    for file in destination.iterdir():
        if file.is_file() and file.name.startswith('LICENSE') and not (source / file.name).exists():
            file.unlink()
    names = ['ffmpeg.exe', 'download-manifest.json', 'README.md', 'build-ffmpeg-audio.sh', 'FF_VERSION', 'compiler-version.txt', 'toolchain-packages.txt', 'windows-imports.txt', 'config.h', 'config_components.h', 'config.mak']
    names += [file.name for file in source.glob('LICENSE*')]
    for name in names:
        shutil.copy2(source / name, destination / name)
    with (destination / 'README.md').open('a', encoding='utf-8') as notice:
        notice.write('\nExact source: ' + pin['source_url'] + '\nBuild recipe: ' + pin['recipe_url'] + '\nCloud build: ' + pin['run_url'] + '\n')
    print(json.dumps({'ready': str(destination), 'bytes': (destination / 'ffmpeg.exe').stat().st_size,
                      'version': verify_executable(destination), 'sha256': pin['exe_sha256']}, ensure_ascii=False, indent=2))

if args.artifact_zip:
    (root / 'build-tools').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ccmusic-audio-artifact-', dir=root / 'build-tools') as temporary:
        source = Path(temporary)
        with zipfile.ZipFile(args.artifact_zip) as archive:
            for entry in archive.infolist():
                if not (source / entry.filename).resolve().is_relative_to(source.resolve()):
                    raise RuntimeError('Unsafe artifact path')
            archive.extractall(source)
        install(source)
elif args.from_artifact:
    install(args.from_artifact.resolve())
elif (destination / 'ffmpeg.exe').exists():
    verify_executable(destination)
    for name, expected in pin['files'].items():
        if name.startswith('LICENSE') and digest(destination / name) != expected:
            raise RuntimeError('License notice SHA256 mismatch: ' + name)
    print('Verified pinned audio-only FFmpeg (' + str(pin['bytes']) + ' bytes)')
else:
    raise SystemExit('Download ccmusic-ffmpeg-audio-win64 from ' + pin['run_url'] + '\nThen run: python scripts/setup-download-audio.py --artifact-zip PATH_TO_ZIP')
