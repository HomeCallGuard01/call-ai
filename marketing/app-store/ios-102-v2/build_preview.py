#!/usr/bin/env python3
"""Home Call Guard iOS 1.0.2 — App Store screenshot PREVIEW (2026-10-04, pass 2).

EARLY VISUAL REVIEW ONLY. Not final assets, not for upload.

Direction approved by Andrew 2026-10-04 (pass 1); this is the refinement pass:
larger app UI in frames 03-07, shorter copy, no overlaps, Frame 04 reworked as
the trusted-call OUTCOME, Frame 08 with three short benefits.

App screens are authored at a real iPhone logical size (390x844 pt) with the
app's own sizes from mobile/lib/theme.ts and component styles, then scaled
into the phone frame — so the UI reads like the app, not like a shrunken
drawing. Wording on screens is the app's real wording:
  - Activity rows: app/(tabs)/activity.tsx describeOutcome ("Rang straight
    through", "High risk — call stopped", "Screened, no concerns"), dated
    rows, no contact names (the app does not show names there).
  - Home: mobile/lib/protectionView.ts headlines / checklist labels.
  - Contacts: app/(tabs)/contacts/index.tsx (name, number, Delete, Add contact).
Incoming calls are presented by the system with no HCG customisation, so no
native call screen is drawn; Frame 04 shows the outcome as a call-flow built
only from true behaviour (trusted number recognised -> rings as normal ->
never monitored -> logged in Activity).

Renders 1320x2868 (App Store 6.9" portrait), flattened to RGB (no alpha).

Copy rules (Apple 2.3.1 / 2.3.7 / 2.3.10; Google Play preview-asset policy):
no price, no "Android", no "stops every scam"/"guaranteed"/"before they reach
you", no competitor claims, fake data only.

Run:  python3 marketing/app-store/ios-102-v2/build_preview.py            # preview (mock screens)
      python3 marketing/app-store/ios-102-v2/build_preview.py --final    # upload set from real captures
Out:  preview/  (PREVIEW-*)   ·   final/6.9/ + final/6.5/  (HCG-iOS102-NN-*.png)

FINAL EXPORT (2026-10-05): frames 03/05/06/07 show the real Build 16 /
production-equivalent app when these captures exist (portrait iPhone
screenshots, any 19.5:9 size; gitignored — they may show real data):
  captures/03-activity.png       Activity after the device-test calls
  captures/05-home-protected.png Home showing YOUR PHONE IS PROTECTED
  captures/06-home-setup.png     Home in setup, scrolled to the checklist
  captures/07-contacts.png       Contacts with example names, Ofcom drama numbers
A missing capture falls back to the approved mock; in --final mode that frame is
written as DRAFT-* (gitignored) and the run exits non-zero, so a mock can never
be uploaded by accident. 6.5" (1284x2778) is derived from the 6.9" render.
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
CAPTURES = HERE / "captures"
FINAL = HERE / "final"
SIZE_65 = (1284, 2778)  # App Store 6.5" portrait

SHIELD = "data:image/png;base64," + base64.b64encode((ROOT / "mobile/assets/shield-mark-from-logo-master.png").read_bytes()).decode()
APP_SHIELD = "data:image/png;base64," + base64.b64encode((ROOT / "mobile/assets/shield-mark.png").read_bytes()).decode()

# ── icons (simple inline SVG, currentColor) ──────────────────────────────────
def svg(path, size=22, stroke=False, vb=24):
    fill = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' if stroke else 'fill="currentColor"'
    return f'<svg width="{size}" height="{size}" viewBox="0 0 {vb} {vb}" {fill}>{path}</svg>'

I_PERSON = '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7z"/>'
I_SHIELD_OK = '<path d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5z"/><path d="m8.5 12 2.5 2.5 4.5-5" stroke="#04100a" stroke-width="2.2" fill="none" stroke-linecap="round"/>'
I_WARN = '<path d="M12 2 1 21h22z"/><rect x="11" y="9" width="2" height="6" fill="#241708"/><rect x="11" y="16.5" width="2" height="2" fill="#241708"/>'
I_HOME = '<path d="M3 11 12 3l9 8v10h-6v-6H9v6H3z"/>'
I_PEOPLE = '<circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.8"/><path d="M2 20c0-3.6 3-6 7-6s7 2.4 7 6z"/><path d="M15.5 14.2c3.6-.4 6.5 1.6 6.5 5.8h-5"/>'
I_CARD = '<rect x="2" y="5" width="20" height="14" rx="2.5"/><rect x="2" y="9" width="20" height="2.5" fill="#050a07"/>'
I_HELP = '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="#050a07"/>'
I_PHONE = '<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z"/>'
I_CHECK = '<path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
I_X = '<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'
I_ARROW = '<path d="M12 4v15m-6-6 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'

# ── CSS ──────────────────────────────────────────────────────────────────────
CSS = """
:root{--bg:#050a07;--card:#0c130f;--card2:#111c16;--border:#1d2b23;--border2:#2b4136;
--text:#f3f7f4;--muted:#98a99f;--accent:#3cf07a;--deep:#18dd56;--accentMuted:#0a2014;
--accentSoft:rgba(60,240,122,.14);--amber:#f59e0b;--amberBg:#241708;--amberSoft:rgba(245,158,11,.14);
--amberText:#fde68a;--neutral:#9aa8b6;--neutralSoft:rgba(154,168,182,.14)}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:440px;height:956px;overflow:hidden;background:var(--bg);
font-family:-apple-system,"SF Pro Display","SF Pro Text",system-ui,sans-serif;color:var(--text);-webkit-font-smoothing:antialiased}
.frame{position:relative;width:440px;height:956px;overflow:hidden;
background:radial-gradient(120% 62% at 50% 74%,#0d2a18 0%,#06110a 46%,#050a07 76%)}
.g{color:var(--accent)}
.glow{position:absolute;left:50%;transform:translateX(-50%);border-radius:50%;
background:radial-gradient(circle,rgba(60,240,122,.30),rgba(60,240,122,0) 70%)}
.lockup{display:flex;align-items:center;justify-content:center;gap:7px;padding-top:30px}
.lockup img{width:24px}.lockup span{font-weight:700;font-size:16.5px;letter-spacing:-.2px}
.head{padding:12px 24px 0;text-align:center}
.head h1{font-size:33px;line-height:1.08;font-weight:800;letter-spacing:-.9px}
.head p{margin-top:9px;font-size:16px;line-height:1.35;color:#c3d0c8}
/* phone */
.phone{position:absolute;left:50%;transform:translateX(-50%);border-radius:52px;background:#0b0f0d;
border:2px solid #2a3a31;box-shadow:0 0 0 6px #020403,0 0 0 8px #26352d,0 30px 80px rgba(0,0,0,.6),0 0 100px rgba(60,240,122,.16);overflow:hidden}
.screen{position:absolute;left:7px;top:7px;border-radius:45px;background:var(--bg);overflow:hidden}
.app{position:absolute;left:0;top:0;width:390px;height:844px;transform-origin:top left;background:var(--bg)}
.island{position:absolute;top:11px;left:50%;transform:translateX(-50%);width:122px;height:35px;border-radius:20px;background:#000;z-index:5}
.status{position:absolute;top:0;left:0;right:0;height:54px;display:flex;justify-content:space-between;align-items:center;padding:4px 34px 0 40px;font-size:16px;font-weight:600;z-index:4;background:var(--bg)}
.scroll{position:absolute;top:54px;left:0;right:0;bottom:83px;overflow:hidden}
.pad{padding:8px 24px 24px}
.tabbar{position:absolute;bottom:0;left:0;right:0;height:83px;border-top:1px solid var(--border);background:var(--bg);display:flex;justify-content:space-around;padding-top:8px;z-index:4}
.tab{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11px;font-weight:600;color:var(--muted);width:25%;white-space:nowrap}
.tab.on{color:var(--accent)}
/* app components (sizes from theme.ts / component styles) */
.brandmark{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:16px}
.brandmark img{width:34px}.brandmark span{font-size:21px;font-weight:700;letter-spacing:-.3px}
.hero{display:flex;justify-content:center;margin:8px 0 24px}
.r1{width:204px;height:204px;border-radius:50%;background:rgba(60,240,122,.10);display:flex;align-items:center;justify-content:center}
.r2{width:164px;height:164px;border-radius:50%;background:var(--accentMuted);border:1px solid var(--deep);display:flex;align-items:center;justify-content:center}
.r2 img{width:120px}
.r1.m{background:var(--neutralSoft)}.r1.m .r2{background:var(--card);border-color:var(--border)}.r1.m img{opacity:.45}
.hl{font-size:26px;font-weight:800;letter-spacing:.4px;text-align:center;margin-bottom:8px}
.body{font-size:16px;line-height:23px;color:var(--muted);text-align:center;margin-bottom:24px}
.btn{height:54px;border-radius:14px;background:var(--accent);color:#04100a;font-size:17px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-bottom:16px}
.caption{font-size:13px;color:var(--muted);text-align:center;margin:-8px 0 24px}
.stats{display:flex;gap:16px;margin-bottom:16px}
.stat{flex:1;background:var(--card);border:1px solid var(--border);border-radius:18px;padding:22px 8px;text-align:center}
.stat b{display:block;font-size:36px;font-weight:800;color:var(--accent);letter-spacing:-.5px}
.stat span{font-size:13px;color:var(--muted)}
.stat.w{border-color:var(--amber);background:var(--amberBg)}.stat.w b{color:var(--amber)}
.block{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden;margin-bottom:24px}
.srow{display:flex;align-items:center;min-height:56px;padding:0 16px;font-size:16px;gap:8px}
.srow+.srow{border-top:1px solid var(--border)}
.srow .lab{flex:1}.srow .val{color:var(--accent);font-weight:700}.srow .chev{color:var(--muted);font-size:20px}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:1px;color:var(--muted);padding:16px 16px 4px}
.step{display:flex;align-items:center;gap:16px;padding:16px;font-size:16px}
.step+.step{border-top:1px solid var(--border)}
.badge{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex:none}
.badge.d{background:var(--accent);color:#04100a}.badge.t{border:1.5px solid var(--border2);color:var(--muted)}
.step.t{color:var(--muted)}
.title{font-size:28px;font-weight:700;letter-spacing:-.4px;margin:8px 0 4px}
.subtitle{font-size:16px;color:var(--muted);margin-bottom:24px}
.orow{display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid var(--border)}
.obadge{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none}
.obadge.n{background:var(--neutralSoft);color:var(--neutral)}.obadge.p{background:var(--accentSoft);color:var(--accent)}.obadge.w{background:var(--amberSoft);color:var(--amber)}
.otitle{font-size:16px;font-weight:600}.otitle.w{color:var(--amberText)}
.osub{font-size:13px;color:var(--muted);margin-top:3px}
.crow{display:flex;align-items:center;padding:14px 16px;gap:14px}
.crow+.crow{border-top:1px solid var(--border)}
.av{width:44px;height:44px;border-radius:50%;background:var(--accentSoft);color:var(--accent);font-weight:700;font-size:18px;display:flex;align-items:center;justify-content:center;flex:none}
.cname{font-size:17px;font-weight:600}.cnum{font-size:14px;color:var(--muted);margin-top:2px}
.del{margin-left:auto;color:var(--amber);font-weight:600;font-size:15px}
.footbtn{position:absolute;left:24px;right:24px;bottom:16px}
/* marketing cards (frames 02, 04) */
.mcard{position:absolute;left:28px;right:28px;border-radius:22px;padding:20px 22px;display:flex;align-items:center;gap:18px;
background:var(--card);border:1.5px solid var(--border2);box-shadow:0 16px 40px rgba(0,0,0,.5)}
.mcard .ic{width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none}
.mcard b{display:block;font-size:22px;font-weight:700;letter-spacing:-.3px}
.mcard span{display:block;font-size:16px;color:var(--muted);margin-top:4px;line-height:1.3}
.mcard.n .ic{background:#24302a;color:var(--muted)}.mcard.n b{color:var(--muted);text-decoration:line-through;text-decoration-thickness:2px}
.mcard.q .ic{background:var(--neutralSoft);color:var(--neutral)}
.mcard.w{border-color:var(--amber);background:var(--amberBg)}.mcard.w .ic{background:var(--amber);color:#1a1000}.mcard.w b{color:var(--amberText)}
.mcard.g2{border-color:var(--deep);background:#0a1a10}.mcard.g2 .ic{background:var(--accent);color:#04100a}
.mcard .tag{display:inline-block;margin-top:8px;font-size:13px;font-weight:700;color:var(--accent);background:var(--accentSoft);border-radius:999px;padding:4px 10px}
.flow{position:absolute;left:0;right:0;display:flex;align-items:center;justify-content:center;gap:8px;color:var(--accent);font-size:15px;font-weight:600}
.benefits{position:absolute;left:36px;right:36px;display:flex;flex-direction:column;gap:12px}
.benefit{display:flex;align-items:center;gap:14px;font-size:19px;font-weight:600;padding:14px 18px;border-radius:16px;background:rgba(12,19,15,.85);border:1px solid var(--border)}
.benefit .ic{width:36px;height:36px;border-radius:50%;background:var(--accentSoft);color:var(--accent);display:flex;align-items:center;justify-content:center;flex:none}
"""

LOCKUP = f'<div class="lockup"><img src="{SHIELD}"><span>Home Call <span class="g">Guard</span></span></div>'


def head(h1, p=None):
    return f'<div class="head"><h1>{h1}</h1>' + (f"<p>{p}</p>" if p else "") + "</div>"


def tabbar(active):
    tabs = [("Home", I_HOME), ("Contacts", I_PEOPLE), ("Membership", I_CARD), ("Help & Account", I_HELP)]
    return '<div class="tabbar">' + "".join(
        f'<div class="tab{" on" if t == active else ""}">{svg(ic, 26)}{t}</div>' for t, ic in tabs) + "</div>"


def phone(inner, top, width, active="Home", scroll=0, extra=""):
    s = (width - 14) / 390
    h = round(844 * s + 14)
    return (f'<div class="phone" style="top:{top}px;width:{width}px;height:{h}px">'
            f'<div class="screen" style="width:{width-14}px;height:{h-14}px"><div class="app" style="transform:scale({s:.4f})">'
            f'<div class="island"></div><div class="status"><span>9:41</span><span>●●● ▮</span></div>'
            f'<div class="scroll"><div class="pad" style="margin-top:-{scroll}px">{inner}</div></div>{extra}'
            f'{tabbar(active)}</div></div></div>')


def capture_uri(slot):
    """data: URI of captures/<slot>.png, or None when the capture is missing."""
    p = CAPTURES / f"{slot}.png"
    return "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode() if p.exists() else None


def phone_capture(uri, top, width):
    """The same device frame as phone(), filled with a real full-screen capture
    (its own status bar and tab bar), cropped from the top."""
    s = (width - 14) / 390
    h = round(844 * s + 14)
    return (f'<div class="phone" style="top:{top}px;width:{width}px;height:{h}px">'
            f'<div class="screen" style="width:{width-14}px;height:{h-14}px;overflow:hidden">'
            f'<img src="{uri}" style="display:block;width:100%;height:100%;object-fit:cover;object-position:top"></div></div>')


def screen(slot, mock_inner, top, width, **kw):
    """Real capture when present (final mode), else the approved mock screen."""
    uri = capture_uri(slot)
    return (phone_capture(uri, top, width), True) if uri else (phone(mock_inner, top, width, **kw), False)


BRANDMARK = f'<div class="brandmark"><img src="{APP_SHIELD}"><span>Home Call <span class="g">Guard</span></span></div>'

HOME_PROTECTED = BRANDMARK + f"""
<div class="hero"><div class="r1"><div class="r2"><img src="{APP_SHIELD}"></div></div></div>
<div class="hl g">YOUR PHONE IS PROTECTED</div>
<div class="body">Home Call Guard is protecting calls to this phone. People you trust ring straight through.</div>
<div class="caption">Last confirmed Today, 15:51</div>
<div class="stats"><div class="stat"><b>6</b><span>calls checked today</span></div><div class="stat w"><b>1</b><span>scam call stopped</span></div></div>
<div class="block"><div class="srow"><span class="lab">Trusted contacts</span><span class="val">8 contacts</span><span class="chev">›</span></div>
<div class="srow"><span class="lab">Membership</span><span class="val">Active</span><span class="chev">›</span></div></div>
"""

HOME_SETUP = BRANDMARK + f"""
<div class="hero"><div class="r1 m"><div class="r2"><img src="{APP_SHIELD}"></div></div></div>
<div class="hl">FINISH SETTING UP PROTECTION</div>
<div class="body">Turn on call forwarding so your calls reach Home Call Guard.</div>
<div class="btn">Turn on call forwarding</div>
<div class="block"><div class="eyebrow">YOUR SETUP</div>
<div class="step"><span class="badge d">{svg(I_CHECK,16)}</span>Membership active</div>
<div class="step"><span class="badge d">{svg(I_CHECK,16)}</span>Your protected number is ready</div>
<div class="step t"><span class="badge t">3</span>Call forwarding on</div>
<div class="step t"><span class="badge t">4</span>This phone ready to receive protected calls</div>
<div class="step t"><span class="badge t">5</span>First protected call received</div></div>
"""


def orow(kind, title, sub):
    icon = {"n": I_PERSON, "p": I_SHIELD_OK, "w": I_WARN}[kind]
    return (f'<div class="orow"><div class="obadge {kind}">{svg(icon, 22)}</div>'
            f'<div><div class="otitle{" w" if kind == "w" else ""}">{title}</div><div class="osub">{sub}</div></div></div>')


ACTIVITY = ('<div class="title">Activity</div><div class="subtitle">How each call was handled</div>'
            + orow("w", "High risk — call stopped", "04/10/2026, 11:02:14")
            + orow("p", "Screened, no concerns", "04/10/2026, 09:40:51")
            + orow("n", "Rang straight through", "03/10/2026, 17:21:09")
            + orow("p", "Screened, no concerns", "03/10/2026, 12:05:33")
            + orow("n", "Rang straight through", "02/10/2026, 18:33:40")
            + orow("p", "Screened, no concerns", "02/10/2026, 10:12:02"))

CONTACTS = ('<div class="title">Trusted contacts</div><div class="subtitle">Their calls ring straight through.</div><div class="block">'
            + "".join(f'<div class="crow"><span class="av">{n[0]}</span><div><div class="cname">{n}</div><div class="cnum">{num}</div></div><span class="del">Delete</span></div>'
                      for n, num in [("Mum", "07700 900123"), ("Grandad", "07700 900456"), ("Sarah", "07700 900789"),
                                     ("Dr Patel's surgery", "01632 960111"), ("James", "07700 900321")])
            + "</div>")
CONTACTS_FOOT = '<div class="footbtn" style="bottom:99px"><div class="btn" style="margin:0">Add contact</div></div>'


def doc(body):
    return f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}</style></head><body><div class="frame">{body}</div></body></html>'


def mcard(kind, top, icon, title, sub, tag=None):
    return (f'<div class="mcard {kind}" style="top:{top}px"><div class="ic">{svg(icon, 26)}</div>'
            f'<div><b>{title}</b><span>{sub}</span>' + (f'<div class="tag">{tag}</div>' if tag else "") + '</div></div>')


# Frames 03-07: the phone is 392 px wide (89% of the frame) and deliberately
# runs off the bottom edge (standard App Store "bleed") so the app UI stays
# legible at thumbnail size; the top of every screen — the part that carries
# the message — is fully visible.
PH_W = 392
# Frames whose phone shows an app screen that must be a real capture for upload.
CAPTURE_SLOTS = {"03": "03-activity", "05": "05-home-protected", "06": "06-home-setup", "07": "07-contacts"}


def build_frames():
    s03, c03 = screen("03-activity", ACTIVITY, 214, PH_W, active="")
    s05, c05 = screen("05-home-protected", HOME_PROTECTED, 214, PH_W)
    s06, c06 = screen("06-home-setup", HOME_SETUP, 214, PH_W, scroll=290)
    s07, c07 = screen("07-contacts", CONTACTS, 160, PH_W, active="Contacts", extra=CONTACTS_FOOT)
    captured = {"03": c03, "05": c05, "06": c06, "07": c07}
    return frames_with(s03, s05, s06, s07), captured


def frames_with(s03, s05, s06, s07):
  return [
    ("01", "Beyond blocking numbers", doc(
        LOCKUP
        + head('Scam call protection that goes <span class="g">beyond blocking numbers</span>')
        + '<div class="glow" style="top:300px;width:600px;height:600px"></div>'
        + f'<img src="{SHIELD}" style="position:absolute;top:330px;left:50%;transform:translateX(-50%);width:340px;filter:drop-shadow(0 0 44px rgba(60,240,122,.45))">'
        + '<div style="position:absolute;bottom:52px;left:0;right:0;text-align:center;font-size:18px;color:#c3d0c8;font-weight:500">Unknown calls checked while you talk</div>'
    )),
    ("02", "Scammers change numbers", doc(
        LOCKUP
        + head('Scammers <span class="g">change their numbers</span>', "Blocking a known number isn’t enough on its own.")
        + mcard("n", 250, I_X, "07700 900412", "Blocked last week")
        + mcard("w", 396, I_PHONE, "07700 900877", "Same caller, new number")
        + mcard("w", 542, I_PHONE, "“Your bank”", "Number made to look familiar")
        + f'<div class="flow" style="top:694px">{svg(I_ARROW, 26)}</div>'
        + mcard("g2", 740, I_SHIELD_OK, "Home Call Guard", "Adds a check during the call itself")
    )),
    ("03", "Protection as the call develops", doc(
        LOCKUP
        + head('Protection <span class="g">as the call develops</span>', "Unknown callers are checked while you talk.")
        + s03
    )),
    ("04", "Trusted people ring through", doc(
        LOCKUP
        + head('Trusted people <span class="g">ring straight through</span>', "Their calls connect as normal and are never monitored.")
        + mcard("g2", 236, I_PERSON, "Mum", "In your trusted contacts", tag="Trusted")
        + f'<div class="flow" style="top:378px">{svg(I_ARROW, 26)} Number recognised</div>'
        + mcard("g2", 424, I_PHONE, "Your phone rings", "Straight through, as normal")
        + f'<div class="flow" style="top:566px">{svg(I_ARROW, 26)}</div>'
        + mcard("q", 612, I_SHIELD_OK, "Never monitored", "Calls from trusted contacts aren’t checked")
        + '<div style="position:absolute;top:772px;left:28px;right:28px;border-radius:22px;border:1px solid var(--border);background:var(--bg);padding:6px 20px 2px">'
        + '<div style="font-size:12px;font-weight:700;letter-spacing:1px;color:var(--muted);padding-top:12px">IN YOUR ACTIVITY</div>'
        + orow("n", "Rang straight through", "Today, 15:51").replace('border-bottom:1px solid var(--border)', '')
        + '</div>'
    )),
    ("05", "Know when you're protected", doc(
        LOCKUP
        + head('Know when <span class="g">you’re protected</span>', "One clear answer, confirmed by real calls.")
        + s05
    )),
    ("06", "Simple setup", doc(
        LOCKUP
        + head('Simple,<br><span class="g">step-by-step setup</span>', "Each step is ticked only when it’s confirmed.")
        + s06
    )),
    ("07", "Choose who you trust", doc(
        LOCKUP
        + head('Choose <span class="g">who you trust</span>', "Add family and friends in a few taps.")
        + s07
    )),
    ("08", "Brand close", doc(
        '<div class="glow" style="top:70px;width:520px;height:520px"></div>'
        + f'<img src="{SHIELD}" style="position:absolute;top:108px;left:50%;transform:translateX(-50%);width:250px;filter:drop-shadow(0 0 40px rgba(60,240,122,.45))">'
        + '<div class="head" style="position:absolute;top:420px;left:0;right:0"><h1 style="font-size:42px">Home Call <span class="g">Guard</span></h1>'
        + '<p style="font-size:19px;color:var(--text);font-weight:600;margin-top:12px">Protection that goes beyond<br>blocking numbers</p></div>'
        + '<div class="benefits" style="top:600px">'
        + f'<div class="benefit"><span class="ic">{svg(I_SHIELD_OK, 20)}</span>Protection status</div>'
        + f'<div class="benefit"><span class="ic">{svg(I_PEOPLE, 20)}</span>Trusted contacts</div>'
        + f'<div class="benefit"><span class="ic">{svg(I_CHECK, 20)}</span>Simple setup</div>'
        + '</div>'
    )),
]


def render(final=False):
    frames, captured = build_frames()
    HTML_DIR.mkdir(parents=True, exist_ok=True)
    if final:
        for d in (FINAL / "6.9", FINAL / "6.5"):
            d.mkdir(parents=True, exist_ok=True)
            for old in d.glob("*.png"):
                old.unlink()
    else:
        for old in OUT.glob("PREVIEW-*.png"):
            old.unlink()
    pngs = []
    missing = []
    for num, name, html in frames:
        hp = HTML_DIR / f"frame-{num}.html"
        hp.write_text(html)
        raw = OUT / f"_raw-{num}.png"
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                        f"--force-device-scale-factor={SCALE}", f"--window-size={W},{H}",
                        f"--screenshot={raw}", hp.as_uri()], check=True, capture_output=True)
        im = Image.open(raw).convert("RGB")  # Apple: no alpha channel
        assert im.size == (W * SCALE, H * SCALE), im.size
        raw.unlink()
        if final:
            draft = num in CAPTURE_SLOTS and not captured[num]
            if draft:
                missing.append(CAPTURE_SLOTS[num])
            prefix = "DRAFT-" if draft else ""
            out = FINAL / "6.9" / f"{prefix}HCG-iOS102-{num}-{W*SCALE}x{H*SCALE}.png"
            im.save(out, optimize=True)
            # 6.5": scale to 1284 wide, centre-crop the few extra pixels of height.
            w65, h65 = SIZE_65
            scaled = im.resize((w65, round(im.height * w65 / im.width)), Image.LANCZOS)
            off = (scaled.height - h65) // 2
            scaled.crop((0, off, w65, off + h65)).save(FINAL / "6.5" / f"{prefix}HCG-iOS102-{num}-{w65}x{h65}.png", optimize=True)
        else:
            out = OUT / f"PREVIEW-HCG-iOS102-{num}-{W*SCALE}x{H*SCALE}.png"
            im.save(out, optimize=True)
        pngs.append((num, name, out))
        print("rendered", out.name)
    if not final:
        contact_sheet(pngs)
    elif missing:
        print("NOT UPLOADABLE — missing captures (frames written as DRAFT-*):", ", ".join(f"captures/{m}.png" for m in missing))
        sys.exit(2)
    else:
        print("FINAL set complete: final/6.9 and final/6.5 (8 frames each)")


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
    d.text((pad, 28), "HCG iOS 1.0.2 App Store screenshots — PREVIEW pass 2, 6.9\" 1320×2868, fake data",
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
    render(final="--final" in sys.argv)
