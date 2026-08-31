/** Verify the packed plugin against the exact source-built alpha.3 Web profile. */
process.env.DSH_VOICE_SMOKE_ALPHA_VERSION = '0.1.2-alpha.3'
process.env.DSH_VOICE_SMOKE_ALPHA_AUTH = '1'
await import('./smoke-harness-fake-qwen.mjs')
