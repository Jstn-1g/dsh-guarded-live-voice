import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'

import {
  collectPreflightFacts,
  createSanitizedPreflightReceipt,
  DESKTOP_CANDIDATE,
  DISPOSABLE_VM_ACKNOWLEDGEMENT,
  evaluatePreflightPolicy,
  isNativeX64Machine,
  isStrictWindowsChildPath,
  netstatHasListeningPort,
  probeExclusiveLoopbackPort,
  registryOutputHasDesktopAutostart,
  registryOutputHasDesktopRegistration,
  registryValue,
  tasklistHasDesktopProcess,
  windowsPathListContains,
} from '../../scripts/preflight-windows-desktop.mjs'
import type {
  PathInspection,
  PreflightOptions,
} from '../../scripts/preflight-windows-desktop.mjs'

const readyFacts = {
  platformIsWindows: true,
  processArchitectureIsX64: true,
  nativeMachineIsX64: true,
  explicitDisposableAcknowledgement: true,
  requiredEnvironmentPathsAvailable: true,
  dshHomeIsExplicit: true,
  dshHomeIsAbsolute: true,
  dshHomeUsesDisposablePrefix: true,
  dshHomeIsUnderTemp: true,
  dshHomeRealPathIsUnderTemp: true,
  dshHomeIsNotDefault: true,
  dshHomeExistsAsDirectory: true,
  dshHomeIsNotLink: true,
  dshHomeIsEmpty: true,
  defaultDshHomeIsAbsent: true,
  programShortcutTreeProbesSucceeded: true,
  knownDesktopStateIsAbsent: true,
  tasklistProbeSucceeded: true,
  desktopProcessIsAbsent: true,
  netstatProbeSucceeded: true,
  exclusiveBindProbeSucceeded: true,
  desktopPortIsAvailable: true,
  registryProbeSucceeded: true,
  shortcutKnownFolderProbesSucceeded: true,
  desktopUninstallRegistrationIsAbsent: true,
  desktopInstallLocationRegistrationIsAbsent: true,
  desktopAutostartRegistrationIsAbsent: true,
  desktopShimPathRegistrationIsAbsent: true,
  dshCliPathOverrideIsAbsent: true,
  pathDshCandidatesAreAbsent: true,
  installerArgumentIsPresent: true,
  installerNameMatches: true,
  installerIsRegularFile: true,
  installerIsNotLink: true,
  installerSizeMatches: true,
  installerHashReadSucceeded: true,
  installerHashMatches: true,
} as const

const privateUserProfile = 'C:\\Users\\PrivateTester'
const disposableHome = `${privateUserProfile}\\AppData\\Local\\Temp\\dsh-live-voice-desktop-123`
const installerPath = `${privateUserProfile}\\Downloads\\${DESKTOP_CANDIDATE.installerName}`
const secretSentinel = 'provider-secret-must-not-appear'

const fakeEnvironment = {
  APPDATA: `${privateUserProfile}\\AppData\\Roaming`,
  LOCALAPPDATA: `${privateUserProfile}\\AppData\\Local`,
  USERPROFILE: privateUserProfile,
  TEMP: `${privateUserProfile}\\AppData\\Local\\Temp`,
  ProgramData: 'C:\\ProgramData',
  PUBLIC: 'C:\\Users\\Public',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  OneDrive: `${privateUserProfile}\\OneDrive`,
  PATH: 'C:\\Windows\\System32',
  DSH_HOME: disposableHome,
  DSH_LIVE_VOICE_DISPOSABLE_VM: DISPOSABLE_VM_ACKNOWLEDGEMENT,
  DASHSCOPE_API_KEY: secretSentinel,
}

const absentPath: PathInspection = {
  readable: true,
  exists: false,
  directory: false,
  regularFile: false,
  link: false,
}

function baseSpawn(
  command: string,
  arguments_: readonly string[],
): { error?: Error; status: number | null; stdout: string } {
  if (command === 'tasklist.exe') {
    return { status: 0, stdout: '"node.exe","100","Console","1","20,000 K"\r\n' }
  }
  if (command === 'netstat.exe') {
    return { status: 0, stdout: 'TCP    127.0.0.1:4000    0.0.0.0:0    LISTENING    100\r\n' }
  }
  if (command !== 'reg.exe') return { status: null, stdout: '', error: new Error('unexpected') }

  const registryKey = arguments_[1] ?? ''
  if (registryKey === 'HKCU\\Environment') {
    return { status: 0, stdout: '    Path    REG_EXPAND_SZ    C:\\Windows\\System32\r\n' }
  }
  if (
    registryKey ===
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'
  ) {
    return {
      status: 0,
      stdout: [
        '    Desktop    REG_EXPAND_SZ    %OneDrive%\\Desktop',
        '    Programs    REG_EXPAND_SZ    %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs',
      ].join('\r\n'),
    }
  }
  if (
    registryKey ===
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'
  ) {
    return {
      status: 0,
      stdout: [
        '    Common Desktop    REG_EXPAND_SZ    %PUBLIC%\\Desktop',
        '    Common Programs    REG_EXPAND_SZ    %ProgramData%\\Microsoft\\Windows\\Start Menu\\Programs',
      ].join('\r\n'),
    }
  }
  return { status: 0, stdout: `${registryKey}\r\n    DisplayName    REG_SZ    Another App\r\n` }
}

function basePathInspection(target: string | undefined): Promise<PathInspection> {
  if (target === disposableHome) {
    return Promise.resolve({
      readable: true,
      exists: true,
      directory: true,
      regularFile: false,
      link: false,
    })
  }
  if (target === installerPath) {
    return Promise.resolve({
      readable: true,
      exists: true,
      directory: false,
      regularFile: true,
      link: false,
      size: DESKTOP_CANDIDATE.installerBytes,
    })
  }
  return Promise.resolve(absentPath)
}

function successfulCollectorOptions(overrides: Partial<PreflightOptions> = {}): PreflightOptions {
  return {
    installerPath,
    env: fakeEnvironment,
    platform: 'win32',
    processArchitecture: 'x64',
    nativeMachine: 'x86_64',
    homeDirectory: privateUserProfile,
    osRelease: '10.0.test',
    nodeVersion: 'v24.0.0-test',
    generatedAt: '2026-08-29T00:00:00.000Z',
    preflightScriptSha256: 'a'.repeat(64),
    spawn: baseSpawn,
    inspectPath: basePathInspection,
    readDirectory: async () => [],
    resolveRealPath: async (target) => target,
    hashFile: async () => DESKTOP_CANDIDATE.installerSha256,
    exclusivePortProbe: async () => ({ probeSucceeded: true, available: true }),
    ...overrides,
  }
}

describe('Windows packaged-shell preflight policy', () => {
  it('pins the exact audited shell while leaving its runtime-selected core unverified', () => {
    expect(DESKTOP_CANDIDATE).toEqual({
      desktopRelease: 'v0.9.3',
      desktopCommit: '2a467b5f33f53908a8c008280180c0fdba5ab948',
      installerName: 'Deepseek.Harness.Desktop_0.9.3_x64-setup.exe',
      installerBytes: 5_353_920,
      installerSha256: '5ed93b77f1a3503ad5e339d3ba247cab13dd74838517cebe450fd7fc7bdfa133',
      coreResolution: 'runtime-selected-unverified',
    })
    expect(DISPOSABLE_VM_ACKNOWLEDGEMENT).toBe('I_ACKNOWLEDGE_THIS_IS_A_DISPOSABLE_VM')
  })

  it('passes only when every disposable-host and provenance fact is true', () => {
    expect(evaluatePreflightPolicy(readyFacts)).toMatchObject({
      readyForDisposableInstall: true,
      failureCodes: [],
      checks: readyFacts,
    })

    for (const check of Object.keys(readyFacts)) {
      const result = evaluatePreflightPolicy({ ...readyFacts, [check]: false })
      expect(result.readyForDisposableInstall, check).toBe(false)
      expect(result.failureCodes, check).toHaveLength(1)
    }
  })

  it('treats missing or non-boolean facts as failures', () => {
    const missingHash = { ...readyFacts } as Record<string, unknown>
    delete missingHash.installerHashMatches
    expect(evaluatePreflightPolicy(missingHash)).toMatchObject({
      readyForDisposableInstall: false,
      failureCodes: ['installer_hash_mismatch'],
    })
    expect(
      evaluatePreflightPolicy({ ...readyFacts, installerHashMatches: 'yes' }),
    ).toMatchObject({
      readyForDisposableInstall: false,
      failureCodes: ['installer_hash_mismatch'],
    })
  })

  it('collects every ready fact through injected Windows probes', async () => {
    await expect(collectPreflightFacts(successfulCollectorOptions())).resolves.toEqual(readyFacts)
  })

  it('keeps the receipt path- and secret-free while binding its own script digest', async () => {
    const receipt = await createSanitizedPreflightReceipt(successfulCollectorOptions())
    expect(receipt).toMatchObject({
      sanitized: true,
      readyForDisposableInstall: true,
      preflight: { scriptSha256: 'a'.repeat(64) },
      candidate: { coreResolution: 'runtime-selected-unverified' },
      host: {
        platform: 'win32',
        processArchitecture: 'x64',
        nativeMachine: 'x86_64',
      },
      probes: {
        filesystemReadAttempted: true,
        processListReadAttempted: true,
        processListReadSucceeded: true,
        registryReadAttempted: true,
        registryReadSucceeded: true,
        netstatReadAttempted: true,
        netstatReadSucceeded: true,
        transientExclusiveLoopbackBindAttempted: true,
        transientExclusiveLoopbackBindSucceeded: true,
      },
      actions: {
        downloaded: false,
        installed: false,
        launched: false,
        pluginInstalled: false,
        uninstalled: false,
        deleted: false,
      },
      unproven: {
        packagedDesktop: true,
        installedHarnessIdentity: true,
      },
    })
    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toContain(privateUserProfile)
    expect(serialized).not.toContain(installerPath)
    expect(serialized).not.toContain(secretSentinel)
  })

  it('reports attempted and successful probes without claiming a skipped bind', async () => {
    const probeError = new Error('probe unavailable')
    const receipt = await createSanitizedPreflightReceipt(
      successfulCollectorOptions({
        platform: 'linux',
        spawn: () => ({ error: probeError, status: null, stdout: '' }),
      }),
    )
    expect(receipt.readyForDisposableInstall).toBe(false)
    expect(receipt.probes).toEqual({
      filesystemReadAttempted: true,
      processListReadAttempted: true,
      processListReadSucceeded: false,
      registryReadAttempted: true,
      registryReadSucceeded: false,
      netstatReadAttempted: true,
      netstatReadSucceeded: false,
      transientExclusiveLoopbackBindAttempted: false,
      transientExclusiveLoopbackBindSucceeded: false,
    })
  })

  it('fails closed on native emulation, probe errors, reparse state, and bad installer provenance', async () => {
    const probeError = new Error('probe failed')
    const facts = await collectPreflightFacts(
      successfulCollectorOptions({
        nativeMachine: 'arm64',
        spawn: (command, arguments_) =>
          command === 'tasklist.exe'
            ? { error: probeError, status: null, stdout: '' }
            : baseSpawn(command, arguments_),
        inspectPath: async (target) => {
          if (target === disposableHome) {
            return {
              readable: true,
              exists: true,
              directory: true,
              regularFile: false,
              link: true,
            }
          }
          if (target === installerPath) {
            return {
              readable: true,
              exists: true,
              directory: false,
              regularFile: true,
              link: false,
              size: DESKTOP_CANDIDATE.installerBytes - 1,
            }
          }
          return { ...absentPath, readable: false }
        },
        hashFile: async () => 'b'.repeat(64),
        exclusivePortProbe: async () => ({ probeSucceeded: false, available: false }),
      }),
    )
    expect(facts).toMatchObject({
      nativeMachineIsX64: false,
      dshHomeIsNotLink: false,
      dshHomeIsEmpty: false,
      knownDesktopStateIsAbsent: false,
      tasklistProbeSucceeded: false,
      desktopProcessIsAbsent: false,
      exclusiveBindProbeSucceeded: false,
      desktopPortIsAvailable: false,
      installerSizeMatches: false,
      installerHashMatches: false,
    })
    expect(evaluatePreflightPolicy(facts).readyForDisposableInstall).toBe(false)
  })

  it('rejects an explicit or PATH-discovered user DSH core candidate', async () => {
    const overrideFacts = await collectPreflightFacts(
      successfulCollectorOptions({
        env: {
          ...fakeEnvironment,
          DSH_CLI_PATH: 'C:\\Tools\\dsh.cmd',
        },
      }),
    )
    expect(overrideFacts.dshCliPathOverrideIsAbsent).toBe(false)
    expect(evaluatePreflightPolicy(overrideFacts).readyForDisposableInstall).toBe(false)

    const globalDshPath = 'C:\\Users\\PrivateTester\\AppData\\Roaming\\npm\\dsh.cmd'
    const pathFacts = await collectPreflightFacts(
      successfulCollectorOptions({
        env: {
          ...fakeEnvironment,
          PATH: `${fakeEnvironment.PATH};C:\\Users\\PrivateTester\\AppData\\Roaming\\npm`,
        },
        inspectPath: async (target) => {
          if (target === globalDshPath) {
            return {
              readable: true,
              exists: true,
              directory: false,
              regularFile: true,
              link: false,
            }
          }
          return await basePathInspection(target)
        },
      }),
    )
    expect(pathFacts.pathDshCandidatesAreAbsent).toBe(false)
    expect(evaluatePreflightPolicy(pathFacts).readyForDisposableInstall).toBe(false)

    const quotedDshPath = 'C:\\core;bin\\dsh.cmd'
    for (const pathValue of ['"C:\\core;bin"', 'C:\\co"re;bi"n']) {
      const quotedPathFacts = await collectPreflightFacts(
        successfulCollectorOptions({
          env: { ...fakeEnvironment, PATH: pathValue },
          inspectPath: async (target) => {
            if (target === quotedDshPath) {
              return {
                readable: true,
                exists: true,
                directory: false,
                regularFile: true,
                link: false,
              }
            }
            return await basePathInspection(target)
          },
        }),
      )
      expect(quotedPathFacts.pathDshCandidatesAreAbsent, pathValue).toBe(false)
      expect(evaluatePreflightPolicy(quotedPathFacts).readyForDisposableInstall, pathValue).toBe(
        false,
      )
    }

    const literalPercentDshPath = 'C:\\%TEMP%\\bin\\dsh.cmd'
    const literalPercentFacts = await collectPreflightFacts(
      successfulCollectorOptions({
        env: { ...fakeEnvironment, PATH: 'C:\\%TEMP%\\bin' },
        inspectPath: async (target) => {
          if (target === literalPercentDshPath) {
            return {
              readable: true,
              exists: true,
              directory: false,
              regularFile: true,
              link: false,
            }
          }
          return await basePathInspection(target)
        },
      }),
    )
    expect(literalPercentFacts.pathDshCandidatesAreAbsent).toBe(false)
    expect(evaluatePreflightPolicy(literalPercentFacts).readyForDisposableInstall).toBe(false)
  })

  it('rejects ambiguous registry absence, persistent install state, autostart state, and redirected shortcuts', async () => {
    const ambiguousRegistryFacts = await collectPreflightFacts(
      successfulCollectorOptions({
        spawn: (command, arguments_) => {
          if (command === 'reg.exe' && arguments_.includes('/s')) {
            return { status: 1, stdout: '' }
          }
          if (command === 'reg.exe' && (arguments_[1] ?? '').endsWith('CurrentVersion')) {
            const parent = (arguments_[1] ?? '')
              .replace(/^HKCU\\/u, 'HKEY_CURRENT_USER\\')
              .replace(/^HKLM\\/u, 'HKEY_LOCAL_MACHINE\\')
            const root = `${parent}\\Uninstall`
            return { status: 0, stdout: `${arguments_[1]}\r\n${root}\r\n` }
          }
          return baseSpawn(command, arguments_)
        },
      }),
    )
    expect(ambiguousRegistryFacts.registryProbeSucceeded).toBe(false)
    expect(ambiguousRegistryFacts.desktopUninstallRegistrationIsAbsent).toBe(false)

    const persistentInstallFacts = await collectPreflightFacts(
      successfulCollectorOptions({
        spawn: (command, arguments_) => {
          const key = arguments_[1] ?? ''
          if (command === 'reg.exe' && key === 'HKCU\\Software\\github') {
            return {
              status: 0,
              stdout: `${key}\r\nHKEY_CURRENT_USER\\Software\\github\\Deepseek Harness Desktop\r\n`,
            }
          }
          return baseSpawn(command, arguments_)
        },
      }),
    )
    expect(persistentInstallFacts.registryProbeSucceeded).toBe(true)
    expect(persistentInstallFacts.desktopInstallLocationRegistrationIsAbsent).toBe(false)
    expect(evaluatePreflightPolicy(persistentInstallFacts).readyForDisposableInstall).toBe(false)

    const staleStateFacts = await collectPreflightFacts(
      successfulCollectorOptions({
        spawn: (command, arguments_) => {
          const key = arguments_[1] ?? ''
          if (command === 'reg.exe' && key.endsWith('StartupApproved\\Run')) {
            return {
              status: 0,
              stdout: `${key}\r\n    Deepseek Harness Desktop    REG_BINARY    02000000\r\n`,
            }
          }
          return baseSpawn(command, arguments_)
        },
        inspectPath: async (target) => {
          if (target === `${fakeEnvironment.OneDrive}\\Desktop\\Deepseek Harness Desktop.lnk`) {
            return {
              readable: true,
              exists: true,
              directory: false,
              regularFile: true,
              link: false,
            }
          }
          return await basePathInspection(target)
        },
      }),
    )
    expect(staleStateFacts.registryProbeSucceeded).toBe(true)
    expect(staleStateFacts.desktopAutostartRegistrationIsAbsent).toBe(false)
    expect(staleStateFacts.knownDesktopStateIsAbsent).toBe(false)

    const commonShortcutFacts = await collectPreflightFacts(
      successfulCollectorOptions({
        inspectPath: async (target) => {
          if (
            target ===
            `${fakeEnvironment.ProgramData}\\Microsoft\\Windows\\Start Menu\\Programs\\Deepseek Harness Desktop.lnk`
          ) {
            return {
              readable: true,
              exists: true,
              directory: false,
              regularFile: true,
              link: false,
            }
          }
          return await basePathInspection(target)
        },
      }),
    )
    expect(commonShortcutFacts.shortcutKnownFolderProbesSucceeded).toBe(true)
    expect(commonShortcutFacts.knownDesktopStateIsAbsent).toBe(false)
  })

  it('finds product shortcuts inside custom nested user and common Start Menu folders', async () => {
    const userPrograms = `${fakeEnvironment.APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs`
    const commonPrograms = `${fakeEnvironment.ProgramData}\\Microsoft\\Windows\\Start Menu\\Programs`
    for (const programsRoot of [userPrograms, commonPrograms]) {
      const customFolder = `${programsRoot}\\Custom Folder`
      const nestedShortcut = `${customFolder}\\Deepseek Harness Desktop.lnk`
      const facts = await collectPreflightFacts(
        successfulCollectorOptions({
          inspectPath: async (target) => {
            if (target === customFolder) {
              return {
                readable: true,
                exists: true,
                directory: true,
                regularFile: false,
                link: false,
              }
            }
            if (target === nestedShortcut) {
              return {
                readable: true,
                exists: true,
                directory: false,
                regularFile: true,
                link: false,
              }
            }
            return await basePathInspection(target)
          },
          readDirectory: async (target) => {
            if (target === programsRoot) return ['Custom Folder']
            if (target === customFolder) return ['Deepseek Harness Desktop.lnk']
            return []
          },
        }),
      )
      expect(facts.programShortcutTreeProbesSucceeded, programsRoot).toBe(true)
      expect(facts.knownDesktopStateIsAbsent, programsRoot).toBe(false)
      expect(evaluatePreflightPolicy(facts).readyForDisposableInstall, programsRoot).toBe(false)
    }
  })

  it('requires a strict Windows TEMP child instead of an equal or sibling path', () => {
    expect(
      isStrictWindowsChildPath(
        'C:\\Users\\Tester\\AppData\\Local\\Temp',
        'C:\\Users\\Tester\\AppData\\Local\\Temp\\dsh-live-voice-desktop-123',
      ),
    ).toBe(true)
    expect(
      isStrictWindowsChildPath(
        'C:\\Users\\Tester\\AppData\\Local\\Temp',
        'C:\\Users\\Tester\\AppData\\Local\\Temp',
      ),
    ).toBe(false)
    expect(
      isStrictWindowsChildPath(
        'C:\\Users\\Tester\\AppData\\Local\\Temp',
        'C:\\Users\\Tester\\AppData\\Local\\dsh-live-voice-desktop-123',
      ),
    ).toBe(false)
  })

  it('detects both the Desktop process and a listener on the release port', () => {
    expect(
      tasklistHasDesktopProcess(
        '"deepseek-harness-desktop.exe","4120","Console","1","24,000 K"\r\n',
      ),
    ).toBe(true)
    expect(tasklistHasDesktopProcess('"node.exe","4120","Console","1","24,000 K"\r\n')).toBe(
      false,
    )

    const netstat = [
      '  TCP    127.0.0.1:3080       0.0.0.0:0       LISTENING       4120',
      '  TCP    [::1]:4000           [::]:0          LISTENING       9000',
    ].join('\r\n')
    expect(netstatHasListeningPort(netstat, 3080)).toBe(true)
    expect(netstatHasListeningPort(netstat, 3081)).toBe(false)
  })

  it('distinguishes the native machine from an emulated x64 process', () => {
    expect(isNativeX64Machine('x86_64')).toBe(true)
    expect(isNativeX64Machine('AMD64')).toBe(true)
    expect(isNativeX64Machine('arm64')).toBe(false)
    expect(isNativeX64Machine('aarch64')).toBe(false)
  })

  it('recognizes product-name, identifier, and GUID-key uninstall registrations', () => {
    expect(
      registryOutputHasDesktopRegistration(`
HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}
    DisplayName    REG_SZ    Deepseek Harness Desktop
`),
    ).toBe(true)
    expect(
      registryOutputHasDesktopRegistration(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}
    BundleIdentifier    REG_SZ    io.github.hairyf.deepseek-harness-desktop
`),
    ).toBe(true)
    expect(registryOutputHasDesktopRegistration('DisplayName    REG_SZ    Another App')).toBe(false)
    expect(
      registryOutputHasDesktopAutostart(
        '    Deepseek Harness Desktop    REG_SZ    C:\\Apps\\deepseek-harness-desktop.exe',
      ),
    ).toBe(true)
    expect(registryOutputHasDesktopAutostart('    Another App    REG_SZ    C:\\Apps\\other.exe')).toBe(
      false,
    )
    expect(
      registryValue(
        '    Desktop    REG_EXPAND_SZ    %OneDrive%\\Desktop',
        'Desktop',
        fakeEnvironment,
      ),
    ).toBe(`${fakeEnvironment.OneDrive}\\Desktop`)
    expect(
      registryValue('    Desktop    REG_EXPAND_SZ    %UNKNOWN%\\Desktop', 'Desktop', fakeEnvironment),
    ).toBeUndefined()
  })

  it('uses an exclusive loopback bind to detect unavailable ports', async () => {
    await expect(probeExclusiveLoopbackPort(0)).resolves.toEqual({
      probeSucceeded: true,
      available: true,
    })

    const blocker = createServer()
    await new Promise<void>((fulfill, reject) => {
      blocker.once('error', reject)
      blocker.listen({ host: '127.0.0.1', port: 0, exclusive: true }, fulfill)
    })
    const port = (blocker.address() as AddressInfo).port
    try {
      await expect(probeExclusiveLoopbackPort(port)).resolves.toEqual({
        probeSucceeded: true,
        available: false,
      })
    } finally {
      await new Promise<void>((fulfill, reject) =>
        blocker.close((error) => (error ? reject(error) : fulfill())),
      )
    }
  })

  it('detects expanded and literal shim entries in Windows PATH values', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local',
      APPDATA: 'C:\\Users\\Tester\\AppData\\Roaming',
      USERPROFILE: 'C:\\Users\\Tester',
    }
    const shim = 'C:\\Users\\Tester\\AppData\\Local\\deepseek-harness\\bin'
    expect(windowsPathListContains(`C:\\Windows;${shim}`, shim)).toBe(true)
    expect(windowsPathListContains('C:\\Windows;%LOCALAPPDATA%\\deepseek-harness\\bin', shim)).toBe(
      false,
    )
    const expandedRegistryPath = registryValue(
      '    Path    REG_EXPAND_SZ    C:\\Windows;%LOCALAPPDATA%\\deepseek-harness\\bin',
      'Path',
      env,
    )
    expect(windowsPathListContains(expandedRegistryPath, shim)).toBe(true)
    expect(windowsPathListContains('"C:\\core;bin";C:\\Windows', 'C:\\core;bin')).toBe(true)
    expect(windowsPathListContains('C:\\co"re;bi"n;C:\\Windows', 'C:\\core;bin')).toBe(true)
    expect(windowsPathListContains('C:\\Windows;C:\\Tools', shim)).toBe(false)
  })
})
