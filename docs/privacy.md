# Privacy boundary

The branch requests microphone permission only from the explicit record button,
after the separate destination/authority disclosure has been accepted. Its
owned AudioWorklet downmixes and resamples browser audio to bounded PCM16
mono/16 kHz frames. Provider PCM16 mono/24 kHz is scheduled through an owned,
bounded playback context. Current verification uses deterministic browser
dependencies and a local fake Qwen server, not a live credential.

The provider request contains no DSH conversation history, files, workspace
instructions, memory, arbitrary text input, custom system instruction, or tool
definition. It contains only the fixed audio-mode/manual-turn configuration and
the PCM bytes deliberately supplied after acceptance.

Input PCM, provider audio deltas, and transcripts are not persisted by this
plugin. The in-memory controller and provider resources are discarded on stop,
session change, unmount, connection failure, provider failure, or authority
change. A completed final user transcript may be copied into the normal
composer only through an explicit revision-checked action and is never sent
automatically. The draft-revision check immediately before `setDraft` is not an
atomic compare-and-set and must not be treated as collision-proof.

These plugin-side non-persistence requirements do not imply provider zero
retention or deletion. Exact Qwen realtime-audio retention is not currently
specified and is shown as unknown in the disclosure UI. A successful
credentialed functional test cannot establish retention, deletion, or data
residency policy; those claims require authoritative provider documentation or
contractual terms.
