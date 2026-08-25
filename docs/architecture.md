# Architecture

The host-side spine is intentionally ordered:

1. `carrier` admits only a WebSocket upgrade with an explicitly trusted host
   and matching browser origin.
2. `authority` binds a connection to the exact live session object and its
   unique workspace membership.
3. `consent` creates a short-lived client-attested disclosure challenge for
   that full binding. Milestone one makes no human-presence claim.
4. `session-manager` consumes the challenge once, revalidates authority, and
   only then calls provider authorization.
5. `qwen` validates the fixed provider endpoint and enforces handshake order.
6. `proposal` converts the sole allowed tool call into bounded data with
   `authority: none`.

The carrier accepts only versioned JSON control frames in milestone one.
Binary audio is intentionally rejected until browser capture, backpressure,
provider streaming, cancellation, and cleanup are tested together.
