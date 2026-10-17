"""Fetch official whisper.cpp Windows CPU CLI and multilingual small quantized model.
No installer scripts are executed. Archives are confined to resources/whisper.
"""
import hashlib
import json
from pathlib import Path
import requests
import zipfile

root = Path(__file__).resolve().parent.parent / 'resources' / 'whisper'
root.mkdir(parents=True, exist_ok=True)
session = requests.Session()
session.headers['User-Agent'] = 'ccMusic-development-validation'
release_response = session.get('https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/b5454', timeout=45)
release_response.raise_for_status()
selected = None
for release in [release_response.json()]:
    for asset in release.get('assets', []):
        if asset['name'] == 'whisper-bin-x64.zip':
            selected = (release, asset)
            break
    if selected:
        break
if not selected:
    raise RuntimeError('Official Windows CPU archive was not found')
release, asset = selected
print('Official binary:', release['tag_name'], asset['name'], asset['size'], flush=True)

def download(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        print('Already present:', dest.name, flush=True)
        return
    partial = dest.with_suffix(dest.suffix + '.part')
    with session.get(url, stream=True, timeout=(30, 90)) as response:
        response.raise_for_status()
        total = 0 if response.headers.get('content-encoding') else int(response.headers.get('content-length', 0))
        received = 0
        last = 0
        with partial.open('wb') as target:
            for chunk in response.iter_content(1024 * 1024):
                target.write(chunk)
                received += len(chunk)
                if received - last >= 25 * 1024 * 1024:
                    print(dest.name, received, '/', total or '?', flush=True)
                    last = received
        if total and received != total:
            raise RuntimeError('Incomplete download')
    partial.replace(dest)

archive = root / 'whisper-bin-x64.zip'
download(asset['browser_download_url'], archive)
digest = asset.get('digest')
actual = hashlib.sha256(archive.read_bytes()).hexdigest()
if digest and digest != 'sha256:' + actual:
    raise RuntimeError('Official binary SHA256 mismatch')
with zipfile.ZipFile(archive) as package:
    for entry in package.infolist():
        if not (root / entry.filename).resolve().is_relative_to(root.resolve()):
            raise RuntimeError('Unsafe archive path')
    # Do not overwrite a CLI/DLL that may currently be used by a validation run.
    for entry in package.infolist():
        if not (root / entry.filename).exists():
            package.extract(entry, root)
model = root / 'ggml-small-q5_1.bin'
model_revision = '5359861c739e955e79d9a303bcbc70fb988958b1'
download(f'https://huggingface.co/ggerganov/whisper.cpp/resolve/{model_revision}/ggml-small-q5_1.bin', model)
expected_model = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'
actual_model = hashlib.sha256(model.read_bytes()).hexdigest()
if actual_model != expected_model:
    raise RuntimeError('Official model SHA256 mismatch')
download('https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5454/LICENSE', root / 'LICENSE-whisper-cpp')
download('https://raw.githubusercontent.com/openai/whisper/main/LICENSE', root / 'LICENSE-openai-whisper')
manifest = {'release': release['tag_name'], 'binary_sha256': actual, 'model': model.name,
    'model_sha256': actual_model, 'model_revision': model_revision,
    'source': release['html_url']}
(root / 'download-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print('Ready:', list(str(p.relative_to(root)) for p in root.rglob('*cli.exe')), flush=True)
