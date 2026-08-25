# Conformance gates

Marketplace or release submission is blocked until all of these are proven:

- host, origin, payload, and session/workspace rejection tests pass;
- no provider connection or credential resolution occurs before client-attested
  disclosure acceptance;
- no secret appears in client frames, errors, fixtures, logs, or package files;
- Qwen handshake, transcription, output audio, barge-in, and cancellation pass
  against a live credentialed endpoint;
- microphone, playback, sockets, timers, and buffers stop on every lifecycle
  edge;
- accepted proposals fill but never submit the ordinary composer;
- build, packed-install, and current DSH profile smokes pass; and
- documentation states only behavior demonstrated by those gates.
