# Privacy boundary

Milestone two requests no microphone permission, sends no audio or text, and
opens no provider connection. After accepted disclosure, it checks only the
Host-side provider configuration and credential availability.

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
