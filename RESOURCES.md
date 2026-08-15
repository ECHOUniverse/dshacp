# RESOURCES — 学习资源清单

> 这些是高质量的一手资料，教学会以它们为准，而不是我的记忆。

## 本项目自有资料（最重要的起点）

- **`README.md`（中文）/ `README.en.md`（英文）** — 项目本身的安装、Zed 配置、环境变量说明。第一课照这个做。
- **`docs/DESIGN.md`** — 完整设计与实现计划，含 §8 Zed 配置、§7 审批桥、§9 验收标准。
- **`tests/bridge.e2e.test.mjs`** — 端到端测试，展示了"像 Zed 一样"用 SDK 客户端驱动 dshacp 的完整对话流程（流式、审批、回放……）。测试就是最好的行为说明书。

## Zed 官方文档（权威）

- Zed 外部代理（External Agents）配置与原理：
  https://zed.dev/docs/ai/external-agents
- Zed Agent Panel（对话面板怎么用、新线程、Threads 侧栏）：
  https://zed.dev/docs/ai/agent-panel
- Zed AI 设置总览（Settings → AI 下各项的含义）：
  https://zed.dev/docs/ai/agent-settings
- ACP 调试日志（`dev: open acp logs`）：
  https://zed.dev/docs/ai/external-agents#debugging

## ACP 协议官方资料（理解原理）

- 协议主页与文档：https://agentclientprotocol.com
- v1 初始化与能力协商：https://agentclientprotocol.com/protocol/v1/initialization
- v1 会话设置（session/new、load、resume）：https://agentclientprotocol.com/protocol/v1/session-setup
- v1 prompt 回合与流式输出：https://agentclientprotocol.com/protocol/v1/prompt-turn
- v1 工具调用与权限请求：https://agentclientprotocol.com/protocol/v1/tool-calls
- v1 取消（session/cancel）：https://agentclientprotocol.com/protocol/v1/cancellation

## 排查用

- 本机 dshacp 服务端日志：运行 dshacp 的终端 stderr
- `~/.dsh/.credentials.yaml` — DeepSeek API 密钥（dshacp 复用它）
- `~/.dsh/dsh-ssh.json` — SSH 主机配置（如果要用 ssh 工具）
