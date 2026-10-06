"""Copy product feature images into Haven's uploads, sized for chat.

Reads amniScientProducts.json, writes uploads/products/<slug>--<feature>.jpg (max
1600 px wide, 1400 px tall) and prints a JSON map of source path -> /uploads URL.
"""
import hashlib
import json
import os
import re
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
AI = Path(os.environ.get('AMNI_AI_ROOT') or Path.home() / 'ai')
DATA = Path(os.environ['HAVEN_DATA_DIR'])
OUT = DATA / 'uploads' / 'products'


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def prep(src, dest):
    im = Image.open(src)
    if im.mode in ('RGBA', 'LA', 'P'):
        im = im.convert('RGBA')
        bg = Image.new('RGB', im.size, (13, 15, 20))
        bg.paste(im, mask=im.getchannel('A'))
        im = bg
    else:
        im = im.convert('RGB')
    im.thumbnail((1600, 1400), Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, 'JPEG', quality=86, optimize=True, progressive=True)


def main():
    catalog = json.loads((HERE / 'amniScientProducts.json').read_text(encoding='utf-8'))
    out = {}
    for p in catalog['products']:
        for f in p['features']:
            rel = f.get('image')
            if not rel:
                continue
            src = AI / rel
            if not src.is_file():
                print(f'missing: {src}', file=sys.stderr)
                continue
            h = hashlib.sha1(f'{rel}:{src.stat().st_mtime_ns}'.encode()).hexdigest()[:10]
            name = f'{slug(f["name"])[:40]}-{h}.jpg'
            # One folder level only: the client only treats /uploads/<dir>/<file> as an image.
            name = f'{slug(p["name"])}--{name}'
            dest = OUT / name
            if not dest.exists():
                prep(src, dest)
            out[rel] = f'/uploads/products/{name}'
    print(json.dumps(out))


if __name__ == '__main__':
    main()
