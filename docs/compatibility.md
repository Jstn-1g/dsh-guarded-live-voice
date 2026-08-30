# Compatibility receipt

This receipt records only environments and paths backed by reproducible evidence.
An unlisted combination is unverified, not implicitly compatible.

## Verified combinations

| DSH | DSH Live Voice | OS / architecture | Node / pnpm | Verification | Result / date | Limitations |
| --- | --- | --- | --- | --- | --- | --- |
| `dsh-v0.1.1-rc.2` (`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`) official shipped Web profile | Merge `584e7bb1daa6f5f74b621b809aafd79b759f5191` | Windows `10.0.26200` / Not recorded | Not recorded | [Sanitized receipt](https://github.com/Jstn-1g/dsh-live-voice/issues/7#issuecomment-5461139958) from evidence commit `708e83e7a83a22839ee1d35be3f6bc1b6a27b5d4`; Chrome `151.0.7922.170`, Playwright `1.61.1`; official-profile idle and active BFCache lifecycle with synthetic audio and a fake loopback provider | Passed; receipt published 2026-08-29 | This does not verify independent reproduction, credential-backed Qwen or another live provider, physical microphone or speaker, OS device indicators, or packaged Desktop behavior. |

This evidence-backed receipt is intentionally the only row until an exact DSH version,
environment, and reproducible evidence are recorded for another combination.

## Adding a receipt

Add a row only when the exact DSH and plugin release or commit, operating system,
architecture, Node and pnpm versions, procedure, result/date, and limitations are
recorded in a public tester report or release-gate comment. Link that evidence in
the verification column. Keep credentials, audio, transcripts, workspace content,
personal data, and identifying logs out of this document.
