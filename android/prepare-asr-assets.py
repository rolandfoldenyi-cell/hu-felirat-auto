import concurrent.futures
import hashlib
import json
import pathlib
import subprocess
import urllib.request

root = pathlib.Path(__file__).resolve().parent
manifest = json.loads((root / 'model-manifest.json').read_text())
destination = root / 'model-assets' / 'models'
destination.mkdir(parents=True, exist_ok=True)

def download(model):
    path = destination / model['file']
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == model['sha256']:
        return model['file']
    temporary = path.with_suffix('.download')
    with urllib.request.urlopen(model['url'], timeout=60) as source, temporary.open('wb') as output:
        digest = hashlib.sha256()
        total = 0
        while chunk := source.read(1024 * 1024):
            total += len(chunk)
            if total > model['bytes']:
                raise RuntimeError('Model size exceeds its pinned manifest')
            digest.update(chunk)
            output.write(chunk)
    if total != model['bytes'] or digest.hexdigest() != model['sha256']:
        raise RuntimeError('Model checksum mismatch: ' + model['file'])
    temporary.replace(path)
    return model['file']

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    for name in pool.map(download, manifest['models']): print('Verified model:', name)
(destination / 'manifest.json').write_text(json.dumps(manifest))
fixture = root / 'app' / 'src' / 'androidTest' / 'assets' / 'speech-sample.m4a'
fixture.parent.mkdir(parents=True, exist_ok=True)
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i',
    str(root / 'third-party' / 'whisper.cpp' / 'samples' / 'jfk.wav'),
    '-c:a', 'aac', '-b:a', '64k', str(fixture)], check=True)
