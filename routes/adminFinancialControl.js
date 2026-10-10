// Financial Control Centre v1 page (WS4, 2026-10-10).
//
//   GET /admin/financial-control   → admin-financial-control.html
//
// READ-ONLY, requireAuth + requireAdmin. Serves a static page that reads
// existing admin JSON APIs (fortress overview, usage safety, ops events,
// control-centre summary) plus WS2's per-customer profitability endpoint
// (assumed contract "ws2-profitability-v1"; documented in
// docs/launch/2026-10-10-WS4-REPORT.md). No new database query, no write,
// no provider call. The page renders with textContent only; the CSP below
// also blocks any third-party script, frame or connection.
//
// NOT MOUNTED by this change. Mount in server.js next to the other admin
// factories with:
//   app.use(require("./routes/adminFinancialControl").createAdminFinancialControlRoutes());
"use strict";

const path = require("path");
const express = require("express");

const PAGE_PATH = path.join(__dirname, "..", "admin-financial-control.html");
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function createAdminFinancialControlRoutes({
  requireAuth = require("../middleware/requireAuth").requireAuth,
  requireAdmin = require("../middleware/requireAdmin").requireAdmin,
  pagePath = PAGE_PATH,
} = {}) {
  const router = express.Router();

  router.get("/admin/financial-control", requireAuth, requireAdmin, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "no-referrer");
    res.sendFile(pagePath);
  });

  return router;
}

module.exports = { createAdminFinancialControlRoutes, CONTENT_SECURITY_POLICY };
