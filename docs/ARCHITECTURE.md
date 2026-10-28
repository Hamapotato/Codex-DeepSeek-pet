# 架构与数据流

一句话：**Codex 的 lifecycle hook → 本机 HTTP → dsh-pet 桌宠**；桌宠本身是
`%DSH_HOME%` 里安装的 `dsh-pet` 包，这个仓库只放"胶水"和对它打的补丁。

```
Codex (MSIX / CLI)
  │  hooks: SessionStart / UserPromptSubmit / PostToolUse /
  │         PermissionRequest / Stop / Interrupt
  ▼  stdin(JSON)
hook.js  ──► src/hook.js          事件 → 动画/气泡；必要时拉起桌宠
  │
  │  HTTP  127.0.0.1:3080/dsh-pet-7340/*
  ▼
dsh-pet standalone host (node)
  │  bridge
  ▼
Electron helper ──► 透明置顶小窗（桌宠 + 气泡 + 右键菜单）

启动链:
  Codex 启动 ──► 计划任务 dsh-pet-on-codex-launch (AppModel event 201)
             ──► scripts/start-watch.vbs ──► src/watch-codex.js
             ──► src/standalone-launcher.js ──► src/patches/index.js
             ──► node lib/standalone-codex.js
```

## 目录职责

| 路径 | 作用 |
|---|---|
| `hook.js` | Codex hook 入口（**必须留在根目录**：`~/.codex/config.toml` 的信任记录按这个路径 + 命令串校验） |
| `src/hook.js` | 事件映射、宿主发现、必要时拉起 |
| `src/watch-codex.js` | 看门狗：Codex 启动→拉起桌宠；关闭→写日记后自己退出（桌宠留着）；每 60 秒检查是否该写日记 |
| `src/standalone-launcher.js` | 启动器：先跑补丁，再起 standalone（失败回退原版） |
| `src/config.js` | 所有路径 / 端口 / 状态目录 |
| `src/patches/` | 对已安装 dsh-pet 的就地补丁（余额、菜单、打开本地文件、托盘名） |
| `src/diary.js` | 日记：读会话、裁剪素材、调模型、落盘、状态机 |
| `src/diary-view.js` | 阅读页 HTML 渲染（`diary/viewer.html`） |
| `src/impressions.js` | 印象簿：从日记摘要里慢慢总结主人特征（慢热 + 特别细节） |
| `src/chat-link.js` | 心声线：绑定一条对话，双向同步人设/日记/印象/记忆 |
| `scripts/start-watch.vbs` | 计划任务的隐藏入口 |
| `install/` | 一次性安装脚本：写 hooks、注册/注销计划任务 |
| `config/` | 脱敏样例配置（真实配置在 `%DSH_HOME%\dsh-pet\`） |

## 数据流：日记

```
~/.codex/sessions/**/rollout-*.jsonl  ┐
~/.codex/archived_sessions/*.jsonl    ┘ 只取 role=user 的提问
        │  按「消息时间戳」归日（不按文件目录）
        │  每条截断 140 字，跳过系统注入，密钥脱敏
        ▼
   DeepSeek /chat/completions  (deepseek-flash)
        ▼
%DSH_HOME%\dsh-pet\diary\YYYY-MM-DD.md   + index.md + viewer.html
```

## 数据流：印象簿

```
diary/*.md（已压缩的日记摘要）
        │  第一次 ≥8 篇 / 150 条；之后每 +4 篇 / +80 条
        │  特别的小事：每 +2 篇捕捉一次 0～2 条
        ▼
   DeepSeek /chat/completions   （只输出一小段 JSON）
        ▼
%DSH_HOME%\dsh-pet\impressions\profile.{json,md} + viewer.html
```

证据不足时不会生成结论，阅读页只显示「还在观察」和进度数字。

## 数据流：心声线

```
绑定的那条对话                      其它对话
   │ UserPromptSubmit                  │
   ▼                                   ▼
hook 注入：人设+日记+印象+记忆      只作为日记/印象素材（单向）
   │                                   │
   ▼                                   ▼
模型以「大肥鱼」身份回答            diary / impressions
   │ Stop
   ▼
memory.json  （桌宠聊天窗读写同一份）
```

日记状态（`.state.json`）只保存 `lastTs`、每次写入的条数和 token 数，
不保存对话正文。

## 补丁机制

`src/patches/*` 改的是 `%DSH_HOME%\profiles\desktop\node_modules\dsh-pet`
里的文件，每个补丁：

1. 幂等 —— 用 `/* dsh-pet xxx patch */` 标记，重复执行会跳过；
2. 可回滚 —— 首次改动前留 `*.dsh-pet-*` 备份；
3. 有语法闸 —— `node --check` 失败就还原。

所以 dsh-pet 升级后不需要手工改，启动器每次都会重新打一遍。
