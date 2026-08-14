# NOTES — 教学笔记

## 用户画像与偏好

- 中文交流；自称"不会操作"——**新手**，需要极其详细的逐步指引（点哪里、看什么、出现什么算成功）。
- 用户是这个项目（DSHACP）的作者，但**不熟悉 Zed 的操作界面**。
- 教学语言：中文；代码/配置原文保留英文。
- 每步都要给"成功的样子"和"失败的样子"，方便自检。

## 环境事实（2026-08 检查）

- ✅ Zed 已安装：`/Applications/Zed.app`，CLI：`/usr/local/bin/zed`
- ✅ Node v26.5.0，npm 12.0.2
- ✅ `~/.dsh/.credentials.yaml` 有 DEEPSEEK_API_KEY
- ⚠️ `dshacp` 命令尚未全局安装（需要 `npm link`）
- ⚠️ `~/.dsh/dsh-ssh.json` 不存在（ssh 工具会报 "no hosts configured"，不影响主流程验证）

## 待办/后续课程想法

- 第 1 课：安装 + 配置 + 首次对话（本课）
- 第 2 课：逐功能验证清单（流式/思考/工具卡片/审批/会话恢复）
- 第 3 课：ACP 协议原理 + 用 `dev: open acp logs` 读报文
- 第 4 课：常见故障排查（连不上、无密钥、审批卡住、stdout 污染）
