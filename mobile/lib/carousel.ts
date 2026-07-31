// Pure paging math extracted from app/(auth)/welcome.tsx so it's directly
// unit testable (tests/mobile-carousel.test.mjs) without rendering a real
// ScrollView. See that file's own header comment for the bug this
// prevents: a panel wider than the actual scrollable viewport (caused by
// an ancestor's padding) meant this math was being fed the wrong width
// entirely — the functions here were correct in isolation even before
// the fix; the bug was in what width value reached them. Both are now
// covered: this file's tests pin the math itself, and the width used at
// the call site is the carousel's own onLayout measurement.

// Which page a given horizontal scroll offset corresponds to, for a
// given (measured, not assumed) page width. Guards against width <= 0
// (not yet measured) to avoid a NaN/Infinity page index.
export function computePageIndex(offsetX: number, pageWidth: number): number {
  if (pageWidth <= 0) return 0;
  return Math.round(offsetX / pageWidth);
}

// Whether a width change (rotation, iPad Split View/Slide Over resize)
// requires re-syncing the scroll position to the current page. False on
// the very first measurement (nothing to resync from) and when the width
// hasn't actually changed.
export function shouldResyncScrollPosition(previousWidth: number, nextWidth: number): boolean {
  return previousWidth > 0 && nextWidth > 0 && previousWidth !== nextWidth;
}

// The x-offset to scroll to in order to show `pageIndex` at `pageWidth`.
export function scrollOffsetForPage(pageIndex: number, pageWidth: number): number {
  return pageIndex * pageWidth;
}
