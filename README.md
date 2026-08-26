# dsh-guarded-live-voice

A guarded DeepSeek Harness voice foundation with an exact-session Host boundary
and a lazy browser disclosure UI. Live microphone and audio remain disabled.

## Current status

Milestone two adds the browser-side consent surface to the milestone-one Host
boundary:

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

Milestone three groundwork adds an internal, configuration-only Qwen session
transport with deterministic fake-provider coverage. It can send only one fixed
text-only, manual-turn configuration event and exposes no audio, transcript,
instruction, tool, DSH context, raw socket, or send capability. The provider
must confirm the exact requested model, session identity, modalities, and turn
detection before the transport reports readiness.

The registered plugin and installed package do not request microphone access,
transmit audio or text, open a Qwen provider connection, perform transcription
or playback, or insert a proposal into the composer. The internal transport is
not exported from the package root and is not called by `apply`. Binary
WebSocket frames remain rejected. Version 0.2.0 is a development milestone, not
a marketplace-ready voice product.

The disclosure flow is user-visible, but it is not cryptographic proof that a
human accepted it. The one-shot challenge proves control of that local client
connection only. Loopback, Host, Origin, and `Sec-Fetch-Site` checks mitigate
remote access, DNS rebinding, and cross-site requests; they do not authenticate
a human or resist a malicious same-user local process.

## Safety boundary

The registered plugin sends no data to Qwen because it opens no provider
connection. A future audio milestone is designed to exclude DSH history, files,
workspace instructions, memory, and project context. Its provider output may
create only bounded proposal data for the exact bound session. Composer
integration is not implemented yet; when added, it must fill the ordinary draft
without submitting a message, calling a tool, writing a custom session event, or
executing work.

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

After accepted disclosure, the registered plugin validates the allowlisted
endpoint and credential availability only; it does not connect to Qwen. The
internal configuration-only transport will remain outside the public package API
until it is composed behind the same exact authority and consumed-consent
boundary.

Configure the credential through DSH's credential provider. Never put a secret
value in `cordis.patch.yml`, browser storage, an issue, or a log.

## License and provenance

MIT licensed. This repository is a clean-room implementation with new public
history. It does not contain private product source, assets, identifiers, or
repository history.
