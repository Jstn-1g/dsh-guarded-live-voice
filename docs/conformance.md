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

## Controlled Chromium BFCache smoke

`pnpm run smoke:browser:bfcache` builds the current client and serves separate
idle and active pages plus a same-origin traversal point. A controlled Chromium
tab visits each case, navigates to that traversal point, and goes Back. The
fixture accepts a result only when the original document reports both
`pagehide.persisted = true` and a later `pageshow.persisted = true`; an ordinary
reload is a failure, not a BFCache pass.

The active case reaches `recording` with a synthetic MediaStream and loopback
WebSocket before navigation. Its receipt verifies that pagehide returns the
controller to idle, stops the synthetic track, requests closure of both
plugin-owned AudioContexts, closes the socket, leaves no tracked timers, emits no
post-teardown audio, and rejects the old Session, consent, composer binding,
and buffered-input authority after restoration. Both cases must then start a
fresh disclosure-bound lifecycle, while an empty commit remains a no-op.

This is controlled evidence for the built client in a minimal slot harness
and a specific controlled Chromium run. It does **not** request a physical
microphone, inspect an OS indicator, connect to Qwen, resolve a credential,
compose an exact official DSH Web profile, exercise packaged Desktop, or by
itself close the BFCache release gate.

## Official DSH Web-profile BFCache smoke

`pnpm run smoke:harness:browser:bfcache` requires `DSH_HARNESS_ROOT` to name an
exact, clean Harness source checkout with its dependencies installed. It
rebuilds that checkout's Host and Client libraries and Web bundle with the
official client build values, writes and verifies the upstream client-artifact
receipt, packs the current plugin, and installs it through the official CLI
into a disposable shipped `web` profile. A headed stable Chrome then drives the
actual DSH Web UI through isolated idle and active history traversals.

A pass requires three distinct BFCache signals: an unchanged document boot
nonce, `pagehide.persisted = true` followed by `pageshow.persisted = true`, and
a main-frame `BackForwardCacheRestore` event with no
`Page.backForwardCacheNotUsed` diagnostic. Both official DSH event streams must
reconnect. The active case must also stop the synthetic track, close the two
plugin-owned AudioContexts, clear plugin timers, close the original voice
socket with `1000` / `stopped`, send no browser audio after teardown, preserve
the original composer draft, and require fresh disclosure and challenges when
reopening the original Session and then binding a second Session.

The recorded maintainer run used DSH v0.1.1-rc.2 at
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, Chrome 151, Playwright 1.61.1,
Windows `10.0.26200`, a deterministic fake provider, and synthetic Web Audio.
It did **not** use credential-backed Qwen, a physical microphone or speaker, an
OS device indicator, or packaged Desktop. It supplies exact official
Web-profile evidence for that environment, but issue #7 remains open for an
independent reproduction and no other release gate is inferred from it.
