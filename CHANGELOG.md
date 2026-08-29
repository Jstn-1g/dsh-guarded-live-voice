# Changelog

## Unreleased

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
