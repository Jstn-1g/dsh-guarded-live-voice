# Privacy boundary

The planned v0.1 provider request contains only a static guard prompt and live
audio or text the user deliberately supplies after disclosure. It excludes DSH
conversation history, files, workspace instructions, memory, and project
context.

Raw microphone audio, provider audio deltas, and partial transcripts must not
be persisted by this plugin. The browser must discard them on stop, session
change, unmount, connection failure, or provider failure. A final proposal is
shown for review and may be copied into the normal composer, but is never sent
automatically.
