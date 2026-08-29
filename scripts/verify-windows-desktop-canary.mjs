/**
 * Exercise only the packaged Desktop seams needed before a full plugin smoke.
 *
 * The caller owns disposable-VM preflight, installer verification, installation,
 * launch, shutdown, and uninstall. This driver attaches to the packaged Tauri
 * WebView2 over loopback CDP, invokes the shell's own dependency and lifecycle
 * commands, verifies the pinned packaged Harness core, reaches its iframe, and
 * writes a path-free receipt. It does not install Live Voice or touch audio.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright-core'

const DESKTOP_RELEASE = 'v0.9.3'
const DESKTOP_COMMIT = '2a467b5f33f53908a8c008280180c0fdba5ab948'
const DESKTOP_INSTALLER_ASSET_ID = 534_988_643
const DESKTOP_INSTALLER_BYTES = 5_353_920
const DESKTOP_INSTALLER_SHA256 =
  '5ed93b77f1a3503ad5e339d3ba247cab13dd74838517cebe450fd7fc7bdfa133'
const CORE_RELEASE = 'dsh-0.1.1-rc.2-32485170079'
const CORE_VERSION = '0.1.1-rc.2'
const CORE_ASSET_ID = 523_757_080
const CORE_ASSET_BYTES = 39_046_365
const CORE_ASSET_SHA256 =
  '6ed77bae333650e4ed3a82b440a1d666d5fbc01ad7a2becd78d7afc4ff49aa8c'
const SHELL_READY_TIMEOUT_MS = 120_000
const DEPENDENCY_TIMEOUT_MS = 20 * 60_000
const SERVICE_TIMEOUT_MS = 5 * 60_000

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (
      !new Set(['--cdp-url', '--receipt']).has(key) ||
      !value ||
      value.startsWith('--')
    ) {
      throw new Error('invalid_arguments')
    }
    if (values[key] !== undefined) throw new Error('invalid_arguments')
    values[key] = value
  }
  if (!values['--cdp-url'] || !values['--receipt'])
    throw new Error('invalid_arguments')
  return values
}

function assertLoopbackHttpUrl(value, label) {
  const url = new URL(value)
  assert.ok(
    new Set(['http:', 'https:']).has(url.protocol),
    `${label} must use HTTP(S)`,
  )
  assert.ok(
    new Set(['127.0.0.1', '[::1]', 'localhost']).has(url.hostname),
    `${label} must be loopback`,
  )
  assert.equal(url.username, '', `${label} must not contain a username`)
  assert.equal(url.password, '', `${label} must not contain a password`)
  return url
}

function isPackagedShellUrl(value) {
  try {
    const url = new URL(value)
    return (
      url.hostname === 'tauri.localhost' &&
      new Set(['http:', 'https:', 'tauri:']).has(url.protocol)
    )
  } catch {
    return false
  }
}

async function delay(milliseconds) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function withTimeout(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}_timeout`)),
          milliseconds,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function findShellPage(browser) {
  const deadline = Date.now() + SHELL_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages())
    const page = pages.find((candidate) => isPackagedShellUrl(candidate.url()))
    if (page) {
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(
        () => typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function',
        undefined,
        { timeout: 30_000 },
      )
      return page
    }
    await delay(250)
  }
  throw new Error('packaged_shell_page_timeout')
}

async function invokeTauri(page, command, arguments_ = {}) {
  return await page.evaluate(
    async ({ command: commandName, arguments: commandArguments }) => {
      const invoke = globalThis.__TAURI_INTERNALS__?.invoke
      if (typeof invoke !== 'function')
        throw new Error('tauri_invoke_unavailable')
      return await invoke(commandName, commandArguments)
    },
    { command, arguments: arguments_ },
  )
}

async function waitForRuntime(page) {
  let installCommandInvoked = false
  if ((await invokeTauri(page, 'runtime_ready')) !== true) {
    installCommandInvoked = true
    await withTimeout(
      invokeTauri(page, 'install_dependencies'),
      DEPENDENCY_TIMEOUT_MS,
      'install_dependencies',
    )
  }

  const deadline = Date.now() + DEPENDENCY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await invokeTauri(page, 'runtime_ready')) === true) break
    await delay(2_000)
  }
  assert.equal(
    await invokeTauri(page, 'runtime_ready'),
    true,
    'packaged dependencies did not become ready',
  )

  let config = await invokeTauri(page, 'get_app_config')
  const configDeadline = Date.now() + 120_000
  while (config?.installed !== true && Date.now() < configDeadline) {
    installCommandInvoked = true
    await withTimeout(
      invokeTauri(page, 'install_dependencies'),
      30_000,
      'install_dependencies_heal',
    )
    await delay(500)
    config = await invokeTauri(page, 'get_app_config')
  }
  assert.equal(
    config?.installed,
    true,
    'Desktop did not persist installed runtime state',
  )
  return installCommandInvoked
}

function selectPinnedCore(cores) {
  assert.ok(Array.isArray(cores), 'get_cores did not return an array')
  const core = cores.find((candidate) => candidate?.active === true)
  assert.ok(core, 'Desktop reported no active Harness core')
  assert.equal(
    core.source,
    'app',
    'Desktop selected an unpinned local Harness core',
  )
  assert.equal(
    core.present,
    true,
    'Desktop packaged Harness core was not present',
  )
  assert.equal(
    core.version,
    CORE_VERSION,
    'Desktop packaged Harness version differed',
  )
  assert.equal(
    core.tag,
    CORE_RELEASE,
    'Desktop packaged Harness release differed',
  )
  assert.equal(
    core.error ?? null,
    null,
    'Desktop packaged Harness core reported an error',
  )
  return Object.freeze({
    id: core.id,
    source: core.source,
    version: core.version,
    tag: core.tag,
    present: core.present,
    active: core.active,
    error: core.error ?? null,
  })
}

async function waitForHarnessRoot(serviceUrl) {
  const deadline = Date.now() + SERVICE_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await fetch(serviceUrl, { redirect: 'error' })
      if (response.status === 200) return response.status
    } catch {
      // The packaged process is still reaching readiness.
    }
    await delay(1_000)
  }
  throw new Error('packaged_harness_root_timeout')
}

async function waitForHarnessFrame(page, serviceOrigin) {
  const deadline = Date.now() + SERVICE_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue
      try {
        if (new URL(frame.url()).origin !== serviceOrigin) continue
        await frame
          .locator('body')
          .waitFor({ state: 'attached', timeout: 5_000 })
        return true
      } catch {
        // The iframe is navigating or has not mounted yet.
      }
    }
    await delay(500)
  }
  throw new Error('packaged_harness_iframe_timeout')
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  assert.equal(
    process.platform,
    'win32',
    'packaged Desktop canary requires Windows',
  )
  assert.equal(
    process.env.DSH_DESKTOP_CORE_ASSET_VERIFIED,
    'true',
    'workflow did not preverify the pinned Harness core asset',
  )
  assert.ok(
    process.env.WEBVIEW2_RUNTIME_VERSION,
    'workflow did not pin the observed WebView2 runtime',
  )
  assert.match(
    process.env.DESKTOP_EXE_SHA256 ?? '',
    /^[0-9a-f]{64}$/u,
    'workflow did not hash the installed Desktop executable',
  )
  assert.match(
    process.env.GITHUB_REPOSITORY ?? '',
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    'workflow repository identity was unavailable',
  )
  assert.match(
    process.env.GITHUB_RUN_ID ?? '',
    /^\d+$/u,
    'workflow run id was unavailable',
  )
  const cdpUrl = assertLoopbackHttpUrl(options['--cdp-url'], 'CDP URL')
  const receiptPath = resolve(options['--receipt'])
  await mkdir(dirname(receiptPath), { recursive: true })

  let browser
  try {
    browser = await withTimeout(
      chromium.connectOverCDP(cdpUrl.toString()),
      60_000,
      'webview2_cdp_connection',
    )
    const shellPage = await findShellPage(browser)
    assert.match(
      await shellPage.title(),
      /Deepseek Harness Desktop/iu,
      'CDP target was not the packaged Desktop shell',
    )

    const installCommandInvoked = await waitForRuntime(shellPage)
    await withTimeout(
      invokeTauri(shellPage, 'skip_preinstall_plugins'),
      30_000,
      'skip_preinstall_plugins',
    )
    await withTimeout(
      invokeTauri(shellPage, 'ensure_internal_plugins'),
      5 * 60_000,
      'ensure_internal_plugins',
    )
    await withTimeout(
      invokeTauri(shellPage, 'launch_harness'),
      5 * 60_000,
      'launch_harness',
    )

    const runtimeInfo = await invokeTauri(shellPage, 'get_runtime_info')
    const serviceUrl = assertLoopbackHttpUrl(
      runtimeInfo?.service_url,
      'Harness service URL',
    )
    const harnessRootStatus = await waitForHarnessRoot(serviceUrl)
    const activeCore = selectPinnedCore(
      await invokeTauri(shellPage, 'get_cores'),
    )

    await shellPage.reload({ waitUntil: 'domcontentloaded' })
    await waitForHarnessFrame(shellPage, serviceUrl.origin)

    const receipt = Object.freeze({
      schema: 'dsh-live-voice/windows-packaged-desktop-canary/v1',
      generatedAt: new Date().toISOString(),
      sanitized: true,
      workflow: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      host: Object.freeze({
        platform: platform(),
        architecture: arch(),
        osRelease: release(),
        nodeVersion: process.version,
        webView2RuntimeVersion: process.env.WEBVIEW2_RUNTIME_VERSION,
        webView2BrowserVersion: browser.version(),
      }),
      candidate: Object.freeze({
        desktopRelease: DESKTOP_RELEASE,
        desktopCommit: DESKTOP_COMMIT,
        desktopInstallerAssetId: DESKTOP_INSTALLER_ASSET_ID,
        desktopInstallerBytes: DESKTOP_INSTALLER_BYTES,
        desktopInstallerSha256: DESKTOP_INSTALLER_SHA256,
        installedDesktopExeSha256: process.env.DESKTOP_EXE_SHA256,
        harnessCoreRelease: CORE_RELEASE,
        harnessCoreVersion: CORE_VERSION,
        harnessCoreAssetId: CORE_ASSET_ID,
        harnessCoreAssetBytes: CORE_ASSET_BYTES,
        harnessCoreAssetSha256: CORE_ASSET_SHA256,
      }),
      activeCore,
      checks: Object.freeze({
        exactDesktopInstallerPreverified: true,
        existingWebView2RuntimeRequired: true,
        exactHarnessCoreReleaseAssetPreverified: true,
        webView2CdpAttachedOverLoopback: true,
        packagedTauriInvokeAvailable: true,
        packagedDependenciesReady: true,
        packagedHarnessCoreSelected: true,
        harnessRootStatus,
        packagedHarnessIframeReached: true,
      }),
      actions: Object.freeze({
        installDependenciesInvoked: installCommandInvoked,
        presetPluginsSkipped: true,
        internalPluginsEnsured: true,
        harnessLaunched: true,
        liveVoiceInstalled: false,
        disclosureAccepted: false,
      }),
      unproven: Object.freeze({
        liveVoicePackagedDesktop: true,
        credentialBackedQwen: true,
        liveProvider: true,
        physicalMicrophone: true,
        physicalSpeaker: true,
        osIndicator: true,
        bfcache: true,
        fileIpcDesktop: true,
        officialEndorsement: true,
      }),
    })
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } finally {
    await browser?.close().catch(() => {})
  }
}

await main()
