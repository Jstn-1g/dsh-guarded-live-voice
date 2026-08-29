# DSH Live Voice

![DSH Live Voice: consent-bound voice for DSH](https://raw.githubusercontent.com/Jstn-1g/dsh-live-voice/main/assets/dsh-live-voice-social.png)

[![CI](https://github.com/Jstn-1g/dsh-live-voice/actions/workflows/ci.yml/badge.svg)](https://github.com/Jstn-1g/dsh-live-voice/actions/workflows/ci.yml)

[Preview release](https://github.com/Jstn-1g/dsh-live-voice/releases/tag/v0.3.0-preview.1)
· [Contributing](https://github.com/Jstn-1g/dsh-live-voice/blob/main/CONTRIBUTING.md)
· [Testing guide](https://github.com/Jstn-1g/dsh-live-voice/blob/main/TESTING.md)
· [Release gate](https://github.com/Jstn-1g/dsh-live-voice/issues/5)

A safety-first live-voice add-on for the served DeepSeek Harness Web profile
and shells that embed that profile, with an exact-session Host boundary, a lazy
browser disclosure UI, and one bounded manual audio turn. The v0.3 preview
includes explicit-gesture microphone capture and bounded playback;
credentialed-provider, physical-device, and packaged-shell behavior are not yet
proven.

## Current status

Unless stated otherwise, this section describes the current `main` branch, not
the published preview artifact. The immutable public `v0.3.0-preview.1` release
is pinned to `fdeb7c8` and predates the official-Web BFCache and exact-alpha
authentication merges. Bind every result to the exact revision that was
tested.

### Runtime support

| Runtime | Preview status |
| --- | --- |
| Shipped DSH `web` profile on v0.1.1-rc.2 | Exact fake-provider composition and official Web-profile BFCache receipt passed; physical audio, live Qwen, and independent reproduction remain open. |
| Exact source-built `dsh-v0.1.2-alpha.1` Web profile | Browser-session authentication and one fake-provider turn passed for that pinned tag only. The declared peer ranges remain unchanged and exclude this alpha prerelease; verified release-line support remains rc.2. |
| Community packaged shell embedding the served Web profile over HTTP(S) | Structurally compatible candidate, not a pass. The exact Tauri v0.9.3 install/restart/uninstall run is tracked in [issue #9](https://github.com/Jstn-1g/dsh-live-voice/issues/9). |
| Harness-documented packaged `file://` + Fetch-over-IPC model | Not supported by the current direct WebSocket carrier. A public transport seam or validated Remote redesign is tracked in [issue #20](https://github.com/Jstn-1g/dsh-live-voice/issues/20). |

A packaged-shell result must name its exact carrier. A pass in a shell that
loads `http://127.0.0.1:<port>` proves only that served-Web architecture; it
does not prove a shell that loads the UI from `file://` and sends Fetch through
IPC.

The v0.2.0 pre-release, published under the former
`dsh-guarded-live-voice` name, established the browser-side consent surface and
exact-session Host boundary:

- a lazy DSH browser module with composer-control and disclosure-panel slots;
- structured Host-to-browser boot data containing only the non-secret WebSocket
  route;
- exact live-session and workspace binding, including id-reuse detection;
- a visible disclosure of destination, exported context, execution authority,
  unknown provider retention, session, workspace, and expiry;
- an explicit button gesture as the included UI path for consuming the hidden,
  expiring, one-shot challenge;
- credential resolution only after that user-visible client-attested acceptance;
- loopback, same-origin, trusted-Host, payload, and connection-count fences;
- fail-closed protocol parsing and deterministic socket, timer, and session
  cleanup; and
- bounded proposal parsing with no execution authority.

This v0.3 preview adds a bounded manual-turn foundation behind that
same consumed-consent and authority lease:

- an audio-mode Qwen handshake that requires the requested model, stable
  provider session identity, `pcm` input/output, text+audio modalities, and
  manual `turn_detection: null`;
- one PCM16 mono/16 kHz input turn, limited to 32 KiB chunks and 30 seconds,
  followed by exactly one explicit commit and `response.create`;
- bounded complete user/assistant transcript snapshots and PCM16 mono/24 kHz
  output, including provider/response/item/index identity checks and rejection
  of tool or other non-message capabilities;
- provider and browser backpressure limits, one-minute output ceiling,
  a 60-second uncommitted-input deadline, a 90-second response deadline,
  fail-closed parsing, and deterministic terminal teardown;
- authority revalidation after provider open and before every audio append or
  commit, including session-object reuse and workspace-move rejection; and
- a final user-transcript “Use my transcript as draft” action that is available
  only after a completed response with a final user transcript and while the
  composer revision and opaque, per-Session action identity captured at consent
  remain unchanged. The binding is consumed immediately before `setDraft`, so
  even same-text-ID Session replacement and repeated clicks fail closed. The
  current voice lifecycle and exact Session are also re-read at the click. This
  still is not an atomic compare-and-set with concurrent typing. It never
  submits;
- an explicit “Start recording” gesture that requests microphone permission,
  an AudioWorklet that downmixes and continuously resamples browser audio to
  PCM16 mono/16 kHz, 100 ms bounded input frames, and deterministic cleanup on
  denial, cancellation, cap, processing failure, session failure, or unload;
  and
- ordered PCM16 mono/24 kHz Web Audio playback with five-second and 256-live-
  source ceilings, reset ownership, and fail-closed backpressure.

The preview still does **not** support continuous conversation or barge-in, send
DSH history/files/instructions, call tools, submit the composer, or write custom
session events. Capture, resampling, framing, cleanup, playback ordering, and
backpressure are deterministic-fake tested. Packed composition with the
official Harness is verified against a local fake Qwen server; no
credential-backed audio roundtrip, physical-device audio, or packaged-shell
smoke is claimed. A standalone controlled-Chromium fixture now verifies
real BFCache save/restore for idle and synthetic active-audio paths, including
resource teardown and stale client Session, consent, and composer-binding
rejection. A second opt-in smoke rebuilds an exact, clean Harness checkout with
the official client build profile, installs the packed plugin through the
official CLI into a disposable shipped `web` profile, and drives the real DSH
UI. The recorded DSH v0.1.1-rc.2 / Chrome 151 run verified BFCache restoration,
DSH event-stream reconnection, active teardown, draft preservation, and fresh
consent and Session binding. It used synthetic audio and a fake loopback
provider; independent reproduction and a packaged served-Web shell receipt
remain open. The separate `file://` + IPC Desktop architecture needs the
portable-carrier work in issue #20 before it can be tested. A separate
authenticated composition smoke now verifies the exact,
clean source-built DSH `dsh-v0.1.2-alpha.1` Web profile: an unauthenticated voice
upgrade receives `401`, the private launch token is exchanged for the Harness
cookie without entering the receipt, and the authenticated client, workspace,
Session, and fake-provider voice turn complete. This exact-tag result does not
widen the published peer range, claim general alpha compatibility, or infer
BFCache behavior for the alpha. This is not a marketplace-ready voice product
and is not “ChatGPT
Live parity.” DSH Live Voice is the product name; the guarded consent and
authority model remains its security architecture.

The disclosure flow is user-visible, but it is not cryptographic proof that a
human accepted it. The one-shot challenge proves control of that local client
connection only. Loopback, Host, Origin, and `Sec-Fetch-Site` checks mitigate
remote access, DNS rebinding, and cross-site requests; they do not authenticate
a human or resist a malicious same-user local process.

## Safety boundary

Only PCM supplied through the bounded browser-controller seam after accepted
disclosure can reach Qwen. No DSH history, files, workspace instructions,
memory, arbitrary text, system instruction, or tool schema crosses that
boundary. The final user transcript can become an ordinary composer draft only
through an explicit button, an exact-current-Session recheck, the opaque
per-Session composer action identity captured at consent, and a draft-revision
check. The identity binding is one-shot and blocks same-ID Session replacement.
Assistant text remains a voice preview and is never inserted by that action.
The current DSH action is not an atomic
compare-and-set, so the check is not a collision-proof overwrite guard. The
plugin cannot submit a message, call a tool, write a custom session event, or
execute work.

## Install the preview

The release tag includes prebuilt Host and browser artifacts, so installation
does not require a source build:

```sh
dsh plugin --profile web add github:Jstn-1g/dsh-live-voice#v0.3.0-preview.1
```

Restart the Web profile after installation. Existing v0.2.0 testers should
remove `dsh-guarded-live-voice` before installing the renamed package. The
internal Cordis row id `guarded-live-voice`, default `/guarded-voice` route, and
hidden browser protocol/composition keys remain stable for this transition so
existing profiles and mixed cached bundles do not silently duplicate or stop
matching the plugin.

This preview has deterministic and packed fake-provider coverage but still
requires the live-provider and physical-device checks tracked in the release
gate before a release candidate or stable release.

## Help validate the preview

Useful reports are welcome even when they uncover a failure. Use the structured
[tester report](https://github.com/Jstn-1g/dsh-live-voice/issues/new?template=tester-report.yml)
for install, browser, provider, physical-device, BFCache, or exact packaged
shell results. Follow the
[testing guide](https://github.com/Jstn-1g/dsh-live-voice/blob/main/TESTING.md),
then include the exact release or commit, DSH version, platform, browser,
steps, and sanitized evidence. Never attach credentials, recordings, private
transcripts, workspace content, or identifying logs.

A passing report is evidence for only the environment and path it directly
tested. It does not by itself close another release gate or make the preview a
stable, marketplace-ready, or officially endorsed product.

## Development

Requirements: Node.js 22.19.x or Node.js 24+, and pnpm 11.7.

```sh
pnpm install
pnpm check
```

`pnpm check` runs strict Host and browser TypeScript checking, deterministic
tests, Host and browser builds, package linting, browser-bundle materialization,
and a dry-run package-content check.

New contributors can browse the
[`good first issue`](https://github.com/Jstn-1g/dsh-live-voice/labels/good%20first%20issue)
and [`help wanted`](https://github.com/Jstn-1g/dsh-live-voice/labels/help%20wanted)
queues. Read the
[contribution guide](https://github.com/Jstn-1g/dsh-live-voice/blob/main/CONTRIBUTING.md)
before opening a pull request; it explains the safety invariants, test
expectations, and paths that do not require provider credentials or physical
audio hardware.

## Development configuration

The bundle inserts the compatibility-stable `guarded-live-voice` Cordis row
with the `dsh-live-voice` package name. A profile override will
need an Alibaba Cloud Model Studio workspace id before provider authorization:

```yaml
- id: guarded-live-voice
  name: dsh-live-voice
  config:
    credentialRef: DASHSCOPE_API_KEY
    dashscopeWorkspaceId: your-workspace-id
    model: qwen-audio-3.0-realtime-plus
    route: /guarded-voice
    trustedHosts: localhost,127.0.0.1,[::1]
    maxConnections: 8
```

After accepted disclosure, the preview opens the allowlisted Qwen
endpoint for one exact-session manual turn and resolves the credential only on
the Host. A second explicit button starts browser capture; finishing it commits
only that bounded provider turn. This path is fake-tested but still needs a
packaged served-Web shell receipt and credential-backed Qwen roundtrip. The
separate `file://` + IPC Desktop carrier requires issue #20 first.

Configure the credential through DSH's credential provider. Never put a secret
value in `cordis.patch.yml`, browser storage, an issue, or a log.

## License and provenance

MIT licensed. This repository is a clean-room implementation with new public
history. It does not contain private product source, assets, identifiers, or
repository history.
