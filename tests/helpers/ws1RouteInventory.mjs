// WS1 2026-10-10: static HTTP route inventory of server.js + routes/**.js.
// Shared by tests/ws1-unauthenticated-surface.test.mjs and
// tests/ws1-admin-route-guards.test.mjs. Pure source parsing — loads nothing.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

export function routeSourceFiles() {
  return [path.join(ROOT, 'server.js'), ...walk(path.join(ROOT, 'routes'))];
}

const ROUTE_RE = /\b(app|router)\.(get|post|put|patch|delete|all)\(\s*(?:(["'`])([^"'`]+)\3|([A-Za-z_$][\w$]*))/g;

// Each route: { file, line, method, path, args, body }
//   args = the text between the path and the handler (the middleware chain)
//   body = up to 1,500 chars from the declaration (for in-handler checks)
export function listRoutes() {
  const routes = [];
  for (const file of routeSourceFiles()) {
    const src = readFileSync(file, 'utf8');
    ROUTE_RE.lastIndex = 0;
    let m;
    while ((m = ROUTE_RE.exec(src))) {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 600);
      const cuts = ['(req', '\nrouter.', '\napp.', '\n  router.'].map((c) => after.indexOf(c)).filter((i) => i >= 0);
      const args = after.slice(0, cuts.length ? Math.min(...cuts) : after.length);
      routes.push({
        file: path.relative(ROOT, file),
        line: src.slice(0, m.index).split('\n').length,
        method: m[2].toUpperCase(),
        path: m[4] || `<${m[5]}>`,
        args,
        body: src.slice(m.index, m.index + 1500),
      });
    }
  }
  return routes;
}

// Middleware tokens that authenticate a request before the handler runs.
export const AUTH_TOKENS = ['requireAuthApi', 'requireAuth', 'twilioSignatureGuard'];

export function hasToken(args, token) {
  return new RegExp(`(^|[^\\w$])${token}([^\\w$]|$)`).test(args);
}

export function isAuthenticatedByMiddleware(route) {
  return AUTH_TOKENS.some((t) => hasToken(route.args, t));
}
