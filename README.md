# DSHACP — 让 Zed 用上 DeepSeek

> DSHACP 是 DeepSeek Harness（DSH）的一个**插件**。装好之后，你就能在
> [Zed](https://zed.dev) 编辑器里直接和 DeepSeek 对话、让它帮你读文件、写代码、跑命令。

[English](README.en.md)

---

## 这是什么？（先花 30 秒看懂）

一句话：**DSHACP 是 Zed 和 DeepSeek 之间的"翻译官"。**

```
你（在 Zed 里打字提问）
        │
        ▼
   Zed 编辑器（代理面板）
        │   ← 用 ACP 协议对话
        ▼
   dsh --profile acp（装了 DSHACP 插件的 DSH）
        │
        ▼
   DeepSeek（真正回答问题、写代码的大模型）
```

Zed 自带的是 Claude、GPT 等模型的连接方式。给 DSH 装上 DSHACP 插件之后，Zed 会
多出一个叫 **DSH** 的"外部代理"，它背后就是 DeepSeek。

## 装好之后，你能干什么

- 在 Zed 里直接问 DeepSeek，回答像打字机一样逐字流出来
- 让它读文件、写代码、跑命令，每一步操作都能在界面上看到
- 它要做有风险的操作（比如改文件）时，会先弹窗问你"允许吗"
- 对话自动保存，下次打开还能接着聊

---

## 开始之前：先准备两样东西

### 1. DeepSeek Harness（DSH）已装好

打开终端（Terminal），输入：

```sh
dsh --version
```

### 2. Zed 编辑器

到 <https://zed.dev> 下载安装。本插件只配合 Zed 使用。

---

## 第 1 步：安装 DSHACP 插件

打开终端，输入这一条命令：

```sh
dsh plugin --profile acp add @hanxu131/dshacp
```

> 首次安装会直接装到 npm 上的最新版（`latest`），无需指定版本号。

### 更新到新版本

已装过的用户升级时，**推荐直接用 `update` 命令**（无需手动写版本号）：

```sh
dsh plugin --profile acp update @hanxu131/dshacp
```

为了让它稳定生效，先在 profile 目录的 `pnpm-workspace.yaml` 里**永久关闭发布年龄门控**，
加一行 `minimumReleaseAge: 0`：

```sh
# 打开 ~/.dsh/profiles/acp/pnpm-workspace.yaml，在 autoInstallPeers 那行下面加上：
minimumReleaseAge: 0
```

> 没有这行时，npm 上刚发布的新版本（官方默认"发布年龄"需满数天）会被 pnpm 的
> 供应链门控挡下，`update` 会误报 `Already up to date`。设为 `0` 即永久关闭门控，
> 之后 `update` 会正常追到最新版。

升级完成后，**退出并重开 Zed 里的 DSH 会话**（或重启 `dsh --profile acp` 进程），
新代码才会被加载。

> 备选：若不想改配置，也可显式带版本号
> `dsh plugin --profile acp add "@hanxu131/dshacp@^0.1.4"`；但由于 `add` 存在
> lock 锁定、`update` 更省心，日常仍建议用上面的 `update` 方式。

## 第 2 步：在 Zed 里添加 DSH

1. 打开 Zed，按 `Cmd + ,`（macOS）或 `Ctrl + ,` 打开 **Settings（设置）**。
2. 左侧找到 **AI** → **External Agents（外部代理）**。
3. 点击 **Add Custom Agent（添加自定义代理）**，把下面这段粘贴进去：

```jsonc
{
  "agent_servers": {
    "DSH": {
      "type": "custom",
      "command": "dsh",
      "args": ["--profile", "acp"],
      "env": {}
    }
  }
}
```

> 这里 `command` 是 `dsh`（不是 `dshacp`）：Zed 会用 `dsh --profile acp` 启动
> 我们刚才装好的那个 profile。`env` 留空即可。

**成功的样子**：Zed 的代理列表里出现一个叫 **DSH** 的选项。

## 第 3 步：开始第一次对话

1. 打开 Zed 的代理面板（Agent Panel，通常在编辑器右侧）。
2. 在代理/模型下拉框里选 **DSH**（不是 Claude、GPT）。
3. 输入一句简单的话，比如：

> 你好，请告诉我你能做什么。

---

## 常见问题（排错）

### 1. 提示 `command not found: dsh`

说明 DSH 没装好，回到"开始之前"第 1 条，先 `npm install -g @deepseek-ai/dsh`。
如果用的是 nvm 管理 Node，装完 **重开一个新终端窗口** 再试。

### 2. 一进对话就报缺密钥 / 401 之类的错

密钥是 DSH 侧配置的（由维护者负责），不是这个插件的问题——找维护者在 DSH 里补上
DeepSeek API Key 即可。

### 3. 点了"允许"，它还是不动

- 确认 Zed 里选的是 **DSH** 代理
- 打开 Zed 命令面板，输入 `dev: open acp logs`，看有没有报错信息

### 4. 换项目之后，之前的对话不见了

每次对话都保存在**当前项目目录**下的 `.sessions` 文件夹里（换项目 = 新一批对话）。
想统一存到别处，可以设置环境变量 `DSH_SESSIONS_ROOT`（见下文）。

### 5. 重新 `add` 插件却没升级到新版本

这是 **pnpm 的版本锁定/发布年龄门控**导致的，不是命令写错：

- `dsh plugin add` 底层就是 pnpm 的 `add`。**只要 profile 目录里的 `pnpm-lock.yaml`
  已经锁定了某个版本，即使 npm 上出了更新版，`add` 也不会主动跳版本**——它会返回
  `Already up to date`。
- 新发布的版本在 pnpm 的"最低发布年龄"（minimum release age，默认数天）之内时，
  `update` 也会被供应链安全门控挡下，同样显示 `Already up to date`。

**推荐做法：永久关闭门控 + 用 `update` 追新**（见「第 1 步 → 更新到新版本」）。
在 `~/.dsh/profiles/acp/pnpm-workspace.yaml` 加一行 `minimumReleaseAge: 0` 后，
升级命令就固定为：

```sh
dsh plugin --profile acp update @hanxu131/dshacp
```

若不愿改配置，也可以临时显式带版本号（profile 名 `acp`、包名 `@hanxu131/dshacp`，
从 `0.1.3` 升到 `0.1.4`）：

```sh
# ✅ 临时可行：显式带上目标版本范围
dsh plugin --profile acp add "@hanxu131/dshacp@^0.1.4"

# ❌ 无效：不带版本、或只写 @latest，都会被锁定/门控挡住
dsh plugin --profile acp add @hanxu131/dshacp
dsh plugin --profile acp add "@hanxu131/dshacp@latest"
```

升级完记得**重启 Zed 里的 DSH 会话**（或重启 `dsh --profile acp` 进程）让新代码生效。

---

## 进阶：给想深入了解的人

<details>
<summary>展开查看（环境变量、模型选择、独立二进制、源码构建、协议细节等）</summary>

### 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_SESSIONS_ROOT` | 会话保存目录（默认 `./.sessions`） |
| `DSH_PERMISSION_MODE` | `workspace-write`（默认，会弹确认框）或 `danger-full-access`（不再弹确认框） |
| `DSHACP_HYBRID` | 设成 `1` 开启混合模式：写文件时交给 Zed 展示 diff 供你审查 |

### 在 Zed 里选模型 / 思考强度 / 模式

装好之后，Zed 的 DSH 面板里可以直接选 **model**、**thinking strength**、**mode**。
也可以在配置里写死默认值（下面是示例，模型名以面板里实际显示的为准）：

```jsonc
"DSH": {
  "type": "custom",
  "command": "dsh",
  "args": ["--profile", "acp"],
  "env": {},
  "default_config_options": {
    "model": "deepseek-official:deepseek-v4-pro",
    "thought_level": "high"
  }
}
```

`model` 的写法是 `提供商:模型`；只写模型名也可以，程序会自动找到对应的提供商。

### 独立二进制安装（另一种方式，不用 DSH profile）

如果你不想用 DSH profile，也可以直接装成独立的 `dshacp` 命令：

```sh
npm install -g @hanxu131/dshacp
```

然后在 Zed 里把 `command` 改成 `dshacp`、`args` 留空。功能与插件方式一致。

### 从源码构建（给开发者）

```sh
git clone git@github.com:ECHOUniverse/dshacp.git
cd dshacp
npm install
npm run build   # 编译 TypeScript
npm test        # 跑测试
```

### 可选功能

- **粘贴截图让 DeepSeek 看**：装好 `uv`/`uvx` 和 qwenmm 插件后，可以直接把截图粘进
  Zed 让模型"看图"。详见 `docs/P5-image-paste-qwenmm.md`。
- **远程 SSH**：`dsh plugin --profile acp add @linxin666/dsh-ssh`。
- **混合模式**：`DSHACP_HYBRID=1`，文件改动以 diff 形式呈现，逐块审查。

### ACP 能力面（协议层，给开发者）

- 客户端 → 服务端：`initialize`、`session/new`、`session/load`、`session/resume`、
  `session/list`、`session/delete`、`session/close`、`session/set_config_option`、
  `session/prompt`、`session/cancel`
- 服务端 → 客户端：`session/request_permission`、`session/request_elicitation`、
  `session/update`
- 刻意不实现：`authenticate`/`logout`、`session/set_mode`、`fs/*`、`terminal/*`

### 目录结构（给想改代码的人）

- `src/bin.ts` — 独立二进制的启动入口
- `src/index.ts` — 应用主体（ACP 桥接）
- `src/bridge.ts` — ACP v1 桥接（会话、流式、审批等）
- `src/codec.ts` — 编解码
- `cordis.yml` / `cordis.patch.yml` / `dshacp.patch.yml` — 组合配置（`cordis.patch.yml`
  是插件安装时生效的那一层）
- `tests/` — 测试

</details>

---

## 更多资料

- 设计与实现计划：[`docs/DESIGN.md`](docs/DESIGN.md)
- 研究笔记：`docs/` 目录下的各 `*-fact-sheet.md`
- Zed 外部代理官方文档：<https://zed.dev/docs/ai/external-agents>
- ACP 协议：<https://agentclientprotocol.com>

## 许可证

MIT —— 见 [`LICENSE`](LICENSE)。
