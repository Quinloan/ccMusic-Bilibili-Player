"""Developer/build setup only; verifies a pinned release resource bundle."""
from pathlib import Path
import hashlib
import json
import shutil
import tempfile
import urllib.request
import zipfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'resources/release-resources.json').read_text())
def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
if all((root / item['path']).is_file() and digest(root / item['path']) == item['sha256'] for item in manifest['files']):
    print('Resource hashes verified; no download needed.')
    raise SystemExit()
with tempfile.TemporaryDirectory(prefix='ccmusic-setup-') as temporary:
    archive = Path(temporary) / 'resources.zip'
    with urllib.request.urlopen(manifest['url'], timeout=120) as response, archive.open('wb') as target:
        shutil.copyfileobj(response, target)
    if digest(archive) != manifest['sha256']:
        raise RuntimeError('Resource ZIP SHA256 mismatch')
    with zipfile.ZipFile(archive) as bundle:
        for item in manifest['files']:
            target = (root / item['path']).resolve()
            if not target.is_relative_to(root / 'resources') or item['path'] not in bundle.namelist():
                raise RuntimeError('Invalid resource path')
            target.parent.mkdir(parents=True, exist_ok=True)
            partial = target.with_name(target.name + '.part')
            try:
                with bundle.open(item['path']) as source, partial.open('wb') as output:
                    shutil.copyfileobj(source, output)
                if digest(partial) != item['sha256']:
                    raise RuntimeError('Resource file SHA256 mismatch')
                partial.replace(target)
            finally:
                partial.unlink(missing_ok=True)
print('Release resources prepared and verified.')
