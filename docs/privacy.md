# Privacy boundary

The registered plugin requests no microphone permission, sends no audio or
text, and opens no provider connection. After accepted disclosure, it checks
only the Host-side provider configuration and credential availability.

The source tree includes an internal configuration-only transport that is not
exported from the package root or called by `apply`. Its default dialer could
open an authenticated Qwen session only if repository code explicitly invokes
it; current verification uses a deterministic local fake and no live
credential. The transport can send only one fixed text-only/manual-turn update
and exposes no application-data send capability.

The planned provider request contains only a static guard prompt and live audio
or text the user deliberately supplies after explicit disclosure acceptance. It
excludes DSH conversation history, files, workspace instructions, memory, and
project context.

Raw microphone audio, provider audio deltas, and partial transcripts must not
be persisted by this plugin. The browser must discard them on stop, session
change, unmount, connection failure, or provider failure. A final proposal is
shown for review and may be copied into the normal composer, but is never sent
automatically.

These plugin-side non-persistence requirements do not imply provider zero
retention or deletion. Exact Qwen realtime-audio retention is not currently
specified and is shown as unknown in the disclosure UI. A successful
credentialed functional test cannot establish retention, deletion, or data
residency policy; those claims require authoritative provider documentation or
contractual terms.
