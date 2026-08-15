# Phase 5 (P5) — Zed 粘贴图片 → tmp 路径 → qwenmm 理解回传

> 目标：在所有模型（含纯文本/非视觉模型）上，用户在 Zed agent panel 粘贴剪贴板图片后，
> DSHACP 自动把图片存成 `/tmp` 下的文件、把文件路径作为"链接"注入 prompt；模型按需调用
> qwenmm（`QwenLM/Qwen-MM-Plugins` 的 `api` 能力）的 `vision_chat` / `ocr` MCP 工具，拿到
> 文本描述回传。DSHACP 本身不改模型路由、不引入多模态 native image block（DeepSeek 适配器
> 是纯文本的，走不通）。
>
> 本文档 = 研究结论 + 最终设计决策 + 可照做的实现计划，供独立窗口执行。

---

## 1. 研究结论（事实，含来源）

### 1.1 ACP v1 侧：图片是怎么到达 DSHACP 的

- ACP `ContentBlock` 有 `image` 变体：`{ type: 'image', data: <base64 string>, mimeType: <string>, uri?: string|null }`，`data` 与 `mimeType` 为必填。— `node_modules/@agentclientprotocol/sdk/schema/schema.json` → `ImageContent`（行 3055）
- 图片要能被客户端（Zed）发送，agent 必须在 `initialize` 的 `agentCapabilities.promptCapabilities` 里声明 `image: true`，否则 Zed 会禁用图片粘贴。— 同上 → `PromptCapabilities`（行 5275）；`ContentBlock` 里 `image` 注释 "Requires the `image` prompt capability"（行 1772）
- 当前 DSHACP **未声明**：`src/bridge.ts:1437` 返回 `promptCapabilities: {}`；并且 `src/bridge.ts:1555` 用 `promptHasUnsupportedContent` 直接拒绝非 `text`/`resource_link` 的块。这就是"现在不能粘贴图片"的直接原因。

### 1.2 DSH 侧：为什么不能用原生多模态（改走 qwenmm 旁路）

- DSH 有原生图片通道：`ctx.attachments.saveImage()` 按内容寻址存到 `~/.dsh/attachments/`，返回不透明 `sha256:` 引用；用户消息 `ContentBlock` 有 `image` 变体 `{ type:'image', attachment: ImageAttachmentRef }`。— `node_modules/@deepseek-ai/dsh-attachment/lib/types/index.d.ts`；`node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts`（`ImageBlock`，行 54）
- **但当前默认路由 `deepseek-official`（`@deepseek-ai/dsh-llm-deepseek`）是纯文本**：序列化时 `assertTextOnly` 对任何含 image 的消息抛 `"The DeepSeek chat-completions adapter does not support image content."`。— `node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`（`assertTextOnly`）
- `read_image` 工具（`@deepseek-ai/dsh-tool-fs`）同样被路由闸门挡住：`assertImageCapableRoute` 要求当前路由 `inputModalities.includes('image')`，否则报 "switch to an image-capable model"。— `node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js`（行 890）
- 结论：**在 deepseek-official 上，模型拿不到像素**，所以"粘贴→原生 image block"或"粘贴→路径→read_image"都不可用；唯一可行的是把"看图"外包给一个视觉模型（qwenmm），只把**文本**结果回传。

### 1.3 qwenmm（QwenLM/Qwen-MM-Plugins）怎么工作

- 每个 capability = 一个 **Skill** + 一个可选 **MCP server**，安装名 `qwen-mm-plugins-<cap>`。— https://github.com/QwenLM/Qwen-MM-Plugins
- 关键区分两个能力：
  - `core`：本地读图/读视频/可视化，**返回的是像素**（`read_image` 等）。DSH 会把 MCP 返回的 image/audio/resource 块替换成 `content discarded`，所以 core 对文本模型没用。
  - `api`：云端理解（`vision_chat`、`ocr`、`grounding`、Omni 系列），**返回文本**。DSH 官方适配文档明确 "Text results from `vision_chat`, OCR, ASR, and search remain usable." —— **本方案只用 `api`**。
- `vision_chat`：对一张或多张图/视频提问，**`images`/`videos` 列表接受本地路径和 URL**，支持 `dry_run=true`。`ocr` 识别本地图文字。— https://github.com/QwenLM/Qwen-MM-Plugins/blob/main/cookbooks/api/usage.md
- `api` 需要 **DashScope**（`DASHSCOPE_API_KEY`）；VL 模型默认 `qwen3.7-plus`，可用 `model` 参数 override。
- 工具名规则（DSH 侧）：`mcp__<serverName>__<rawName>`，如 `mcp__qwen-mm-plugins-api__vision_chat`。— `node_modules/@deepseek-ai/dsh-mcp-client/lib/types/tools.d.ts`

### 1.4 qwenmm 在 DSH 里的接线方式

qwenmm 官方给了 DeepSeek Harness 的手工接线文档（已验证 `@deepseek-ai/dsh` 0.1.0-rc.6）：
- MCP 用 `dsh-mcp-client` 的 stdio 行挂载（`command: uvx`）。
- Skill 拷到 `$DSH_HOME/skills`（即 `~/.dsh/skills`）。
- **"DSH filters credential-like variables from MCP child environments"** —— 所以 `DASHSCOPE_API_KEY` 不能靠 MCP 的 `env` 传，要写进共享配置文件 `~/.qwen-mm-plugins/config`（`bash install.sh configure` 生成）。
- 兼容性："DSH 0.1.0-rc.6 preserves MCP text and structured results but replaces image, audio, and resource blocks with `content discarded`."
- 来源：https://github.com/QwenLM/Qwen-MM-Plugins/blob/main/docs/en/manual_harnesses.md （"DeepSeek Harness (developer preview)" 一节）

已核对 DSHACP 侧对应机制：
- `dsh-mcp-client` stdio 配置结构：`{ transport:'stdio', serverName, command, args, env, cwd, toolCallTimeoutMs, failOnStartupError }`，且会 scrub 父进程环境里的"凭据形状"变量。— `node_modules/@deepseek-ai/dsh-mcp-client/lib/types/index.d.ts` + `lib/index.js`
- DSHACP 已有 `forwardMcpServers`（`src/bridge.ts:659`）用同一插件把 Zed 的 `mcpServers` 挂成工具——**证明 host 层挂 `dsh-mcp-client` 行、工具进入 agent 目录这条路是通的**。但本方案按决策改走"bake 进 `cordis.yml`"，不依赖 Zed 转发。
- Skill 发现：`standard` preset 的 `skill-filesystem` 默认根包含 `~/.dsh/skills`（source `user-dsh`），所以把 Skill 放 `~/.dsh/skills/qwen-mm-plugins-api` 即自动被发现，**无需改 preset**。— `node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js`（`roots()`，行 150）
- 当前 qwenmm `api` 最新不可变 tag：**`qwen-mm-plugins-api-v1.0.3`**（`git ls-remote --tags https://github.com/QwenLM/Qwen-MM-Plugins.git` 确认）。

---

## 2. 设计决策台账（已与用户逐条确认）

| # | 决策点 | 结论 |
|---|---|---|
| Q1 | 编排方式 | **模型驱动**：桥只做"粘贴→存文件→注入路径"；qwenmm 由模型 + Skill 触发。桥接不碰 DashScope、不把 `session/prompt` 卡在云端调用上 |
| Q2 | 链接存储 | `os.tmpdir()/dshacp-<uuid>.<ext>`（绝对路径；`<ext>` 由 mime 决定） |
| Q3 | 输入策略 | 仅 `png`/`jpeg`/`webp`/`gif`；其余 mime 清晰报错；允许多图（各自一个链接）；单图上限 25MB |
| Q4/Q5 | 落点 | MCP 行 bake 进 DSHACP `cordis.yml`；Skill 拷 `~/.dsh/skills/qwen-mm-plugins-api`；DashScope key 放 `~/.qwen-mm-plugins/config` |
| Q6 | 注入格式 | `\n[用户粘贴的图片: <path> — 如需理解图片内容，请调用 qwenmm 的 vision_chat / ocr 工具]\n`，附在用户文本之后 |
| Q7 | replay 死链 | 接受死链（描述文本已持久化进会话历史，几乎不会重读原图） |
| Q8 | 失败兜底 | 自然失败：MCP 没挂 / key 缺失 → `vision_chat` 调用在工具卡里显示失败；不主动探测 |

---

## 3. 实现计划（可直接照做）

### 3.1 `src/codec.ts` —— 纯函数改动

1. `promptHasUnsupportedContent` 放行 `image`（仍拒绝 `audio` / `resource`，因为未声明相应能力）：

```ts
export function promptHasUnsupportedContent(prompt: readonly AcpContentBlock[]): boolean {
  return prompt.some(block => block.type !== 'text' && block.type !== 'resource_link' && block.type !== 'image')
}
```

2. 新增 mime→扩展名白名单（放 `codec.ts`）：

```ts
/** Accepted raster mime types → on-disk extension (P5). */
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

export function imageExtensionForMime(mimeType: string): string | undefined {
  return IMAGE_MIME_EXTENSIONS[mimeType.trim().toLowerCase()]
}
```

> `acpPromptToText` 已把非 `text`/`resource_link` 块当作 `[]` 忽略，图片块不会误入文本，无需改它；图片的抽取/存储放 bridge（下面）。

### 3.2 `src/bridge.ts` —— 声明能力 + 处理图片块

1. 新增 imports（`randomUUID`、`join` 已存在）：
   - `import { tmpdir } from 'node:os'`
   - `import { writeFile } from 'node:fs/promises'`
   - 从 `./codec.ts` 增引 `imageExtensionForMime`

2. 常量：`const MAX_PASTED_IMAGE_BYTES = 25 * 1024 * 1024`（25MB）。

3. `initialize`（约 `src/bridge.ts:1437`）把 `promptCapabilities: {}` 改为：

```ts
promptCapabilities: { image: true },
```

4. `prompt()`（约 `src/bridge.ts:1549-1568`）把"拒绝非文本 + `acpPromptToText`"这段替换为：

```ts
if (promptHasUnsupportedContent(params.prompt)) {
  throw invalidParams('only text, resource_link, and image prompt content is supported')
}

// 图片块：校验 mime → base64 解码 → 落 tmp 文件 → 收集路径。
const imageRefs: string[] = []
for (const block of params.prompt) {
  if (block.type !== 'image') continue
  const ext = imageExtensionForMime(block.mimeType)
  if (ext === undefined) {
    throw invalidParams(`unsupported pasted image type: ${block.mimeType} (supported: png/jpeg/webp/gif)`)
  }
  const data = Buffer.from(block.data, 'base64')
  if (data.length > MAX_PASTED_IMAGE_BYTES) {
    throw invalidParams(`pasted image too large: ${data.length} bytes (max ${MAX_PASTED_IMAGE_BYTES})`)
  }
  const path = join(tmpdir(), `dshacp-${randomUUID()}${ext}`)
  await writeFile(path, data)
  imageRefs.push(path)
}

const text = acpPromptToText(params.prompt) + imageRefs.map(path =>
  `\n[用户粘贴的图片: ${path} — 如需理解图片内容，请调用 qwenmm 的 vision_chat / ocr 工具]\n`,
).join('')
if (text.trim().length === 0) throw invalidParams('empty prompt')
```

   （后续 `createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })` 保持不变。）

> 说明：写入发生在 host 进程、`prompt()` 内，DSH 的文件沙箱只约束模型发起的 bash/fs 工具，不约束桥接自身的 `writeFile`，所以写 `/tmp` 不受沙箱限制。

### 3.3 `cordis.yml` —— bake qwenmm MCP 行

在 DSHACP 叶子组合里追加一行（与现有 `ssh` / `dshacp` 等行平级）：

```yaml
# P5: qwenmm 视觉理解（qwen-mm-plugins api 能力）。host 层挂载 dsh-mcp-client，
# 工具以 mcp__qwen-mm-plugins-api__* 进入每个会话的工具目录（与 forwardMcpServers
# 同一条注册路）。DashScope key 必须放 ~/.qwen-mm-plugins/config（dsh-mcp-client
# 会 scrub 子进程环境里的凭据形变量，env 注入会被滤掉）。uv/uvx 需预先安装。
- id: mcp-qwen-mm-plugins-api
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: qwen-mm-plugins-api
    transport: stdio
    command: uvx
    args:
      - '--from'
      - 'qwen-mm-plugins[api] @ git+https://github.com/QwenLM/Qwen-MM-Plugins.git@qwen-mm-plugins-api-v1.0.3'
      - 'qwen-mm-plugins-api'
    cwd: !!js process.cwd()
    failOnStartupError: false
```

> `failOnStartupError: false` 保证缺 `uvx`/key 时 DSHACP 仍能启动、只是该 MCP 工具不可用（对应 Q8 自然失败）。

### 3.4 `README.md` / `README.zh.md` —— 安装前提文档

新增一小节（或并入 Install），写明三件事：
1. `uv`/`uvx` 需安装（`curl -LsSf https://astral.sh/uv/install.sh | sh`）。
2. Skill 一次性拷贝：
   ```bash
   dsh_home=${DSH_HOME:-"$HOME/.dsh"}
   mkdir -p "$dsh_home/skills"
   # 从 tag qwen-mm-plugins-api-v1.0.3 的 checkout 拷贝：
   cp -R /path/to/qwen-mm-plugins/src/capabilities/api/skill \
     "$dsh_home/skills/qwen-mm-plugins-api"
   ```
3. DashScope key 写 `~/.qwen-mm-plugins/config`（或运行 qwenmm 仓库的 `bash install.sh configure`），不能放 Zed `mcpServers` 的 `env`。

---

## 4. 明确假设 / 待验证项（执行时逐条验证，不静默）

1. **Zed 实际发送的 mimeType**：假定 Zed 对粘贴的剪贴板图统一发 `image/png`（mac 截图是 png）。若真机发现 Zed 发 `image/tiff` 等非白名单类型，会被拒绝——届时再决定放行 or 在桥接侧转码（引入 sharp）。**这是上线前必须真机验证的头号项。**
2. **模型会主动调 `vision_chat`**：依赖 Q6 的注入提示 + qwenmm Skill 指令。若真机观察到模型不主动调，升级为强指令（Q6-C：注入"必须调用 vision_chat 描述图片后再回答"）。
3. **qwenmm tag pin**：当前 pin `v1.0.3`；升级时只改 `cordis.yml` 的 tag，并同步升级 Skill 目录。
4. **多图顺序**：所有图片标记按 wire 顺序追加在用户文本之后（Q6 约定），不与正文交错。

### 4.1 真机验证记录（2026-08-15，Zed + mac 截图）

- **项 1 通过**：Zed 实际发送 `image/png`（1568×544 mac 截图），白名单放行，tmp 落盘与标记注入均正常。
- **项 2 出现重要偏差——已修复，待复测**：
  - 真机观察：模型**优先调用 `read_image` 而非 qwenmm**。原因是本机 `~/.dsh/settings.yaml` 给 `llm-pi-ai.providers.opencode-go` 的 `modelOverrides` 声明了 `input: [text, image]`，使 `read_image` 的 `assertImageCapableRoute` 闸门放行（P5 §1.2 的"所有路由纯文本"前提在该路由上不成立）。
  - 后果：`read_image` 返回 DSH 原生 image block（attachment 引用）进入消息历史，`dsh-llm-pi-ai` 将其序列化为 `image_url` 变体，而 **Console Go 上游 schema 只接受 `text`** → `400 invalid_request_error: unknown variant 'image_url', expected 'text'`（`Internal error: turn failed: 400 …`）。
  - 修复：`~/.dsh/settings.yaml` 中 opencode-go 两个模型的 `input` 改回 `[text]`（上游本就不支持 image，声明是假能力；`dsh-llm-pi-ai` 行 827 还会在序列化前抛 `UNSUPPORTED_CONTENT` 兜底）。**待复测**：read_image 被闸门拦截后，模型是否转向 qwenmm `vision_chat`——若仍不转向，落地 Q6-C 强指令。
  - 已污染会话（历史含 image block）必须删除（本机为项目 `.sessions` 下的对应目录），任何路由都无法继续使用该历史。
- **项 2 复测（2026-08-15 第二次）**：修复生效——模型主动调用 `read_image` 被拦（"模型未声明图像输入"），并**自主转向 qwenmm `vision_chat` / `ocr`**。但工具返回 `401 - Incorrect API key`：`~/.qwen-mm-plugins/config` 中的 key（`sk-ws-` 前缀，115 字符）经 curl 实测 DashScope 兼容端点（`dashscope.aliyuncs.com/compatible-mode/v1/models`）与国际端点均 401，**key 本身无效**（config 格式与加载路径均正确）。需用户提供有效 DashScope key 写入该文件；或通过 `DASHSCOPE_BASE_URL` + 对应 key 指向其他 OpenAI 兼容 VL 服务。

---

## 5. 测试计划

- `tests/codec.test.mjs`（或现有 codec 单测）新增：
  - `promptHasUnsupportedContent` 对 `image` 返回 false、对 `audio`/`resource` 返回 true。
  - `imageExtensionForMime`：`image/png→.png`、`image/jpeg→.jpg`、`image/jpg→.jpg`、`image/webp→.webp`、`image/gif→.gif`、未知/空→`undefined`。
- e2e（可选，看 Zed 侧能否模拟 `image` 块）：现有 `tests/*.test.mjs` 用官方 `@agentclientprotocol/sdk` 客户端驱动；可构造一个含 `image` 块的 `session/prompt`，断言：不抛错、返回 stopReason、tmp 文件存在且可被 `read_image`/qwenmm 工具读到。

---

## 6. 验收清单（真机 Zed 验证）

- [ ] `dshacp` 启动 stderr 无 qwenmm MCP 崩溃（`failOnStartupError: false` 生效）。
- [ ] Zed agent panel 能粘贴图片（`promptCapabilities.image: true` 生效）。
- [ ] 粘贴后 prompt 里出现 `[用户粘贴的图片: /tmp/dshacp-xxxx.png — …]` 标记。
- [ ] `/tmp/dshacp-*.png` 文件真实落盘、可打开。
- [ ] 模型调用 `mcp__qwen-mm-plugins-api__vision_chat`（或 `ocr`），工具卡显示文本结果，模型据结果回答。
- [ ] 贴一张非白名单类型（如 SVG）→ 收到清晰报错而非崩溃。
- [ ] 多图粘贴 → 多个独立链接。
- [ ] 纯文本会话（不贴图）行为与改动前一致。

---

## 7. 参考来源

- ACP 协议 / SDK：`node_modules/@agentclientprotocol/sdk/schema/schema.json`；https://agentclientprotocol.com/protocol/content
- DSH 附件/图像通道：`node_modules/@deepseek-ai/dsh-attachment`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tool-fs`
- DeepSeek 适配器纯文本限制：`node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`
- qwenmm：https://github.com/QwenLM/Qwen-MM-Plugins ；API cookbook https://github.com/QwenLM/Qwen-MM-Plugins/blob/main/cookbooks/api/usage.md ；DSH 手工接线 https://github.com/QwenLM/Qwen-MM-Plugins/blob/main/docs/en/manual_harnesses.md
- DSHACP 现有 MCP 转发：`src/bridge.ts` `forwardMcpServers`；`node_modules/@deepseek-ai/dsh-mcp-client/lib/types/index.d.ts`
