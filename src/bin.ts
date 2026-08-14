#!/usr/bin/env node
/**
 * Boot the DSHACP ACP v1 stdio server. Usage: `dshacp [--config path]`.
 *
 * The default config is the `cordis.yml` shipped inside this package (found
 * relative to this bin), so Zed can launch `dshacp` from any project root with
 * no per-project configuration; `--config` overrides it. The process
 * composition is three layers (DESIGN §12): the leaf config below, the
 * `dsh-base` bundle patch inserted before it (the shared host core and every
 * model-facing tool), and the shipped `dshacp.patch.yml` overlay applied
 * after it (the web-app-style disable list + DSHACP persona + persistence
 * root). Bare plugin specifiers in the base patch resolve from this package's
 * install tree (the `bareModuleBaseUrl` anchor). Shared env loading, Loader
 * guards, snapshot config selection, and settled-tree boot live in
 * dsh-app-boot. Replay skips `.env` and selects the sibling
 * `cordis.snapshot.yml` so a stray key cannot trigger a model call. EOF
 * disposes and flushes snapshot runs; the calling automation owns process
 * lifetime. Stdout is reserved for JSON-RPC, so diagnostics go only to
 * stderr.
 * @module dshacp/bin
 */

import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { boot, installFailLoud, loadEnv, loadOverlayPatches, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dshacp'
/** The shipped leaf composition, resolved relative to this built bin (`lib/bin.js` → package root). */
const SHIPPED_CONFIG = fileURLToPath(new URL('../cordis.yml', import.meta.url))
/** The shipped DSHACP overlay layer (disable list + DSHACP-owned row values). */
const SHIPPED_OVERLAY = fileURLToPath(new URL('../dshacp.patch.yml', import.meta.url))
/** The dsh-base bundle patch: the shared host core, inherited from DSH. */
const BASE_PATCH = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'))
/**
 * The shipped agent-preset compositions (`standard`/`cordis`/`code`/`minimal`),
 * owned by the dsh CLI package like the web app's shipped root. Exposed to
 * the `agent-presets` row's `!!js` expression through a boot-provided value.
 */
const SHIPPED_PRESET_ROOT = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/config/agent-presets'))

/* v8 ignore start -- thin self-executing composition over the unit-tested
   dsh-app-boot helpers; exercised end-to-end by the built-bin smoke */
installFailLoud(NAME)
const snapshotMode = process.env['DSH_SNAPSHOT']
if (snapshotMode !== 'replay') loadEnv(NAME)
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
})
if (values.help) {
  // `dshacp` is a stdio server, not an interactive CLI: Zed spawns it and
  // speaks line-delimited JSON-RPC on stdin/stdout. The only useful flags are
  // `--config` (override the shipped cordis.yml) and this help text.
  process.stdout.write(
    'dshacp — Zed-first ACP v1 server for DeepSeek Harness\n\n'
    + 'Usage: dshacp [--config <path>]\n\n'
    + '  -c, --config <path>   Cordis composition to boot (default: the cordis.yml shipped with this package)\n'
    + '  -h, --help            Show this help and exit\n\n'
    + 'This process is a stdio ACP server: it reads newline-delimited JSON-RPC\n'
    + 'from stdin and writes responses to stdout. Configure it in Zed under\n'
    + 'Settings → AI → External Agents as a custom agent with command "dshacp".\n',
  )
  process.exit(0)
}
const basePatches = loadOverlayPatches(NAME, BASE_PATCH)
const overlayPatches = loadOverlayPatches(NAME, SHIPPED_OVERLAY)
const ctx = await boot(
  NAME,
  resolveConfigPath(values.config ?? SHIPPED_CONFIG, snapshotMode),
  [...basePatches, ...overlayPatches],
  (hostCtx) => {
    // The roster's shipped root is an assembly fact of the dsh installation,
    // resolved by this bin (the same treatment apps/cli gives it).
    hostCtx.provide('shippedPresetRoot', SHIPPED_PRESET_ROOT)
  },
)
// EOF closes the ACP connection; dispose the tree (flush persistence, drain
// agents) and exit cleanly. The calling client (Zed) also owns process
// lifetime and may kill us outright — this is the graceful path.
process.stdin.on('end', () => {
  void ctx.fiber.dispose().then(() => { process.exit(0) })
})
/* v8 ignore stop */
