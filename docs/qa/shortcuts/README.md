# Shortcut compatibility review

Current-app integration baseline: `08fec64` (UI asset `index-BMI0yhwg.js`).
Public review base: `f4fbd04` on upstream/main. The intervening upstream changes concern AI taught rules; the keyboard resolver and reader match the current app. Both bases will be checked.

Before evidence was captured using the built-in fictional offline provider, two mailboxes, 80 Inbox rows, dark Superlocal theme, comfortable density, 100% zoom, 1707×960 viewport, optimized Vite build, Bun 1.4.2 on macOS arm64. No real accounts or secrets are included. The animated key-event capture shows initial state, Shift+G, existing Cmd+Down, then gg. It demonstrates outcomes, not animation timing. The sidebar image shows that g i leaves Starred and the folder drawer unchanged.

![Before jumps](before-jumps.gif)
![Before g i with sidebar open](before-sidebar.png)

Planned changes: add gg/Shift+G jumps, resolve G-sequence ownership across drawer/reader/iframe, compare the official Mac shortcut sheet against compose, selection, calendar and native window behavior. Preserve existing shortcuts and text editing. Capture matching after evidence and regressions before marking ready.

Official reference: https://download.superhuman.com/Superhuman%20Keyboard%20Shortcuts.pdf (Mac edition v8, retrieved 2026-09-07).
