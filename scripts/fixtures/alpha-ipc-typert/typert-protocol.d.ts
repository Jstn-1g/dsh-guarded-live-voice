declare module '@deepseek-ai/dsh-typert-protocol' {
  export interface TypertLookupMap {}
  export interface TypertContextMap {}
  export interface TypertRemoteMap {}
  export interface TypertRemoteScopeMap {}

  export interface RemoteFailure {
    readonly code: string
    readonly message: string
    readonly details: object
  }

  export type RemoteResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: RemoteFailure }

  export type TypertRemoteNamespace<Namespace extends string> = {
    [Endpoint in keyof TypertRemoteMap as Endpoint extends `${Namespace}/${infer Method}`
      ? Method
      : never]: TypertRemoteMap[Endpoint]
  }

  export interface TypertRemoteNamespaceMap {}

  export interface TypertRemoteContribution {
    readonly package: string
    readonly descriptors: readonly unknown[]
  }

  export abstract class TypertRemoteService {
    readonly typertRemote: {
      readonly service: TypertRemoteService
      readonly serviceKey: string
      readonly namespace: string
    }
    protected constructor(
      ctx: unknown,
      serviceKey: string,
      options?: { readonly namespace?: string },
    )
  }

  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void

  export function Remote(option: string | { readonly mode: 'stream' }):
  <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void
}
