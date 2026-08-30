# DSH Live Voice

![DSH Live Voice: consent-bound voice for DSH](https://raw.githubusercontent.com/Jstn-1g/dsh-live-voice/main/assets/dsh-live-voice-social.png)

[![CI](https://github.com/Jstn-1g/dsh-live-voice/actions/workflows/ci.yml/badge.svg)](https://github.com/Jstn-1g/dsh-live-voice/actions/workflows/ci.yml)

[Preview release](https://github.com/Jstn-1g/dsh-live-voice/releases/tag/v0.3.0-preview.5)
· [Contributing](CONTRIBUTING.md)
· [Testing guide](TESTING.md)
· [No-secret tester task](https://github.com/Jstn-1g/dsh-live-voice/issues/19)
· [Release gate](https://github.com/Jstn-1g/dsh-live-voice/issues/5)

DSH Live Voice is built for one bounded voice turn: speak, hear returned audio,
review both transcripts, and decide whether to place your own words into the
current draft. It never submits the composer or runs tools for you.

Unlike a speech-to-text-only microphone button, the intended experience carries
native audio in both directions, binds visible consent to the exact live DSH
Session, and requires a second explicit action before your transcript enters the
draft. Preview.5 adds the explicit, network-free synthetic demo described
below. Preview.4 separately verifies authenticated packed-plugin composition
in DSH Web with synthetic audio and a local fake Qwen provider. Credential-
backed Qwen, a physical microphone or speaker, and packaged Desktop remain
unproven release gates.

![Scripted DSH Live Voice synthetic demo: disclosure, local turn, transcripts,
and explicit draft handoff](assets/dsh-live-voice-synthetic-demo.gif)

_Scripted deterministic UI walkthrough with fixed synthetic audio and
transcripts. It uses no Qwen credential or external provider and does not prove
physical audio I/O or packaged Desktop.
[Watch the 24-second MP4](assets/dsh-live-voice-synthetic-demo.mp4)._

## Two-minute synthetic test

Requirements: a DSH Web profile, Chrome or Edge, and a disposable test profile
or environment. No Qwen credential or microphone permission is needed.

```sh
dsh plugin --profile web add github:Jstn-1g/dsh-live-voice#v0.3.0-preview.5
```

Restart the Web profile and open a live Session. The microphone icon appears in
the composer control row with the label **Open DSH Live Voice**. Open it and
confirm the destination says **Local deterministic synthetic demo**. Continue,
start the synthetic demo, finish the turn, and expect two fixed synthetic
transcripts plus a short chime. **Use my transcript as draft** changes only the
current draft; it does not submit it.

```sh
dsh plugin --profile web remove dsh-live-voice
```

## Current status

Unless stated otherwise, this section describes the immutable
`v0.3.0-preview.5` artifact and its tagged source. Later `main` changes are not
part of that release. Bind every result to the exact revision that was tested.

### Runtime support

Every row names the immutable artifact that produced its evidence. An older
Preview.4 result remains evidence only for Preview.4; it is not rebound to
Preview.5 by appearing in this release's documentation.

| Runtime | Status |
| --- | --- |
| Shipped DSH `web` profile on v0.1.1-rc.2 | Preview.4 packed fake-provider composition passed. Preview.2 recorded the official Web-profile BFCache receipt; that older receipt is not rebound to this artifact. Physical audio, live Qwen, and independent reproduction remain open. |
| Exact source-built `dsh-v0.1.2-alpha.1` Web profile | Preview.4 authenticated packed-plugin composition passed. Preview.3 recorded official Web-profile BFCache and an active SPA Session switch with synthetic audio and a fake provider; those browser receipts remain bound to preview.3. |
| Exact source-built `dsh-v0.1.2-alpha.2` Web profile | Preview.5 packed installation passed using its bundled synthetic provider: authenticated Workspace/Session RPC, exact disclosure, fixed transcripts, bounded chime, disposal, no credential, and no external provider server. The explicit fake-Qwen path also passed. Physical audio, live Qwen, BFCache, and later alphas remain unproven. |
| Community packaged shell embedding the served Web profile over HTTP(S) | Structurally compatible candidate, not a pass. The exact Tauri v0.9.3 install/restart/uninstall run is tracked in [issue #9](https://github.com/Jstn-1g/dsh-live-voice/issues/9). |
| Harness-documented packaged `file://` + Fetch-over-IPC model | Not supported by the current direct WebSocket carrier. A public transport seam or validated Remote redesign is tracked in [issue #20](https://github.com/Jstn-1g/dsh-live-voice/issues/20). |

A packaged-shell result must name its exact carrier. A pass in a shell that
loads `http://127.0.0.1:<port>` proves only that served-Web architecture; it
does not prove a shell that loads the UI from `file://` and sends Fetch through
IPC.

Any packaged-shell restart receipt must also prove an ordered, quiescent
Harness handoff: one DSH backend instance owns each persisted Session at a
time, and the old instance drains and disposes before its replacement can
write that Session.
The exact alpha documents this single-writer limit, and upstream
[discussion #5103](https://github.com/deepseek-ai/deepseek-harness/discussions/5103)
records committed sequence rollback that can make an entire Session history
unloadable. A controlled `dsh-v0.1.2-alpha.1` reproduction confirmed the same
fail-closed outcome when two JSONL backend instances loaded and wrote the same
Session ID in a shared root. This is a Harness persistence boundary, not a Live
Voice repair claim; do not let overlapping Harness instances write the same
persisted Session, and back up an affected log before attempting recovery.

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

Preview.3 also fixes a lifecycle isolation defect in preview.2: leaving an
active Session through DSH's client-side navigation could remove both voice
controls without stopping the shared controller. Each rendered control now
holds an exact-Session lease. Commit-phase unmount releases the final lease and
schedules same-turn teardown before the next browser task, stopping that
Session's socket, capture, playback, provider path, timers, and transcript
state. Parent/fork-child isolation is covered by Host tests, and an
exact-alpha browser smoke verifies that an active old Session cannot continue
capturing or sending after the UI switches to a new Session.

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
authenticated composition smoke verifies the exact, clean source-built DSH
`dsh-v0.1.2-alpha.1` Web profile: an unauthenticated voice
upgrade receives `401`, the private launch token is exchanged for the Harness
cookie without entering the receipt, and the authenticated client, workspace,
Session, and fake-provider voice turn complete. Preview.3 additionally records
real BFCache restoration and active SPA Session-switch teardown through that
exact alpha's shipped Web UI. The immutable preview.3 peer range admits only
this pinned alpha in addition to the existing rc line. Preview.4 separately
admits exact `0.1.2-alpha.2` after clean alpha.1 and alpha.2 source builds,
coherent peer-graph checks, and authenticated packed-plugin fake-provider
composition smokes. The alpha.2 proof is pinned to upstream commit
`0a53fb55bea101816fa226bb964ae2bed71c343b`. Neither result establishes later
or broad alpha compatibility. Preview.5 separately installs its bundled
synthetic provider through the official CLI into exact alpha.2 and completes
the authenticated gateway turn without a credential, Qwen transport shim, or
external provider server. This is not a marketplace-ready voice product
and is not “ChatGPT
Live parity.” DSH Live Voice is the product name; the guarded consent and
authority model remains its security architecture.

The disclosure flow is user-visible, but it is not cryptographic proof that a
human accepted it. The one-shot challenge proves control of that local client
connection only. Loopback, Host, Origin, and `Sec-Fetch-Site` checks mitigate
remote access, DNS rebinding, and cross-site requests; they do not authenticate
a human or resist a malicious same-user local process.

## Safety boundary

The bundled synthetic demo uses fixed in-process content and never connects to
Qwen. When `provider: qwen` is explicitly configured, only PCM supplied through
the bounded browser-controller seam after accepted disclosure can reach Qwen.
No DSH history, files, workspace instructions,
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
dsh plugin --profile web add github:Jstn-1g/dsh-live-voice#v0.3.0-preview.5
```

Restart the Web profile after installation. Existing v0.2.0 testers should
remove `dsh-guarded-live-voice` before installing the renamed package. The
internal Cordis row id `guarded-live-voice`, default `/guarded-voice` route, and
hidden browser protocol/composition keys remain stable for this transition so
existing profiles and mixed cached bundles do not silently duplicate or stop
matching the plugin.

The installed row explicitly starts in local `synthetic-demo` mode. It does not
silently fall back from Qwen. Credential-backed Qwen requires the explicit
development configuration below and still needs the live-provider and
physical-device checks tracked in the release gate before a release candidate
or stable release.

## Help validate the preview

We need five founding testers using Windows with Chrome or Edge. Install
Preview.5 in a disposable Web profile, run the two-minute synthetic test above,
and submit the structured
[tester report](https://github.com/Jstn-1g/dsh-live-voice/issues/new?template=tester-report.yml),
including the last setup stage you reached and where you hesitated or stopped.
No credential, recording, real transcript, Session id, or private log should be
shared. Useful reports will be credited in the release notes and contributors
section with the tester's consent. The
[adoption measurement](docs/adoption.md) counts completed external outcomes and
explicit stopping points, not clones or asset downloads.

For a separate credential-free compatibility contribution, fork or sync this
repository, enable Actions, and manually run the
[`Exact-alpha.2 authenticated Web proof`](https://github.com/Jstn-1g/dsh-live-voice/actions/workflows/alpha2-auth-proof.yml).
Then add the independently owned run link and its sanitized JSON receipt to
[issue #19](https://github.com/Jstn-1g/dsh-live-voice/issues/19). The workflow
checks immutable preview.4 against exact alpha.2 without a provider credential
or physical audio devices. Its disposable profile may resolve the preview's
declared public dependencies from npm; it requests no secrets, so do not add
any. A successful run exposes the validated receipt in its public job summary
and as one downloadable JSON file; raw output is not included in that artifact.
A run owned by this repository is maintainer repeatability evidence, not the
independent reproduction requested by that issue. The earlier alpha.1
[`Exact-alpha authenticated Web proof`](https://github.com/Jstn-1g/dsh-live-voice/actions/workflows/alpha-auth-proof.yml)
remains pinned to immutable preview.3; its historical runs are not rebound to
preview.4 or alpha.2.

Useful reports are welcome even when they uncover a failure. The same form also
accepts provider, physical-device, BFCache, or exact packaged-shell results.
Follow the
[testing guide](https://github.com/Jstn-1g/dsh-live-voice/blob/main/TESTING.md),
then include the exact release or commit, DSH version, platform, browser,
steps, and sanitized evidence. Never attach credentials, recordings, private
transcripts, workspace content, or identifying logs.

A passing report is evidence for only the environment and path it directly
tested. It does not by itself close another release gate or make the preview a
stable, marketplace-ready, or officially endorsed product.

## Development

Requirements: Node.js 22.19 or newer within the 22.x line, or Node.js 24.12+,
and pnpm 11.7. The supported rc.2 Web loader is not supported on Node 24.0
through 24.11.1; alpha.2 has a newer floor, but this plugin keeps the
conservative shared range while rc.2 remains supported.

```sh
pnpm install
pnpm check
```

`pnpm check` runs strict Host and browser TypeScript checking, deterministic
tests, Host and browser builds, package linting, browser-bundle materialization,
and a dry-run package-content check.

`pnpm run demo:capture` regenerates the scripted walkthrough locally with
Chrome, FFmpeg, and FFprobe. It blocks external browser requests and verifies
key synthetic UI labels plus the fixed transcripts before replacing the GIF
and MP4.

New contributors can browse the open, unassigned
[`good first issue`](https://github.com/Jstn-1g/dsh-live-voice/issues?q=is%3Aissue+is%3Aopen+no%3Aassignee+label%3A%22good+first+issue%22)
and [`help wanted`](https://github.com/Jstn-1g/dsh-live-voice/issues?q=is%3Aissue+is%3Aopen+no%3Aassignee+label%3A%22help+wanted%22)
queues. Comment on an issue before beginning substantial work so its scope and
ownership are clear. Read the
[contribution guide](https://github.com/Jstn-1g/dsh-live-voice/blob/main/CONTRIBUTING.md)
before opening a pull request; it explains the safety invariants, test
expectations, and paths that do not require provider credentials or physical
audio hardware.

## Development configuration

The bundle inserts the compatibility-stable `guarded-live-voice` Cordis row
with the `dsh-live-voice` package name and explicit `synthetic-demo` provider.
To use Qwen, a profile override must select `qwen` and provide an Alibaba Cloud
Model Studio workspace id before provider authorization:

```yaml
- id: guarded-live-voice
  name: dsh-live-voice
  config:
    provider: qwen
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
