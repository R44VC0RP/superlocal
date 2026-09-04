# Reply feedback and newest-message focus

## Baseline

Current deployed/public application: `088f1acf743f6b144e4a50c209e2c532a70fc8dc`.
The original Mac checkout's two unpublished commits concern offline classification;
they do not change this UI and are excluded. Its private README edit is untouched.
The remote currently serves `index-6mNjncul.js` and `index-Bb0O4DVi.css`.
The optimized local build of the same source serves `index-BnvlWz2W.js`.

The real SDK-backed offline fixture starts with 160 messages / 160 memberships,
two sources and 80 projected conversations. A fictional reply to the lantern
workshop conversation is sent, then a fictional incoming response is injected
through the mock provider and synchronized through the SDK. No real mail or
production writes are involved.

Captures: 1440 × 1000 CSS pixels, 100% zoom, Carbon theme, Comfortable density,
Super Sans / Normal text, images enabled, 10-second Undo Send policy, bounded
timing logs enabled. Browser actions use disclosed DOM activations in a read-only
Browser Control session, not OS-level input.

## Reproduced before implementation

- Accepted replies display “Sending reply…” throughout the intentional hold.
- Sending retains the previous expanded message beside the outgoing message.
- Returning to the thread after a newer incoming reply opens both the old sent
  reply and the new incoming message. The old sent reply receives the accent.
- This is retained send-focus state, not a duplicate SDK message or provider send.

![Accepted reply during Undo hold](before-send.png)
![Reopened conversation with a newer reply](before-new-reply.png)

## Intended change

Use the explicitly requested “Reply sent” / “Email sent” acknowledgment with
Undo while cancellation is available. This is a requested UI-copy exception
for accepted immediate submissions, not a change to delivery state: SDK pending,
processing, scheduled, failed, partial and uncertain states remain authoritative.
Do not change the hold, send earlier, claim delivery receipts, or offer Undo after
the SDK has begun sending. Scheduled sends and unsuccessful outcomes stay explicit.

Only the newest message should open/highlight on reentry. Preserve manual
expansion, reader shortcuts, draft state and pending-to-canonical identity.

Implementation and matching after evidence are pending. No merge or deployment
is authorized by this baseline-only draft.
