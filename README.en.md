# DSHACP — Use DeepSeek inside Zed

> DSHACP is a **plugin** for DeepSeek Harness (DSH). Once installed, you can chat
> with DeepSeek directly inside the [Zed](https://zed.dev) editor and have it read
> files, write code, and run commands for you.

[中文](README.md)

---

## What is this? (30-second version)

In one sentence: **DSHACP is the "translator" between Zed and DeepSeek.**

```
You (typing questions in Zed)
        │
        ▼
   Zed editor (agent panel)
        │   ← talks over the ACP protocol
        ▼
   dsh --profile dshacp (DSH with the DSHACP plugin)
        │
        ▼
   DeepSeek (the model that actually answers and writes code)
```

Out of the box, Zed knows how to talk to Claude, GPT, and a few others. Once you
add the DSHACP plugin to DSH, Zed gains a new **external agent** named **DSH**,
backed by DeepSeek.

## What you get after installing

- Chat with DeepSeek right inside Zed; replies stream in word by word
- Let it read files, write code, and run commands — every action is visible
- Before it does anything risky (like editing a file), it asks "allow?"
- Conversations are saved automatically and can be resumed later

## How is this different from official `dsh --profile acp`?

Since DSH 0.1.2, npm ships both **`@deepseek-ai/dsh-acp`** (`dsh --profile acp`) and this plugin
**`@hanxu131/dshacp`** (`dsh --profile dshacp`). Both speak ACP v1 over stdio, but they target
different jobs — **do not install both bridges into the same profile**.

| | Official `@deepseek-ai/dsh-acp` | DSHACP (this plugin) |
|---|---|---|
| **Launch** | `dsh --profile acp` | `dsh --profile dshacp` |
| **Audience** | CI, scripts, automation pipelines | Interactive ACP clients such as [Zed](https://zed.dev) |
| **Sessions** | Basic `new` / `prompt` / `cancel` | Full lifecycle: `list` / `load` / `resume` / `delete` / `close` |
| **Streaming** | Mostly turn-level text | **Token-level** `assistant/chunk`, reasoning, tool I/O |
| **Approval** | Minimal | Pushes `request_permission` to the client (allow once / always) |
| **Config** | None | Zed panel: **model / thinking / permission / mode** (agent presets) |
| **Extras** | None | Slash commands, plans, `ask_user_question` (elicitation), HTTP MCP forwarding, optional hybrid file writes |
| **Install** | Bundled with official profile | `dsh plugin --profile dshacp add @hanxu131/dshacp` |

In short: **official ACP is deliberately narrow for machines; DSHACP is a widened bridge for humans in Zed.**

```
Zed ──ACP──► dsh --profile dshacp ──► @hanxu131/dshacp (this plugin)

CI  ──ACP──► dsh --profile acp  ──► @deepseek-ai/dsh-acp (official — keep separate)
```

---

## Before you start: two things you need

### 1. DeepSeek Harness (DSH) installed

Open a terminal and run:

```sh
dsh --version
```

If it prints a version number, DSH is ready. If it says `command not found`,
install DSH first:

```sh
npm install -g @deepseek-ai/dsh
```

> The DeepSeek API key is configured on the DSH side by the maintainer — you
> don't need to worry about it in this tutorial.

### 2. The Zed editor

Download and install it from <https://zed.dev>. This plugin only works with Zed.

---

## Step 1: Install the DSHACP plugin

In a terminal, run this one command:

```sh
dsh plugin --profile dshacp add @hanxu131/dshacp
```

> First-time installs fetch the latest version (`latest`) directly — no version
> number needed.

### Updating to a newer version

If you already installed it and want to upgrade, **prefer the `update` command**
(no version number needed):

```sh
dsh plugin --profile dshacp update @hanxu131/dshacp
```

For this to work reliably, **permanently disable the release-age gate** in the
profile's `pnpm-workspace.yaml` by adding one line:

```sh
# open ~/.dsh/profiles/dshacp/pnpm-workspace.yaml, add below the autoInstallPeers line:
minimumReleaseAge: 0
```

> Without this line, a version released only recently (pnpm's default
> "minimum release age" is a few days) gets blocked by supply-chain gating and
> `update` wrongly reports `Already up to date`. Setting it to `0` disables the
> gate permanently, so `update` always fetches the latest version.

After upgrading, **quit and reopen the DSH session in Zed** (or restart the
`dsh --profile dshacp` process) so the new code is actually loaded.

> Alternative: if you'd rather not edit the config, you can pin the version
> explicitly — `dsh plugin --profile dshacp add "@hanxu131/dshacp@^0.2.0"`. But
> because of pnpm's lock behavior, `update` is the easier day-to-day choice.

### Migrating from the old `acp` profile (0.2.0+)

Since DSH 0.1.2, official `dsh --profile acp` is reserved for `@deepseek-ai/dsh-acp`
(automation-only ACP). DSHACP uses its own profile **`dshacp`** — do not install both
bridges into the same profile.

If you previously installed into `~/.dsh/profiles/acp`:

```sh
dsh plugin --profile acp remove @hanxu131/dshacp
dsh plugin --profile dshacp add @hanxu131/dshacp
```

Then change Zed's `"args": ["--profile", "acp"]` to `"dshacp"` and restart the DSH session.

Breaking it down:

- `dsh plugin` = use DSH's plugin manager
- `--profile dshacp` = install into a profile named `dshacp` (created automatically if missing)
- `add @hanxu131/dshacp` = install the DSHACP plugin

**How to know it worked**: the command finishes without `error`, ending with
something like `Done in Xs`.

> To double-check, run `dsh --profile dshacp --dump-config` — you should see
> `dshacp`-related config rows in the output.

**Remote SSH is optional** and not included by default. If you want it, add one
more plugin:

```sh
dsh plugin --profile dshacp add @linxin666/dsh-ssh
```

## Step 2: Add DSH to Zed

1. Open Zed and press `Cmd + ,` (macOS) or `Ctrl + ,` to open **Settings**.
2. Find **AI** → **External Agents** in the sidebar.
3. Click **Add Custom Agent** and paste the following:

```jsonc
{
  "agent_servers": {
    "DSH": {
      "type": "custom",
      "command": "dsh",
      "args": ["--profile", "dshacp"],
      "env": {}
    }
  }
}
```

> Here `command` is `dsh` (not `dshacp`): Zed launches `dsh --profile dshacp`, which
> boots the profile we just installed. Leave `env` empty.

**How to know it worked**: an option named **DSH** appears in Zed's agent list.

## Step 3: Start your first conversation

1. Open Zed's agent panel (usually on the right side).
2. In the agent/model dropdown, pick **DSH** (not Claude/GPT).
3. Type something simple, like:

> Hi, tell me what you can do.

**How to know it worked**:

- The reply streams in word by word (not all at once)
- When it wants to perform an action, an "allow / deny" confirmation pops up

If it gets stuck, see "Troubleshooting" below.

---

## Troubleshooting

### 1. `command not found: dsh`

DSH isn't installed. Go back to "Before you start" item 1 and run
`npm install -g @deepseek-ai/dsh`. If you use a version manager like nvm, **open a
new terminal window** and try again.

### 2. It errors out with a missing key / 401 as soon as a conversation starts

The key is configured on the DSH side (the maintainer's responsibility), not by
this plugin — ask the maintainer to add the DeepSeek API key to DSH.

### 3. You click "allow", but nothing happens

- Make sure you selected the **DSH** agent in Zed
- Open Zed's command palette and run `dev: open acp logs` to look for errors

### 4. Your conversations disappear after switching projects

Conversations are saved under a `.sessions` folder in the **current project
directory** (a new project = a new set of conversations). To store them all in
one place, set the `DSH_SESSIONS_ROOT` environment variable (see below).

### 5. Re-running `add` doesn't upgrade to the new version

This is **pnpm's version-locking / release-age gating**, not a mistake in the command:

- `dsh plugin add` wraps pnpm's `add`. Once the profile's `pnpm-lock.yaml` has
  pinned a version, `add` **won't jump to a newer version** even if one exists on
  npm — it just prints `Already up to date`.
- Versions younger than pnpm's "minimum release age" (a few days by default) are
  also blocked by supply-chain gating, so `update` shows `Already up to date`
  too.

**Recommended fix: disable the gate permanently and use `update`** (see
"Step 1 → Updating to a newer version"). Add `minimumReleaseAge: 0` to
`~/.dsh/profiles/dshacp/pnpm-workspace.yaml`, then the upgrade command is simply:

```sh
dsh plugin --profile dshacp update @hanxu131/dshacp
```

If you'd rather not edit the config, pin the version explicitly instead (profile
`acp`, package `@hanxu131/dshacp`, upgrading `0.1.3` → `0.1.4`):

```sh
# ✅ Works ad hoc: pin the target range explicitly
dsh plugin --profile dshacp add "@hanxu131/dshacp@^0.1.4"

# ❌ Does NOT work: no version, or only @latest — both are blocked by locking/gating
dsh plugin --profile dshacp add @hanxu131/dshacp
dsh plugin --profile dshacp add "@hanxu131/dshacp@latest"
```

After upgrading, **restart the DSH session in Zed** (or restart the
`dsh --profile dshacp` process) so the new code takes effect.

---

## Advanced: for those who want to dig deeper

<details>
<summary>Expand (environment variables, model selection, standalone binary, building from source, protocol details, …)</summary>

### Environment variables

| Variable | Effect |
|---|---|
| `DSH_SESSIONS_ROOT` | Where sessions are stored (default `./.sessions`) |
| `DSH_PERMISSION_MODE` | `workspace-write` (default, shows confirmations) or `danger-full-access` (no confirmations) |
| `DSHACP_HYBRID` | Set to `1` to enable hybrid mode: file writes are delegated to Zed as reviewable diffs |

### Choosing model / thinking strength / permissions / mode in Zed

Once installed, you can pick **model**, **thinking strength**, **Permissions**, and
**mode** directly in Zed's DSH panel. You can also pin defaults in the config (the
example below is illustrative — use whatever the panel actually shows):

```jsonc
"DSH": {
  "type": "custom",
  "command": "dsh",
      "args": ["--profile", "dshacp"],
  "env": {},
  "default_config_options": {
    "model": "deepseek-official:deepseek-v4-pro",
    "thought_level": "high",
    "permission": "workspace-write"
  }
}
```

The `model` value is `provider:model`; a bare model id also works and resolves
to the provider that owns it.

**Permissions** (`permission`) controls the sandbox and approval policy. Typical values:

- `workspace-write` (default): sandbox restricts writes outside the workspace; sensitive operations prompt for confirmation
- `danger-full-access`: no sandbox restrictions and no confirmation prompts

**mode** is the agent preset (tooling / skill set) and is separate from **Permissions**; do not confuse it with the ACP doc example where a `mode` option controls permission behavior.

### Install as a standalone binary (alternative, no DSH profile)

If you'd rather not use a DSH profile, you can install the standalone `dshacp`
command instead:

```sh
npm install -g @hanxu131/dshacp
```

Then in Zed set `command` to `dshacp` with an empty `args`. The functionality is
identical to the plugin method.

### Build from source (for developers)

```sh
git clone git@github.com:ECHOUniverse/dshacp.git
cd dshacp
npm install
npm run build   # compile TypeScript
npm test        # run tests
```

### Link a local build into the DSH dshacp profile (for developers)

**Do not `npm link` the source tree** — it pulls the repo's `node_modules/` into the
profile, which duplicates Cordis plugins (`deployment:persona already registered`)
or breaks imports (`schemastery not found`).

From the repo root:

```sh
./scripts/dev-link-dsh-profile.sh   # build → npm pack → install into ~/.dsh/profiles/dshacp
```

After code changes, re-run that script and **restart your Zed DSH session**. To restore
the registry release:

```sh
./scripts/dev-unlink-dsh-profile.sh
```

### Optional features

- **Paste a screenshot for DeepSeek to read**: after installing `uv`/`uvx` and the
  qwenmm plugin, you can paste screenshots into Zed for the model to "see". See
  `docs/P5-image-paste-qwenmm.md`.
- **Remote SSH**: `dsh plugin --profile dshacp add @linxin666/dsh-ssh`.
- **Hybrid mode**: `DSHACP_HYBRID=1` — file edits appear as reviewable diffs.

### ACP surface (protocol layer, for developers)

- Client → server: `initialize`, `session/new`, `session/load`, `session/resume`,
  `session/list`, `session/delete`, `session/close`, `session/set_config_option`,
  `session/prompt`, `session/cancel`
- Server → client: `session/request_permission`, `session/request_elicitation`,
  `session/update`
- Intentionally not implemented: `authenticate`/`logout`, `session/set_mode`,
  `fs/*`, `terminal/*`

### Layout (for contributors)

- `src/bin.ts` — entry point for the standalone binary
- `src/index.ts` — app plugin (the ACP bridge)
- `src/bridge.ts` — ACP v1 bridge (sessions, streaming, approval, …)
- `src/codec.ts` — codecs
- `cordis.yml` / `cordis.patch.yml` / `dshacp.patch.yml` — composition config
  (`cordis.patch.yml` is the layer applied by the plugin install)
- `tests/` — tests

</details>

---

## Further reading

- Design & implementation plan: [`docs/DESIGN.md`](docs/DESIGN.md)
- Research notes: the `*-fact-sheet.md` files under `docs/`
- Zed external-agents docs: <https://zed.dev/docs/ai/external-agents>
- ACP protocol: <https://agentclientprotocol.com>

## License

MIT — see [`LICENSE`](LICENSE).
