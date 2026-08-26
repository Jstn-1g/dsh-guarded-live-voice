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
- The v0.3 development path permits one bounded manual PCM turn after accepted
  disclosure. The package does not durably persist raw audio or partial
  provider deltas, and releases its owned transient resources on lifecycle
  teardown. An integrator that supplies a custom PCM sink owns that sink's
  retention behavior.
- Invalid, oversized, stale, ambiguous, or out-of-order input fails closed.

When explicitly configured with a DashScope workspace and credential reference,
the registered v0.3 development path can connect to Qwen after exact disclosure
acceptance and stream only bounded PCM input. It exports no DSH history, files,
workspace instructions, arbitrary text input, system instruction, or tool
schema. Provider transcript/audio output is revalidated against the exact live
session and workspace lease before it reaches the browser. Completed text stays
proposal-only: an explicit, draft-revision-fenced action may fill the composer,
but no path submits a prompt or invokes a tool.

The package-root `openQwenManualTurn` primitive owns provider destination,
protocol, and resource controls. Direct Host-side callers must compose an
equivalent exact-authority and consumed-consent boundary; the registered
`apply` path does so. Browser microphone capture and default playback are not
included in this milestone.

## Known limitation

A malicious process running as the same OS user can forge browser-like headers,
open its own loopback connection, receive its own challenge, and accept it
without a human. Milestone two therefore provides a user-visible client-attested
acceptance path, not authenticated human consent. Stronger local-process
resistance requires an external trust root such as user-verifying WebAuthn or
authenticated operating-system IPC.
