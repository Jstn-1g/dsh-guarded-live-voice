# Threat model

## Protected assets

- DSH credential values;
- microphone audio and transcripts;
- session/workspace identity; and
- the user's authority to send prompts or execute tools.

## Addressed in milestone one

- Remote raw clients, DNS rebinding, and cross-site WebSocket attempts:
  loopback peer enforcement, explicit trusted host, matching Origin, and
  `Sec-Fetch-Site` checks.
- Session-id reuse and workspace reassignment: object-identity lease and
  membership revalidation.
- Consent replay or swapping: random, expiring, one-shot challenge tied to the
  connection, session, workspace, and provider.
- Idle resource retention: bind and disclosure expiry timers plus a hard
  simultaneous-connection cap.
- Parser abuse: byte limits, exact client schemas, and fail-closed provider
  handshake order.
- Tool escalation: one bounded proposal schema with `authority: none`.

## Deferred with the feature

Audio framing, rate/backpressure limits, provider cancellation, browser CSP
compatibility, and interruption latency will be addressed before audio is
enabled. Live-provider behavior and retention claims require credentialed
validation and are not inferred from the fake provider tests.
