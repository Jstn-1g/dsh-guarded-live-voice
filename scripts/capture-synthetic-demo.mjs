import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const fixturePath = join(here, 'fixtures', 'synthetic-demo-capture.html')
const cssPath = join(root, 'src', 'client', 'voice.module.css')
const panelPath = join(root, 'src', 'client', 'VoicePanel.tsx')
const localesPath = join(root, 'src', 'client', 'locales.ts')
const providerPath = join(root, 'src', 'host', 'synthetic-demo-turn.ts')
const assetsDir = join(root, 'assets')
const gifPath = join(assetsDir, 'dsh-live-voice-synthetic-demo.gif')
const mp4Path = join(assetsDir, 'dsh-live-voice-synthetic-demo.mp4')

const WIDTH = 960
const HEIGHT = 540
const DURATION_SECONDS = 24
const FPS = 8
const FRAME_COUNT = DURATION_SECONDS * FPS
const AUDIO_SAMPLE_RATE = 24_000
const CHIME_START_MS = 12_600

const requiredSource = new Map([
  [panelPath, [
    "t(syntheticDemo ? 'panel.demoPreview' : 'panel.preview')",
    "t(syntheticDemo ? 'panel.demoRecord' : 'panel.record')",
    "t(syntheticDemo ? 'panel.demoFinishTurn' : 'panel.finishTurn')",
    "t('panel.useUserAsDraft')",
  ]],
  [localesPath, [
    "'panel.demoPreview': 'Local test mode · synthetic audio'",
    "'panel.demoReadyDetail': 'Run one deterministic synthetic turn. No microphone or external provider is used.'",
    "'panel.demoRecord': 'Start synthetic demo'",
    "'panel.demoFinishTurn': 'Finish demo and request response'",
    "'panel.useUserAsDraft': 'Use my transcript as draft'",
  ]],
  [providerPath, [
    "Synthetic demo request: place this sample transcript in the DSH draft.",
    "Synthetic demo response: the local consent-bound turn completed without contacting an external provider.",
  ]],
])

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status ?? 'no status'}):\n${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true })
    if (result.status === 0) return candidate
  }
  throw new Error('Chrome/Chromium was not found; set CHROME_PATH to an installed executable')
}

async function verifySourceContract() {
  for (const [path, fragments] of requiredSource) {
    const source = await readFile(path, 'utf8')
    for (const fragment of fragments) {
      if (!source.includes(fragment)) {
        throw new Error(`capture fixture is stale: ${path} no longer contains ${JSON.stringify(fragment)}`)
      }
    }
  }
}

function probe(path) {
  const raw = run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height',
    '-of', 'json',
    path,
  ])
  const parsed = JSON.parse(raw)
  const video = parsed.streams?.find(stream => stream.codec_type === 'video')
  const audio = parsed.streams?.find(stream => stream.codec_type === 'audio')
  return {
    width: Number(video?.width),
    height: Number(video?.height),
    durationSeconds: Number(parsed.format?.duration),
    audioCodec: audio?.codec_name,
  }
}

function syntheticChimeWav() {
  const totalSamples = DURATION_SECONDS * AUDIO_SAMPLE_RATE
  const chimeSamples = AUDIO_SAMPLE_RATE * 100 / 1_000
  const chimeStart = CHIME_START_MS * AUDIO_SAMPLE_RATE / 1_000
  const pcm = Buffer.alloc(totalSamples * 2)
  for (let index = 0; index < chimeSamples; index += 1) {
    const phase = index % 48
    const triangle = phase < 12 ? phase : phase < 36 ? 24 - phase : phase - 48
    const envelope = Math.min(index, chimeSamples - 1 - index, 240)
    const sample = Math.trunc(triangle * 100 * envelope / 240)
    pcm.writeInt16LE(sample, (chimeStart + index) * 2)
  }
  const wav = Buffer.alloc(44 + pcm.byteLength)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.byteLength - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(AUDIO_SAMPLE_RATE, 24)
  wav.writeUInt32LE(AUDIO_SAMPLE_RATE * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcm.byteLength, 40)
  pcm.copy(wav, 44)
  return wav
}

await verifySourceContract()
run('ffmpeg', ['-version'])
run('ffprobe', ['-version'])
await mkdir(assetsDir, { recursive: true })

const temporary = await mkdtemp(join(tmpdir(), 'dsh-live-voice-demo-'))
const framesDir = join(temporary, 'frames')
await mkdir(framesDir)

let browser
try {
  const fixture = await readFile(fixturePath, 'utf8')
  const productCss = await readFile(cssPath, 'utf8')
  const renderedFixture = fixture.replace('/*__VOICE_CSS__*/', productCss)
  if (renderedFixture === fixture) throw new Error('capture fixture is missing its VoicePanel CSS insertion point')
  const renderedPath = join(temporary, 'synthetic-demo-capture.html')
  await writeFile(renderedPath, renderedFixture, 'utf8')

  browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
    ],
  })
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.route('**/*', async route => {
    if (route.request().url().startsWith('file:')) await route.continue()
    else await route.abort('blockedbyclient')
  })
  await page.goto(pathToFileURL(renderedPath).href, { waitUntil: 'load' })
  const metadata = await page.evaluate(() => window.demoMetadata)
  if (metadata?.durationMs !== DURATION_SECONDS * 1_000 || metadata?.width !== WIDTH || metadata?.height !== HEIGHT) {
    throw new Error(`fixture metadata mismatch: ${JSON.stringify(metadata)}`)
  }

  for (let index = 0; index < FRAME_COUNT; index += 1) {
    const timeMs = index * 1_000 / FPS
    await page.evaluate(value => { window.renderDemoAt(value) }, timeMs)
    await page.screenshot({
      path: join(framesDir, `frame-${String(index).padStart(4, '0')}.png`),
      type: 'png',
      animations: 'disabled',
    })
  }
  await context.close()
  await browser.close()
  browser = undefined

  const framePattern = join(framesDir, 'frame-%04d.png')
  const audioPath = join(temporary, 'synthetic-demo-chime.wav')
  await writeFile(audioPath, syntheticChimeWav())
  run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS), '-i', framePattern,
    '-i', audioPath,
    '-vf', 'scale=960:540:flags=lanczos',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '24',
    '-c:a', 'aac', '-b:a', '64k',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-shortest',
    mp4Path,
  ])
  run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS), '-i', framePattern,
    '-filter_complex', '[0:v]scale=768:432:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
    '-loop', '0',
    gifPath,
  ])

  const [gifInfo, mp4Info, gifStat, mp4Stat] = await Promise.all([
    Promise.resolve(probe(gifPath)),
    Promise.resolve(probe(mp4Path)),
    stat(gifPath),
    stat(mp4Path),
  ])
  if (gifInfo.width !== 768 || gifInfo.height !== 432) throw new Error(`unexpected GIF dimensions: ${JSON.stringify(gifInfo)}`)
  if (mp4Info.width !== WIDTH || mp4Info.height !== HEIGHT) throw new Error(`unexpected MP4 dimensions: ${JSON.stringify(mp4Info)}`)
  if (mp4Info.audioCodec !== 'aac') throw new Error(`MP4 lacks its synthetic chime track: ${JSON.stringify(mp4Info)}`)
  if (Math.abs(gifInfo.durationSeconds - DURATION_SECONDS) > 0.2
    || Math.abs(mp4Info.durationSeconds - DURATION_SECONDS) > 0.2) {
    throw new Error(`unexpected media duration: GIF ${gifInfo.durationSeconds}s, MP4 ${mp4Info.durationSeconds}s`)
  }
  if (gifStat.size > 8 * 1024 * 1024) throw new Error(`GIF is too large: ${gifStat.size} bytes`)
  if (mp4Stat.size > 4 * 1024 * 1024) throw new Error(`MP4 is too large: ${mp4Stat.size} bytes`)

  console.log(JSON.stringify({
    scripted: true,
    deterministic: true,
    externalNetwork: false,
    syntheticChime: true,
    frames: FRAME_COUNT,
    fps: FPS,
    gif: { path: gifPath, bytes: gifStat.size, ...gifInfo },
    mp4: { path: mp4Path, bytes: mp4Stat.size, ...mp4Info },
  }, null, 2))
} finally {
  if (browser !== undefined) await browser.close()
  await rm(temporary, { recursive: true, force: true })
}
