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
   authorizes only the provider named in that disclosure. The bundled
   `synthetic-demo` provider resolves no credential; explicit `qwen` mode
   authorizes the allowlisted model without exposing credential material.
9. `manual-turn` revalidates that ready lease, opens a provider capability, then
   revalidates again before publishing readiness. It repeats the check before
   every append and commit, and again before every provider event is exposed to
   the browser.
10. `synthetic-demo-turn` validates and counts bounded PCM without retaining it,
    then emits fixed transcripts and one deterministic chime in process.
    Alternatively, `qwen-manual-turn` requires an audio-mode
    `pcm`/manual-turn handshake and exposes exactly one bounded PCM append/commit
    capability. It accepts only the documented transcript/audio/response event
    subset; response, item, output, and content identities cannot change
    mid-turn. Uncommitted Qwen input expires after 60 seconds and an in-flight
    response after 90 seconds.
11. After provider readiness, `gateway` accepts bounded binary PCM frames and
    one `turn.commit` control. It relays only complete transcript snapshots,
    bounded PCM output frames, and one terminal status.
12. A second explicit button gesture selects the disclosed provider's input
    source. Synthetic mode emits one fixed local frame and never asks for a
    microphone. Qwen mode creates the browser audio context and asks for
    microphone permission; an owned AudioWorklet downmixes the input, preserves
    resampler phase, emits bounded PCM16 mono/16 kHz frames, flushes before
    explicit commit, and releases tracks, nodes, contexts, and late permission
    results on every terminal path.
13. Provider PCM16 mono/24 kHz output is converted and scheduled in protocol
    order. Playback is prepared by the same record gesture, permits at most five
    seconds of queued audio and 256 live source nodes, and resets every
    scheduled source on lifecycle teardown.
14. A completed final user transcript can be copied to the exact session's
    composer only if its draft revision still equals the revision captured at
    disclosure acceptance at the moment of the button handler's check. DSH's
    current `setDraft` action provides no atomic compare-and-set, so this is a
    best-effort conflict check rather than a collision-proof guarantee.
    Conflict, cancellation, or incomplete transcript leaves the composer
    untouched; no code path calls submit.

## Runtime carrier scope

The current registered path is a served-Web implementation. The Host publishes
its route through `webserver/index-inject` and owns an exact
`ctx.webServer.registerUpgrade` route. The browser requires an HTTP(S) page,
derives the corresponding `ws:` or `wss:` origin, and opens a native
`WebSocket`.

That path can be exercised by a packaged shell only when the shell embeds the
ordinary served DSH Web profile over HTTP(S). Such a result must identify the
exact shell and proves only that architecture.

Harness `dsh-v0.1.2-alpha.1` separately [documents an Electron
model](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/web-server.md#L1-L7)
that loads the built UI over `file://` and carries Fetch through IPC instead of
`dsh-host-webserver`. The current client fails closed on `file:`, and Harness's
page transport hooks do not expose an arbitrary authenticated binary duplex
channel. Therefore that Desktop model is unsupported by the current carrier,
not merely untested. [Issue #20](https://github.com/Jstn-1g/dsh-live-voice/issues/20)
tracks either a public transport-independent duplex seam or a measured,
bounded redesign over the existing Remote/Gateway facilities. It must preserve
all consent, authority, credential, backpressure, byte, time, and teardown
invariants.

The issue #20 synthetic proof establishes only that the exact alpha's generated
strict Typert Remote calls can carry bounded canonical-base64 PCM and events
through the real Client Connection/Gateway and Host shared-Fetch/stream seams
over a structured-clone `MessageChannel`. Its bounded page adapter is test-only:
besides normalizing the URL, it applies proof-specific body, queue, error,
abort, and lifecycle policy and is not a drop-in `WorkerTunnel`. The exact
alpha's unmodified `WorkerTunnel` still throws while resolving a unary URL from
a `file://` null origin, so that implementation cannot be reused unchanged
there. The official Desktop carrier and plugin seam remain unconfirmed, and
the proof does not alter the production carrier.

The local synthetic provider has deterministic end-to-end carrier coverage.
Qwen provider behavior is fake-server tested. Capture/resampling and audible
playback are deterministic dependency-fake tested, including permission,
worklet-crash, cap, ordering, backpressure, and teardown paths. Credentialed
Qwen behavior and an exact packaged served-Web shell physical-device smoke
remain v0.3 release gates. Portable IPC Desktop transport is a deferred
compatibility target rather than a requirement for that release; browser CSP
compatibility and measured latency also remain deferred.
