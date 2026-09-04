# Remove the floating inbox count

Current published and deployed baseline:
`ebd90771ec052c8b481ca3ef288de7994861ac29`. The local-only classifier commits do
not change the app UI and are not included. The remote Linux build serves
`index-TIu8T8_J.js`; the same source built locally serves `index-pSZFDdX6.js`.
Both use `index-BZiHe4Vb.css`.

The reported top-right number is the sidebar's `.notification-count`, a redundant
inbox count absolutely positioned 8px from the top/right in a fixed 16px square.
The supplied screenshot shows 552 overflowing it; private user media is not
published here. The inspected fictional before capture reproduces the same
element with the existing mock's actual count of 80.

Capture conditions: optimized current app, real offline SDK mock, 160 messages,
two sources, 80 conversations; 1440 × 1000 CSS pixels, zoom/DPR 1, Carbon/dark,
Comfortable density, Super Sans/Normal and snippets enabled. The retained fixture
is unchanged between captures. No live mailbox was opened or mutated.

Expected change: remove only the floating badge and its unused CSS. Keep the
normal inbox/split/folder counts, sidebar, rows, and reader navigation unchanged.
This is static visual removal; paired screenshots are the relevant evidence.

## Verification

- All 61 existing web tests pass. TypeScript and the optimized Vite build pass;
  the existing large-chunk warning remains. No new tests or dependencies.
- Candidate assets: `index-BnvlWz2W.js` / `index-Bb0O4DVi.css`, verified after a
  full browser reload. The floating badge is absent from the DOM.
- Inspected before/after images differ only in the badge's original 16 × 16
  pixels at (1416, 8). Every rendered mail-row identity/bounding rectangle and
  both split labels/counts match exactly.
- Opening the folder drawer retains its legitimate Inbox count of 80.
  At 900 × 800 the badge remains absent, split counts remain intact, and the
  document has no horizontal overflow. These fixture controls were DOM-activated.
- No changes to count derivation, mailbox state, reader shortcuts, API behavior,
  loading, or animation; no new latency or large-mailbox performance claim.
