# Architecture

The current design has an ordered Host/browser control path:

1. The Host publishes only a versioned, non-secret WebSocket route through
   DSH's structured index-injection table.
2. The lazy browser module registers a compact composer control and full-width
   disclosure panel through delayed slot declarations.
3. An explicit user gesture opens the socket and binds it to the exact mounted
   session.
4. `carrier` enforces loopback peer, trusted Host, matching Origin, fetch-site,
   and connection-count fences. These checks do not authenticate a human or
   same-user local process.
5. `authority` binds the connection to the exact live session object and its
   unique workspace membership.
6. `consent` creates a short-lived, one-shot challenge for that connection,
   session, workspace, and provider.
7. The browser keeps the challenge out of its public UI snapshot, displays the
   exact disclosure and binding, and sends acceptance only after the disclosure
   button is pressed.
8. `session-manager` consumes the challenge once, revalidates authority, and
   permits the Host to validate credential availability and the allowlisted
   `qwen` endpoint. The registered runtime stops here.
9. The internal `qwen` handshake validates provider-event bounds, documented
   order, exact session identity, requested model, and effective configuration.
10. The internal `qwen-transport` can establish a configuration-only session,
    send one fixed text-only/manual-turn update, and return only an opaque close
    lease. It is not exported from the package root or called by `apply`.
11. `proposal` can parse bounded non-executable proposal data, but no
    provider-to-composer integration exists yet.

Steps 9 through 11 are internal, fake-provider-tested groundwork and do not
create a public provider or composer path.

The carrier accepts only versioned JSON control frames. Binary audio remains
rejected until microphone capture, backpressure, provider streaming,
cancellation, playback, and cleanup are implemented and verified together.
