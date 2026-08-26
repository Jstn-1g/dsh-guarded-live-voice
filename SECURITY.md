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
- No audio or provider deltas exist in milestone two. A future transport must
  keep raw audio and partial deltas ephemeral and clear them at every lifecycle
  boundary.
- Invalid, oversized, stale, ambiguous, or out-of-order input fails closed.

The current milestone does not stream audio or connect to a live provider.

## Known limitation

A malicious process running as the same OS user can forge browser-like headers,
open its own loopback connection, receive its own challenge, and accept it
without a human. Milestone two therefore provides a user-visible client-attested
acceptance path, not authenticated human consent. Stronger local-process
resistance requires an external trust root such as user-verifying WebAuthn or
authenticated operating-system IPC.
