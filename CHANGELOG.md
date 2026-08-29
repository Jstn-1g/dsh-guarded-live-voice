# Changelog

## Unreleased

- Prepare the production client dependency graph for the upstream
  `dsh-client-runtime` to `dsh-client-ui-renderer` migration while preserving
  the current verified DSH release-candidate compatibility range. The upstream
  alpha remains unclaimed until an exact packaged composition smoke is possible.

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
