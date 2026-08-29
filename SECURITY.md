# Security policy

## Reporting

Please report suspected vulnerabilities privately through GitHub's security
advisory flow for this repository. Do not include API keys, voice recordings,
private transcripts, or private workspace content in a public issue.

## Security invariants

- A voice connection is bound to one exact live DSH session object and one
  workspace membership.
- Credential resolution and any future provider connection cannot occur before
  exact, unexpired, one-shot, user-visible client-attested disclosure acceptance
  for that binding. The included button is an explicit gesture path, but the
  challenge does not authenticate human identity or presence.
- Credential values remain on the host and are resolved per operation.
- The carrier requires a loopback peer, trusted Host, matching HTTP(S) Origin,
  acceptable `Sec-Fetch-Site`, and an available bounded-connection slot. These
  are network-exposure and DNS-rebinding/cross-site fences, not authentication.
- Provider proposals carry no execution authority.
- The v0.3 preview path permits one bounded manual PCM turn after accepted
  disclosure. The package does not durably persist raw audio or partial
  provider deltas, and releases its owned transient resources on lifecycle
  teardown. The included browser path requests microphone permission only from
  its explicit record gesture, resamples through an owned AudioWorklet, and
  schedules bounded PCM playback without durable storage. An integrator that
  supplies a custom PCM sink owns that sink's retention behavior.
- Invalid, oversized, stale, ambiguous, or out-of-order input fails closed.

When explicitly configured with a DashScope workspace and credential reference,
the registered v0.3 preview path can connect to Qwen after exact disclosure
acceptance and stream only bounded PCM input. It exports no DSH history, files,
workspace instructions, arbitrary text input, system instruction, or tool
schema. Provider transcript/audio output is revalidated against the exact live
session and workspace lease before it reaches the browser. Completed assistant
text stays proposal-only. An explicit action may copy only the final user
transcript into the exact current Session's composer after re-reading the voice
lifecycle and matching both the draft revision and the opaque per-Session
composer action identity captured at consent. That one-shot binding blocks a
replacement Session that reuses the same textual ID, but no path submits a
prompt or invokes a tool. The available `setDraft` action is not an atomic
compare-and-set with concurrent typing, so this is not a collision-proof
overwrite guarantee.

The package-root `openQwenManualTurn` primitive owns provider destination,
protocol, and resource controls. Direct Host-side callers must compose an
equivalent exact-authority and consumed-consent boundary; the registered
`apply` path does so. The included capture/playback implementation is
deterministic-fake tested but not yet proven in a packaged served-Web shell or
against a credentialed Qwen endpoint. The separate Harness-documented
`file://` + IPC Desktop carrier is not supported by the current direct
WebSocket and requires issue #20.

## Known limitation

A malicious process running as the same OS user can forge browser-like headers,
open its own loopback connection, receive its own challenge, and accept it
without a human. Milestone two therefore provides a user-visible client-attested
acceptance path, not authenticated human consent. Stronger local-process
resistance requires an external trust root such as user-verifying WebAuthn or
authenticated operating-system IPC.
