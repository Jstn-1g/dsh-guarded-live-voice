import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, machine, release } from 'node:os'
import { resolve as resolvePath, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DESKTOP_CANDIDATE = Object.freeze({
  desktopRelease: 'v0.9.3',
  desktopCommit: '2a467b5f33f53908a8c008280180c0fdba5ab948',
  installerName: 'Deepseek.Harness.Desktop_0.9.3_x64-setup.exe',
  installerBytes: 5_353_920,
  installerSha256: '5ed93b77f1a3503ad5e339d3ba247cab13dd74838517cebe450fd7fc7bdfa133',
  coreResolution: 'runtime-selected-unverified',
})

export const DISPOSABLE_VM_ACKNOWLEDGEMENT = 'I_ACKNOWLEDGE_THIS_IS_A_DISPOSABLE_VM'

const DSH_HOME_PREFIX = 'dsh-live-voice-desktop-'
const APP_IDENTIFIER = 'io.github.hairyf.deepseek-harness-desktop'
const PRODUCT_NAME = 'Deepseek Harness Desktop'
const PRODUCT_SHORTCUT_NAME = `${PRODUCT_NAME}.lnk`
const MAX_PROGRAM_SHORTCUT_DEPTH = 16
const MAX_PROGRAM_SHORTCUT_ENTRIES = 4_096
const DESKTOP_PROCESS_NAMES = new Set([
  'deepseek-harness-desktop.exe',
  'deepseek harness desktop.exe',
])

const REQUIRED_CHECKS = Object.freeze([
  ['platformIsWindows', 'platform_not_windows'],
  ['processArchitectureIsX64', 'process_architecture_not_x64'],
  ['nativeMachineIsX64', 'native_machine_not_x64'],
  ['explicitDisposableAcknowledgement', 'disposable_acknowledgement_missing'],
  ['requiredEnvironmentPathsAvailable', 'required_environment_path_missing'],
  ['dshHomeIsExplicit', 'dsh_home_missing'],
  ['dshHomeIsAbsolute', 'dsh_home_not_absolute'],
  ['dshHomeUsesDisposablePrefix', 'dsh_home_prefix_invalid'],
  ['dshHomeIsUnderTemp', 'dsh_home_outside_temp'],
  ['dshHomeRealPathIsUnderTemp', 'dsh_home_realpath_outside_temp'],
  ['dshHomeIsNotDefault', 'dsh_home_is_default'],
  ['dshHomeExistsAsDirectory', 'dsh_home_not_directory'],
  ['dshHomeIsNotLink', 'dsh_home_is_link'],
  ['dshHomeIsEmpty', 'dsh_home_not_empty'],
  ['defaultDshHomeIsAbsent', 'default_dsh_home_exists'],
  ['programShortcutTreeProbesSucceeded', 'program_shortcut_tree_probe_failed'],
  ['knownDesktopStateIsAbsent', 'desktop_state_exists_or_unreadable'],
  ['tasklistProbeSucceeded', 'tasklist_probe_failed'],
  ['desktopProcessIsAbsent', 'desktop_process_running'],
  ['netstatProbeSucceeded', 'netstat_probe_failed'],
  ['exclusiveBindProbeSucceeded', 'exclusive_bind_probe_failed'],
  ['desktopPortIsAvailable', 'desktop_port_unavailable'],
  ['registryProbeSucceeded', 'registry_probe_failed'],
  ['shortcutKnownFolderProbesSucceeded', 'shortcut_known_folder_probe_failed'],
  ['desktopUninstallRegistrationIsAbsent', 'desktop_uninstall_registration_exists'],
  ['desktopInstallLocationRegistrationIsAbsent', 'desktop_install_location_registration_exists'],
  ['desktopAutostartRegistrationIsAbsent', 'desktop_autostart_registration_exists'],
  ['desktopShimPathRegistrationIsAbsent', 'desktop_shim_path_registered'],
  ['dshCliPathOverrideIsAbsent', 'dsh_cli_path_override_present'],
  ['pathDshCandidatesAreAbsent', 'path_dsh_candidate_exists_or_unreadable'],
  ['installerArgumentIsPresent', 'installer_argument_missing'],
  ['installerNameMatches', 'installer_name_mismatch'],
  ['installerIsRegularFile', 'installer_not_regular_file'],
  ['installerIsNotLink', 'installer_is_link'],
  ['installerSizeMatches', 'installer_size_mismatch'],
  ['installerHashReadSucceeded', 'installer_hash_read_failed'],
  ['installerHashMatches', 'installer_hash_mismatch'],
])

export function isStrictWindowsChildPath(parent, candidate) {
  if (typeof parent !== 'string' || typeof candidate !== 'string' || parent === '' || candidate === '') {
    return false
  }
  const difference = win32.relative(win32.resolve(parent), win32.resolve(candidate))
  return (
    difference !== '' &&
    difference !== '..' &&
    !difference.startsWith(`..${win32.sep}`) &&
    !win32.isAbsolute(difference)
  )
}

export function tasklistHasDesktopProcess(output) {
  for (const line of String(output).split(/\r?\n/u)) {
    const match = /^"([^"]+)"/u.exec(line.trim())
    if (match && DESKTOP_PROCESS_NAMES.has(match[1].toLowerCase())) {
      return true
    }
  }
  return false
}

export function netstatHasListeningPort(output, port = 3080) {
  for (const line of String(output).split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u)
    if (fields.length < 4 || fields[0]?.toUpperCase() !== 'TCP') continue
    if (fields[3]?.toUpperCase() !== 'LISTENING') continue
    const localAddress = fields[1] ?? ''
    const match = /:(\d+)$/u.exec(localAddress)
    if (match && Number(match[1]) === port) return true
  }
  return false
}

export function isNativeX64Machine(value) {
  return new Set(['amd64', 'x64', 'x86_64']).has(String(value).trim().toLowerCase())
}

function expandKnownWindowsEnvironment(value, env) {
  const environment = new Map(
    Object.entries(env).map(([name, entry]) => [name.toLowerCase(), entry]),
  )
  return String(value).replaceAll(/%([^%]+)%/gu, (match, name) => {
    const replacement = environment.get(String(name).toLowerCase())
    return typeof replacement === 'string' && replacement !== '' ? replacement : match
  })
}

function splitWindowsPathList(value) {
  const unparsed = String(value ?? '')
  const entries = []
  let current = ''
  let inQuote = false
  for (const character of unparsed) {
    if (character === '"') {
      inQuote = !inQuote
    } else if (character === ';' && !inQuote) {
      entries.push(current)
      current = ''
    } else {
      current += character
    }
  }
  entries.push(current)
  return entries
}

export function windowsPathListContains(value, expected) {
  if (!value || !expected) return false
  const normalizedExpected = win32.normalize(expected).replace(/[\\/]+$/u, '').toLowerCase()
  return splitWindowsPathList(value)
    .filter(Boolean)
    .some(
      (entry) => win32.normalize(entry).replace(/[\\/]+$/u, '').toLowerCase() === normalizedExpected,
    )
}

function userDshCandidatePaths(value) {
  const unique = new Map()
  for (const entry of splitWindowsPathList(value)) {
    const directory = entry
    if (!directory) continue
    for (const name of ['dsh.cmd', 'dsh.exe', 'dsh.bat']) {
      const candidate = win32.normalize(win32.join(directory, name))
      const key = candidate.toLowerCase()
      if (!unique.has(key)) unique.set(key, candidate)
    }
  }
  return [...unique.values()]
}

export function evaluatePreflightPolicy(facts) {
  const checks = {}
  const failureCodes = []
  for (const [check, failureCode] of REQUIRED_CHECKS) {
    const passed = facts?.[check] === true
    checks[check] = passed
    if (!passed) failureCodes.push(failureCode)
  }
  return Object.freeze({
    checks: Object.freeze(checks),
    failureCodes: Object.freeze(failureCodes),
    readyForDisposableInstall: failureCodes.length === 0,
  })
}

function parseArguments(argv) {
  let installerPath
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (argument === '--installer') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('invalid_arguments')
      if (installerPath !== undefined) throw new Error('invalid_arguments')
      installerPath = value
      index += 1
      continue
    }
    throw new Error('invalid_arguments')
  }
  return { help, installerPath }
}

async function inspectPath(target) {
  if (!target) return { readable: false, exists: false, directory: false, regularFile: false, link: false }
  try {
    const status = await lstat(target)
    return {
      readable: true,
      exists: true,
      directory: status.isDirectory(),
      regularFile: status.isFile(),
      link: status.isSymbolicLink(),
      size: status.size,
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { readable: true, exists: false, directory: false, regularFile: false, link: false }
    }
    return { readable: false, exists: false, directory: false, regularFile: false, link: false }
  }
}

async function sha256File(target) {
  return await new Promise((fulfill, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(target)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => fulfill(hash.digest('hex')))
  })
}

function runProbe(command, arguments_, spawn = spawnSync) {
  const result = spawn(command, arguments_, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  })
  return {
    available: !result.error && typeof result.status === 'number',
    status: typeof result.status === 'number' ? result.status : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
  }
}

export function registryOutputHasDesktopRegistration(output) {
  const normalized = String(output).toLowerCase()
  return (
    normalized.includes(PRODUCT_NAME.toLowerCase()) ||
    normalized.includes(APP_IDENTIFIER.toLowerCase()) ||
    normalized.includes('deepseek-harness-desktop')
  )
}

export function registryOutputHasDesktopAutostart(output) {
  const product = PRODUCT_NAME.toLowerCase()
  return String(output)
    .split(/\r?\n/u)
    .some((line) => {
      const normalized = line.trim().toLowerCase()
      return normalized.startsWith(`${product} `) || normalized.includes(`\\${product}.exe`)
    })
}

export function registryValue(output, valueName, env = {}) {
  const escapedName = String(valueName).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const matcher = new RegExp(`^\\s*${escapedName}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'iu')
  for (const line of String(output).split(/\r?\n/u)) {
    const match = matcher.exec(line)
    if (!match) continue
    const expanded = expandKnownWindowsEnvironment(match[1], env)
    return /%[^%]+%/u.test(expanded) ? undefined : expanded
  }
  return undefined
}

export async function probeExclusiveLoopbackPort(port = 3080, serverFactory = createServer) {
  return await new Promise((fulfill) => {
    const server = serverFactory()
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fulfill(Object.freeze(result))
    }
    const timer = setTimeout(() => {
      try {
        server.close()
      } catch {
        // A never-started server has nothing to close.
      }
      finish({ probeSucceeded: false, available: false })
    }, 5_000)
    server.once('error', (error) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      finish({
        probeSucceeded: code === 'EADDRINUSE' || code === 'EACCES',
        available: false,
      })
    })
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close((error) => {
        finish({ probeSucceeded: !error, available: !error })
      })
    })
  })
}

function knownDesktopStatePaths(env, knownFolders = {}) {
  const paths = []
  if (env.APPDATA) {
    paths.push(win32.join(env.APPDATA, APP_IDENTIFIER))
  }
  if (env.LOCALAPPDATA) {
    paths.push(
      win32.join(env.LOCALAPPDATA, APP_IDENTIFIER),
      win32.join(env.LOCALAPPDATA, PRODUCT_NAME),
      win32.join(env.LOCALAPPDATA, 'Programs', PRODUCT_NAME),
      win32.join(env.LOCALAPPDATA, 'deepseek-harness', 'bin'),
    )
  }
  if (env.ProgramFiles) paths.push(win32.join(env.ProgramFiles, PRODUCT_NAME))
  if (env['ProgramFiles(x86)']) paths.push(win32.join(env['ProgramFiles(x86)'], PRODUCT_NAME))
  for (const programsFolder of [knownFolders.userPrograms, knownFolders.commonPrograms]) {
    if (!programsFolder) continue
    paths.push(
      win32.join(programsFolder, PRODUCT_SHORTCUT_NAME),
      win32.join(programsFolder, PRODUCT_NAME, PRODUCT_SHORTCUT_NAME),
    )
  }
  for (const desktopFolder of [knownFolders.userDesktop, knownFolders.commonDesktop]) {
    if (desktopFolder) paths.push(win32.join(desktopFolder, PRODUCT_SHORTCUT_NAME))
  }
  const unique = new Map()
  for (const entry of paths) {
    const normalized = win32.normalize(entry)
    const key = normalized.toLowerCase()
    if (!unique.has(key)) unique.set(key, normalized)
  }
  return [...unique.values()]
}

async function scanProgramShortcutTree(root, inspect, readDirectory) {
  if (!root) return { probeSucceeded: false, shortcutFound: false }
  const pending = [{ directory: root, depth: 0 }]
  let inspectedEntries = 0
  while (pending.length > 0) {
    const current = pending.shift()
    let entries
    try {
      entries = await readDirectory(current.directory)
    } catch {
      return { probeSucceeded: false, shortcutFound: false }
    }
    if (!Array.isArray(entries)) return { probeSucceeded: false, shortcutFound: false }
    for (const entry of entries) {
      if (
        typeof entry !== 'string' ||
        entry === '' ||
        entry === '.' ||
        entry === '..' ||
        win32.basename(entry) !== entry
      ) {
        return { probeSucceeded: false, shortcutFound: false }
      }
      inspectedEntries += 1
      if (inspectedEntries > MAX_PROGRAM_SHORTCUT_ENTRIES) {
        return { probeSucceeded: false, shortcutFound: false }
      }
      const target = win32.join(current.directory, entry)
      const status = await inspect(target)
      if (!status.readable || !status.exists) {
        return { probeSucceeded: false, shortcutFound: false }
      }
      if (entry.toLowerCase() === PRODUCT_SHORTCUT_NAME.toLowerCase()) {
        return { probeSucceeded: true, shortcutFound: true }
      }
      if (status.link) return { probeSucceeded: false, shortcutFound: false }
      if (status.directory) {
        if (current.depth >= MAX_PROGRAM_SHORTCUT_DEPTH) {
          return { probeSucceeded: false, shortcutFound: false }
        }
        pending.push({ directory: target, depth: current.depth + 1 })
      }
    }
  }
  return { probeSucceeded: true, shortcutFound: false }
}

function uninstallRegistryTrees() {
  return [
    {
      root: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    },
    {
      root: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    },
    {
      root: 'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    },
  ]
}

function autostartRegistryTrees() {
  return [
    {
      root: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      recursive: false,
    },
    {
      root: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
      recursive: false,
    },
  ]
}

function installLocationRegistryTrees() {
  return [
    {
      root: 'HKCU\\Software\\github',
      product: `HKCU\\Software\\github\\${PRODUCT_NAME}`,
    },
    {
      root: 'HKLM\\Software\\github',
      product: `HKLM\\Software\\github\\${PRODUCT_NAME}`,
    },
    {
      root: 'HKLM\\Software\\WOW6432Node\\github',
      product: `HKLM\\Software\\WOW6432Node\\github\\${PRODUCT_NAME}`,
    },
  ]
}

function normalizeRegistryKey(value) {
  return String(value)
    .trim()
    .replace(/^HKCU\\/iu, 'HKEY_CURRENT_USER\\')
    .replace(/^HKLM\\/iu, 'HKEY_LOCAL_MACHINE\\')
    .toLowerCase()
}

function parentRegistryKey(root) {
  const separator = String(root).trim().lastIndexOf('\\')
  return separator > 0 ? String(root).trim().slice(0, separator) : undefined
}

function registryKeyProbe(root, spawn, recursive = false) {
  const arguments_ = ['query', root]
  if (recursive) arguments_.push('/s')
  const probe = runProbe('reg.exe', arguments_, spawn)
  if (!probe.available) return { definitive: false, exists: false, output: '' }
  if (probe.status === 0) return { definitive: true, exists: true, output: probe.stdout }
  if (probe.status !== 1) return { definitive: false, exists: false, output: '' }

  const parent = parentRegistryKey(root)
  if (!parent) return { definitive: false, exists: false, output: '' }
  const parentProbe = registryKeyProbe(parent, spawn)
  if (!parentProbe.definitive) return { definitive: false, exists: false, output: '' }
  if (!parentProbe.exists) return { definitive: true, exists: false, output: '' }

  const normalizedRoot = normalizeRegistryKey(root)
  const rootWasListed = parentProbe.output
    .split(/\r?\n/u)
    .some((line) => normalizeRegistryKey(line) === normalizedRoot)
  return rootWasListed
    ? { definitive: false, exists: true, output: '' }
    : { definitive: true, exists: false, output: '' }
}

function registryTreeProbe(tree, spawn) {
  return registryKeyProbe(tree.root, spawn, tree.recursive !== false)
}

export async function collectPreflightFacts(options = {}) {
  const installerPath = options.installerPath
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const processArchitecture = options.processArchitecture ?? process.arch
  const nativeMachine = options.nativeMachine ?? machine()
  const homeDirectory = options.homeDirectory ?? homedir()
  const spawn = options.spawn ?? spawnSync
  const inspect = options.inspectPath ?? inspectPath
  const readDirectory = options.readDirectory ?? readdir
  const resolveRealPath = options.resolveRealPath ?? realpath
  const hashFile = options.hashFile ?? sha256File
  const exclusivePortProbe = options.exclusivePortProbe ?? probeExclusiveLoopbackPort

  const userProfile = env.USERPROFILE || homeDirectory
  const tempDirectory = env.TEMP || env.TMP || ''
  const dshHome = env.DSH_HOME || ''
  const defaultDshHome = userProfile ? win32.join(userProfile, '.dsh') : ''
  const shimPath = env.LOCALAPPDATA
    ? win32.join(env.LOCALAPPDATA, 'deepseek-harness', 'bin')
    : ''

  const requiredEnvironmentPathsAvailable = Boolean(
    env.APPDATA &&
      env.LOCALAPPDATA &&
      env.USERPROFILE &&
      tempDirectory &&
      env.ProgramData &&
      env.PUBLIC &&
      env.ProgramFiles &&
      env['ProgramFiles(x86)'],
  )
  const dshHomeIsExplicit = dshHome.trim() !== ''
  const dshHomeIsAbsolute = dshHomeIsExplicit && win32.isAbsolute(dshHome)
  const dshHomeName = dshHomeIsExplicit ? win32.basename(dshHome).toLowerCase() : ''
  const dshHomeUsesDisposablePrefix =
    dshHomeName.startsWith(DSH_HOME_PREFIX) && dshHomeName.length > DSH_HOME_PREFIX.length
  const dshHomeIsUnderTemp =
    dshHomeIsAbsolute && Boolean(tempDirectory) && isStrictWindowsChildPath(tempDirectory, dshHome)
  const dshHomeIsNotDefault =
    dshHomeIsAbsolute &&
    Boolean(defaultDshHome) &&
    win32.resolve(dshHome).toLowerCase() !== win32.resolve(defaultDshHome).toLowerCase()

  const dshHomeStatus = await inspect(dshHome)
  let dshHomeEntries
  if (dshHomeStatus.readable && dshHomeStatus.directory && !dshHomeStatus.link) {
    try {
      dshHomeEntries = await readDirectory(dshHome)
    } catch {
      dshHomeEntries = undefined
    }
  }

  let dshHomeRealPathIsUnderTemp = false
  if (dshHomeStatus.directory && !dshHomeStatus.link && tempDirectory) {
    try {
      const [realTemp, realDshHome] = await Promise.all([
        resolveRealPath(tempDirectory),
        resolveRealPath(dshHome),
      ])
      dshHomeRealPathIsUnderTemp = isStrictWindowsChildPath(realTemp, realDshHome)
    } catch {
      dshHomeRealPathIsUnderTemp = false
    }
  }

  const tasklist = runProbe('tasklist.exe', ['/FO', 'CSV', '/NH'], spawn)
  const netstat = runProbe('netstat.exe', ['-ano', '-p', 'tcp'], spawn)
  let exclusiveBind = { probeSucceeded: false, available: false }
  if (platform === 'win32') {
    try {
      exclusiveBind = await exclusivePortProbe(3080)
    } catch {
      exclusiveBind = { probeSucceeded: false, available: false }
    }
  }

  const registryAvailability = registryKeyProbe('HKCU\\Environment', spawn)
  const uninstallTreeProbes = uninstallRegistryTrees().map((tree) => registryTreeProbe(tree, spawn))
  const autostartTreeProbes = autostartRegistryTrees().map((tree) => registryTreeProbe(tree, spawn))
  const installLocationTrees = installLocationRegistryTrees()
  const installLocationTreeProbes = installLocationTrees.map((tree) =>
    registryTreeProbe({ ...tree, recursive: false }, spawn),
  )
  const userShellFoldersProbe = runProbe(
    'reg.exe',
    [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
    ],
    spawn,
  )
  const commonShellFoldersProbe = runProbe(
    'reg.exe',
    [
      'query',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
    ],
    spawn,
  )
  const knownFolders = {
    userDesktop: registryValue(userShellFoldersProbe.stdout, 'Desktop', env),
    userPrograms: registryValue(userShellFoldersProbe.stdout, 'Programs', env),
    commonDesktop: registryValue(commonShellFoldersProbe.stdout, 'Common Desktop', env),
    commonPrograms: registryValue(commonShellFoldersProbe.stdout, 'Common Programs', env),
  }
  const shortcutKnownFolderProbesSucceeded = Boolean(
    userShellFoldersProbe.available &&
      userShellFoldersProbe.status === 0 &&
      commonShellFoldersProbe.available &&
      commonShellFoldersProbe.status === 0 &&
      Object.values(knownFolders).every(
        (knownFolder) => knownFolder && win32.isAbsolute(knownFolder),
      ),
  )
  const registryProbeSucceeded =
    registryAvailability.definitive &&
    shortcutKnownFolderProbesSucceeded &&
    uninstallTreeProbes.every((probe) => probe.definitive) &&
    installLocationTreeProbes.every((probe) => probe.definitive) &&
    autostartTreeProbes.every((probe) => probe.definitive)
  let desktopUninstallRegistrationIsAbsent = false
  let desktopInstallLocationRegistrationIsAbsent = false
  let desktopAutostartRegistrationIsAbsent = false
  let desktopShimPathRegistrationIsAbsent = false
  if (registryProbeSucceeded) {
    desktopUninstallRegistrationIsAbsent = uninstallTreeProbes.every(
      (probe) => !registryOutputHasDesktopRegistration(probe.output),
    )
    desktopInstallLocationRegistrationIsAbsent = installLocationTreeProbes.every(
      (probe, index) =>
        !probe.output
          .split(/\r?\n/u)
          .some(
            (line) =>
              normalizeRegistryKey(line) ===
              normalizeRegistryKey(installLocationTrees[index].product),
          ),
    )
    desktopAutostartRegistrationIsAbsent = autostartTreeProbes.every(
      (probe) => !registryOutputHasDesktopAutostart(probe.output),
    )
    const registryPathValue = registryValue(registryAvailability.output, 'Path', env) ?? ''
    desktopShimPathRegistrationIsAbsent =
      !windowsPathListContains(env.PATH ?? '', shimPath) &&
      !windowsPathListContains(registryPathValue, shimPath)
  }

  const defaultDshHomeStatus = await inspect(defaultDshHome)
  const stateStatuses = await Promise.all(
    knownDesktopStatePaths(env, knownFolders).map(async (target) => await inspect(target)),
  )
  const programShortcutTreeProbes = await Promise.all(
    [knownFolders.userPrograms, knownFolders.commonPrograms].map(
      async (root) => await scanProgramShortcutTree(root, inspect, readDirectory),
    ),
  )
  const programShortcutTreeProbesSucceeded = programShortcutTreeProbes.every(
    (probe) => probe.probeSucceeded,
  )
  const knownDesktopStateIsAbsent =
    stateStatuses.length > 0 &&
    stateStatuses.every((status) => status.readable && !status.exists) &&
    programShortcutTreeProbesSucceeded &&
    programShortcutTreeProbes.every((probe) => !probe.shortcutFound)
  const pathDshCandidateStatuses = await Promise.all(
    userDshCandidatePaths(env.PATH).map(async (target) => await inspect(target)),
  )
  const dshCliPathOverrideIsAbsent =
    typeof env.DSH_CLI_PATH !== 'string' || env.DSH_CLI_PATH.trim() === ''
  const pathDshCandidatesAreAbsent = pathDshCandidateStatuses.every(
    (status) => status.readable && !status.exists,
  )

  const installerArgumentIsPresent = typeof installerPath === 'string' && installerPath.trim() !== ''
  const installerStatus = await inspect(installerPath)
  let installerHash
  let installerHashReadSucceeded = false
  if (installerStatus.regularFile && !installerStatus.link) {
    try {
      installerHash = await hashFile(installerPath)
      installerHashReadSucceeded = true
    } catch {
      installerHashReadSucceeded = false
    }
  }

  return {
    platformIsWindows: platform === 'win32',
    processArchitectureIsX64: processArchitecture === 'x64',
    nativeMachineIsX64: isNativeX64Machine(nativeMachine),
    explicitDisposableAcknowledgement:
      env.DSH_LIVE_VOICE_DISPOSABLE_VM === DISPOSABLE_VM_ACKNOWLEDGEMENT,
    requiredEnvironmentPathsAvailable,
    dshHomeIsExplicit,
    dshHomeIsAbsolute,
    dshHomeUsesDisposablePrefix,
    dshHomeIsUnderTemp,
    dshHomeRealPathIsUnderTemp,
    dshHomeIsNotDefault,
    dshHomeExistsAsDirectory:
      dshHomeStatus.readable && dshHomeStatus.exists && dshHomeStatus.directory,
    dshHomeIsNotLink: dshHomeStatus.readable && !dshHomeStatus.link,
    dshHomeIsEmpty: Array.isArray(dshHomeEntries) && dshHomeEntries.length === 0,
    defaultDshHomeIsAbsent: defaultDshHomeStatus.readable && !defaultDshHomeStatus.exists,
    programShortcutTreeProbesSucceeded,
    knownDesktopStateIsAbsent,
    tasklistProbeSucceeded: tasklist.available && tasklist.status === 0,
    desktopProcessIsAbsent:
      tasklist.available && tasklist.status === 0 && !tasklistHasDesktopProcess(tasklist.stdout),
    netstatProbeSucceeded: netstat.available && netstat.status === 0,
    exclusiveBindProbeSucceeded: exclusiveBind.probeSucceeded,
    desktopPortIsAvailable:
      netstat.available &&
      netstat.status === 0 &&
      !netstatHasListeningPort(netstat.stdout, 3080) &&
      exclusiveBind.available,
    registryProbeSucceeded,
    shortcutKnownFolderProbesSucceeded,
    desktopUninstallRegistrationIsAbsent,
    desktopInstallLocationRegistrationIsAbsent,
    desktopAutostartRegistrationIsAbsent,
    desktopShimPathRegistrationIsAbsent,
    dshCliPathOverrideIsAbsent,
    pathDshCandidatesAreAbsent,
    installerArgumentIsPresent,
    installerNameMatches:
      installerArgumentIsPresent && win32.basename(installerPath) === DESKTOP_CANDIDATE.installerName,
    installerIsRegularFile:
      installerStatus.readable && installerStatus.exists && installerStatus.regularFile,
    installerIsNotLink: installerStatus.readable && !installerStatus.link,
    installerSizeMatches:
      installerStatus.regularFile && installerStatus.size === DESKTOP_CANDIDATE.installerBytes,
    installerHashReadSucceeded,
    installerHashMatches:
      installerHashReadSucceeded && installerHash === DESKTOP_CANDIDATE.installerSha256,
  }
}

export async function createSanitizedPreflightReceipt(options = {}) {
  const facts = await collectPreflightFacts(options)
  const policy = evaluatePreflightPolicy(facts)
  const preflightScriptSha256 =
    options.preflightScriptSha256 ?? (await sha256File(fileURLToPath(import.meta.url)))
  const receiptPlatform = options.platform ?? process.platform
  const receiptProcessArchitecture = options.processArchitecture ?? process.arch
  const receiptNativeMachine = options.nativeMachine ?? machine()
  return Object.freeze({
    schema: 'dsh-live-voice/windows-desktop-preflight/v1',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sanitized: true,
    candidate: DESKTOP_CANDIDATE,
    preflight: Object.freeze({ scriptSha256: preflightScriptSha256 }),
    host: Object.freeze({
      platform: receiptPlatform,
      processArchitecture: receiptProcessArchitecture,
      nativeMachine: receiptNativeMachine,
      osRelease: options.osRelease ?? release(),
      nodeVersion: options.nodeVersion ?? process.version,
    }),
    checks: policy.checks,
    readyForDisposableInstall: policy.readyForDisposableInstall,
    failureCodes: policy.failureCodes,
    probes: Object.freeze({
      filesystemReadAttempted: true,
      processListReadAttempted: true,
      processListReadSucceeded: facts.tasklistProbeSucceeded,
      registryReadAttempted: true,
      registryReadSucceeded: facts.registryProbeSucceeded,
      netstatReadAttempted: true,
      netstatReadSucceeded: facts.netstatProbeSucceeded,
      transientExclusiveLoopbackBindAttempted: receiptPlatform === 'win32',
      transientExclusiveLoopbackBindSucceeded: facts.exclusiveBindProbeSucceeded,
    }),
    actions: Object.freeze({
      downloaded: false,
      installed: false,
      launched: false,
      pluginInstalled: false,
      uninstalled: false,
      deleted: false,
    }),
    unproven: Object.freeze({
      packagedDesktop: true,
      installedHarnessIdentity: true,
      credentialBackedQwen: true,
      physicalMicrophone: true,
      physicalSpeaker: true,
      osIndicator: true,
    }),
  })
}

function usage() {
  return [
    'Usage:',
    `  pnpm run preflight:desktop:windows -- --installer <${DESKTOP_CANDIDATE.installerName}>`,
    '',
    `Required environment: DSH_LIVE_VOICE_DISPOSABLE_VM=${DISPOSABLE_VM_ACKNOWLEDGEMENT}`,
    `DSH_HOME must be an explicit empty ${DSH_HOME_PREFIX}* directory beneath Windows TEMP.`,
    'This command reads local state, hashes the installer, and briefly binds loopback port 3080.',
    'It does not download, install, launch, persist configuration, or delete.',
  ].join('\n')
}

async function main() {
  let arguments_
  try {
    arguments_ = parseArguments(process.argv.slice(2))
  } catch {
    process.stderr.write('Invalid arguments. Run with --help for the accepted form.\n')
    process.exitCode = 2
    return
  }
  if (arguments_.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const receipt = await createSanitizedPreflightReceipt({ installerPath: arguments_.installerPath })
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  if (!receipt.readyForDisposableInstall) process.exitCode = 1
}

const currentFile = fileURLToPath(import.meta.url)
const invokedFile = process.argv[1] ? fileURLToPath(pathToFileURL(resolvePath(process.argv[1]))) : ''
if (currentFile.toLowerCase() === invokedFile.toLowerCase()) {
  await main()
}
