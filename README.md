# dsh-guarded-live-voice

The host-side protocol and authority foundation for a planned DeepSeek Harness
realtime voice plugin with a proposal-only composer handoff.

## Current status

Milestone one implements and tests the protocol and authority boundary:

- a loopback socket boundary, same-origin checks, explicit host allowlisting,
  and a bounded connection count;
- exact live-session and workspace binding, including id-reuse detection;
- short-lived, one-shot disclosure-acceptance challenges bound to that
  connection, with expiry cleanup;
- credential resolution only after client-attested disclosure acceptance;
- documented Qwen `session.created` -> `session.update` ->
  `session.updated` handshake enforcement;
- bounded, fail-closed `prepare_work_instruction` proposal parsing; and
- deterministic cleanup on connection or DSH session disposal.

Microphone capture, provider audio streaming, the Harness lazy browser module,
browser controls, and live provider validation are **not implemented yet**.
No `dsh.client` module is declared, and binary WebSocket frames are rejected.
Version 0.1.0 is therefore a development milestone, not a marketplace-ready
voice product.

Milestone one records only a client-attested acceptance of the disclosure. It
does not claim to prove that a human saw or accepted it. A future browser UI
must add an authenticated, user-visible capability before audio is enabled.

## Safety boundary

The planned first release sends no DSH history, files, workspace instructions,
memory, or project context to the voice provider. Provider output may create a
bounded proposal for the exact bound session. It will only fill the ordinary
DSH composer draft; it will not submit a message, call a tool, write a custom
session event, or execute work.

## Development

Requirements: Node.js 22.19+ and pnpm 11.7.

```sh
pnpm install
pnpm check
```

`pnpm check` runs strict TypeScript checking, deterministic tests, the host
build, package linting, and a dry-run package-content check.

## Planned configuration

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

Configure the credential through DSH's credential provider. Never put a secret
value in `cordis.patch.yml`, browser storage, an issue, or a log.

## License and provenance

MIT licensed. This repository is a clean-room implementation with new public
history. It does not contain private product source, assets, identifiers, or
repository history.
