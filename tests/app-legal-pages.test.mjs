// In-app legal pages with no route to web checkout (WS4, 2026-10-10).
//
// Google Play's consumption-only rule (Payments policy FAQ): an app may link
// account/privacy/help pages "as long as the web page does not eventually
// lead to" a prohibited payment method. public/terms.html and privacy.html
// carry the site header and footer (homepage, customer login → sign-up →
// Stripe Checkout), so the Android app opens navigation-free copies instead:
//
//   public/legal/terms-app.html    generated from public/terms.html
//   public/legal/privacy-app.html  generated from public/privacy.html
//
// The legal TEXT is byte-for-byte the site's <main> (only the cross-link
// between the two documents is pointed at its app copy). The header and
// footer are replaced by a plain, unlinked brand mark. This test regenerates
// both in memory and fails if the committed files differ, so the app copy
// can never drift from the published terms.
//
//   Regenerate after editing terms.html / privacy.html:
//     node tests/app-legal-pages.test.mjs --write
//
// Run with: node tests/app-legal-pages.test.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const PAGES = [
  { source: 'terms.html', target: 'terms-app.html' },
  { source: 'privacy.html', target: 'privacy-app.html' },
];

const PLAIN_HEADER = `<header class="site-header">
    <div class="container nav-row">
      <span class="brand">
        <img src="/logo.png" alt="Home Call Guard logo">
        <span class="brand-name">Home Call <span>Guard</span></span>
      </span>
    </div>
  </header>`;

const PLAIN_FOOTER = `<footer class="site-footer">
    <div class="container">
      <p class="copyright">
        © <span id="currentYear"></span> Home Call Guard. All rights reserved.
      </p>
    </div>
  </footer>`;

function replaceOnce(html, re, replacement, what) {
  const matches = html.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || [];
  if (matches.length !== 1) throw new Error(`${what}: expected exactly one match, found ${matches.length}`);
  return html.replace(re, replacement);
}

export function buildAppLegalPage(sourceHtml, sourceName) {
  let html = sourceHtml;
  html = replaceOnce(html, /<!DOCTYPE html>\n/, `<!DOCTYPE html>\n<!-- GENERATED from public/${sourceName} by tests/app-legal-pages.test.mjs --write. Do not edit by hand: edit public/${sourceName} and regenerate. In-app copy with no site navigation (Google Play consumption-only rule: no route to web checkout). -->\n`, 'doctype');
  html = replaceOnce(html, /(<link rel="canonical"[^>]*>)/, '$1\n\n  <meta name="robots" content="noindex">', 'canonical');
  html = replaceOnce(html, /<header class="site-header">[\s\S]*?<\/header>/, PLAIN_HEADER, 'site header');
  html = replaceOnce(html, /<footer class="site-footer">[\s\S]*?<\/footer>/, PLAIN_FOOTER, 'site footer');
  html = html.replace(/href="\/privacy\.html"/g, 'href="/legal/privacy-app.html"').replace(/href="\/terms\.html"/g, 'href="/legal/terms-app.html"');
  return html;
}

const mainOf = (html) => {
  const m = html.match(/<main class="doc">[\s\S]*<\/main>/);
  return m ? m[0] : null;
};

const write = process.argv.includes('--write');
for (const { source, target } of PAGES) {
  const expected = buildAppLegalPage(read('public', source), source);
  if (write) {
    mkdirSync(path.join(root, 'public', 'legal'), { recursive: true });
    writeFileSync(path.join(root, 'public', 'legal', target), expected);
    console.log(`wrote public/legal/${target}`);
  }
  let actual = null;
  try { actual = read('public', 'legal', target); } catch { /* missing */ }
  check(actual === expected, `public/legal/${target} is exactly the generated copy of public/${source} (regenerate with --write after editing ${source})`);
  if (!actual) continue;

  const siteMain = mainOf(read('public', source)).replace(/href="\/privacy\.html"/g, 'href="/legal/privacy-app.html"').replace(/href="\/terms\.html"/g, 'href="/legal/terms-app.html"');
  check(mainOf(actual) === siteMain, `${target}: the legal text is identical to ${source} (only the sibling-document link is rewritten)`);

  const hrefs = [...actual.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  const allowed = (h) =>
    h.startsWith('mailto:') ||
    h === 'https://ico.org.uk' ||
    h === '/legal/terms-app.html' ||
    h === '/legal/privacy-app.html' ||
    h === `https://homecallguard.co.uk/${source}`; // <link rel="canonical"> (not navigable)
  const bad = hrefs.filter((h) => !allowed(h));
  check(bad.length === 0, `${target}: every link is mailto:, the sibling app legal page, the regulator (ico.org.uk) or the canonical tag — no homepage, login, sign-up, dashboard or checkout (${bad.join(', ') || 'none'})`);
  const canonicalIdx = actual.indexOf('<link rel="canonical"');
  const anchorsOnly = actual.slice(0, canonicalIdx) + actual.slice(actual.indexOf('>', canonicalIdx) + 1);
  check(!/https:\/\/homecallguard\.co\.uk/.test(anchorsOnly), `${target}: no navigable link back to the HCG website`);
  check(!/<a [^>]*href="\/(?!legal\/)/.test(actual) && !/href="\/"/.test(actual), `${target}: no relative link into the site (only /legal/*-app.html)`);
  check(!/checkout|\/login|\/register|\/upload|\/dashboard|stripe\.com|billing\.stripe|buy\.stripe/i.test(hrefs.join(' ')), `${target}: no checkout, login, register, upload, dashboard or Stripe link`);
  check(!/<form\b/i.test(actual) && !/<iframe\b/i.test(actual), `${target}: no forms or embedded frames`);
  check(/<meta name="robots" content="noindex">/.test(actual), `${target}: not indexed by search engines (the site page stays canonical)`);
  const scripts = [...actual.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1].trim());
  check(scripts.length === 1 && scripts[0] === 'document.getElementById("currentYear").textContent = new Date().getFullYear();', `${target}: the only script is the copyright year (no redirects or injected links)`);
}

console.log(failures === 0 ? '\nApp legal pages: all checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
