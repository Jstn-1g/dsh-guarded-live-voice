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
12. The browser controller exposes explicit PCM append/commit seams and an
    injectable PCM output sink. It contains no microphone or default playback
    implementation in this branch.
13. A completed final assistant transcript can be copied to the exact session's
    composer only if its draft revision still equals the revision captured at
    disclosure acceptance. Conflict, cancellation, or incomplete transcript
    leaves the composer untouched; no code path calls submit.

All provider behavior is fake-server tested. Credentialed Qwen behavior,
browser capture/resampling, audible playback, packed DSH installation, and
latency remain release gates.
