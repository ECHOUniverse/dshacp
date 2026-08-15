# DSHACP — 面向 Zed 的 DeepSeek Harness ACP v1 服务端

Zed（agent 面板，ACP v1 stdio 客户端）→ **dshacp**（独立 agent spine）→ DSH 核心服务。

`dshacp` 是一个独立的 DSH 应用二进制，通过换行分隔的 JSON-RPC stdio 使用
**Agent Client Protocol（ACP）v1 稳定版**通信，对外暴露 DSH 的完整核心闭环，
让 Zed 成为 DSH 的一等前端：

- 令牌级流式输出（`agent_message_chunk`，每个 text delta 一条）与思考过程
  （`agent_thought_chunk`）
- 工具调用与结果（`tool_call` / `tool_call_update`，含 ACP `kind` 映射）
- 由 `todo_write` 生成的计划更新（`plan`）与累计用量（`usage_update`）
- 审批推送到客户端（`session/request_permission`，含 `allow_once` /
  `allow_always` / `reject_once`；超时或断连时 fail-closed 拒绝；
  `allow_always` 会在会话内记住该工具）
- 完整的会话管理：`session/new`、`session/load`（恢复 + 全量历史回放）、
  `session/resume`、`session/list`（标题来自 DSH 会话标题服务）、
  `session/delete`、`session/close`、`session/cancel`
- 委托运行的结构化可见性：workflow 与 subagent 运行以 `plan` 更新呈现
- 远程 SSH 运维（ssh_list / ssh_exec / ssh_upload / ssh_download /
  ssh_tunnel / ssh_cluster），复用 `~/.dsh/dsh-ssh.json`
- 可选混合模式（`DSHACP_HYBRID=1`）：当客户端声明支持时，`write` 工具委托给
  Zed 的 `fs/write_text_file`，文件编辑以逐块可审查的 diff 呈现

设计与实现计划：[`docs/DESIGN.md`](docs/DESIGN.md)。
研究事实清单：[`ACP-fact-sheet.md`](ACP-fact-sheet.md)、
[`docs/zed-acp-integration-fact-sheet.md`](docs/zed-acp-integration-fact-sheet.md)、
[`docs/DSH-extension-facts.md`](docs/DSH-extension-facts.md)。

## 安装

```sh
npm install
npm run build        # tsc → lib/
npm test             # 单元 + 端到端协议测试（prompt 测试需要模型密钥）
```

bin 名为 `dshacp`（通过 `npm link` 或包内 `bin` 使用）。它会启动自己随附的
`cordis.yml` 组合——agent spine（llm、sandbox、tools、approval、subagent、
workflow）、JSONL 会话持久化与 ACP bridge——并复用 `~/.dsh` 配置（凭据、
设置）。无 stdout 日志器、无 HMR：stdout 只承载 JSON-RPC，诊断信息全部走
stderr。

### 粘贴图片理解（P5，可选）

在 Zed agent 面板粘贴截图开箱即用：桥接声明 `image` prompt 能力，接受
png/jpeg/webp/gif（单张 ≤ 25 MB），把每张图写到 `/tmp/dshacp-<uuid>.<ext>`
文件，并把路径以文本标记注入 prompt。由于默认 DeepSeek 路由是纯文本的，
"看图"外包给 **qwenmm**（`QwenLM/Qwen-MM-Plugins` 的 `api` 能力）：其
`vision_chat` / `ocr` 工具返回文本，模型据此作答。需要三步准备：

1. 安装 `uv` / `uvx`（MCP server 通过 `uvx` 运行）：
   `curl -LsSf https://astral.sh/uv/install.sh | sh`
2. 一次性拷贝 qwenmm `api` skill —— `~/.dsh/skills` 下的 skill 会被自动发现
   （从 tag `qwen-mm-plugins-api-v1.0.3` 的 checkout 拷贝）：
   ```sh
   dsh_home=${DSH_HOME:-"$HOME/.dsh"}
   mkdir -p "$dsh_home/skills"
   cp -R /path/to/qwen-mm-plugins/src/capabilities/api/skill \
     "$dsh_home/skills/qwen-mm-plugins-api"
   ```
3. 把 DashScope key 写进 `~/.qwen-mm-plugins/config`（运行 qwenmm 仓库的
   `bash install.sh configure`，或直接写该文件）。**不要**放在 Zed
   `mcpServers` 的 `env` 里——DSH 会过滤 MCP 子进程环境中的凭据形变量。

MCP 行已 bake 进 `cordis.yml`，且 `failOnStartupError: false`：缺 `uvx` /
key 时 `dshacp` 照常启动，只是视觉工具在工具卡中失败、模型会报告无法读图。

## Zed 配置

`settings.json` → AI → External Agents → Add Custom Agent：

```jsonc
{
  "agent_servers": {
    "DSH": {
      "type": "custom",   // 必填
      "command": "dshacp",
      "args": [],
      "env": {}           // 密钥来自 ~/.dsh，不写在这里
    }
  }
}
```

Zed 以 `cwd` = 项目根目录启动 `dshacp`，通过 stdio 使用换行分隔的 JSON-RPC
通信。服务端为每个 ACP 会话创建一个 DSH agent，作用域为该 `cwd`，并把会话
持久化到项目根目录的 `./.sessions` 下（可用 `DSH_SESSIONS_ROOT` 覆盖）。

凭据：DeepSeek 适配器从 `~/.dsh/.credentials.yaml`（或环境变量）读取
`DEEPSEEK_API_KEY`。Zed 不会为自定义 agent 注入任何密钥。

### 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_SESSIONS_ROOT` | 会话持久化目录（默认 `./.sessions`） |
| `DSH_PERMISSION_MODE` | `workspace-write`（默认）或 `danger-full-access`（审批策略变为 `never`） |
| `DEEPSEEK_API_KEY` | `~/.dsh/.credentials.yaml` 缺失时的 API 密钥 |
| `DSHACP_HYBRID` | `1` 开启 P3 混合模式：当客户端声明 `fs/write_text_file` 时，`write` 委托给客户端（Zed diff 审查） |

## ACP 能力面

客户端 → agent：`initialize`、`session/new`、`session/load`、`session/resume`、
`session/list`、`session/delete`、`session/close`、`session/prompt`、
`session/cancel`（通知）。

Agent → 客户端：`session/request_permission`、`session/update`。

刻意不实现：`authenticate`/`logout`（`authMethods: []`）、`session/set_mode`
（不宣告任何模式）、`fs/*` 与 `terminal/*`（DSH 自包含执行；文件编辑以
工具调用卡片呈现）。

## 目录结构

- `src/bin.ts` — 启动入口（`dsh-app-boot`），默认使用随附的 `cordis.yml`
- `src/index.ts` — 应用组合：agent spine + 持久化 + bridge
- `src/bridge.ts` — 扩展版 ACP v1 bridge（会话记录、流式、审批）
- `src/codec.ts` — stopReason / 工具 kind / 计划 / prompt 编解码
- `cordis.yml` — 部署组合（适配器、sandbox、approval、subagent、workflow、
  fs、todo、持久化、qwenmm MCP 客户端）
- `tests/` — 编解码单元测试 + 完整的端到端协议测试（像 Zed 一样使用官方
  `@agentclientprotocol/sdk` 客户端通过 stdio 驱动）
