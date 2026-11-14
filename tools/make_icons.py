#!/usr/bin/env python3
"""Draws the NuTranslate toolbar icons (requires Pillow).

    python3 tools/make_icons.py

Each size is drawn from scratch at 8x and downsampled, which keeps the small
sizes crisp instead of blurring the 128 px version.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
SIZES = (16, 32, 48, 128)
FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
)

TOP = (26, 115, 232)  # blue
BOTTOM = (11, 87, 208)  # darker blue
MARK = (52, 199, 89)  # green "fixed" dot


def font(size):
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_icon(size):
    scale = 8
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    gradient = Image.new("RGBA", (s, s))
    gd = ImageDraw.Draw(gradient)
    for y in range(s):
        k = y / (s - 1)
        color = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * k) for i in range(3)) + (255,)
        gd.line([(0, y), (s, y)], fill=color)

    mask = Image.new("L", (s, s), 0)
    radius = round(s * 0.22)
    inset = round(s * 0.04)
    ImageDraw.Draw(mask).rounded_rectangle([inset, inset, s - inset, s - inset], radius=radius, fill=255)
    img.paste(gradient, (0, 0), mask)

    d = ImageDraw.Draw(img)
    letter_font = font(round(s * 0.66))
    box = d.textbbox((0, 0), "N", font=letter_font)
    w, h = box[2] - box[0], box[3] - box[1]
    x = (s - w) / 2 - box[0] - s * 0.04
    y = (s - h) / 2 - box[1]
    d.text((x, y), "N", font=letter_font, fill=(255, 255, 255, 255))

    # A small dot in the corner: "the language is fixed".
    r = s * (0.13 if size <= 16 else 0.115)
    cx, cy = s * 0.79, s * 0.24
    ring = r + s * 0.035
    d.ellipse([cx - ring, cy - ring, cx + ring, cy + ring], fill=(255, 255, 255, 255))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=MARK + (255,))

    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon{size}.png"
        draw_icon(size).save(path, optimize=True)
        print("wrote", path.relative_to(ROOT))


if __name__ == "__main__":
    main()
