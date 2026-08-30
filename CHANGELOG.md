# Changelog

## Unreleased

## 0.3.0-preview.4

- Add exact DSH `0.1.2-alpha.2` source compatibility without changing the
  immutable preview.3 artifact. The development graph now follows the
  alpha.2 package ownership split and Cordis cohort, while retaining an
  explicit direct client-store type edge and moving the renderer integration
  proof away from the removed client-runtime package.
- Add an authenticated packed-plugin composition smoke pinned to the exact
  `dsh-v0.1.2-alpha.2` tag and commit. Future alpha versions remain excluded;
  credential-backed Qwen, physical audio devices, BFCache, and packaged
  Desktop remain outside this proof.

## 0.3.0-preview.3

- Fix exact-Session lifecycle isolation during DSH client-side navigation.
  Preview.2 could unmount both Session controls while its shared controller
  kept the old voice socket, browser capture path, playback, and
  provider turn alive. Session-scoped UI leases now stop the exact lifecycle
  when its final seat leaves, while tolerating React StrictMode/HMR replay.
- Add parent/fork-child SessionStore and manual-turn isolation tests, plus an
  exact `dsh-v0.1.2-alpha.1` Web-profile browser regression that switches away
  from an active Session without `pagehide` and verifies stopped capture,
  socket, provider, and post-cleanup audio before fresh consent in the new
  Session.
- Admit only the source-verified `0.1.2-alpha.1` DSH package graph alongside the
  existing rc range, and adapt the integration proof to alpha's browser-token
  authentication, `remote.mux`, Lexical composer, and authenticated nested
  Session creation. Narrow Node support to Node 22.19 or newer within the 22.x
  line, or Node 24.12+, because upstream's current Web loader fails on earlier
  Node 24 releases. Credential-backed Qwen,
  physical devices, packaged Desktop, and broad alpha compatibility remain
  unverified.

## 0.3.0-preview.2

- Add a non-installing Windows packaged-shell preflight for the exact community
  Desktop v0.9.3 candidate. It refuses non-disposable state, the default DSH
  home, prior Desktop/app/shim state, an explicit or PATH-discovered user DSH
  core, a running process, port 3080 collisions, and any installer whose name,
  size, or SHA-256 differs from the pinned asset;
  it also uses a transient exclusive loopback bind to detect reserved or
  otherwise unavailable ports. Its sanitized JSON receipt makes no install,
  launch, installed-core, physical-device, live-provider, or packaged-Desktop
  claim.
- Add a controlled, loopback-only Chromium BFCache smoke for idle and active
  synthetic-audio save/restore paths, plus an opt-in exact Harness smoke that
  rebuilds with the official client build profile, installs into a disposable
  shipped Web profile, and drives the real DSH UI. The DSH v0.1.1-rc.2 / Chrome
  151 receipt covers BFCache restoration, DSH stream reconnection, teardown,
  draft preservation, and fresh Session/consent binding. It remains
  fake-provider, synthetic-audio evidence pending independent reproduction;
  packaged served-Web shell validation remains open. Document that the separate
  Harness `file://` + IPC Desktop architecture needs a portable carrier before
  it can be tested, and track that prerequisite in issue #20.
- Prepare the production client dependency graph for the upstream
  `dsh-client-runtime` to `dsh-client-ui-renderer` migration while preserving
  the current verified DSH release-candidate compatibility range. Adapt the
  voice upgrade to Harness's optional authenticated connection gate and add an
  exact source-built `dsh-v0.1.2-alpha.1` composition smoke covering its private
  launch-token exchange, authenticated RPC, client bundle, and fake-provider
  voice turn. The package peer range remains unchanged; broader alpha support
  is not inferred from this one tagged source build.
- Add a contributor guide, Code of Conduct, structured bug/proposal/tester
  forms, pull-request safety checklist, runtime support table, and branded
  social preview. Reports remain bound to their exact revision and environment;
  traffic and deterministic evidence are not presented as users or broad
  runtime support.

## 0.3.0-preview.1

- Rename the product and package from `dsh-guarded-live-voice` to
  `dsh-live-voice` / DSH Live Voice.
- Add an explicit-gesture browser microphone path with bounded PCM16 capture,
  continuous resampling, deterministic teardown, and ordered PCM playback.
- Add one consent-bound Qwen manual audio turn with strict identity,
  backpressure, timeout, and capability checks.
- Allow a completed final user transcript to become an editable composer draft
  only through an explicit, one-shot action that never submits.
- Add packed official-Harness fake-provider composition and controlled browser
  lifecycle smokes.

Compatibility note: the Cordis row id `guarded-live-voice` and default
`/guarded-voice` transport route remain stable in this transition release.
Continuous conversation, barge-in, tool execution, automatic submission, and
release-candidate or stable-release status are not claimed.

## 0.2.0

- Publish the original exact-session disclosure and proposal-only consent
  foundation under the `dsh-guarded-live-voice` development name.
