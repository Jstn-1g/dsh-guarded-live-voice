# Threat model

## Protected assets

- DSH credential values;
- microphone audio and transcripts;
- session/workspace identity; and
- the user's authority to send prompts or execute tools.

## Addressed through milestone two

- Remote network access, DNS rebinding, and cross-site WebSocket attempts are
  constrained by loopback peer enforcement, an explicit Host allowlist,
  matching Origin, `Sec-Fetch-Site`, and connection limits. These controls do
  not authenticate a browser or human.
- Session-id reuse and workspace reassignment: object-identity lease and
  membership revalidation.
- Challenge replay or cross-binding substitution is constrained by a random,
  expiring, one-shot challenge tied to the connection, session, workspace, and
  provider. The challenge does not prove human presence.
- Idle resource retention: bind and disclosure expiry timers plus a hard
  simultaneous-connection cap.
- Parser abuse: byte limits, exact client schemas, and fail-closed provider
  handshake order.
- Tool escalation: one bounded proposal schema with `authority: none`.

## Deferred with the feature

Audio framing, rate/backpressure limits, provider cancellation, browser CSP
compatibility, and interruption latency will be addressed before audio is
enabled. Live handshake and audio behavior require credentialed functional
testing. Provider retention, deletion, or residency claims require authoritative
provider policy or contractual evidence and cannot be inferred from fake tests
or successful live connections.

## Known unresolved boundary

A malicious same-user local process can emulate the browser control protocol
and accept a challenge issued to its own connection. The current UI supplies a
visible gesture path, but no external trust root binds that gesture to a human.
WebAuthn with user verification or authenticated OS IPC would be required if
this attacker is brought into scope.
