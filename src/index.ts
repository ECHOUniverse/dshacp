/**
 * DSHACP app: the standalone ACP server composition.
 *
 * The app owns the default agent spine (llm runtime, session store, title
 * service, system prompt, tool registry, agent registry + loop, retry, jobs,
 * invariants, shell and workspace context), JSONL session persistence plus the
 * derived query index, and the {@link dshacp/bridge} transport. It writes
 * nothing to stdout — the bridge reserves it for JSON-RPC — and pre-creates no
 * agents: each ACP `session/new`/`session/load`/`session/resume` creates or
 * resumes one owned agent through `ctx.agents`.
 *
 * Named exports are required so the Loader retains this plugin's `Config`
 * schema (see docs/postmortem/0001 in the harness repo).
 *
 * @module dshacp
 */

import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionTitleService, { type Config as SessionTitleConfig } from '@deepseek-ai/dsh-session-title'
import SystemPrompt, { type Config as SystemPromptConfig } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools'
import SkillRegistry, { type Config as SkillRegistryConfig } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import * as llmRetry from '@deepseek-ai/dsh-llm-retry'
import LocalJobRegistry, { type Config as JobsConfig } from '@deepseek-ai/dsh-jobs-local'
import InvariantRegistry, { type Config as InvariantConfig } from '@deepseek-ai/dsh-invariants'
import * as sessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as agentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as scopeInvariant from '@deepseek-ai/dsh-scope/invariant'
import * as agentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import * as bashEnv from '@deepseek-ai/dsh-shell-env'
import * as workspaceContext from '@deepseek-ai/dsh-agent-instructions'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import AgentLoop, { type Config as AgentLoopConfig } from '@deepseek-ai/dsh-agent-loop'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import JsonlSessionPersistence, {
  JsonlCompressionSchema,
  type JsonlCompression,
} from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as sessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import * as bridge from './bridge.ts'

export const name = 'dshacp'
const DEFAULT_PERSISTENCE_ROOT = './.sessions'

/** Overridable example policy used when a bundle consumer omits `sessionTitle`. */
const EXAMPLE_SESSION_TITLE_CONFIG: SessionTitleConfig = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
}

/** Skill bundle config forwarded to the registry, local provider, and model-facing consumer. */
export interface SkillConfig {
  /** Mount the bundled local skill provider and model-facing skill tool (default true). */
  enabled?: boolean
  /** Registry-level discovery cache settings. */
  registry?: SkillRegistryConfig
  /** Local filesystem skill provider settings. */
  filesystem?: SkillFileSystem.Config
  /** Model-facing skill catalog and tool settings. */
  tool?: toolSkill.Config
}

/**
 * App config: the swappable per-deployment values. `provider` and `model`
 * select each agent the bridge creates at `session/new` (absent = composition
 * defaults); `persona` is the deployment persona; `workspaceContext` is the
 * required AGENTS.md budget; `persistenceRoot` is the JSONL backend directory;
 * `approvalTimeoutMs` is the fail-closed permission timeout the bridge pushes
 * to the client.
 */
export interface Config {
  /** Provider route for ACP-created agents (defaults to the composition default). */
  provider?: string
  /** Model name for ACP-created agents (defaults to the composition default). */
  model?: string
  /** Bundled agent-loop concurrency cap; `1` is serial and omission uses its default. */
  maxParallelToolCalls?: number
  /** Deployment persona (the system-prompt plugin's `persona` config). */
  persona?: string
  /** Explicit model-facing tool order (the system-prompt plugin's `toolOrder` config). */
  toolOrder?: string[]
  /** Tool-registry config — its presentation `mode`. */
  tools?: ToolsConfig
  /** DSH home directory exposed to bash and used for local skill discovery. */
  dshHome?: string
  /** Fallback session-title limits. */
  sessionTitle?: SessionTitleConfig
  /** Directory for JSONL sessions and the derived query index. Defaults to `./.sessions`. */
  persistenceRoot?: string
  /** Write delta-chunk runs as packed storage rows (the JSONL backend's `packChunks`). Defaults to `true`. */
  packChunks?: boolean
  /** JSONL artifact encoding; defaults to checksummed Zstandard frames. */
  persistenceCompression?: JsonlCompression
  /** Controls automatic AGENTS.md/CLAUDE.md loading; configure a byte budget or set `false`. */
  workspaceContext: workspaceContext.Config | false
  /** Skill registry, local-provider, and model-facing consumer config. */
  skills?: SkillConfig
  /** Model-facing bash tool config forwarded through the spine. */
  toolBash?: toolBash.Config | false
  /** Process-local background-job admission config. */
  jobs?: JobsConfig
  /** Generic background-job controls; set false to keep the job service without model-facing job tools. */
  toolJobs?: toolJobs.Config | false
  /** Global enablement and package-name filters for invariant companions. */
  invariants?: InvariantConfig
  /** How long a pushed permission request waits for the client before rejecting (fail-closed). */
  approvalTimeoutMs?: number
}

/** The skill config schema exported for app packages that forward `skills`. */
export const SkillConfigSchema: z<SkillConfig> = z.object({
  enabled: z.boolean().default(true),
  registry: SkillRegistry.Config,
  filesystem: SkillFileSystem.Config,
  tool: toolSkill.Config,
})

/** The session-title config schema with the shared bundle's overridable example limits. */
export const SessionTitleConfigSchema: z<SessionTitleConfig> = SessionTitleService.Config
  .default(EXAMPLE_SESSION_TITLE_CONFIG)

/** The bash-tool config schema exported for app packages that forward `toolBash`. */
export const ToolBashConfigSchema: z<toolBash.Config | false> =
  z.union([z.const(false), toolBash.Config])

/** The process-local job registry schema exported for app packages that forward `jobs`. */
export const JobsConfigSchema: z<JobsConfig> = LocalJobRegistry.Config

/** The job-control-tool config schema exported for app packages that forward `toolJobs`. */
export const ToolJobsConfigSchema: z<toolJobs.Config> = toolJobs.Config

export const Config: z<Config> = z.object({
  provider: z.string(),
  model: z.string(),
  maxParallelToolCalls: z.number().step(1).min(1),
  persona: z.string(),
  // The array default is forced to undefined: ABSENT means "lexicographic
  // order" (the owning dsh-system-prompt schema does the same), while
  // schemastery's native [] default would read as an invalid configured list.
  toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  tools: ToolRuntime.Config,
  dshHome: z.string(),
  sessionTitle: SessionTitleConfigSchema,
  persistenceRoot: z.string().default(DEFAULT_PERSISTENCE_ROOT),
  packChunks: z.boolean().default(true),
  persistenceCompression: JsonlCompressionSchema,
  workspaceContext: z.union([z.const(false), workspaceContext.Config]).required(),
  skills: SkillConfigSchema,
  toolBash: ToolBashConfigSchema,
  jobs: JobsConfigSchema,
  toolJobs: z.union([z.const(false), ToolJobsConfigSchema]),
  invariants: InvariantRegistry.Config,
  approvalTimeoutMs: z.natural(),
})

/**
 * Copy the spine-owned fields from an app config without leaking entry-point
 * settings. Absent optional fields stay absent so owner schemas apply defaults.
 */
function pickSpineConfig(config: Config): Omit<Config, 'provider' | 'model' | 'persistenceRoot' | 'packChunks' | 'persistenceCompression' | 'approvalTimeoutMs'> {
  return {
    ...config.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: config.maxParallelToolCalls } : {},
    ...config.persona !== undefined ? { persona: config.persona } : {},
    ...config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : {},
    ...config.tools !== undefined ? { tools: config.tools } : {},
    ...config.dshHome !== undefined ? { dshHome: config.dshHome } : {},
    ...config.sessionTitle !== undefined ? { sessionTitle: config.sessionTitle } : {},
    workspaceContext: config.workspaceContext,
    ...config.skills !== undefined ? { skills: config.skills } : {},
    ...config.toolBash !== undefined ? { toolBash: config.toolBash } : {},
    ...config.jobs !== undefined ? { jobs: config.jobs } : {},
    ...config.toolJobs !== undefined ? { toolJobs: config.toolJobs } : {},
    ...config.invariants !== undefined ? { invariants: config.invariants } : {},
  }
}

/**
 * Load the spine. Each `ctx.plugin(...)` mounts one child of the bundle fiber;
 * `agent-loop` receives no pre-created agents (the bridge creates them on
 * demand) and `system-prompt` the forwarded `persona` and `toolOrder`.
 * The composite effect unloads in reverse order, keeping checkpoint and
 * persistence listeners attached until bridge agents have flushed their
 * closing events. No logger, no `hmr` — stdout stays pure.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const persistenceRoot = config.persistenceRoot ?? DEFAULT_PERSISTENCE_ROOT
  const spineConfig = pickSpineConfig(config)
  await ctx.effect(async function* () {
    const spine = ctx.plugin(spineComposition, spineConfig)
    await spine
    yield spine.dispose
    const persistence = ctx.plugin(JsonlSessionPersistence, {
      root: persistenceRoot,
      ...config.packChunks !== undefined ? { packChunks: config.packChunks } : {},
      ...(config.persistenceCompression === undefined ? {} : { compression: config.persistenceCompression }),
    })
    await persistence
    yield persistence.dispose
    const checkpoint = ctx.plugin(sessionCheckpointPolicy)
    await checkpoint
    yield checkpoint.dispose
    const query = ctx.plugin(SqliteSessionQueryEngine, { path: join(persistenceRoot, 'session-query.db') })
    await query
    yield query.dispose
    const transport = ctx.plugin(bridge, {
      ...config.provider !== undefined ? { provider: config.provider } : {},
      ...config.model !== undefined ? { model: config.model } : {},
      ...config.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: config.approvalTimeoutMs } : {},
    })
    await transport
    yield transport.dispose
  }, 'dshacp.composition')
}

/** The default executor-less, UI-less agent spine (adapted from agent-spine-demo). */
const spineComposition = {
  name: 'dshacp-spine',
  async apply(spineCtx: Context, config: ReturnType<typeof pickSpineConfig>): Promise<void> {
    const nestedDshHome = config.skills?.filesystem?.dshHome
    if (config.dshHome !== undefined && nestedDshHome !== undefined
      && resolveDshHome(config.dshHome) !== resolveDshHome(nestedDshHome)) {
      throw new Error('dshacp: dshHome and skills.filesystem.dshHome must resolve to the same directory')
    }
    const dshHome = resolveDshHome(config.dshHome ?? nestedDshHome)

    spineCtx.plugin(Timer)
    spineCtx.plugin(LlmRuntime)
    spineCtx.plugin(SessionStore)
    spineCtx.plugin(SessionTitleService, config.sessionTitle ?? EXAMPLE_SESSION_TITLE_CONFIG)
    // Owner schemas resolve defaults; forward toolOrder only when explicitly set.
    spineCtx.plugin(SystemPrompt, {
      includeHarnessIdentity: true,
      includeRuntimeContext: true,
      persona: config.persona ?? '',
      ...config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : {},
    })
    spineCtx.plugin(ToolRuntime, config.tools ?? {})
    const skillsEnabled = config.skills?.enabled ?? true
    if (skillsEnabled) {
      spineCtx.plugin(SkillRegistry, config.skills?.registry ?? {})
      spineCtx.plugin(SkillFileSystem, Object.assign({}, config.skills?.filesystem, { dshHome }))
    }
    spineCtx.plugin(AgentRegistry)
    spineCtx.plugin(llmRetry)
    spineCtx.plugin(LocalJobRegistry, config.jobs ?? {})
    spineCtx.plugin(InvariantRegistry, config.invariants ?? {})
    spineCtx.plugin(sessionInvariant)
    spineCtx.plugin(agentInvariant)
    spineCtx.plugin(scopeInvariant)
    spineCtx.plugin(agentLoopInvariant)
    if (config.toolBash !== false) {
      spineCtx.plugin(bashEnv, { dshHome })
      spineCtx.plugin(toolBash, config.toolBash ?? {})
    }
    if (config.workspaceContext !== false) {
      spineCtx.plugin(workspaceContext, config.workspaceContext)
    }
    // Both plugins prepend session-prefix messages. Registration order is the
    // rendered order, so workspace instructions must precede the skill catalog.
    if (skillsEnabled) spineCtx.plugin(toolSkill, config.skills?.tool ?? {})
    if (config.toolJobs !== false) spineCtx.plugin(toolJobs, config.toolJobs ?? {})
    spineCtx.plugin(AgentLoop, {
      agents: [] satisfies AgentLoopConfig['agents'],
      ...config.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: config.maxParallelToolCalls } : {},
    })
  },
}
