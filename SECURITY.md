# Security policy

## Reporting

Please report suspected vulnerabilities privately through GitHub's security
advisory flow for this repository. Do not include API keys, voice recordings,
private transcripts, or private workspace content in a public issue.

## Security invariants

- A voice connection is bound to one exact live DSH session object and one
  workspace membership.
- Provider authorization cannot happen before exact, unexpired, one-shot
  client-attested disclosure acceptance for that binding. Human consent is not
  claimed until the future browser capability is implemented and verified.
- Credential values remain on the host and are resolved per operation.
- The carrier requires a loopback peer, trusted host, matching HTTP(S) origin,
  and an available bounded-connection slot.
- Provider proposals carry no execution authority.
- Raw audio and partial provider deltas are ephemeral.
- Invalid, oversized, stale, ambiguous, or out-of-order input fails closed.

The current milestone does not stream audio or connect to a live provider.
