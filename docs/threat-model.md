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

## Added in the v0.3 preview

The provider handshake binds the created and updated session identity, requires
the requested allowlisted model, and confirms effective audio/text, PCM, manual-
turn configuration. The one-turn capability bounds input/output chunks, turn
duration, transcript length, provider-event size, and socket backpressure; disables
redirects and compression; rejects tool/function-call surfaces; and cleans up
on cancellation, timeout, protocol failure, provider closure, authority change,
and local close. Independent 60-second input and 90-second response wall clocks
prevent a low-rate peer from holding the provider capability indefinitely.

The coordinator revalidates exact session object identity and workspace
membership before and after provider open, before every append/commit, and
before every provider output event is forwarded to the browser. The composer
handoff is explicit, accepts only a completed final user transcript, and
checks for an unchanged draft revision immediately before `setDraft`. Because
DSH exposes no atomic compare-and-set action here, this reduces obvious stale
replacement but cannot guarantee that a concurrent edit will never be
overwritten.

The browser capture path begins only from the explicit record gesture after
disclosure acceptance. It uses an owned AudioWorklet, continuous resampler,
bounded frames, a hard turn cap, and deterministic track/node/context cleanup.
Playback preserves provider-frame order and fails closed above a five-second
queue or 256 live source nodes. Worklet crashes, message errors, permission
denial, delayed permission, reset races, and backpressure are
deterministic-fake tested.

Client and Host preserve the observed order of binary audio and non-cancellation
control frames. After a terminal response, the browser retains only the bounded
completed snapshot and releases its one-shot carrier connection immediately.

## Deferred with the feature

Provider cancellation and barge-in, continuous turns, browser CSP compatibility,
packaged Desktop behavior, and interruption latency remain deferred. Browser
capture/playback still require a physical-device packaged Desktop smoke; live
handshake and audio behavior require credentialed functional testing. Provider retention, deletion,
or residency claims require authoritative provider policy or contractual
evidence and cannot be inferred from fake tests or successful live connections.

## Known unresolved boundary

A malicious same-user local process can emulate the browser control protocol
and accept a challenge issued to its own connection. The current UI supplies a
visible gesture path, but no external trust root binds that gesture to a human.
WebAuthn with user verification or authenticated OS IPC would be required if
this attacker is brought into scope.
