#!/usr/bin/env python3
"""Home Call Guard iOS 1.0.2 — App Store screenshot PREVIEW (2026-10-04).

EARLY VISUAL REVIEW ONLY. Not final assets, not for upload.

Builds 8 frames as HTML (the app's own palette from mobile/lib/theme.ts, the
real shield mark, mock-ups of the real 1.0.2 screens with FAKE data only) and
renders each with headless Chrome at 1320x2868 (App Store 6.9" portrait,
developer.apple.com screenshot specifications, checked 2026-10-04), then
flattens to RGB (Apple: no alpha) and assembles a contact sheet.

Copy rules (Apple 2.3.1 / 2.3.7 / 2.3.10, Google Play preview-asset policy):
  - no price in any image (both stores prohibit price in screenshots)
  - no "Android", no other platform imagery
  - no "stops every scam", "guaranteed", "before they reach you"
  - only behaviour the product actually has (see support FAQ in
    mobile/app/(tabs)/account/support.tsx)

Run:  python3 marketing/app-store/ios-102-v2/build_preview.py
Out:  marketing/app-store/ios-102-v2/preview/  (PREVIEW-*.png, contact sheet)
"""
import base64
import pathlib
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = HERE / "preview"
HTML_DIR = OUT / "html"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
W, H, SCALE = 440, 956, 3  # CSS px x3 = 1320 x 2868

SHIELD = base64.b64encode((ROOT / "mobile/assets/shield-mark-from-logo-master.png").read_bytes()).decode()
SHIELD_SRC = f"data:image/png;base64,{SHIELD}"

# ── shared CSS (values from mobile/lib/theme.ts) ─────────────────────────────
CSS = """
:root{--bg:#050a07;--card:#0c130f;--card2:#111c16;--border:#1d2b23;--border2:#2b4136;
--text:#f3f7f4;--muted:#98a99f;--accent:#3cf07a;--deep:#18dd56;--accentMuted:#0a2014;
--amber:#f59e0b;--amberBg:#241708;--neutral:#9aa8b6}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:440px;height:956px;overflow:hidden;background:var(--bg);
font-family:-apple-system,"SF Pro Display","SF Pro Text",system-ui,sans-serif;color:var(--text);
-webkit-font-smoothing:antialiased}
.frame{position:relative;width:440px;height:956px;overflow:hidden;
background:radial-gradient(120% 60% at 50% 72%,#0d2a18 0%,#06110a 45%,#050a07 75%)}
.glow{position:absolute;left:50%;transform:translateX(-50%);border-radius:50%;
background:radial-gradient(circle,rgba(60,240,122,.28),rgba(60,240,122,0) 70%)}
.lockup{display:flex;align-items:center;justify-content:center;gap:8px;padding-top:44px}
.lockup img{width:30px}.lockup span{font-weight:700;font-size:20px;letter-spacing:-.3px}
.g{color:var(--accent)}
.head{padding:18px 30px 0;text-align:center}
.head h1{font-size:37px;line-height:1.08;font-weight:800;letter-spacing:-1px}
.head p{margin-top:12px;font-size:16.5px;line-height:1.38;color:#c3d0c8}
/* phone */
.phone{position:absolute;left:50%;transform:translateX(-50%);width:300px;height:620px;border-radius:46px;
background:#0b0f0d;border:2px solid #2a3a31;box-shadow:0 0 0 7px #020403,0 0 0 9px #26352d,0 30px 80px rgba(0,0,0,.6),0 0 90px rgba(60,240,122,.14);overflow:hidden}
.screen{position:absolute;inset:7px;border-radius:39px;background:var(--bg);overflow:hidden}
.island{position:absolute;top:9px;left:50%;transform:translateX(-50%);width:84px;height:24px;border-radius:14px;background:#000;z-index:3}
.status{height:40px;display:flex;justify-content:space-between;align-items:center;padding:6px 24px 0;font-size:12.5px;font-weight:600}
.content{padding:4px 14px 0}
.tabbar{position:absolute;bottom:0;left:0;right:0;height:56px;border-top:1px solid var(--border);background:var(--bg);
display:flex;justify-content:space-around;padding-top:7px}
.tab{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:8px;font-weight:600;color:var(--muted);width:25%;white-space:nowrap}
.tab.on{color:var(--accent)}.tab i{width:18px;height:18px;border-radius:5px;border:1.8px solid currentColor;display:block}
.tab.on i{background:currentColor}
.brand{display:flex;align-items:center;justify-content:center;gap:5px;margin:4px 0 10px}
.brand img{width:19px}.brand span{font-weight:700;font-size:13px}
.hero{display:flex;justify-content:center;margin:6px 0 10px}
.ring1{width:124px;height:124px;border-radius:50%;background:rgba(60,240,122,.10);display:flex;align-items:center;justify-content:center}
.ring2{width:96px;height:96px;border-radius:50%;background:var(--accentMuted);border:1px solid var(--deep);display:flex;align-items:center;justify-content:center}
.ring2 img{width:66px}
.ring1.muted{background:rgba(154,168,182,.14)}.ring1.muted .ring2{background:var(--card);border-color:var(--border)}.ring1.muted img{opacity:.45}
.hl{text-align:center;font-weight:800;font-size:16.5px;letter-spacing:.3px;margin-bottom:5px}
.body{text-align:center;color:var(--muted);font-size:10.5px;line-height:1.4;margin:0 6px 10px}
.btn{background:var(--accent);color:#04100a;font-weight:700;font-size:11.5px;text-align:center;border-radius:12px;padding:10px;margin-bottom:10px}
.btn.sec{background:transparent;color:var(--accent);border:1.5px solid var(--accent)}
.stats{display:flex;gap:8px;margin-bottom:9px}
.stat{flex:1;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:10px 4px;text-align:center}
.stat b{display:block;font-size:24px;color:var(--accent);font-weight:800}
.stat span{font-size:9px;color:var(--muted)}
.stat.warn{border-color:var(--amber);background:var(--amberBg)}.stat.warn b{color:var(--amber)}
.block{background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:10px;overflow:hidden}
.row{display:flex;align-items:center;padding:9px 11px;font-size:11px;gap:8px}
.row+.row{border-top:1px solid var(--border)}
.row .lab{flex:1}.row .val{color:var(--accent);font-weight:700}.row .chev{color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex:none}
.dot.n{background:var(--neutral)}.dot.a{background:var(--amber)}
.sec-t{font-size:13px;font-weight:700;margin:4px 0 6px}
.act{padding:7px 2px;border-bottom:1px solid var(--border);display:flex;gap:9px;align-items:flex-start;font-size:10.5px}
.act small{display:block;color:var(--muted);font-size:9px;margin-top:2px}
.eyebrow{font-size:8.5px;font-weight:700;letter-spacing:1px;color:var(--muted);padding:9px 11px 2px}
.step{display:flex;align-items:center;gap:9px;padding:8px 11px;font-size:10.5px}
.step+.step{border-top:1px solid var(--border)}
.badge{width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;flex:none}
.badge.d{background:var(--accent);color:#04100a}.badge.t{border:1.5px solid var(--border2);color:var(--muted)}
.step.t{color:var(--muted)}
.title{font-size:19px;font-weight:700;margin:4px 2px 10px}
.contact{display:flex;align-items:center;gap:10px;padding:9px 11px;font-size:11.5px}
.contact+.contact{border-top:1px solid var(--border)}
.av{width:28px;height:28px;border-radius:50%;background:rgba(60,240,122,.14);color:var(--accent);font-weight:700;display:flex;align-items:center;justify-content:center;font-size:11px}
.contact small{display:block;color:var(--muted);font-size:9.5px}
/* floating outcome cards */
.card{position:absolute;background:#0c130f;border:1.5px solid var(--border2);border-radius:18px;padding:12px 14px;display:flex;gap:11px;align-items:center;
box-shadow:0 14px 40px rgba(0,0,0,.55)}
.card .ic{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:17px;flex:none}
.card b{display:block;font-size:13.5px}.card span{font-size:11px;color:var(--muted);line-height:1.3}
.card.good{border-color:var(--deep)}.card.good .ic{background:var(--accent);color:#04100a}
.card.warn{border-color:var(--amber);background:#241708}.card.warn .ic{background:var(--amber);color:#1a1000}.card.warn b{color:#fde68a}
.card.neu .ic{background:#2b3a32;color:var(--text)}
.foot{position:absolute;bottom:34px;left:0;right:0;text-align:center;color:var(--accent);font-weight:600;font-size:14px}
"""

def tabbar(active):
    tabs = ["Home", "Contacts", "Membership", "Help & Account"]
    return '<div class="tabbar">' + "".join(
        f'<div class="tab{" on" if t == active else ""}"><i></i>{t}</div>' for t in tabs) + "</div>"

def phone(inner, top, active="Home", left="50%"):
    return (f'<div class="phone" style="top:{top}px;left:{left}"><div class="screen"><div class="island"></div>'
            f'<div class="status"><span>9:41</span><span>●●● ▮</span></div><div class="content">{inner}</div>'
            f'{tabbar(active)}</div></div>')

BRAND = f'<div class="brand"><img src="{SHIELD_SRC}"><span>Home Call <span class="g">Guard</span></span></div>'
LOCKUP = f'<div class="lockup"><img src="{SHIELD_SRC}"><span>Home Call <span class="g">Guard</span></span></div>'

def head(h1, p):
    return f'<div class="head"><h1>{h1}</h1><p>{p}</p></div>'

# ── app screens (fake data only) ─────────────────────────────────────────────
HOME_PROTECTED = BRAND + f"""
<div class="hero"><div class="ring1"><div class="ring2"><img src="{SHIELD_SRC}"></div></div></div>
<div class="hl g">YOUR PHONE IS PROTECTED</div>
<div class="body">Home Call Guard is protecting calls to this phone. People you trust ring straight through.</div>
<div class="stats"><div class="stat"><b>6</b><span>calls checked today</span></div>
<div class="stat warn"><b>1</b><span>scam call stopped</span></div></div>
<div class="block"><div class="row"><span class="lab">Trusted contacts</span><span class="val">8 contacts</span><span class="chev">›</span></div>
<div class="row"><span class="lab">Membership</span><span class="val">Active</span><span class="chev">›</span></div></div>
<div class="sec-t">Recent activity</div>
<div class="act"><span class="dot n"></span><div>Trusted contact called<small>Today, 15:51</small></div></div>
<div class="act"><span class="dot a"></span><div>High risk — call stopped<small>Today, 11:02</small></div></div>
<div class="act"><span class="dot"></span><div>Checked an unknown caller — all clear<small>Yesterday</small></div></div>
"""

HOME_SETUP = BRAND + f"""
<div class="hero"><div class="ring1 muted"><div class="ring2"><img src="{SHIELD_SRC}"></div></div></div>
<div class="hl">FINISH SETTING UP PROTECTION</div>
<div class="body">Turn on call forwarding so your calls reach Home Call Guard.</div>
<div class="btn">Turn on call forwarding</div>
<div class="block"><div class="eyebrow">YOUR SETUP</div>
<div class="step"><span class="badge d">✓</span>Membership active</div>
<div class="step"><span class="badge d">✓</span>Your protected number is ready</div>
<div class="step t"><span class="badge t">3</span>Call forwarding on</div>
<div class="step t"><span class="badge t">4</span>This phone ready to receive protected calls</div>
<div class="step t"><span class="badge t">5</span>First protected call received</div></div>
"""

ACTIVITY = """<div class="title">Activity</div>
<div class="act"><span class="dot n"></span><div>Mum — rang straight through<small>Today, 15:51</small></div></div>
<div class="act"><span class="dot a"></span><div>High risk — call stopped<small>Today, 11:02</small></div></div>
<div class="act"><span class="dot"></span><div>Unknown caller checked — all clear<small>Yesterday, 17:40</small></div></div>
<div class="act"><span class="dot n"></span><div>Dr Patel's surgery — rang straight through<small>Yesterday, 09:12</small></div></div>
<div class="act"><span class="dot"></span><div>Unknown caller checked — all clear<small>Mon, 14:21</small></div></div>
<div class="act"><span class="dot a"></span><div>High risk — call stopped<small>Sun, 10:05</small></div></div>
<div class="act"><span class="dot n"></span><div>Grandad — rang straight through<small>Sat, 18:33</small></div></div>
"""

CONTACTS = """<div class="title">Trusted contacts</div>
<div class="btn">Add trusted contacts</div>
<div class="block">""" + "".join(
    f'<div class="contact"><span class="av">{n[0]}</span><div>{n}<small>{num}</small></div></div>'
    for n, num in [("Mum", "07700 900123"), ("Grandad", "07700 900456"), ("Sarah", "07700 900789"),
                   ("Dr Patel's surgery", "01632 960111"), ("James", "07700 900321"), ("Aunt Jo", "07700 900654")]
) + "</div>"

def doc(body):
    return f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}</style></head><body><div class="frame">{body}</div></body></html>'

FRAMES = [
    ("01", "Brand: beyond blocking", doc(
        LOCKUP
        + head('Scam call protection that goes <span class="g">beyond blocking numbers</span>',
               "Home Call Guard checks unknown calls while you talk — not just the number they come from.")
        + '<div class="glow" style="top:390px;width:520px;height:520px"></div>'
        + f'<img src="{SHIELD_SRC}" style="position:absolute;top:420px;left:50%;transform:translateX(-50%);width:300px;filter:drop-shadow(0 0 40px rgba(60,240,122,.45))">'
        + '<div class="foot" style="color:#c3d0c8;font-weight:500;font-size:13.5px;line-height:1.7">Trusted people ring straight through<br>Unknown calls checked while you talk<br>See how every call was handled</div>'
    )),
    ("02", "Scammers change numbers", doc(
        LOCKUP
        + head('Scammers <span class="g">change their numbers</span>',
               "A block list only stops numbers already known. Scammers switch to new ones — or make a call look like it’s from someone you trust.")
        + '<div class="card neu" style="top:420px;left:40px;width:330px"><div class="ic">✕</div><div><b>07700 900412</b><span>Blocked last week</span></div></div>'
        + '<div class="card warn" style="top:520px;left:70px;width:330px"><div class="ic">!</div><div><b>07700 900877</b><span>Same caller, brand-new number</span></div></div>'
        + '<div class="card warn" style="top:620px;left:40px;width:330px"><div class="ic">!</div><div><b>“Your bank”</b><span>Number disguised to look familiar</span></div></div>'
        + '<div class="card good" style="top:745px;left:55px;width:330px"><div class="ic">✓</div><div><b>Home Call Guard</b><span>Checks the call itself, whatever number it comes from</span></div></div>'
    )),
    ("03", "Protection during the call", doc(
        LOCKUP
        + head('Protection <span class="g">during the call</span>',
               "Unknown callers are checked while you talk. If there are clear signs of a scam, Home Call Guard ends the call.")
        + phone(ACTIVITY, 300, active="", left="42%")
        + '<div class="card warn" style="top:560px;left:215px;width:210px"><div class="ic">!</div><div><b>High risk —<br>call stopped</b><span>Ended when scam signs were detected</span></div></div>'
        + '<div class="card good" style="top:700px;left:225px;width:200px"><div class="ic">✓</div><div><b>All clear</b><span>Unknown caller checked</span></div></div>'
    )),
    ("04", "Trusted people get through", doc(
        LOCKUP
        + head('Trusted people <span class="g">ring straight through</span>',
               "Calls from your trusted contacts connect straight away and are never monitored.")
        + phone(CONTACTS, 330, active="Contacts")
        + '<div class="card neu" style="top:790px;left:120px;width:300px"><div class="ic">M</div><div><b>Mum</b><span>Rang straight through · not monitored</span></div></div>'
    )),
    ("05", "Know when you're protected", doc(
        LOCKUP
        + head('Know when <span class="g">you’re protected</span>',
               "One clear answer on your home screen — confirmed by real calls, not guesswork.")
        + phone(HOME_PROTECTED, 300)
    )),
    ("06", "Simple setup", doc(
        LOCKUP
        + head('Simple, <span class="g">step-by-step</span> setup',
               "See exactly what’s done and what’s next. Each step is ticked only when it’s confirmed.")
        + phone(HOME_SETUP, 300)
    )),
    ("07", "Manage trusted contacts", doc(
        LOCKUP
        + head('Choose who <span class="g">you trust</span>',
               "Add family, friends and your GP from your contacts in a few taps. Change them any time.")
        + phone(CONTACTS, 300, active="Contacts")
    )),
    ("08", "Brand close", doc(
        '<div class="glow" style="top:170px;width:560px;height:560px"></div>'
        + f'<img src="{SHIELD_SRC}" style="position:absolute;top:210px;left:50%;transform:translateX(-50%);width:270px;filter:drop-shadow(0 0 40px rgba(60,240,122,.45))">'
        + '<div class="head" style="position:absolute;top:560px;left:0;right:0"><h1 style="font-size:44px">Home Call <span class="g">Guard</span></h1>'
        + '<p style="font-size:21px;color:var(--text);font-weight:600;margin-top:10px">Scam call protection</p>'
        + '<p style="margin-top:22px">Keep your own number. One simple monthly membership — cancel any time.</p></div>'
    )),
]


def render():
    HTML_DIR.mkdir(parents=True, exist_ok=True)
    pngs = []
    for num, name, html in FRAMES:
        hp = HTML_DIR / f"frame-{num}.html"
        hp.write_text(html)
        raw = OUT / f"_raw-{num}.png"
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                        f"--force-device-scale-factor={SCALE}", f"--window-size={W},{H}",
                        f"--screenshot={raw}", hp.as_uri()], check=True, capture_output=True)
        im = Image.open(raw).convert("RGB")  # Apple: no alpha channel
        assert im.size == (W * SCALE, H * SCALE), im.size
        out = OUT / f"PREVIEW-HCG-iOS102-{num}-{W*SCALE}x{H*SCALE}.png"
        im.save(out, optimize=True)
        raw.unlink()
        pngs.append((num, name, out))
        print("rendered", out.name)
    contact_sheet(pngs)


def contact_sheet(pngs):
    tw, th = 330, 717
    pad, label_h, top = 28, 46, 90
    cols = 4
    rows = (len(pngs) + cols - 1) // cols
    sheet = Image.new("RGB", (pad + cols * (tw + pad), top + rows * (th + label_h + pad)), (24, 27, 30))
    d = ImageDraw.Draw(sheet)
    try:
        f_big = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", 30)
        f_small = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", 20)
    except OSError:
        f_big = f_small = ImageFont.load_default()
    d.text((pad, 28), "HCG iOS 1.0.2 App Store screenshots — EARLY PREVIEW, 6.9\" 1320×2868, fake data",
           fill=(236, 240, 238), font=f_big)
    for i, (num, name, p) in enumerate(pngs):
        r, c = divmod(i, cols)
        x = pad + c * (tw + pad)
        y = top + r * (th + label_h + pad)
        sheet.paste(Image.open(p).resize((tw, th), Image.LANCZOS), (x, y))
        d.text((x, y + th + 10), f"{num} — {name}", fill=(200, 210, 204), font=f_small)
    out = OUT / "PREVIEW-contact-sheet.png"
    sheet.save(out, optimize=True)
    print("contact sheet", out.name, sheet.size)


if __name__ == "__main__":
    if not pathlib.Path(CHROME).exists():
        sys.exit("Google Chrome is required for rendering")
    render()
