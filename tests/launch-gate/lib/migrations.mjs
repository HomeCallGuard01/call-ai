// Pure helpers for the cross-branch migration inventory. No git, no fs —
// the caller supplies entries so this is unit-testable with fixtures.

const NUMBERED = /^(\d{3,})_.+\.sql$/;

export function migrationNumber(filename) {
  const m = NUMBERED.exec(filename);
  return m ? m[1] : null;
}

/**
 * entries: [{ ref, file }] — one row per (branch, top-level migration file).
 * Returns { byNumber, collisions } where a collision is a number that maps
 * to more than one distinct filename anywhere across the supplied refs.
 */
export function inventory(entries) {
  const byNumber = new Map();
  for (const { ref, file } of entries) {
    const n = migrationNumber(file);
    if (!n) continue;
    if (!byNumber.has(n)) byNumber.set(n, new Map());
    const files = byNumber.get(n);
    if (!files.has(file)) files.set(file, new Set());
    files.get(file).add(ref);
  }
  const collisions = [];
  for (const [n, files] of [...byNumber].sort(([a], [b]) => a.localeCompare(b))) {
    if (files.size > 1) {
      collisions.push({
        number: n,
        files: [...files].map(([file, refs]) => ({ file, refs: [...refs].sort() })),
      });
    }
  }
  return { byNumber, collisions };
}

/** Duplicate numbers inside a single directory listing (one checkout). */
export function duplicatesInTree(filenames) {
  const seen = new Map();
  for (const f of filenames) {
    const n = migrationNumber(f);
    if (!n) continue;
    seen.set(n, [...(seen.get(n) || []), f]);
  }
  return [...seen].filter(([, fs]) => fs.length > 1).map(([number, files]) => ({ number, files }));
}
