// Public website — acquisition journey, links and launch hygiene (2026-09-27).
//
// Pins the structural facts of the public site, not its sentences:
//   1. One consumer acquisition route: marketing pages send visitors to the app
//      store (homepage) or to /go with UTM attribution (guides) — never into the
//      parallel web account-registration journey. /register.html stays reachable
//      only from the account pages (login) and invite links.
//   2. No invented Apple availability: no hard-coded App Store link in any page.
//   3. Every internal link and in-page anchor resolves.
//   4. Launch hygiene: no stray/prototype files in public/, every page has a
//      title and favicon, indexable pages have a canonical + description and
//      are in the sitemap, noindex pages are not.
//   5. A branded 404 exists and is wired narrowly (GET/HEAD + HTML only), after
//      every route.
//   6. The homepage privacy answer makes no absolute "we don't store a
//      transcript" claim.
//
// Run with: node tests/website-journey-links.test.mjs

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const read = (p) => readFileSync(p, 'utf8');
const rel = (p) => path.relative(root, p);

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const allFiles = [];
(function walk(dir) { for (const n of readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, n.name); if (n.isDirectory()) walk(p); else allFiles.push(p); } })(pub);
const pages = allFiles.filter((p) => p.endsWith('.html'));
const noComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const hrefs = (s) => [...noComments(s).replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const PLAY = 'https://play.google.com/store/apps/details?id=co.uk.homecallguard.app';

// ---------- 1. acquisition route ----------
const REGISTER_ALLOWED = new Set(['public/login.html', 'public/register.html']);
const registerLinkers = pages.filter((p) => hrefs(read(p)).some((h) => h.split('?')[0] === '/register.html') && !REGISTER_ALLOWED.has(rel(p)));
check(registerLinkers.length === 0, `no marketing page links into web account registration (/register.html)${registerLinkers.length ? ' — found in: ' + registerLinkers.map(rel).join(', ') : ''}`);

const home = read(path.join(pub, 'index.html'));
check(hrefs(home).filter((h) => h === PLAY).length >= 2, 'homepage: Get-it-on-Google-Play links go to the exact public listing (hero + pricing)');
const playLinks = pages.flatMap((p) => hrefs(read(p)).filter((h) => /play\.google\.com/.test(h)).map((h) => [rel(p), h]));
check(playLinks.every(([, h]) => h === PLAY), `every Google Play link is the exact co.uk.homecallguard.app listing (${playLinks.length} links)`);

const guideDir = path.join(pub, 'guides');
for (const f of readdirSync(guideDir).filter((x) => x.endsWith('.html'))) {
  const slug = f === 'index.html' ? 'guides-index' : f.replace(/\.html$/, '');
  const goLinks = hrefs(read(path.join(guideDir, f))).filter((h) => h.startsWith('/go'));
  const expected = `/go?utm_source=website&utm_medium=guide&utm_campaign=${slug}`;
  check(goLinks.length >= 1 && goLinks.every((h) => h === expected), `guide ${f}: "Get started" links go to /go with its own UTM campaign (${slug})`);
}

// ---------- 2. no invented Apple availability ----------
const appleHrefs = pages.flatMap((p) => hrefs(read(p)).filter((h) => /apps\.apple\.com/.test(h)).map((h) => `${rel(p)}: ${h}`));
check(appleHrefs.length === 0, `no hard-coded App Store link on any page (iOS goes live only via the launch-flag + real URL gate)${appleHrefs.length ? ' — found: ' + appleHrefs.join(' | ') : ''}`);

// ---------- 3. internal links resolve ----------
const serverSrc = read(path.join(root, 'server.js'));
const SERVER_ROUTES = new Set([...serverSrc.matchAll(/app\.get\("([^"]+)"/g)].map((m) => m[1]));
const broken = [];
for (const p of pages) {
  const html = noComments(read(p));
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const u = m[1];
    if (/^(https?:|mailto:|tel:|data:|javascript:)/.test(u) || u.includes('${')) continue;
    if (u.startsWith('#')) { if (u.length > 1 && !ids.has(u.slice(1))) broken.push(`${rel(p)} ${u}`); continue; }
    const file = u.split('#')[0].split('?')[0].replace(/&amp;.*/, '');
    const abs = file.startsWith('/') ? path.join(pub, file) : path.join(path.dirname(p), file);
    const ok = (existsSync(abs) && statSync(abs).isFile()) || existsSync(path.join(abs, 'index.html')) || SERVER_ROUTES.has(file);
    if (!ok) broken.push(`${rel(p)} -> ${u}`);
  }
}
check(broken.length === 0, `every internal link, asset and anchor resolves (${pages.length} pages)${broken.length ? ' — broken: ' + broken.join(' | ') : ''}`);

// ---------- 4. launch hygiene ----------
const WEB_EXT = /\.(html|css|js|png|jpe?g|svg|webp|ico|txt|xml|csv|json|woff2?)$/i;
const odd = allFiles.filter((p) => !WEB_EXT.test(p)).map(rel);
check(odd.length === 0, `public/ contains only standard web file types (no stray/prototype files such as dashboard.htmly)${odd.length ? ' — found: ' + odd.join(', ') : ''}`);
check(!existsSync(path.join(pub, 'dashboard.html')), 'the dead June 2026 prototype public/dashboard.html is gone (GET /dashboard is served from upload.html)');

const sitemap = read(path.join(pub, 'sitemap.xml'));
const sitemapUrls = [...sitemap.matchAll(/<loc>https:\/\/homecallguard\.co\.uk(\/[^<]*)<\/loc>/g)].map((m) => m[1]);
const urlOf = (p) => { const r = '/' + path.relative(pub, p).split(path.sep).join('/'); return r === '/index.html' ? '/' : r.replace(/\/index\.html$/, '/'); };
for (const p of pages) {
  const html = read(p);
  const noindex = /<meta\s+name="robots"\s+content="[^"]*noindex/i.test(html);
  const missing = [];
  if (!/<title>[^<]+<\/title>/.test(html)) missing.push('title');
  if (!/rel="icon"/.test(html)) missing.push('favicon');
  if (!noindex) {
    if (!/rel="canonical"/.test(html)) missing.push('canonical');
    if (!/name="description"/.test(html)) missing.push('description');
    if (!sitemapUrls.includes(urlOf(p))) missing.push('sitemap entry');
  } else if (sitemapUrls.includes(urlOf(p))) missing.push('noindex page listed in sitemap');
  check(missing.length === 0, `${rel(p)} (${noindex ? 'noindex' : 'indexable'}): ${missing.length ? 'missing ' + missing.join(', ') : 'title, favicon' + (noindex ? '' : ', canonical, description, sitemap')}`);
}
check(sitemapUrls.every((u) => pages.some((p) => urlOf(p) === u)), 'every sitemap URL is a real page');

// ---------- 5. 404 ----------
const notFound = read(path.join(pub, '404.html'));
check(/noindex/.test(notFound) && hrefs(notFound).includes('/') && hrefs(notFound).includes('/support.html'), '404 page: noindex, links home and to support');
const iNotFound = serverSrc.indexOf('res.status(404).sendFile(__dirname + "/public/404.html")');
const iDashboard = serverSrc.indexOf('app.get("/dashboard"');
const iErrorHandler = serverSrc.indexOf('app.use((err, req, res, next)');
check(iNotFound > iDashboard && iNotFound < iErrorHandler && iDashboard > 0, 'server: the 404 handler is registered after the last route and before the global error handler');
const handler = serverSrc.slice(serverSrc.lastIndexOf('app.use((req, res, next)', iNotFound), iNotFound);
check(/req\.method !== "GET" && req\.method !== "HEAD"/.test(handler) && /req\.accepts\("html"\)/.test(handler) && /return next\(\)/.test(handler), 'server: the 404 page only answers GET/HEAD requests that accept HTML — API clients and webhooks keep the default 404');

// ---------- 6. privacy wording ----------
const homeText = noComments(home).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
check(!/doesn't store call audio or a transcript/.test(homeText), 'homepage: no absolute "doesn\'t store call audio or a transcript" claim');
check(/doesn't record your calls/.test(homeText) && /third-party service/.test(homeText), 'homepage FAQ: says calls aren\'t recorded and discloses third-party transcription');

// ---------- homepage Play links: install-referrer attribution (2026-09-29) ----------
// Executes the homepage's own snippet against fake links: only UTM fields
// are ever added to Google Play's `referrer`, defaults to website/homepage,
// and unsafe values are dropped.
{
  const homeSrc = readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const PLAY_URL = 'https://play.google.com/store/apps/details?id=co.uk.homecallguard.app';
  const snippet = homeSrc.slice(homeSrc.indexOf('  var PLAY_URL = '), homeSrc.indexOf('/* attribution is optional: links stay the plain listing URL */ }') + 66);
  const run = (search) => {
    const mk = (href) => ({ href, getAttribute: () => href });
    const links = [mk(PLAY_URL), mk(PLAY_URL), mk('/terms.html')];
    vm.runInNewContext(snippet, { window: { location: { search } }, URLSearchParams, encodeURIComponent,
      document: { querySelectorAll: (sel) => (sel === 'a[href]' ? links : []) } });
    if (links[2].href !== '/terms.html') return ['non-Play link was modified'];
    return links.slice(0, 2).map((l) => l.href);
  };
  const ref = (r) => `${PLAY_URL}&referrer=${encodeURIComponent(r)}`;
  check(snippet.length > 200 && run('').every((h) => h === ref('utm_source=website&utm_medium=homepage')), 'homepage Play links: no UTMs -> referrer utm_source=website&utm_medium=homepage');
  check(run('?utm_source=tiktok&utm_medium=bio&utm_campaign=launch&gclid=XYZ&email=a@b.c').every((h) => h === ref('utm_source=tiktok&utm_medium=bio&utm_campaign=launch')), "homepage Play links: the visit's own UTMs are carried; click IDs and other parameters never are");
  check(run('?utm_source=%22%3E%3Cscript%3E&utm_campaign=ok').every((h) => h === ref('utm_medium=homepage&utm_campaign=ok')), 'homepage Play links: an unsafe UTM value is dropped, not encoded into the link');
  check(homeSrc.split(`href="${PLAY_URL}"`).length - 1 === 2, 'homepage: the static Play links stay the plain listing URL in the HTML (hero + pricing); the referrer is added at runtime only');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
