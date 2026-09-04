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
