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
   authorizes the allowlisted `qwen` model without exposing credential material.
9. `manual-turn` revalidates that ready lease, opens a provider capability, then
   revalidates again before publishing readiness. It repeats the check before
   every append and commit, and again before every provider event is exposed to
   the browser.
10. `qwen-manual-turn` requires an audio-mode `pcm`/manual-turn handshake and
    exposes exactly one bounded PCM append/commit capability. It accepts only
    the documented transcript/audio/response event subset; response, item,
    output, and content identities cannot change mid-turn. Uncommitted input
    expires after 60 seconds and an in-flight response after 90 seconds.
11. After provider readiness, `gateway` accepts bounded binary PCM frames and
    one `turn.commit` control. It relays only complete transcript snapshots,
    bounded PCM output frames, and one terminal status.
12. A second explicit button gesture creates the browser audio context and asks
    for microphone permission. An owned AudioWorklet downmixes the input; the
    client preserves resampler phase across callbacks, emits bounded PCM16
    mono/16 kHz frames, flushes before explicit commit, and releases tracks,
    nodes, contexts, and late permission results on every terminal path.
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

All provider behavior is fake-server tested. Capture/resampling and audible
playback are deterministic dependency-fake tested, including permission,
worklet-crash, cap, ordering, backpressure, and teardown paths. Credentialed
Qwen behavior, a packaged DSH Desktop smoke, browser CSP compatibility, and
measured latency remain release gates.
