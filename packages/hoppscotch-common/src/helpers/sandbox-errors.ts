import { Subject } from "rxjs"

export type SandboxErrorEvent = {
  error: string
  phase: "pre-request" | "post-request"
  experimentalSandbox: boolean
}

/**
 * Stream of scripting sandbox errors, consumed by Sentry.
 */
export const sandboxError$ = new Subject<SandboxErrorEvent>()
