# Pull request

## Summary

Describe the exact problem and the smallest change that solves it.

## Verification

- [ ] I added or updated regression coverage for behavior changes, or
  explained why this is documentation-only.
- [ ] `pnpm check` passes locally.
- [ ] I ran any relevant packed Harness, browser lifecycle, provider, or device
  smoke and recorded the exact scope below, or marked it not applicable.

Verification scope and results:

## Safety and claim boundary

- [ ] Credentials remain Host-only and no secret is present in this pull
  request, fixture, log, screenshot, or recording.
- [ ] This change does not silently widen exported context, session authority,
  provider capabilities, transcript promotion, tool access, submission,
  storage, or resource lifetime.
- [ ] Invalid, stale, oversized, ambiguous, and out-of-order inputs still fail
  closed where applicable.
- [ ] User-facing documentation keeps unverified credential-backed Qwen,
  physical-device, and packaged-Desktop paths open, and distinguishes
  maintainer BFCache evidence from independent reproduction.

If a checkbox is not applicable, explain why here:
