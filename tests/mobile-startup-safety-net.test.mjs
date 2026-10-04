// Startup safety net (2026-10-04, after iOS 1.0.2 Build 15 stayed on the
// native splash on a real iPhone). Source-level checks, same convention as the
// other mobile screen tests (no RN test tooling in this repo).
//
// Run with: node tests/mobile-startup-safety-net.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(__dirname, '..', 'mobile', 'app');
const layout = readFileSync(path.join(app, '_layout.tsx'), 'utf8');
const entry = readFileSync(path.join(app, 'index.tsx'), 'utf8');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

// Root error screen
check(/export function ErrorBoundary\(\{ retry \}: ErrorBoundaryProps\)/.test(layout), 'root layout exports an expo-router ErrorBoundary (render errors land on a real screen)');
const boundary = layout.slice(layout.indexOf('export function ErrorBoundary'), layout.indexOf('export default function RootLayout'));
check(/SplashScreen\.hideAsync\(\)/.test(boundary), 'the error screen hides the splash itself');
check(/couldn't confirm your protection right now/.test(boundary) && /Try again/.test(boundary) && /retry\(\)/.test(boundary), 'error screen: says protection could not be confirmed, offers Try again (router retry)');
check(!/you're protected|you are protected|protection is on/i.test(boundary), 'error screen never claims the customer is protected');
check(/mailto:support@homecallguard\.co\.uk/.test(boundary), 'error screen offers support contact');

// Guaranteed splash hide
const root = layout.slice(layout.indexOf('export default function RootLayout'));
check(/useEffect\(\(\) => \{\s*SplashScreen\.hideAsync\(\)\.catch\(\(\) => \{\}\);\s*\}, \[\]\);/.test(root), 'root layout hides the splash once mounted (idempotent, errors swallowed)');
check(/import "\.\.\/lib\/voiceClient";/.test(layout.split('\n').find((l) => l.startsWith('import')) || ''), 'voiceClient is still the FIRST import (PushKit early init unchanged)');

// Slow session restore
check(/const STARTUP_STALL_MS = 10000;/.test(entry) && !/export const STARTUP_STALL_MS/.test(entry), 'start screen has a 10 s stall threshold (not exported from a route file)');
check(/if \(!isLoading\) return;/.test(entry) && /clearTimeout\(timer\)/.test(entry), 'the stall timer only runs while loading and is cleared');
check(/stalled && \(/.test(entry) && /We couldn't confirm your protection right now\. Check your internet connection\./.test(entry), 'after the threshold the start screen shows the "couldn\'t confirm" message (spinner stays)');
check(/<Redirect href="\/\(tabs\)" \/>/.test(entry) && /<Redirect href="\/\(auth\)\/welcome" \/>/.test(entry), 'normal routing unchanged once the session restore finishes');
check(!/setSession|signOut/.test(entry), 'the start screen never forges or clears a session on a slow start');

console.log(failures === 0 ? '\nStartup safety net: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
