# Contributing to DSH Live Voice

Thank you for helping make voice interaction with DeepSeek Harness safer, more
reliable, and easier to validate. Documentation, reproductions, tests,
translations, accessibility improvements, and focused code changes are all
valuable.

DSH Live Voice is an experimental public preview. Contributions must preserve
that status until the corresponding release gates are directly proven.

## Good places to start

- Browse open, unassigned issues labeled
  [`good first issue`](https://github.com/Jstn-1g/dsh-live-voice/issues?q=is%3Aissue+is%3Aopen+no%3Aassignee+label%3A%22good+first+issue%22)
  or [`help wanted`](https://github.com/Jstn-1g/dsh-live-voice/issues?q=is%3Aissue+is%3Aopen+no%3Aassignee+label%3A%22help+wanted%22).
- Submit a structured
  [tester report](https://github.com/Jstn-1g/dsh-live-voice/issues/new?template=tester-report.yml)
  for a specific install, browser, provider, device, BFCache, or packaged-
  Desktop path.
- Improve deterministic tests, documentation, localization, accessibility, or
  failure messages without widening authority.
- Report a reproducible bug with the bug template. Search existing issues first
  so evidence stays in one place.

For a change larger than a small documentation or test correction, open or
claim an issue before investing substantial work. This prevents two people from
solving the same problem and lets us agree on the safety boundary first.

## Safety invariants

Changes must not silently expand what the plugin can export or do. In
particular:

- credentials stay on the Host and are resolved only after accepted,
  exact-session disclosure;
- DSH history, files, workspace instructions, memory, arbitrary text, system
  instructions, and tool schemas do not cross the voice boundary;
- invalid, stale, oversized, ambiguous, or out-of-order input fails closed;
- the plugin does not submit prompts, invoke tools, write custom session events,
  or execute work;
- transcript promotion remains explicit, one-shot, and bound to the exact
  current Session and composer state; and
- owned microphone, audio, socket, timer, and session resources are bounded and
  deterministically released.

Read [docs/threat-model.md](docs/threat-model.md),
[docs/architecture.md](docs/architecture.md), and
[SECURITY.md](SECURITY.md) before changing an authority, transport, capture,
playback, or lifecycle boundary.

## Local setup

Requirements:

- Node.js 22.19 or newer within the 22.x line, or Node.js 24.12+; and
- pnpm 11.7.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs both TypeScript configurations, the deterministic test suite,
Host and browser builds, package linting, browser-bundle materialization, and a
dry-run package-content audit. Focused tests are useful while iterating, but the
complete check is the pull-request baseline.

Six optional smokes cover narrower integration paths:

```sh
pnpm run smoke:harness:fake-qwen
pnpm run smoke:harness:alpha-auth
pnpm run smoke:harness:alpha-ipc
pnpm run smoke:browser:unload
pnpm run smoke:browser:bfcache
pnpm run smoke:harness:browser:bfcache
```

The packed Harness smoke requires a compatible local DeepSeek Harness checkout
through `DSH_HARNESS_ROOT`. The browser smokes use a controlled synthetic audio
source. Read [TESTING.md](TESTING.md) and [docs/conformance.md](docs/conformance.md)
before interpreting a result. The BFCache smoke proves only its standalone
Chromium path. The final opt-in smoke rebuilds an exact clean Harness checkout
and drives its shipped `web` profile, but still uses synthetic audio and a fake
loopback provider. Both alpha smokes are restricted to the exact source-built
`dsh-v0.1.2-alpha.1` tag, which the package admits exactly without inferring a
later alpha build. The IPC proof is test-only, synthetic, and credential-free;
it does not establish a production carrier or an official integration seam.
None of these smokes proves a live provider, physical audio device, packaged
Desktop path, broad alpha compatibility, or independent BFCache reproduction.

Most contributions do not need provider credentials, a microphone, a speaker,
or a packaged Desktop build. The test suite uses deterministic fakes, and the
packed Harness smoke uses a local fake Qwen server. Never use a real credential
in a test, fixture, issue, pull request, recording, screenshot, or log.

## Pull requests

1. Branch from the latest `main`.
2. Keep the change focused and explain the reproduced problem or contributor
   outcome.
3. Add regression coverage for behavior changes. A failing-before,
   passing-after test is preferred.
4. Run `pnpm check` and any relevant smoke test.
5. Update generated `lib/` artifacts when source or public types change.
6. Complete the pull-request safety and claim checklist.

Do not combine unrelated formatting, dependency, generated-output, and behavior
changes. Reviewers should be able to establish the exact authority and failure
surface from the diff.

## Tester evidence and release claims

The open [release gate](https://github.com/Jstn-1g/dsh-live-voice/issues/5)
tracks credential-backed Qwen, physical microphone and speaker, independent
BFCache reproduction, and packaged-Desktop validation. A report must identify
the exact version, environment, procedure, outcome, and sanitized evidence. We
will reproduce or independently review evidence before changing a gate.

Do not describe the project as stable, production-ready, marketplace-accepted,
officially endorsed, continuous conversation, barge-in capable, or equivalent
to another live-voice product unless a later release explicitly proves and
claims that property.

## Security and privacy

Use GitHub's private security-advisory flow for suspected vulnerabilities. Do
not open a public issue containing API keys, voice recordings, private
transcripts, workspace content, personal data, or identifying logs. See
[SECURITY.md](SECURITY.md) for the reporting path and current invariants.
