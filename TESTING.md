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

## Install and mount check

Install the exact preview into the Web profile:

```sh
dsh plugin --profile web add github:Jstn-1g/dsh-live-voice#v0.3.0-preview.1
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
7. Closing, cancelling, Session disposal, or page teardown releases owned audio,
   sockets, timers, and buffers for the path being tested.

Credential-backed Qwen, physical microphone and speaker, OS indicators, and
packaged Desktop behavior remain open gates. Maintainer-run synthetic BFCache
evidence is recorded below, but the BFCache issue remains open for independent
reproduction on its exact environment.

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
Chrome. It rebuilds the Harness Host, Client, and Web artifacts with the
official client build values, installs the current packed plugin through the
official CLI into a disposable shipped `web` profile, and drives both idle and
active cases through the real DSH UI:

```sh
DSH_HARNESS_ROOT=/absolute/path/to/deepseek-harness \
  pnpm run smoke:harness:browser:bfcache
```

The headed run fails unless Chrome reports an actual BFCache restore, both DSH
event streams reconnect, the active resources are released, the original draft
is unchanged, and restored lifecycles require fresh disclosure, challenges, and
Session binding. The receipt records the exact DSH commit/version, built-client
artifact digest, Web index digest, Chrome, Playwright, OS, and explicit claim
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
restart the Web profile. A packaged-Desktop restart and uninstall receipt is
still an open release gate; do not infer that path from a Web-profile removal.

## Report the result

Open a structured
[preview tester report](https://github.com/Jstn-1g/dsh-live-voice/issues/new?template=tester-report.yml)
with:

- exact plugin and DSH versions or commit SHAs;
- OS, architecture, profile, browser or Desktop version, and install source;
- the exact procedure and last successful visible state;
- pass, fail, partial, or inconclusive outcome; and
- the smallest sanitized error, timing, or state receipt needed to reproduce.

Do not attach audio. A maintainer will reproduce or independently review gate
evidence before changing the release status.
