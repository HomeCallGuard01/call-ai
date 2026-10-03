#!/usr/bin/env python3
"""iOS 1.0.2 App Store screenshot frames (2026-10-01, release/ios-1.0.2).

Renders the six-frame Apple set at both required sizes:
  6.9"  1320x2868  -> out/6.9/
  6.5"  1284x2778  -> out/6.5/
RGB PNG, no alpha (App Store Connect rejects alpha).

Frame 1 is complete artwork. Frames 2-6 frame a REAL capture from the iOS
1.0.2 TestFlight build on a physical iPhone, using a real signed-up account
(no mocked API responses, no auth bypass). Put each capture in captures/ under
the name in FRAMES below and re-run. Until it exists, the frame shows a
clearly marked placeholder and the filename gets a DRAFT- prefix, so a
placeholder can't be uploaded by mistake.

Copy rules (docs/launch/IOS_102_STORE_LISTING_2026-10-01.md): no price, no
allowance, no "30-day", no "before they reach you", no invented statistics,
no Android UI.

Usage: python3 generate_frames.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
MOBILE_ASSETS = os.path.join(HERE, "..", "..", "..", "mobile", "assets")
CAPTURES = os.path.join(HERE, "captures")
OUT = os.path.join(HERE, "out")

# mobile/lib/theme.ts
BACKGROUND = (5, 10, 7)
TEXT = (243, 247, 244)
TEXT_MUTED = (152, 169, 159)
ACCENT = (60, 240, 122)
ACCENT_MUTED = (10, 32, 20)

SIZES = {"6.9": (1320, 2868), "6.5": (1284, 2778)}

FRAMES = [
    ("01", "Scam call protection\nfor your mobile phone",
     "Call-blocking apps check the number — and scammers can fake that. Home Call Guard also checks the conversation.",
     None),
    ("02", "Trusted contacts ring\nstraight through",
     "Calls from people on your trusted list aren't monitored.",
     "02-contacts.png"),
    ("03", "Anyone else is checked\nwhile you talk",
     "If the conversation shows serious signs of a scam, the call can be ended.",
     "03-call.png"),
    ("04", "See how every call\nwas handled",
     "Your recent calls, and what happened to each one.",
     "04-activity.png"),
    ("05", "Set up once,\nin the app",
     "Add the people you trust, then turn on call forwarding.",
     "05-forwarding.png"),
    ("06", "Keep your number",
     "No contract. Cancel any time.",
     "06-home.png"),
]


def font(size, bold=True):
    candidates = [
        ("/System/Library/Fonts/SFNS.ttf", "Bold" if bold else "Regular"),
        ("/System/Library/Fonts/HelveticaNeue.ttc", None),
    ]
    for path, variation in candidates:
        if os.path.exists(path):
            f = ImageFont.truetype(path, size, index=1 if (path.endswith(".ttc") and bold) else 0)
            if variation:
                try:
                    f.set_variation_by_name(variation)
                except Exception:
                    pass
            return f
    return ImageFont.load_default()


def wrap(draw, text, fnt, max_width):
    lines = []
    for paragraph in text.split("\n"):
        words, line = paragraph.split(), ""
        for word in words:
            trial = f"{line} {word}".strip()
            if draw.textlength(trial, font=fnt) <= max_width:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines


def draw_centered(draw, lines, fnt, y, width, fill, line_gap):
    for line in lines:
        w = draw.textlength(line, font=fnt)
        draw.text(((width - w) / 2, y), line, font=fnt, fill=fill)
        y += fnt.size + line_gap
    return y


def shield(height):
    img = Image.open(os.path.join(MOBILE_ASSETS, "shield-mark.png")).convert("RGBA")
    return img.resize((int(img.width * height / img.height), height), Image.LANCZOS)


def glow(canvas, center, radius):
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = center
    for i in range(40, 0, -1):
        r = radius * i / 40
        alpha = int(26 * (1 - i / 40) + 2)
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(*ACCENT, alpha))
    canvas.alpha_composite(layer)


def device_slot(canvas, box, capture_path):
    """Rounded iPhone-style bezel; the capture (or a placeholder) inside."""
    x0, y0, x1, y1 = box
    d = ImageDraw.Draw(canvas)
    bezel = int((x1 - x0) * 0.035)
    outer_r = int((x1 - x0) * 0.13)
    d.rounded_rectangle(box, radius=outer_r, fill=(22, 28, 25), outline=(60, 72, 66), width=4)
    inner = (x0 + bezel, y0 + bezel, x1 - bezel, y1 - bezel)
    iw, ih = inner[2] - inner[0], inner[3] - inner[1]
    mask = Image.new("L", (iw, ih), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, iw, ih), radius=outer_r - bezel, fill=255)
    if capture_path and os.path.exists(capture_path):
        shot = Image.open(capture_path).convert("RGBA")
        scale = max(iw / shot.width, ih / shot.height)
        shot = shot.resize((int(shot.width * scale), int(shot.height * scale)), Image.LANCZOS)
        left, top = (shot.width - iw) // 2, 0  # keep the top (status bar + title) of the capture
        shot = shot.crop((left, top, left + iw, top + ih))
        canvas.paste(shot, inner[:2], mask)
        return True
    placeholder = Image.new("RGBA", (iw, ih), (*ACCENT_MUTED, 255))
    pd = ImageDraw.Draw(placeholder)
    label = f"PLACEHOLDER\nreal iPhone capture:\ncaptures/{os.path.basename(capture_path)}"
    f = font(int(iw * 0.055))
    y = ih // 2 - 2 * f.size
    for line in label.split("\n"):
        w = pd.textlength(line, font=f)
        pd.text(((iw - w) / 2, y), line, font=f, fill=ACCENT)
        y += int(f.size * 1.4)
    canvas.paste(placeholder, inner[:2], mask)
    return False


def render(frame, size):
    number, headline, sub, capture = frame
    w, h = size
    canvas = Image.new("RGBA", size, (*BACKGROUND, 255))
    d = ImageDraw.Draw(canvas)
    margin = int(w * 0.08)

    if capture is None:
        glow(canvas, (w // 2, int(h * 0.62)), int(w * 0.75))
        mark = shield(int(h * 0.26))
        canvas.alpha_composite(mark, ((w - mark.width) // 2, int(h * 0.50)))
        hf, sf = font(int(w * 0.079)), font(int(w * 0.043), bold=False)
        y = int(h * 0.12)
        y = draw_centered(d, wrap(d, headline, hf, w - 2 * margin), hf, y, w, TEXT, int(hf.size * 0.18))
        y += int(h * 0.025)
        draw_centered(d, wrap(d, sub, sf, w - 2 * margin), sf, y, w, TEXT_MUTED, int(sf.size * 0.35))
        lockup_font = font(int(w * 0.05))
        draw_centered(d, ["Home Call Guard"], lockup_font, int(h * 0.86), w, ACCENT, 0)
        complete = True
    else:
        hf, sf = font(int(w * 0.078)), font(int(w * 0.04), bold=False)
        y = int(h * 0.065)
        y = draw_centered(d, wrap(d, headline, hf, w - 2 * margin), hf, y, w, TEXT, int(hf.size * 0.18))
        y += int(h * 0.015)
        y = draw_centered(d, wrap(d, sub, sf, w - 2 * margin), sf, y, w, TEXT_MUTED, int(sf.size * 0.35))
        glow(canvas, (w // 2, int(h * 0.72)), int(w * 0.7))
        dev_w = int(w * 0.74)
        dev_h = int(dev_w * 2.16)
        top = y + int(h * 0.04)
        box = ((w - dev_w) // 2, top, (w + dev_w) // 2, top + dev_h)  # bottom bleeds off-canvas by design
        complete = device_slot(canvas, box, os.path.join(CAPTURES, capture))
    return canvas.convert("RGB"), complete


def main():
    report = []
    for label, size in SIZES.items():
        os.makedirs(os.path.join(OUT, label), exist_ok=True)
        for frame in FRAMES:
            img, complete = render(frame, size)
            name = f"{'' if complete else 'DRAFT-'}HCG_iOS102_{frame[0]}_{size[0]}x{size[1]}.png"
            for stale in (f"DRAFT-HCG_iOS102_{frame[0]}_{size[0]}x{size[1]}.png", f"HCG_iOS102_{frame[0]}_{size[0]}x{size[1]}.png"):
                p = os.path.join(OUT, label, stale)
                if os.path.exists(p):
                    os.remove(p)
            img.save(os.path.join(OUT, label, name), "PNG", optimize=True)
            report.append(f"{label}  {name}  {'READY' if complete else 'needs capture ' + frame[3]}")
    print("\n".join(report))


if __name__ == "__main__":
    main()
