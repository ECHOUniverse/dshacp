/**
 * Minimal no-op `webServer` service for the standalone ACP composition.
 *
 * `@linxin666/dsh-ssh` hard-injects `webServer` to register its `/api/dsh-ssh`
 * route family and the terminal WebSocket upgrade. This process serves no
 * HTTP — stdout carries ACP JSON-RPC only — so the bridge provides a stub that
 * accepts and discards registrations. The SSH engine, its model tools
 * (ssh_list/ssh_exec/ssh_upload/ssh_download/ssh_tunnel/ssh_cluster), and the
 * system-prompt announcement all work normally; host management and the web
 * terminal remain in the DSH web app (P2-2).
 *
 * @module dshacp/webserver-stub
 */

import type { Context } from '@deepseek-ai/cordis'

/** Structural stand-in for the `webServer` service (dsh-host-webserver). */
export interface WebServerStub {
  register(_route: unknown): () => void
  registerUpgrade(_route: unknown): () => void
  registerFallback(_handler: unknown): () => void
}

/** A registration sink that keeps nothing: every handler is dropped. */
export function createWebServerStub(): WebServerStub {
  const noop = (): (() => void) => () => {}
  return {
    register: noop,
    registerUpgrade: noop,
    registerFallback: noop,
  }
}

/**
 * Mount the stub under the `webServer` service key. Must run before any row
 * that injects `webServer` resolves (Cordis holds those entries until the
 * service appears).
 * @param ctx - the app composition context.
 */
export function provideWebServerStub(ctx: Context): void {
  ctx.provide('webServer', createWebServerStub() as never)
}
