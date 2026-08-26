# Conformance gates

Marketplace or production-ready release submission is blocked until all of
these are proven:

- host, origin, payload, and session/workspace rejection tests pass;
- no credential resolution or provider connection occurs before exact,
  user-visible client-attested disclosure acceptance;
- lazy-client metadata, non-secret route injection, delayed slot registration,
  exact session/workspace matching, gesture-only acceptance, challenge expiry,
  and disposal cleanup pass;
- the challenge never appears in the public browser snapshot or disclosure UI;
- localhost transport is described and tested only as a network-exposure and
  DNS-rebinding/cross-site fence, never as human authentication;
- provider retention, deletion, and residency are either supported by
  authoritative provider policy or explicitly labeled unknown;
- no secret appears in client frames, errors, fixtures, logs, or package files;
- Qwen handshake, transcription, output audio, barge-in, and cancellation pass
  against a live credentialed endpoint;
- uncommitted input and in-flight responses close at their documented
  wall-clock deadlines even when a peer dribbles data below byte ceilings;
- browser capture resamples to PCM16 mono/16 kHz only after accepted disclosure,
  and default playback consumes PCM16 mono/24 kHz without durable storage;
- microphone, playback, sockets, timers, and buffers stop on every lifecycle
  edge;
- accepted proposals fill but never submit the ordinary composer;
- provider output fails closed if the live Session object or Workspace binding
  changes after commit, and post-commit binary frames cannot overtake commit;
- the one-shot carrier releases its connection slot after terminal completion;
- build, packed-install, and current DSH profile smokes pass; and
- documentation states only behavior demonstrated by those gates.
