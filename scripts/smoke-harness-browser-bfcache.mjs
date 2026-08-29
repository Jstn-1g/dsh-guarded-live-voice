/** Run the packed official-Harness smoke through Chrome's real BFCache path. */
process.env.DSH_VOICE_SMOKE_BROWSER_BFCACHE = '1'
await import('./smoke-harness-fake-qwen.mjs')
