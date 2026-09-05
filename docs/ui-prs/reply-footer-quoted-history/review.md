# Reply footer and quoted history

## Baseline and review scope

This combined draft covers two reader issues: the reply footer's routine save label displaces its Send actions, and recognized older email history remains expanded. No merge or deployment is approved.

- Base: merged PR12, `4fb65106b72855497ada4eafe3ea2862bd2753d5`. Its application tree matches the previously qualified `1881b6c` tree. The separate original Mac checkout, README edit and unpublished classifier commits are untouched and excluded.
- Hosted build at baseline capture: `index-Ba2d0NbS.js` / `index-kKVWxxy0.css`; deployment is owned by the release coordinator. Local optimized before build: `index-CWPNzOho.js` / `index-kKVWxxy0.css` from this exact base.
- Fictional fixture: default offline mock seed plus eight received examples, 168 canonical messages, two sources, one saved reply. No real mail or external inference. Base and candidate use independent copies of the same fixture.
- Appearance: Carbon / Comfortable / Super Sans (internal SuperMailSans) / Normal; 1440 × 1000 CSS px, DPR 1, 100% zoom. Existing email author formatting and scriptless sandbox remain authoritative.

## Before

![Baseline: full quoted history and displaced Send actions](before-reader.png)

[Baseline reader recording](before-reader.mp4) — recorded from the same optimized baseline; decoded frames inspected. The older quote is fully visible and no quoted-history disclosure exists.

## Intended differences

1. Keep Send, Send later and Remind me together on the left, utilities on the right; remove routine saved/saving text from the footer. Preserve autosave, actionable save failures/recovery and unsaved-recipient warnings. There is no Share draft feature to remove.
2. Reversibly collapse only reliably identified trailing history, initially Yahoo's explicit attribution + iOS quote, Gmail's attribution + quote and explicit citation blocks. Keep generic quotations, uncertain formats, quote-only messages and new inline/bottom replies visible. Preserve every sanitized node and all quoted content. Do not infer history from arbitrary prose or hide a broad Gmail wrapper.
3. Keep detection server-side, HTML in the isolated scriptless iframe, remote-media/tracker policy intact, and the disclosure keyboard-accessible.

## Checks pending implementation

Matching after screenshots/recordings, existing API/web regressions, SDK/host/web builds, actual disclosure and composer edge-state checks, and matched optimized 10k/50k action evidence will be added. No budget is lowered. PR12's disclosed concurrent W maximum of 205.7 ms remains a known finding, not a blanket waiver or a claim fixed by this work.

## Review gate

- [x] Baseline captured and inspected before application edits.
- [x] Isolated branch excludes private and unrelated local work.
- [ ] Implementation and relevant correctness checks complete.
- [ ] Matching after evidence and performance findings attached.
- [ ] Ryan approves this exact change before merge/deployment.
