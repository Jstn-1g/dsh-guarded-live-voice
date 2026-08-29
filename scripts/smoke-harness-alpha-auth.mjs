/** Verify the packed plugin against a source-built authenticated Harness Web profile. */
process.env.DSH_VOICE_SMOKE_ALPHA_AUTH = '1'
await import('./smoke-harness-fake-qwen.mjs')
