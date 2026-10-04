#!/usr/bin/env node
// Local, SYNTHETIC-DATA preview of the Admin Control Centre page (admin
// redesign, 2026-10-04). A design-review tool only:
//
//   node tools/admin-preview/serve.js [--port 4777] [--html path/to/admin-business.html]
//   open http://127.0.0.1:4777/admin/business#overview
//
// What it is NOT: it is not the HCG server, it is never mounted by
// server.js, it does not touch Supabase, Twilio, Stripe or any provider, and
// it does not weaken production authentication. It serves the page file
// with window.fetch replaced by the synthetic fixtures in ./fixtures.js
// (built by the real pure server-side modules), binds to 127.0.0.1 only,
// refuses every write (POST/PUT/DELETE answer 405 inside the page), and
// stamps a permanent "SYNTHETIC PREVIEW DATA" ribbon on every screen so a
// screenshot can never be mistaken for a real environment.
//
// Why fixtures rather than a real login: there is no local Supabase (no
// Docker on the review machine) and creating an admin account on staging
// would modify staging; the brief asked for safe mock/test data.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const fixtures = require('./fixtures');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const root = path.join(__dirname, '..', '..');
const PORT = Number(opt('port', 4777));
const HTML = path.resolve(opt('html', path.join(root, 'admin-business.html')));

function injection(routes) {
  return `<script>
// --- SYNTHETIC PREVIEW (tools/admin-preview/serve.js) — not a real environment ---
window.__PREVIEW_ROUTES__ = ${JSON.stringify(routes).replace(/</g, '\\u003c')};
(function () {
  const routes = window.__PREVIEW_ROUTES__;
  const respond = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, redirected: false, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = function (url, init) {
    const method = ((init && init.method) || 'GET').toUpperCase();
    const p = String(url).split('?')[0];
    if (method !== 'GET') return respond(405, { error: 'preview', reason: 'Synthetic preview — nothing is written' });
    if (!(p in routes)) return respond(404, { error: 'not_found', reason: 'no preview fixture for ' + p });
    const r = routes[p];
    if (r && r.__status) return respond(r.__status, r.body);
    return respond(200, r);
  };
  document.addEventListener('DOMContentLoaded', function () {
    const ribbon = document.createElement('div');
    ribbon.textContent = 'SYNTHETIC PREVIEW DATA — not a real environment';
    ribbon.setAttribute('style', 'background:#7c2d12;color:#fff;font:700 11px/1 system-ui,sans-serif;letter-spacing:.06em;padding:6px 12px;text-align:center');
    document.body.insertBefore(ribbon, document.body.firstChild);
    const open = new URLSearchParams(location.search).get('open');
    if (open) setTimeout(function () { if (typeof openCustomer === 'function') openCustomer(open); else if (typeof toggleCustomerDetail === 'function') toggleCustomerDetail(open); }, 400);
  });
})();
</script>`;
}

async function main() {
  const routes = await fixtures.routes();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/admin/business' || url.pathname === '/') {
      const html = fs.readFileSync(HTML, 'utf8');
      const at = html.indexOf('<script>');
      const page = at === -1 ? html : html.slice(0, at) + injection(routes) + '\n' + html.slice(at);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(page);
    }
    if (['/hcg-shield.png', '/logo.png'].includes(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(fs.readFileSync(path.join(root, 'public', url.pathname.slice(1))));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found (synthetic preview)');
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`Synthetic admin preview: http://127.0.0.1:${PORT}/admin/business#overview  (page: ${path.relative(root, HTML)})`));
}

main().catch((err) => { console.error(err); process.exit(1); });
