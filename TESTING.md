# Testing the DSH Live Voice preview

This guide collects reproducible, privacy-safe evidence for one exact release,
environment, and path. Passing one path does not prove another or promote the
preview to release-candidate, stable, marketplace-ready, or officially endorsed
status.

## Before testing

- Use a disposable DSH home and profile with a non-sensitive workspace. A
  temporary workspace alone does not isolate profile plugins, local patches,
  or credential references.
- Record the exact DSH Live Voice release or commit and DeepSeek Harness release
  or commit.
- Use a non-production provider credential with a strict quota if a live
  provider is in scope.
- Do not record sensitive speech or expose credentials, recordings, private
  transcripts, workspace content, personal data, or identifying logs.
- Read the current [release gate](https://github.com/Jstn-1g/dsh-live-voice/issues/5)
  before deciding what a result proves.

## Runtime scope

The current preview is implemented for the served DSH Web profile. A packaged
shell may test it only when that exact shell embeds the ordinary HTTP(S) Web
profile; name the shell, version, commit or immutable asset, and carrier in the
report. The candidate Tauri v0.9.3 receipt is tracked in [issue
#9](https://github.com/Jstn-1g/dsh-live-voice/issues/9).

Do not attempt to report the Harness-documented `file://` + IPC Desktop model
as supported. The current controller rejects `file:` and its custom socket is
reachable only through a `ctx.webServer.registerUpgrade` route. [Issue
#20](https://github.com/Jstn-1g/dsh-live-voice/issues/20) must supply or validate
a portable transport before that architecture can be tested.

## Disposable Windows packaged-shell preflight

The exact served-Web shell candidate in issue #9 is community DeepSeek Harness
Desktop v0.9.3, commit `2a467b5f33f53908a8c008280180c0fdba5ab948`.
Run its preflight only inside Windows Sandbox or a throwaway VM that will be
discarded after the receipt.

The shell installer does **not** pin or contain one Harness core. On a fresh
launch, v0.9.3 prefers a valid user core discovered through `DSH_CLI_PATH` or a
`dsh.cmd`, `dsh.exe`, or `dsh.bat` entry on `PATH`; otherwise its packaged-core
path resolves the moving `latest` asset from
`dsh-tauri-desk/deepseek-harness-pkg`. Therefore the shell installer hash cannot
establish `dsh-0.1.1-rc.2` or any other Harness identity. Record the actual
runtime-selected core version and an immutable release/asset digest before
installing the voice plugin; without that post-install evidence, #9 remains
inconclusive.

Download `Deepseek.Harness.Desktop_0.9.3_x64-setup.exe` from the exact
[v0.9.3 release](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/releases/tag/v0.9.3),
then run this command from an exact DSH Live Voice source tag or commit that
includes the preflight, and record that revision:

```powershell
$env:DSH_LIVE_VOICE_DISPOSABLE_VM = 'I_ACKNOWLEDGE_THIS_IS_A_DISPOSABLE_VM'
$env:DSH_HOME = Join-Path $env:TEMP ("dsh-live-voice-desktop-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $env:DSH_HOME | Out-Null
pnpm run preflight:desktop:windows -- --installer 'C:\path\to\Deepseek.Harness.Desktop_0.9.3_x64-setup.exe'
```

The preflight does not write files or registry state. It reads local state,
hashes the installer, and briefly performs an exclusive loopback bind on port
3080. It refuses to report `readyForDisposableInstall: true` unless all of
these are true:

- the native host and Node process are Windows x64 (not an emulated x64 process
  on ARM64), and the exact disposable-VM acknowledgement is set;
- `DSH_HOME` is an explicit, empty, non-link child of Windows `TEMP` with the
  required disposable prefix, while the ordinary `~/.dsh` is absent;
- no known Desktop install, app-data, shortcut, CLI shim, uninstall
  registration (including GUID-key WiX/MSI entries), persistent NSIS install-
  location registration, Desktop process, or listener/bind conflict on port
  3080 already exists; and
- `DSH_CLI_PATH` is unset and no user `dsh.cmd`, `dsh.exe`, or `dsh.bat`
  candidate exists in the exact `PATH` that will launch Desktop; and
- the installer name, size (`5,353,920` bytes), and SHA-256
  (`5ed93b77f1a3503ad5e339d3ba247cab13dd74838517cebe450fd7fc7bdfa133`)
  match the pinned release asset.

Its JSON contains the preflight-script digest, shell versions, expected hashes,
native/process architectures, booleans, and bounded failure codes—not paths,
credentials, audio, transcripts, cookies, tokens, or workspace content. It does
not download, install, launch, persist configuration, uninstall, or delete.
`readyForDisposableInstall: true` authorizes only the exact shell install in the
throwaway VM. It is not ready-to-test evidence, a Harness-core identity, or a
packaged-Desktop pass. Preserve the same `DSH_HOME`, environment, `PATH`, launch
context, and installer throughout that disposable-VM run, then bind the later
#9 receipt to the core and plugin revisions actually installed.

## Install and mount check

Install the exact preview into the Web profile:

```sh
dsh plugin --profile web add github:Jstn-1g/dsh-live-voice#v0.3.0-preview.3
```

Restart the Web profile, open a live Session, and inspect the composer tool row.
The microphone control should be labeled **Open DSH Live Voice**. Opening it
should show a disclosure panel with the audio destination, exported Harness
context, execution authority, retention status, Session, Workspace, and expiry.

Use a clean browser profile or reset the site's microphone permission before
checking permission timing. At this point the browser must not have requested
microphone permission. The provider credential must not be resolved and the
provider connection must not open until **Continue setup** consumes the exact-
session disclosure. A second explicit **Start recording** action is the only
included path that may request microphone permission.

An install-and-mount report can stop before **Continue setup**. It does not need
a provider credential, microphone, speaker, or captured speech.

## Provider configuration

The installed bundle adds the compatibility-stable `guarded-live-voice` row.
Override that row in the Web profile's local patch with a Model Studio workspace
identifier and a credential reference, never a credential value:

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

For the CLI-managed `web` profile, the machine-local profile patch is under
`$DSH_HOME/profiles/web/cordis.patch.yml`. Configure `DASHSCOPE_API_KEY` through
DSH's credential provider. Do not place its value in YAML, browser storage, an
issue, a screenshot, or a log.

## Manual-turn state check

For a credential-backed test, record the visible state transitions without
capturing sensitive content:

1. **Before voice is enabled** shows the complete disclosure.
2. **Continue setup** reaches **Manual-turn transport ready** or a bounded,
   sanitized failure.
3. **Start recording** is the first microphone-permission request.
4. **Finish and request answer** commits one bounded turn.
5. A completed turn may show final user and assistant transcripts.
6. **Use my transcript as draft** may copy only the final user transcript into
   the still-current composer. It must not submit or invoke a tool.
7. Closing, cancelling, Session disposal, switching to a new or forked Session,
   or page teardown releases the old Session's owned audio, sockets, provider,
   timers, and buffers.

Credential-backed Qwen and a packaged-client physical microphone/speaker and OS
indicator smoke remain the v0.3 RC/stable gates. A served-Web packaged shell is
the current candidate for that exact test. The separate `file://` +
Fetch-over-IPC architecture remains unsupported, but portable support for every
Desktop carrier is not a v0.3 release requirement. Maintainer-run synthetic
BFCache evidence is recorded below, while the BFCache issue remains open for
independent reproduction on its exact environment.

## Deterministic contributor checks

The ordinary pull-request baseline is:

```sh
pnpm install --frozen-lockfile
pnpm check
```

The optional packed Harness smoke installs the current tarball through the
official DSH CLI and exercises a manual turn against a local fake Qwen peer:

```sh
DSH_HARNESS_ROOT=/absolute/path/to/deepseek-harness \
  pnpm run smoke:harness:fake-qwen
```

Revision boundary: the `v0.3.0-preview.3` source tag includes
`smoke:harness:alpha-auth`, `smoke:browser:bfcache`, and
`smoke:harness:browser:bfcache`, including the SPA Session-switch regression;
the `v0.3.0-preview.1` source does not. The
installable tarball excludes maintainer scripts. Run them from an exact source
tag or commit and record that revision; never attribute a result to an earlier
artifact.

For the exact source-built `dsh-v0.1.2-alpha.1` authenticated Web profile, run
the alpha-specific smoke against a clean checkout with a verified official
client build receipt:

```sh
DSH_HARNESS_ROOT=/absolute/path/to/deepseek-harness \
  pnpm run smoke:harness:alpha-auth
```

For a reproducible hosted path, fork or sync this repository, enable Actions in
the fork, and manually run the
[`Exact-alpha authenticated Web proof`](https://github.com/Jstn-1g/dsh-live-voice/actions/workflows/alpha-auth-proof.yml)
workflow from the fork's Actions page. It checks out immutable preview.3 and
the exact alpha commit, installs both frozen lockfiles, runs the complete plugin
check, produces the official Harness build receipt, and prints only the smoke's
sanitized result. The official packed-plugin profile install may use the public
npm registry to resolve the preview's declared dependencies; the workflow
requests no secrets, so do not add any. A run owned by this repository is
maintainer repeatability evidence, not the independent reproduction requested
in [issue #19](https://github.com/Jstn-1g/dsh-live-voice/issues/19).

It requires a real unauthenticated `401`, privately exchanges the launch token
for the Harness cookie, then exercises the advertised client combo,
workspace/session RPC, and one fake-provider voice turn. Its sanitized receipt
contains no token or cookie. This is exact-tag source-build evidence only. The
published peer set admits `0.1.2-alpha.1` exactly, not later alpha builds; this
smoke does not prove credential-backed Qwen, physical audio, BFCache, packaged
Desktop, or broad alpha compatibility.

The test-only IPC-equivalent proof requires clean DSH Live Voice and exact
`dsh-v0.1.2-alpha.1` (`cd5ef8148158c3a752a658978873241fdf8e2bbc`)
source checkouts with dependencies installed and the Harness workspace libraries
built:

```sh
DSH_HARNESS_ROOT=/absolute/path/to/deepseek-harness \
  pnpm run smoke:harness:alpha-ipc
```

It runs the alpha's real Typert generator, generated strict Host/Remote
descriptors, Host shared Fetch handler and stream gateway, Client Connection and
Gateway, `SessionStore`, and `TunnelServer` across a Node `MessageChannel`. PCM
is canonical base64; no binary audio object crosses the Remote seam. It covers
Host-minted connection capabilities, a real alpha parent/child Session fork and
same-ID parent replacement under synthetic workspace membership, bounds,
fail-closed queue pressure, and addressed voice-stream/provider cancellation
cleanup with a fake, credential-free provider. The 300 x 3,200-byte measurement
is a sequential burst, not 10 Hz capture, audible latency, or a physical-device
result.

A local pass always reports `dependencyProvenance: local-unverified` and
`publishable: false`, even from clean source, because an existing ignored
dependency tree is not attested. The manual **Exact-alpha IPC-equivalent proof**
workflow performs fresh frozen-lockfile installs, builds the exact-alpha
workspace libraries, and pins its actions, Node, pnpm, and upstream commit. Its
receipt includes an aggregate SHA-256 over selected built exact-alpha
entrypoints checked by the proof; only that clean workflow may emit
`publishable: true`.
Neither result changes the production WebSocket carrier or proves Electron,
Tauri, packaged Desktop, physical audio, live/credential-backed Qwen, or an
officially supported DSH seam. The proof also characterizes the exact alpha's
real `WorkerTunnel` failure on `file://` / null origin. That URL resolution
blocks reusing the unmodified alpha `WorkerTunnel` there; the intended official
Desktop carrier and plugin seam remain unconfirmed.

The optional controlled-browser smoke builds the client and prints a loopback
URL for a synthetic raw-unload check:

```sh
pnpm run smoke:browser:unload
```

The optional BFCache smoke prints idle, active, and away URLs for two real
Chromium history save/restore receipts:

```sh
pnpm run smoke:browser:bfcache
```

In the same controlled Chromium tab, open the idle URL, navigate to the printed
away URL, and use browser **Back**. Then open the active URL, press **Start**,
**Accept**, and **Record**, wait for `recording` and at least one synthetic audio
frame in the visible counter, navigate to the away URL, and use **Back** again.
The process succeeds only when both original documents report
`pagehide.persisted = true` and
`pageshow.persisted = true`, release the exercised resources, reject stale
authority after restoration, and complete a fresh disclosure-bound lifecycle.

This fixture replaces `getUserMedia`, uses only loopback transport, and loads
the built plugin client in a minimal slot harness. It does not prove a physical
device, live provider, exact official DSH Web profile, or packaged Desktop path.

The opt-in official Web-profile BFCache smoke requires a clean, exact Harness
checkout with its dependencies installed and a locally installed stable Google
Chrome. For the exact admitted alpha version, the smoke selects the authenticated
path and requires the pinned commit, tag, and one-time launch-token exchange
before any profile RPC or plugin upgrade; non-tokenized rc launches retain their
existing path. It rebuilds the Harness Host, Client, and Web artifacts with the
official client build values, installs the current packed plugin through the
official CLI into a disposable shipped `web` profile, and drives both idle and
active cases through the real DSH UI:

```sh
DSH_HARNESS_ROOT=/absolute/path/to/deepseek-harness \
  pnpm run smoke:harness:browser:bfcache
```

The headed run fails unless Chrome reports an actual BFCache restore, both DSH
event streams reconnect, the active resources are released, the original draft
is unchanged, an active SPA switch stops the old Session without `pagehide`,
and restored or newly mounted lifecycles require fresh disclosure, challenges,
and Session binding. The receipt records the exact DSH commit/version,
built-client artifact digest, Web index digest, Chrome, Playwright, OS, and explicit claim
limits. It uses a fake loopback provider and synthetic Web Audio; it does not
use a real provider credential or credential-backed Qwen, a physical microphone
or speaker, an OS indicator, or packaged Desktop. Issue #7 remains open until
another tester independently reproduces an exact-environment result.

See [docs/conformance.md](docs/conformance.md) for what each smoke proves and,
just as importantly, what it does not prove.

## Uninstall or reset

Remove the renamed package from the Web profile:

```sh
dsh plugin --profile web remove dsh-live-voice
```

If the old v0.2 package is present, remove it separately:

```sh
dsh plugin --profile web remove dsh-guarded-live-voice
```

Remove any machine-local `guarded-live-voice` override that you added, then
restart the Web profile. A packaged served-Web shell still needs its own
restart and uninstall receipt; do not infer that result from a CLI Web-profile
removal. A `file://` + IPC shell additionally needs the transport work in issue
#20 before this removal procedure applies.

## Report the result

Open a structured
[preview tester report](https://github.com/Jstn-1g/dsh-live-voice/issues/new?template=tester-report.yml)
with:

- exact plugin and DSH versions or commit SHAs;
- OS, architecture, profile, browser or exact packaged-shell version, carrier,
  and install source;
- the exact procedure and last successful visible state;
- pass, fail, partial, or inconclusive outcome; and
- the smallest sanitized error, timing, or state receipt needed to reproduce.

Do not attach audio. A maintainer will reproduce or independently review gate
evidence before changing the release status.
