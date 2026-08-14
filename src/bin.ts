#!/usr/bin/env node
/**
 * Boot the DSHACP ACP v1 stdio server. Usage: `dshacp [--config path]`.
 *
 * The default config is the `cordis.yml` shipped inside this package (found
 * relative to this bin), so Zed can launch `dshacp` from any project root with
 * no per-project configuration; `--config` overrides it. Bare plugin
 * specifiers in that config resolve from the config directory (this package's
 * install tree), and the config's own `dshacp` row resolves through the same
 * ancestor walk. Shared env loading, Loader guards, snapshot config selection,
 * and settled-tree boot live in dsh-app-boot. Replay skips `.env` and selects
 * the sibling `cordis.snapshot.yml` so a stray key cannot trigger a model
 * call. EOF disposes and flushes snapshot runs; the calling automation owns
 * process lifetime. Stdout is reserved for JSON-RPC, so diagnostics go only
 * to stderr.
 * @module dshacp/bin
 */

import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dshacp'
/** The shipped composition, resolved relative to this built bin (`lib/bin.js` → package root). */
const SHIPPED_CONFIG = fileURLToPath(new URL('../cordis.yml', import.meta.url))

/* v8 ignore start -- thin self-executing composition over the unit-tested
   dsh-app-boot helpers; exercised end-to-end by the built-bin smoke */
installFailLoud(NAME)
const snapshotMode = process.env['DSH_SNAPSHOT']
if (snapshotMode !== 'replay') loadEnv(NAME)
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: 'string', short: 'c' } },
  strict: true,
})
const ctx = await boot(NAME, resolveConfigPath(values.config ?? SHIPPED_CONFIG, snapshotMode))
if (snapshotMode !== undefined) {
  process.stdin.on('end', () => {
    void ctx.fiber.dispose().then(() => { process.exit(0) })
  })
}
/* v8 ignore stop */
