# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化版本。

## [Unreleased]

_暂无_

## [1.2.0] - 2026-10-24

### Added

- **谷时专用**：工作日峰时段（9–12、14–18）不调用模型，只把素材写入
  `diary/.pending.json` 排队；桌宠提示「峰时先不写啦，谷时再补～」。
- 谷时（或下次启动 Codex 且已是谷时）自动补写排队的所有日期，写完清空队列。
- `DSH_DIARY_FORCE_TIER=peak|idle`、`DSH_DIARY_IGNORE_PEAK=1` 两个调试/应急开关。

### Changed

- 日记 prompt 放开主题：允许吐槽、抱怨、许愿、跑题，60～200 字，想到什么写什么。

## [1.1.0] - 2026-10-24

### Added

- **日记**（`src/diary.js` + `src/diary-view.js`）：读取 Codex 当天**所有**会话
  （递归 `sessions/**` + `archived_sessions/`，按消息时间戳归日），只取用户提问，
  压成一小段带情绪的日记，落盘为 `diary/YYYY-MM-DD.md`。
- 一天多条日记：每条带时间（`## 15:30 · 8 件事`），只覆盖上次写完之后新增的提问。
- 自动触发：Codex 关闭时新增 ≥3 条即写；运行中每 60 秒检查，新增 ≥12 条也写；
  写完桌宠弹「日记写好了～（15:30）」。
- 阅读页 `diary/viewer.html`：按时间倒序的卡片流，字体与余额气泡一致（上首软糖体），
  支持深色模式；右键菜单「查看日记」打开。
- `diary --rebuild`：重建当天日记（旧文件备份到 `diary/archive/`，按 60 分钟间隔分段）。
- `src/patches/openpath.js`：preload/main 的 `pet:open-path` 通道，用于打开本地文件
  （原先的 `pet:open-site` 只放行 http(s)）。

### Changed

- 桌面端右键菜单重组：一级只留「查看余额 / 碎碎念 / 对话 / 查看日记 / 动作 / 工具」，
  维护项收进「工具」子菜单。
- 余额气泡格式改为 `余额：¥57.85（谷）`，金额与档位括号同色（平时绿 `#2e9e4f`、
  峰时金 `#c9a227`），并去掉标签与金额之间的 flex 间隙。
- Codex 关闭后**不再关闭桌宠**：看门狗写完日记即退出，桌宠留在桌面直到手动关闭。
- 项目结构整理：`build-patches.js` 拆成 `src/patches/*`；日记渲染拆到 `src/diary-view.js`；
  `start-watch.vbs` 移入 `scripts/`；新增 `docs/ARCHITECTURE.md` 与 `.editorconfig`。

### Fixed

- 会话文件按**开始日期**存放在 `sessions/YYYY/MM/DD/`，导致"前几天开的、今天还在聊"
  的会话被漏读 → 改为递归扫描 + 按消息时间戳过滤。
- 重建日记时与看门狗的自动写入发生竞态（会多写一条）→ 增加 `.rebuild.lock`。
- 日记素材过滤 `<turn_aborted>`、`<in-app-browser-context>`、`<permissions instructions>`
  等系统注入。

## [1.0.0] - 2026-10-24

### Added

- Codex lifecycle hook → dsh-pet 事件联动（动画 + 气泡）。
- 事件触发的计划任务 `dsh-pet-on-codex-launch`（AppModel-Runtime 事件 201），开机不自启。
- 独立模式启动器与就地补丁（余额常驻、菜单分组、托盘名「大肥鱼」）。
- 可移植安装脚本：hook 段写入/移除、计划任务注册/注销、脱敏配置样例。
