export interface DesktopCandidate {
  readonly desktopRelease: string
  readonly desktopCommit: string
  readonly installerName: string
  readonly installerBytes: number
  readonly installerSha256: string
  readonly coreResolution: 'runtime-selected-unverified'
}

export interface PreflightPolicy {
  readonly checks: Readonly<Record<string, boolean>>
  readonly failureCodes: readonly string[]
  readonly readyForDisposableInstall: boolean
}

export interface PathInspection {
  readonly readable: boolean
  readonly exists: boolean
  readonly directory: boolean
  readonly regularFile: boolean
  readonly link: boolean
  readonly size?: number | undefined
}

export interface PreflightOptions {
  readonly installerPath?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly platform?: string | undefined
  readonly processArchitecture?: string | undefined
  readonly nativeMachine?: string | undefined
  readonly homeDirectory?: string | undefined
  readonly osRelease?: string | undefined
  readonly nodeVersion?: string | undefined
  readonly generatedAt?: string | undefined
  readonly preflightScriptSha256?: string | undefined
  readonly spawn?: ((
    command: string,
    arguments_: readonly string[],
    options: Readonly<Record<string, unknown>>,
  ) => {
    error?: Error | undefined
    status: number | null
    stdout?: string | undefined
  }) | undefined
  readonly inspectPath?: ((target: string | undefined) => Promise<PathInspection>) | undefined
  readonly readDirectory?: ((target: string) => Promise<readonly string[]>) | undefined
  readonly resolveRealPath?: ((target: string) => Promise<string>) | undefined
  readonly hashFile?: ((target: string) => Promise<string>) | undefined
  readonly exclusivePortProbe?: ((
    port: number,
  ) => Promise<Readonly<{ probeSucceeded: boolean; available: boolean }>>) | undefined
}

export interface SanitizedPreflightReceipt {
  readonly schema: string
  readonly generatedAt: string
  readonly sanitized: true
  readonly candidate: DesktopCandidate
  readonly preflight: Readonly<{ scriptSha256: string }>
  readonly host: Readonly<{
    platform: string
    processArchitecture: string
    nativeMachine: string
    osRelease: string
    nodeVersion: string
  }>
  readonly checks: Readonly<Record<string, boolean>>
  readonly readyForDisposableInstall: boolean
  readonly failureCodes: readonly string[]
  readonly probes: Readonly<Record<string, boolean>>
  readonly actions: Readonly<Record<string, false>>
  readonly unproven: Readonly<Record<string, true>>
}

export const DESKTOP_CANDIDATE: DesktopCandidate
export const DISPOSABLE_VM_ACKNOWLEDGEMENT: string

export function isStrictWindowsChildPath(parent: string, candidate: string): boolean
export function tasklistHasDesktopProcess(output: unknown): boolean
export function netstatHasListeningPort(output: unknown, port?: number): boolean
export function isNativeX64Machine(value: unknown): boolean
export function registryOutputHasDesktopRegistration(output: unknown): boolean
export function registryOutputHasDesktopAutostart(output: unknown): boolean
export function registryValue(
  output: unknown,
  valueName: string,
  env?: Readonly<Record<string, string | undefined>>,
): string | undefined
export function probeExclusiveLoopbackPort(
  port?: number,
): Promise<Readonly<{ probeSucceeded: boolean; available: boolean }>>
export function windowsPathListContains(
  value: unknown,
  expected: string,
): boolean
export function evaluatePreflightPolicy(
  facts: Readonly<Record<string, unknown>> | undefined,
): PreflightPolicy
export function collectPreflightFacts(options?: PreflightOptions): Promise<Readonly<Record<string, boolean>>>
export function createSanitizedPreflightReceipt(
  options?: PreflightOptions,
): Promise<SanitizedPreflightReceipt>
