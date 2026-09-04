/**
 * DSHACP profile startup latch: binds stdin EOF to graceful shutdown and
 * publishes readiness before the ACP bridge claims stdio. Mirrors the
 * official `@deepseek-ai/dsh-acp-app` pattern so `dsh --profile dshacp
 * --help` exits without opening the JSON-RPC transport.
 *
 * @module dshacp/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline'

export const name = 'dshacp-app-startup'

/** Service the DSHACP bridge row waits for before claiming stdio. */
export const DSHACP_APP_STARTUP_SERVICE = 'dshacpAppStartup'

/**
 * Build this app's zero-option command and help.
 * @returns a fresh program for one invocation.
 */
function dshacpCommand(): Command {
  return new Command()
    .name('dsh --profile dshacp')
    .description('Serve Zed and other ACP clients over Agent Client Protocol stdio.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Example:
  dsh --profile dshacp    serve ACP until the client disconnects
`)
}

/**
 * Accept a DSHACP profile invocation, publish readiness, and bind EOF to the
 * launcher's bounded shutdown.
 * @param ctx - plugin context carrying command-line and exit launcher values.
 */
export function apply(ctx: Context): void {
  // Standalone `dshacp` boots without a launcher cmdline snapshot; publish
  // readiness immediately so the bridge can claim stdio.
  if (ctx.cmdlineArgs === undefined) {
    ctx.provide(DSHACP_APP_STARTUP_SERVICE, { accepted: true })
    return
  }
  const program = dshacpCommand()
  program.action(() => {
    exitOnStdinEnd(ctx, 'dshacp-app.stdin')
    ctx.provide(DSHACP_APP_STARTUP_SERVICE, { accepted: true })
  })
  parseCmdline(ctx, program)
}
