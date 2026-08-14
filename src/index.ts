/**
 * DSHACP app: the standalone ACP server composition.
 *
 * The app is a thin bridge over DSH's own configured surface (DESIGN §12):
 * the host core (registries, sandbox/approval, persistence, every
 * model-facing tool) and the agent presets are mounted by the composition
 * (`cordis.yml` + `dsh-base` + `dshacp.patch.yml`), and this plugin adds only
 * the ACP transport — the widened bridge in {@link dshacp/bridge} — plus the
 * no-op `webServer` stub the ssh plugin hard-injects. It writes nothing to
 * stdout — the bridge reserves it for JSON-RPC — and pre-creates no agents:
 * each ACP `session/new`/`session/load`/`session/resume` creates or resumes
 * one owned agent through `ctx.agents`.
 *
 * Named exports are required so the Loader retains this plugin's `Config`
 * schema (see docs/postmortem/0001 in the harness repo).
 *
 * @module dshacp
 */

import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import * as bridge from './bridge.ts'
import { pickDefined } from './options.ts'
import { provideWebServerStub } from './webserver-stub.ts'

export const name = 'dshacp'

/**
 * App config: the bridge's config, re-exported as the composition row's
 * schema (one declaration owns the surface — see {@link bridge.BridgeConfig}).
 * `provider`/`model` seed each session's model selection (absent = the
 * composition default via the agent-default-model service).
 */
export type Config = bridge.BridgeConfig

/** The row schema is the bridge's own, so the two can never drift. */
export const Config: z<Config> = bridge.Config

/**
 * Mount the DSHACP transport: the ACP bridge over the composed host core.
 * The ssh plugin hard-injects `webServer`; this process serves no HTTP, so
 * publish the no-op stub before any injector row resolves. No logger, no
 * `hmr` — stdout stays pure.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Route every structured log record to stderr: stdout is reserved for ACP
  // JSON-RPC. Cordis's default exporter only buffers, so without this the
  // bridge's diagnostics would be silently dropped.
  ctx.logger.exporter({
    colors: 3,
    export: (message) => {
      try {
        process.stderr.write(`[${message.name}] ${message.type}: ${message.args.map(String).join(' ')}\n`)
      } catch {
        // A logging failure must never corrupt the JSON-RPC stream.
      }
    },
  })
  // P2-2: the ssh plugin hard-injects `webServer`; this process serves no HTTP,
  // so publish the no-op stub before any injector row resolves.
  provideWebServerStub(ctx)
  await ctx.effect(async function* () {
    const transport = ctx.plugin(bridge, pickDefined(config, [
      'provider',
      'model',
      'approvalTimeoutMs',
      'elicitationTimeoutMs',
      'hybridFileWrites',
    ]))
    await transport
    yield transport.dispose
  }, 'dshacp.composition')
}
