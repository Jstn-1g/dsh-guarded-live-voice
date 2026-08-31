/** Verify the packed zero-credential synthetic demo in exact alpha.3 Web. */
process.env.DSH_VOICE_SMOKE_ALPHA_VERSION = '0.1.2-alpha.3'
process.env.DSH_VOICE_SMOKE_ALPHA_AUTH = '1'
process.env.DSH_VOICE_SMOKE_SYNTHETIC_DEMO = '1'
await import('./smoke-harness-fake-qwen.mjs')
