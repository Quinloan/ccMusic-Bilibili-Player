"""Prepare a pinned LGPL FFmpeg download/remux component. Developer/CI only."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import zipfile
import subprocess
import requests

root = Path(__file__).resolve().parent.parent
destination = root / 'resources' / 'download-audio'
parser = argparse.ArgumentParser()
parser.add_argument('--inspect', action='store_true')
args = parser.parse_args()
headers = {'User-Agent': 'ccMusic-build-resource', 'Accept': 'application/vnd.github+json'}
manifest_file = destination / 'download-manifest.json'
if manifest_file.exists() and not args.inspect:
    manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
else:
    response = requests.get('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest', headers=headers, timeout=30)
    if response.status_code == 403:
        # Public release assets remain available without the rate-limited REST API.
        name = 'ffmpeg-master-latest-win64-lgpl.zip'
        checksum_url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256'
        checksums = requests.get(checksum_url, timeout=30)
        checksums.raise_for_status()
        checksum = next(line.split()[0] for line in checksums.text.splitlines() if line.split()[-1].lstrip('*') == name)
        manifest = {'tag': 'latest', 'asset': name, 'url': f'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/{name}',
                    'sha256': checksum, 'checksum_url': checksum_url}
    else:
        response.raise_for_status()
        release = response.json()
        asset = next(item for item in release['assets'] if item['name'] == 'ffmpeg-master-latest-win64-lgpl.zip')
        if not asset.get('digest', '').startswith('sha256:'):
            raise RuntimeError('GitHub asset has no published SHA256; refusing an unverified resource')
        manifest = {'tag': release['tag_name'], 'asset': asset['name'], 'url': asset['browser_download_url'],
                    'sha256': asset['digest'].split(':', 1)[1], 'bytes': asset['size']}
    manifest.update({'source': 'https://github.com/BtbN/FFmpeg-Builds', 'license': 'LGPL-3.0-or-later'})
if args.inspect:
    print(json.dumps(manifest, indent=2))
    raise SystemExit()
destination.mkdir(parents=True, exist_ok=True)
gpl_file = destination / 'LICENSE-GPL-3.0.txt'
if not gpl_file.exists():
    license_response = requests.get('https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/COPYING.GPLv3', timeout=30)
    license_response.raise_for_status()
    gpl_file.write_bytes(license_response.content)
if (destination / 'ffmpeg.exe').exists() and manifest.get('exe_sha256'):
    if hashlib.sha256((destination / 'ffmpeg.exe').read_bytes()).hexdigest() == manifest['exe_sha256']:
        manifest['license'] = 'LGPL-3.0-or-later'
        manifest['version'] = subprocess.check_output([str(destination / 'ffmpeg.exe'), '-version'], text=True).splitlines()[0]
        manifest_file.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        print('Verified download-audio component already exists')
        raise SystemExit()
with tempfile.TemporaryDirectory(prefix='ccmusic-ffmpeg-build-') as temporary:
    archive = Path(temporary) / 'ffmpeg.zip'
    digest = hashlib.sha256()
    with requests.get(manifest['url'], stream=True, timeout=(30, 90)) as response:
        response.raise_for_status()
        with archive.open('wb') as output:
            for chunk in response.iter_content(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
    if digest.hexdigest() != manifest['sha256']:
        raise RuntimeError('FFmpeg ZIP SHA256 mismatch')
    with zipfile.ZipFile(archive) as bundle:
        exe = next(name for name in bundle.namelist() if name.endswith('/bin/ffmpeg.exe'))
        (destination / 'ffmpeg.exe').write_bytes(bundle.read(exe))
        license_name = next(name for name in bundle.namelist() if name.lower().endswith('/license.txt'))
        (destination / 'LICENSE-FFmpeg.txt').write_bytes(bundle.read(license_name))
manifest['exe_sha256'] = hashlib.sha256((destination / 'ffmpeg.exe').read_bytes()).hexdigest()
manifest['version'] = subprocess.check_output([str(destination / 'ffmpeg.exe'), '-version'], text=True).splitlines()[0]
manifest_file.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(json.dumps({'ready': str(destination), 'bytes': (destination / 'ffmpeg.exe').stat().st_size, 'tag': manifest['tag']}))
