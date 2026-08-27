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
- Qwen handshake, transcription, output audio, explicit manual-turn finish, and
  cancellation pass against a live credentialed endpoint;
- uncommitted input and in-flight responses close at their documented
  wall-clock deadlines even when a peer dribbles data below byte ceilings;
- browser capture resamples to PCM16 mono/16 kHz only after accepted disclosure
  and a second record gesture, and default playback consumes PCM16 mono/24 kHz
  without durable storage; these paths pass both deterministic tests and a
  packed Desktop/Web smoke;
- microphone, playback, sockets, timers, and buffers stop on every lifecycle
  edge;
- accepted proposals fill but never submit the ordinary composer, and the
  non-atomic draft-revision check is not described as compare-and-set;
- provider output fails closed if the live Session object or Workspace binding
  changes after commit, and post-commit binary frames cannot overtake commit;
- the one-shot carrier releases its connection slot after terminal completion;
- build, packed-install, and current DSH profile smokes pass; and
- documentation states only behavior demonstrated by those gates.

## Deterministic Harness composition smoke

`pnpm run smoke:harness:fake-qwen` packs the current plugin, installs that
tarball through the official DSH CLI into a disposable profile, composes it
with the official Web bundle, and exercises one disclosure-bound manual turn
through the real workspace/session RPC and `/guarded-voice` gateway. It uses a
fail-closed test loader and a deterministic loopback WebSocket peer; inherited
secret-like environment variables are removed, no real provider credential is
used, and no external provider connection is allowed.

This smoke is evidence only for packaged Host/Harness composition and the
gateway protocol boundary. It does **not** exercise a browser microphone,
browser playback/lifecycle behavior, Desktop packaging, or a live
credentialed Qwen endpoint, and it does not satisfy those release gates.

## Controlled Chromium raw-unload smoke

`pnpm run smoke:browser:unload` builds the current client bundle and starts a
loopback-only browser fixture. A controlled Chromium tab must open the printed
URL, press **Start**, **Accept**, and **Record**, wait for the `recording`
state, and then navigate that same tab to `/done`. The receipt verifies that
raw `pagehide` invokes restartable resource teardown, stops its synthetic
MediaStream track, requests closure of both owned browser AudioContexts,
closes the loopback WebSocket with the documented code, and sends no binary
audio after teardown.

This smoke deliberately replaces `getUserMedia` with a synthetic Web Audio
MediaStream and keeps all transport on IPv4 loopback. It proves document-unload
cleanup of the exercised browser resource path only. It does **not** request a
physical microphone, inspect a browser/OS microphone indicator, use Qwen or a
credential, compose an official packaged DSH client, or satisfy those still-
open release gates.
