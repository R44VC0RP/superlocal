# Reader arrow navigation

Before implementation: current published and deployed source is
`e2874a2edfdb00355e7bbf1c6f44ad3ca2c9fabf`. The two additional local commits
change only the offline classifier and its API tests; they do not change this UI.
The remote image serves `index-BJBoaDib.js` / `index-BZiHe4Vb.css`.
The same source built locally for both evidence captures serves
`index-CvET4OCQ.js` / `index-BZiHe4Vb.css` before the fix.

Evidence uses the actual SDK-backed offline mock, Unified inbox, a three-message
fictional conversation, 1440 × 1000 CSS pixels, DPR/zoom 1, Carbon/dark,
Comfortable density, Super Sans, Normal text size, and snippets enabled.
No live mailbox is opened or mutated. The runtime and starting route are retained
for the candidate. These are optimized builds with normal performance logging.

The before recording dispatches Up, Down, Right, Left in that order through the
real DOM keyboard handlers. Up incorrectly changes to the previous conversation;
Down returns; Right does nothing; Left opens the folder drawer. The timed PNG
sequence is encoded with its measured capture intervals, not presented as a
keyboard-latency or animation benchmark. Frames and the screenshot were inspected.

Expected change: in the reader, Left/Right select the previous/next conversation,
while Up/Down reveal and focus the previous/next message within that conversation.
Keep J/K and N/P, inbox-list arrows, drawer navigation, editing, modal behavior,
and modified keyboard shortcuts intact. Align the reader's navigation controls
and shortcut help with the restored mapping. No mail data or SDK policy changes.

## Candidate verification

- Optimized candidate: `index-pSZFDdX6.js`; CSS remains byte-identical
  `index-BZiHe4Vb.css`. All 61 existing-file web tests pass, including the updated
  shortcut regression; TypeScript and the optimized Vite build pass. The existing
  large-chunk warning remains. No new test files or dependencies.
- Same retained fixture: 160 SDK messages, 160 memberships, two source accounts,
  80 conversations. Matching entry screenshots differ only in the two navigation
  chevrons (a 33 × 10 pixel bounding region). The after recording uses the same
  Up, Down, Right, Left sequence; Up/Down stay within the conversation and
  Right/Left switch to the neighboring conversation and back.
- Browser QA verified message reveal/focus and first/last/single-message bounds;
  N/P and J/K; both header buttons; keys originating inside the sandboxed HTML
  frame; comment-editor and modifier boundaries; list arrows, Escape, folder
  drawer focus/activation, command modal and settings isolation.
- Shortcut help was inspected at 1440 × 1000 and 900 × 800 without horizontal
  clipping. The screenshot and timed recordings were inspected and fully decoded.
  Browser activations and keyboard events were DOM-generated, not OS-level input.
- Navigating from an open list drawer to a reader closes the drawer automatically;
  simultaneous reader/drawer state was not reachable through that checked flow.
  The new vertical-key branch explicitly yields while a drawer/settings panel is
  open. No live email was opened, no mail was sent, and no real mailbox changed.
- No SDK, query, projection, cache, or animation change: these checks are not a
  new startup, keyboard-latency, or large-mailbox performance claim.

The implementation remains subject to user review before merging. Publishing a
review branch does not publish a Docker image or deploy it to the live host.
