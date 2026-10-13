"""Encode a sticker's raster fallback for tools/stickers/build.js.

    python3 encode_png.py <frames dir> <out.png> <frame ms>

The frames dir holds rest.png and, for an animated sticker, f000.png onward.
A still sticker becomes a palette PNG of rest.png. An animated one becomes an
animated PNG whose first frame is the resting pose, so an app that shows only
the first frame (or pauses it for Reduce Motion) gets a sensible picture.
"""
import os
import sys

from PIL import Image, features


def quantize(im, colors=256):
    # RGBA quantizing keeps the soft edges; libimagequant does it best.
    method = Image.Quantize.LIBIMAGEQUANT if features.check_feature('libimagequant') else Image.Quantize.FASTOCTREE
    return im.quantize(colors=colors, method=method, dither=Image.Dither.NONE)


def main():
    src, out, frame_ms = sys.argv[1], sys.argv[2], int(sys.argv[3])
    rest = Image.open(os.path.join(src, 'rest.png')).convert('RGBA')
    frames = sorted(f for f in os.listdir(src) if f.startswith('f') and f.endswith('.png'))
    if not frames:
        quantize(rest).save(out, optimize=True)
        return
    imgs = [Image.open(os.path.join(src, f)).convert('RGBA') for f in frames]
    w, h = imgs[0].size
    imgs[0] = rest.resize((w, h), Image.LANCZOS)
    # One palette for the whole loop: quantize every frame side by side, then
    # cut them apart again. Pixels that do not move keep the same index, so
    # each APNG frame only stores the part that changed.
    strip = Image.new('RGBA', (w * len(imgs), h))
    for i, im in enumerate(imgs):
        strip.paste(im, (i * w, 0))
    strip = quantize(strip, 128)
    seq = [strip.crop((i * w, 0, (i + 1) * w, h)) for i in range(len(imgs))]
    seq[0].save(out, save_all=True, append_images=seq[1:], duration=frame_ms, loop=0, disposal=0, blend=0, optimize=True)


if __name__ == '__main__':
    main()
