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
  without durable storage; these paths pass deterministic tests and the exact
  shipped Web-profile smokes, while packaged-shell evidence remains separate;
- microphone, playback, sockets, timers, and buffers stop on every lifecycle
  edge;
- accepted proposals fill but never submit the ordinary composer, and the
  non-atomic draft-revision check is not described as compare-and-set;
- provider output fails closed if the live Session object or Workspace binding
  changes after commit, and post-commit binary frames cannot overtake commit;
- the one-shot carrier releases its connection slot after terminal completion;
- a packaged-shell restart proves the old Harness writer has drained and
  disposed before a replacement can write the same persisted Session;
- build, packed-install, and current DSH profile smokes pass; and
- documentation states only behavior demonstrated by those gates.

## Packaged Desktop carrier scopes

“Packaged Desktop” is not one transport claim. A shell that embeds the served
DSH Web profile over HTTP(S) can, in principle, reach the current
`/guarded-voice` WebSocket. [Issue #9](https://github.com/Jstn-1g/dsh-live-voice/issues/9)
requires an exact install, restart, credential-free mount, uninstall, and
cleanup receipt before that shell is claimable. That restart receipt must also
show an ordered, quiescent handoff between Harness instances. The exact alpha's
JSONL backend supports one live writer per Session; upstream
[discussion #5103](https://github.com/deepseek-ai/deepseek-harness/discussions/5103)
and a controlled exact-alpha reproduction show that overlapping backend
instances that load and write the same Session ID can commit a sequence rollback
and make the complete Session history fail closed. Live Voice does not repair
Harness logs, so overlapping writers for one persisted Session remain
disallowed and any affected log must be backed up before recovery.

Harness `dsh-v0.1.2-alpha.1` also documents a packaged Electron model that
loads the UI over `file://` and carries Fetch through IPC. The current voice
client rejects non-HTTP(S) pages and its Host side registers only a Web-server
upgrade, so the IPC model cannot pass the present implementation.
[Issue #20](https://github.com/Jstn-1g/dsh-live-voice/issues/20) is the
prerequisite transport task. A served-Web shell receipt must not be promoted
into an IPC Desktop claim. Portable support for every Desktop carrier is not a
v0.3 release requirement: the current release decision requires
credential-backed Qwen and
at least one packaged-client physical-device smoke.

### Exact-alpha IPC-equivalent feasibility proof

`pnpm run smoke:harness:alpha-ipc` composes the exact
`dsh-v0.1.2-alpha.1` source generator, generated strict Typert Host/Remote
descriptors, Host shared Fetch and stream-gateway seams, Client Connection and
Gateway, and the alpha `TunnelServer` over a Node structured-clone
`MessageChannel`. A test-only bounded adapter normalizes the page-side URL and
adds proof-specific body, queue, error, abort, and lifecycle policy; it is not
the alpha `WorkerTunnel`. The production client, Host gateway, carrier, and
configuration are unchanged.

The synthetic proof exercises Host-minted connection capabilities,
cross-connection challenge rejection, the exact alpha `SessionStore` parent/child
fork and same-ID parent replacement under synthetic workspace membership,
canonical-base64 PCM, sequence/chunk/turn/queue limits, fail-closed stream-inbox
overflow, and addressed voice-stream/provider cancellation cleanup. Its provider
is an in-memory fake labeled `qwen-synthetic-no-credential`; its sequential burst
is neither a capture cadence nor an audible latency measurement. Local dependency
trees are unattested and always produce nonpublishable receipts. The manually
triggered, pinned workflow performs a clean frozen-lockfile installation and
builds the exact-alpha workspace libraries. Its receipt hashes selected built
exact-alpha entrypoints checked by the proof; only that workflow may produce a
publishable receipt.

This is IPC-equivalent feasibility evidence, not official seam confirmation or
Electron, Tauri, packaged Desktop, physical microphone/speaker, live provider,
or credential-backed Qwen evidence. The exact alpha's real `WorkerTunnel`
throws during unary URL resolution on a `file://` null origin before posting a
frame, which blocks reusing that implementation unchanged. The official
Desktop carrier and plugin seam remain unconfirmed, and a real packaged-shell
run must pass before issue #20 can support a Desktop claim.

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

## Official DSH alpha authenticated composition smoke

`pnpm run smoke:harness:alpha-auth` requires `DSH_HARNESS_ROOT` to name an
exact, clean, source-built Harness `dsh-v0.1.2-alpha.1` checkout whose official
Web client artifact receipt is present and valid. It packs the current plugin,
installs it through the official CLI into a disposable shipped `web` profile,
and verifies the alpha connection gate before exercising the authenticated
root, revisioned client-plugin combo, workspace/session RPC, disclosure, and
one deterministic fake-provider manual voice turn.

A pass requires the unauthenticated voice WebSocket upgrade to return `401`,
the private launch token to exchange for an HttpOnly, SameSite=Strict Harness
cookie, and all later HTTP, RPC, and voice requests to use that authenticated
session. The token and cookie are retained only in memory, are registered for
redaction, and never enter the sanitized receipt.

The recorded maintainer run used the exact `dsh-v0.1.2-alpha.1` tag at
`cd5ef8148158c3a752a658978873241fdf8e2bbc`, 218 official client artifacts with
SHA-256 `90cd4d95eae7de5963bb2a7acb851ef72d8684d5345ef3728f572d6a86b076b5`,
Windows `10.0.26200`, and a deterministic loopback provider. It proves only
this source-built authenticated Web-profile composition. The preview.3 peer
range admits this exact alpha in addition to the existing rc line; it does
**not** establish later or broad alpha compatibility, use
credential-backed Qwen, request a physical microphone or speaker, inspect an
OS device indicator, exercise BFCache, or exercise packaged Desktop.

## Official DSH alpha.2 authenticated composition smoke

`pnpm run smoke:harness:alpha2-auth` applies the same fail-closed authenticated
composition contract to an exact, clean, source-built
`dsh-v0.1.2-alpha.2` checkout at
`0a53fb55bea101816fa226bb964ae2bed71c343b`. It requires the official Web client
artifact receipt, packs the current plugin, installs it through the official
CLI into a disposable shipped `web` profile, rejects an unauthenticated voice
upgrade, exchanges the private launch token in memory, and completes one
deterministic fake-provider voice turn through the authenticated workspace and
Session RPC path.

The recorded preview.4 compatibility run used Node 24.19.0 and pnpm 11.7.0. It
validated 220 official client artifacts with SHA-256
`b4eda9de7c289a97164a7f1c7c90f4a3ee3f601ca6c1a90d70ff5e600242a3c4` and a
Web index with SHA-256
`d666c73f848b9c4a72501750750194231fa97bdb507f17b8b3bf692fac1eaab9`. This
evidence belongs to the tested preview.4 revision, not immutable preview.3. The
explicit peer range admits alpha.2 but does not admit later alpha versions.
This smoke does not use credential-backed Qwen, request a physical microphone
or speaker, inspect an OS device indicator, exercise BFCache, or exercise
packaged Desktop.

`pnpm run smoke:harness:alpha2-synthetic-demo` is the separate exact-alpha.2
zero-credential path. The official CLI installs the packed plugin into a
disposable authenticated Web profile while retaining the bundle's explicit
`provider: synthetic-demo` row. The proof creates a real Workspace and Session,
consumes the exact provider-bound disclosure, sends one bounded PCM frame, and
requires the fixed transcripts, one 4,800-byte deterministic chime, completed
terminal event, and provider/gateway disposal. It creates no Qwen shim or fake
provider server and configures no credential.

This proves the packed in-process demo on that exact served-Web alpha.2
composition. It does not prove a physical microphone or speaker, BFCache,
packaged Desktop, credential-backed Qwen, a live provider, or any later alpha.

## Official DSH alpha.3 authenticated composition smokes

`pnpm run smoke:harness:alpha3-auth` and
`pnpm run smoke:harness:alpha3-synthetic-demo` apply the same fail-closed
contracts to an exact, clean, source-built `dsh-v0.1.2-alpha.3` checkout at
`dd6322d604e00eec1ba5e0c8541159906a21094a`. Both pack the current plugin,
install it through the official CLI into a disposable shipped `web` profile,
require an unauthenticated voice upgrade to receive `401`, exchange the private
launch token only in memory, and bind authenticated Workspace and Session RPC.

The recorded post-release `main` run used Live Voice commit
`4a5959c7bc6177f039880350e7914f59bfda7486`, Node 24.19.0, and pnpm 11.7.0.
The exact Harness build produced 220 official client artifacts; their aggregate
SHA-256 was
`9ea788d128d4f5a12cde2b8893d581e9a27fcf4cc5bf88e6f6247d97e1cc510a`, and
the Web index SHA-256 was
`444492712f6d5f5c6a0e6741ebd2db04b929d88a269c768102f28b50e6384ab6`.
The fake-provider path completed the exact four-event manual turn. The bundled
synthetic path used no credential, external provider server, or transport shim
and produced the fixed transcripts plus one 4,800-byte deterministic chime.
Both paths disposed their provider and gateway resources.

These receipts apply only to that Live Voice revision and exact alpha.3 source
commit. They do not rebind immutable Preview.5 or prove credential-backed Qwen,
a physical microphone or speaker, BFCache, packaged Desktop, a live provider,
or any later alpha. Alpha.3 intentionally removes the optional SQLite Session
persistence backend; export an SQLite-backed profile with its older DSH version
before upgrading, and never downgrade a Session store in place after a newer
release has written it.

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
exact, clean Harness source checkout with its dependencies installed. The
smoke selects authentication for the exact admitted alpha version and requires
its pinned commit, tag, and one-time launch-token exchange before any profile
RPC or plugin upgrade; non-tokenized rc launches retain their existing path. It
rebuilds that checkout's Host and Client libraries and Web bundle with the
official client build values, writes and verifies the upstream client-artifact
receipt, packs the current plugin, and installs it through the official CLI into
a disposable shipped `web` profile. A headed stable Chrome then drives the
actual DSH Web UI through isolated idle and active history traversals.

A pass requires three distinct BFCache signals: an unchanged document boot
nonce, `pagehide.persisted = true` followed by `pageshow.persisted = true`, and
a main-frame `BackForwardCacheRestore` event with no
`Page.backForwardCacheNotUsed` diagnostic. Both official DSH event streams must
reconnect. The active case must also stop the synthetic track, close the two
plugin-owned AudioContexts, clear plugin timers, close the original voice
socket with `1000` / `stopped`, send no browser audio after teardown, preserve
the original composer draft, and require fresh disclosure and challenges when
reopening the original Session and then binding a second Session. The active
case must also switch from a recording Session to a newly mounted Session
without `pagehide`, stop the old capture, provider, and socket, emit no later
audio frame, and leave the new Session's voice control idle and available.

The recorded maintainer run used DSH v0.1.1-rc.2 at
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, Chrome 151, Playwright 1.61.1,
Windows `10.0.26200`, a deterministic fake provider, and synthetic Web Audio.
It did **not** use credential-backed Qwen, a physical microphone or speaker, an
OS device indicator, or packaged Desktop. It supplies exact official
Web-profile evidence for that environment, but issue #7 remains open for an
independent reproduction and no other release gate is inferred from it.

The preview.3 compatibility run additionally used clean source-built DSH
`dsh-v0.1.2-alpha.1` at
`cd5ef8148158c3a752a658978873241fdf8e2bbc`, 218 official client artifacts with
SHA-256 `31bcfade547ee8929bdf1a6513ccc16c3eaa86a51a5dd20d05f0e1758c233e15`,
Chrome 151, Playwright 1.61.1, Node 24.19.0, Windows `10.0.26200`, synthetic Web
Audio, and a deterministic loopback provider. It passed authenticated startup,
BFCache, and active SPA Session-switch teardown. It does not prove a live or
credential-backed provider, physical input/output, an OS device indicator,
packaged Desktop, independent reproduction, or another DSH alpha revision.
