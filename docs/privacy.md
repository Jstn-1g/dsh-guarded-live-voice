# Privacy boundary

The branch requests no microphone permission and has no capture or playback
implementation. After disclosure acceptance, it can open one Host-side Qwen
session and relay only PCM16 supplied through the browser controller's bounded
manual-turn seam. Current verification uses a deterministic local fake and no
live credential.

The provider request contains no DSH conversation history, files, workspace
instructions, memory, arbitrary text input, custom system instruction, or tool
definition. It contains only the fixed audio-mode/manual-turn configuration and
the PCM bytes deliberately supplied after acceptance.

Input PCM, provider audio deltas, and transcripts are not persisted by this
plugin. The in-memory controller and provider resources are discarded on stop,
session change, unmount, connection failure, provider failure, or authority
change. A completed final assistant transcript may be copied into the normal
composer only through an explicit revision-fenced action and is never sent
automatically.

These plugin-side non-persistence requirements do not imply provider zero
retention or deletion. Exact Qwen realtime-audio retention is not currently
specified and is shown as unknown in the disclosure UI. A successful
credentialed functional test cannot establish retention, deletion, or data
residency policy; those claims require authoritative provider documentation or
contractual terms.
