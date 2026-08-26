# dsh-guarded-live-voice

A guarded DeepSeek Harness voice foundation with an exact-session Host boundary,
a lazy browser disclosure UI, and one bounded manual-turn transport. Browser
microphone capture and audible playback are not implemented.

## Current status

The released v0.2.0 milestone established the browser-side consent surface and
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

This v0.3 development branch adds a bounded manual-turn foundation behind that
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
- a final assistant-text “Use as draft” action that is available only after a
  completed response with a final transcript and only while the composer
  revision captured at consent remains unchanged. It never submits.

The branch still does **not** request microphone permission, capture or resample
browser audio, provide default audio playback, support continuous conversation
or barge-in, send DSH history/files/instructions, call tools, submit the
composer, or write custom session events. Its browser controller exposes a
bounded PCM seam and an output sink for a later audited capture/playback
adapter. Verification uses a deterministic local fake Qwen server; no
credential-backed provider smoke is claimed. This is not a marketplace-ready
voice product and is not “ChatGPT Live parity.”

The disclosure flow is user-visible, but it is not cryptographic proof that a
human accepted it. The one-shot challenge proves control of that local client
connection only. Loopback, Host, Origin, and `Sec-Fetch-Site` checks mitigate
remote access, DNS rebinding, and cross-site requests; they do not authenticate
a human or resist a malicious same-user local process.

## Safety boundary

Only PCM supplied through the bounded browser-controller seam after accepted
disclosure can reach Qwen. No DSH history, files, workspace instructions,
memory, arbitrary text, system instruction, or tool schema crosses that
boundary. Provider text can become an ordinary composer draft only through the
explicit, revision-fenced button; the plugin cannot submit a message, call a
tool, write a custom session event, or execute work.

## Development

Requirements: Node.js 22.19+ and pnpm 11.7.

```sh
pnpm install
pnpm check
```

`pnpm check` runs strict Host and browser TypeScript checking, deterministic
tests, Host and browser builds, package linting, browser-bundle materialization,
and a dry-run package-content check.

## Development configuration

The bundle inserts a `guarded-live-voice` Cordis row. A profile override will
need an Alibaba Cloud Model Studio workspace id before provider authorization:

```yaml
- id: guarded-live-voice
  name: dsh-guarded-live-voice
  config:
    credentialRef: DASHSCOPE_API_KEY
    dashscopeWorkspaceId: your-workspace-id
    model: qwen-audio-3.0-realtime-plus
    route: /guarded-voice
    trustedHosts: localhost,127.0.0.1,[::1]
    maxConnections: 8
```

After accepted disclosure, the development branch opens the allowlisted Qwen
endpoint for one exact-session manual turn and resolves the credential only on
the Host. Without a browser capture adapter, the included UI cannot itself feed
microphone audio into that turn.

Configure the credential through DSH's credential provider. Never put a secret
value in `cordis.patch.yml`, browser storage, an issue, or a log.

## License and provenance

MIT licensed. This repository is a clean-room implementation with new public
history. It does not contain private product source, assets, identifiers, or
repository history.
