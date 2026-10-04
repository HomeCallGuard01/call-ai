"""Trim trailing rows that match the page background from preview screenshots."""
import sys
from PIL import Image

for path in sys.argv[1:]:
    img = Image.open(path).convert("RGB")
    w, h = img.size
    bg = img.getpixel((w - 2, h - 2))
    px = img.load()
    bottom = h
    for y in range(h - 1, 0, -1):
        if any(px[x, y] != bg for x in range(0, w, 3)):
            bottom = min(h, y + 32)
            break
    img.crop((0, 0, w, bottom)).save(path, optimize=True)
