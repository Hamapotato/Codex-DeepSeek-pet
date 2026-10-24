# Codex ↔ dsh-pet（大肥鱼）

Codex 的 lifecycle hooks 在每一轮对话中调用 `hook.js`，通过 dsh-pet 的本机 HTTP API
让桌面宠物播放动画 / 弹气泡。桌宠本体是安装在 DSH 里的 `dsh-pet`
（显示名 **大肥鱼**），这里只放联动脚本和对官方包的本机补丁。

本机当前部署位置：`D:\WORK\Codex-DeepSeek-pet`（同时也是 GitHub 上游仓库
`Hamapotato/Codex-DeepSeek-pet` 的工作副本）。`%USERPROFILE%\.codex\dsh-pet` 已不再使用。

## 功能

- **事件联动**：Codex 开始思考 / 调工具 / 要权限 / 结束 / 被打断，桌宠播对应动画并弹一句气泡。
- **余额常驻**：DeepSeek 余额挂在头顶，`余额：¥57.85（谷）`，平时绿色、峰时段金色，30 秒刷新。
- **自动日记**：把当天**所有** Codex 对话（不分项目）压成一小段日记，一天可以写多条；
  Codex 关闭时攒够 3 条就写，运行中攒够 12 条也写，写完桌宠弹「日记写好了～」。
- **只在谷时花钱**：工作日的峰时段（9–12、14–18）不调用模型，只把素材记下来排队，
  等谷时（或下次启动 Codex 时已经是谷时）再补写。
- **日记阅读页**：右键菜单「查看日记」，按时间倒序的卡片流，字体与余额气泡一致。
- **印象簿**：攒够很多篇日记后才慢慢总结"你是个什么样的人"，平时只偶尔记下特别的小事；
  右键菜单「我的印象」看结果，同样只存在本机。
- **按需启动**：开机不自启；Codex 启动时才拉起看门狗和桌宠，Codex 关闭后桌宠留着你手动关。
- **自愈补丁**：dsh-pet 升级后，启动器会重新打上余额 / 菜单 / 打开的本地文件等补丁。

## 目录结构

```
D:/WORK/Codex-DeepSeek-pet/
├─ hook.js                     Codex hook 入口（只 require src/hook.js，必须留在根目录）
├─ package.json                脚本入口（build / check / launch / watch / diary:*）
├─ src/
│  ├─ config.js                所有路径 / 端口 / 状态目录
│  ├─ hook.js                  事件映射、宿主发现、必要时拉起
│  ├─ watch-codex.js           看门狗：启动时拉起桌宠；关闭时写日记后退出（桌宠留着）
│  ├─ standalone-launcher.js   先跑补丁，再启动独立模式（失败回退原版）
│  ├─ diary.js                 日记：读会话 / 裁素材 / 调模型 / 落盘 / 状态机
│  ├─ diary-view.js            日记阅读页渲染（viewer.html）
│  ├─ impressions.js           印象簿：从日记里慢慢总结"你是什么样的人"
│  └─ patches/                 对已安装 dsh-pet 的就地补丁
│     ├─ index.js              补丁总入口（npm run build）
│     ├─ shared.js             路径、标记、syntaxOk、patchHelper
│     ├─ balance.js            余额气泡（常驻 / 格式化 / 配色 / 首次渲染）
│     ├─ menu.js               右键菜单分组 + 「查看日记」
│     ├─ openpath.js           pet:open-path 通道（打开本地文件）
│     └─ name.js               托盘提示改叫「大肥鱼」
├─ scripts/
│  ├─ start-watch.vbs          计划任务的隐藏入口 → src/watch-codex.js
│  └─ legacy/                  已停用的旧开机项（仅备查）
├─ config/                     脱敏的配置样例（不含任何密钥）
│  ├─ main-config.sample.jsonc 桌宠名/位置/开关/刷新频率
│  ├─ standalone-ai.sample.json 碎碎念/对话的模型配置
│  └─ codex-hooks.sample.toml  Codex hook 段示例
├─ install/
│  ├─ apply-hooks.js           写入/更新/移除 config.toml 的 hook 段
│  ├─ register-task.ps1        注册「Codex 启动」计划任务
│  └─ unregister-task.ps1      移除计划任务
├─ docs/ARCHITECTURE.md        数据流 / 各模块职责 / 补丁机制
├─ CHANGELOG.md                变更记录
└─ README.md
```

- `hook.js` 之所以留在根目录，是因为 `~/.codex/config.toml` 的 hook 命令和它的
  **信任记录**都按这个路径生成；换成 `src/hook.js` 会让 Codex 重新要求信任。
- 所有路径集中在 `src/config.js`：换机器 / 换 DSH 安装目录只改这一处，
  也可以用环境变量 `DSH_HOME`、`DSH_PET_PORT`、`DSH_PET_STANDALONE_JS` 覆盖。
- `scripts/start-watch.vbs` 会用自身位置推算项目根目录、用 `%ProgramFiles%` 找 node，
  整个目录可以平移到别的路径，不需要改脚本。

## 从零部署（另一台机器）

前提：Windows、Node.js ≥ 18、已安装 DeepSeek Harness（含 dsh-pet 0.3.8+）、
Codex 桌面版。

1. **放代码**：把整个项目放到任意目录（例如 `D:\WORK\Codex-DeepSeek-pet`）。
2. **确认 DSH 路径**：默认 `D:\DeepSeekHarness`。不同的话设用户环境变量
   `DSH_HOME`（或在 `src/config.js` 里改默认值）。
3. **配置桌宠**：
   - `config\main-config.sample.jsonc` → `<DSH_HOME>\dsh-pet\main-config.jsonc`；
   - `config\standalone-ai.sample.json` → `<DSH_HOME>\dsh-pet\standalone-ai.json`，
     把 `apiKey` 换成自己的（这个文件含密钥，**不要提交**）。
4. **打补丁并试跑**：

   ```sh
   node src/patches/index.js
   node src/standalone-launcher.js
   node hook.js --check
   ```

   `hook.js --check` 输出 `dsh-pet OK (standalone)` 即通。
5. **接 Codex hooks**：

   ```sh
   node install/apply-hooks.js
   ```

   它按当前真实路径生成带 `# >>> dsh-pet hooks` 标记的段，重复执行只会替换自己那一段，
   改动前会备份 `config.toml`。然后启动 Codex，在 “Hooks need review” 选
   “Trust all and continue”（或 `/hooks` 里按 `t`）。
6. **注册启动触发**（可选，决定了「Codex 启动 → 桌宠出现」）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File install\register-task.ps1
   ```

   注册事件日志触发器可能需要管理员权限。只想手动开桌宠就跳过这步。
7. **卸载自动化**：

   ```sh
   node install/apply-hooks.js --remove
   powershell -NoProfile -ExecutionPolicy Bypass -File install\unregister-task.ps1
   ```

密钥来源：`standalone-ai.json` 只影响碎碎念/对话；余额查询的 key 依次取
`DEEPSEEK_API_KEY` → `%LOCALAPPDATA%\dsh-pet-codex\balance-key.txt` →
`~/.codex/config.toml` 里的 `experimental_bearer_token`。样例文件里没有任何密钥。

## 桌宠：大肥鱼

配置在 `D:\DeepSeekHarness\dsh-pet\main-config.jsonc`：

```jsonc
{
  "pets": [{
    "id": "main",
    "name": "大肥鱼",          // 悬浮提示 / AI 人设里的名字
    "display": "desktop",      // 必须有 desktop 或 both，否则不建桌面小窗
    "position": {
      "corner": "bottom-right", // 默认落在屏幕右下角
      "marginX": 24,
      "marginY": 24
    }
  }]
}
```

改完配置后重启桌宠（或右键「工具 → 重载配置」）。`name` 会同时用于悬浮提示、
对话人设里的「你的名字是…」；聊天记忆 `D:\DeepSeekHarness\dsh-pet\memory.json`
里的旧自我介绍也已同步改成大肥鱼。

程序层面的显示名也一并改了：托盘图标的提示从「dsh-pet 桌面宠物」改成「大肥鱼」
（`runtime/electron-helper/main.js` 的 `tray.setToolTip`，补丁标记 `dsh-pet name patch`）。
Electron 的 `app.setName` **没有**改——它决定 userData 目录，改了会丢掉 Helper 的
Chromium profile 和 DPI 缓存。

## 随 Codex 启动

`watch-codex.js` 是轻量看门狗，**不随机启动**：Codex 通过 MSIX 启动时系统会在
`Microsoft-Windows-AppModel-Runtime/Admin` 写一条事件 201
（`ApplicationName = OpenAI.Codex_2p2nqsd0c76g0!App`，
`Message = [LaunchProcess]`），计划任务 `dsh-pet-on-codex-launch`
用这个事件触发 `scripts/start-watch.vbs` 拉起看门狗，所以开机后什么都不会跑：

- 每 5 秒用 `tasklist` 看有没有 `codex.exe` / `ChatGPT.exe`；
- 发现 Codex **从无到有**且桌宠没在跑，就用隐藏 VBScript（经 Explorer）拉起独立模式；
- 发现 Codex **从有到无**（进程退出）时，只写当天日记，**不动桌宠**——
  桌宠继续留在桌面上，直到你自己关掉它。只在这个"关闭边沿"动手，
  Codex 本来就没开时手动启动的桌宠不受影响；
- 桌宠还活着时不会重复启动；Codex 开着时手动退出桌宠，看门狗不会主动复活，
  但下一次 Codex 事件（提问/工具/结束）会让 hook 兜底拉起；
- 看门狗带 `--exit-on-codex-close` 跑：Codex 一关闭，写完日记后**看门狗自己**退出；
  桌宠不跟着退，你手动关它即可；
  触发后 3 分钟内没看到 Codex（误触发）也会自己退出。

触发方式（不是开机项）：

```
计划任务  \dsh-pet-on-codex-launch
  触发器  事件 Microsoft-Windows-AppModel-Runtime/Admin, EventID 201
          EventData/ApplicationName = OpenAI.Codex_2p2nqsd0c76g0!App
          EventData/Message = [LaunchProcess]
  动作    explorer.exe "D:\WORK\Codex-DeepSeek-pet\scripts\start-watch.vbs"
```

任务通过 `explorer.exe` 转一手，是为了让桌宠脱离 Codex 的进程 job（直接子进程会随 Codex 一起被杀）。
也因此手动 `Start-ScheduledTask` 时 `LastTaskResult` 往往是 1 —— 那是 explorer 的退出码，
看 `watch.log` 里有没有新的 `watchdog started` 才准确。

日志：`%LOCALAPPDATA%\dsh-pet-codex\watch.log`（超过 200 KB 自动清空）。
手动跑一次看门狗逻辑（会立即拉起还没运行的桌宠）：

```sh
"C:/PROGRA~1/nodejs/node.exe" "D:/WORK/Codex-DeepSeek-pet/src/watch-codex.js" --once
```

配合 `hook.js` 的双保险：即使看门狗没起来，Codex 触发 hook 时发现桌宠不在也会拉起。
启动到能播动画约 5–10 秒，第一轮可能赶不上。

## 宿主：优先用独立模式

桌宠有两种跑法，脚本优先用第一种：

1. **独立模式**（`dsh-pet-standalone`）—— 只开一个透明置顶的桌宠小窗，不需要 DSH，
   启动快、没有 DSH 主窗口。入口是
   `D:\DeepSeekHarness\profiles\desktop\node_modules\dsh-pet\lib\standalone.js`。
   独立模式的写接口要能力 token，脚本会从
   `D:\DeepSeekHarness\dsh-pet\standalone-runtime.json` 读取（同用户私有文件）。
2. **完整 DSH 应用** —— 插件内嵌在 DSH 里。只有独立模式入口不存在时才回退到它
   （会弹出 DSH 主窗口）。

两种宿主都可用时，脚本选独立模式。两边同时开着会出现两只宠物。

独立模式支持余额查询（见下节）。DSH 会话工作状态、DSH 系统通知仍不可用；
碎碎念/对话需要在 `http://127.0.0.1:3080/standalone-ai/` 里配置本机 API 才会启用。
动画、拖拽、右键菜单正常。

## 右键菜单

补丁把一级菜单压到 6 项，维护类动作收进「工具」：

```
查看余额
碎碎念
对话
动作 ▸     待机 / 转向 / 拖拽 / 点击回应 / 移动 / 工作状态 / 余额档位 / 碎碎念…
工具 ▸     打开网站 / 显示位置 ▸ / 回到初始位置 / 重载配置
更多 ▸     第三方插件注册的菜单项（没有就不显示）
```

补丁位置：`runtime/electron-helper/sprite.js` 的 `onContextMenu`，
标记 `dsh-pet menu patch v2`。官方升级后启动器会自动重新打；
锚点找不到时构建会报错并保留原版菜单。

## 余额（独立模式，不依赖 DSH）

原生独立模式的余额路由固定报 `unsupported`（provider 是占位符 `standalone`，凭证解析恒空）。
这里用一个**旁路构建**补上：`src/patches/` 读取官方 bundle，生成
`lib/standalone-codex.js`（原文件不动），只改两处：

- 余额查询的 provider 固定为内置的 `deepseek-official`；
- `credentials.resolve('DEEPSEEK_API_KEY')` 从本机取值。

key 的查找顺序：

1. 环境变量 `DEEPSEEK_API_KEY`（或 `DSH_PET_BALANCE_KEY`）；
2. `%LOCALAPPDATA%\dsh-pet-codex\balance-key.txt`（第一行）；
3. `~/.codex/config.toml` 里的 `experimental_bearer_token`（找不到时用 `ANTHROPIC_AUTH_TOKEN`）
   —— 也就是 Codex 正在用的那把 DeepSeek key。

查询走官方 `GET https://api.deepseek.com/user/balance`，展示的是账户余额
（充值 + 赠送，按币种分条），与 DSH 的「平台登录 / 免费额度」路由是两条不同的数据源。

- 手动：右键菜单「查看余额」（独立模式没有斜杠命令）；
- 自动：配置里 `balanceEnabled: true` 时按 `eventsRefreshSec.balance` 轮询。

### 常驻显示（实时）

官方行为是：自动轮询只对「有百分比语义」的服务商弹气泡，DeepSeek 的金额形态永远不自动弹；
气泡也只显示 10 秒。为了让余额一直挂在头顶，构建脚本还会给桌面 Helper 打几处补丁
（原文件备份为 `*.dsh-pet-*`）：

- 自动刷新到 `shape: "money"` 也弹气泡；
- 余额气泡的驻留时间改为 24 小时，点开展示也不会缩短（其余碎碎念/任务气泡仍是 10 秒）；
- **桌宠一启动就显示余额**：首拉 `/state` 原本只记基线、不渲染，要等下一拍轮询（30 秒）
  才出现；补丁让首拉直接渲染宿主里已有的余额叶子（标记 `dsh-pet startup balance patch`）；
- 气泡文案是 `余额：¥64.87（谷）`——金额在前，档位缩写放末尾括号里，金额和括号都用档位色
  （`shared-core.js` 的 `moneyRows`，标记 `dsh-pet balance row patch`）；
  标签与金额之间不留 flex 间隙（`index.html` 的 `.pet-bub-row:has(> .pet-bub-tier)`）；
- 峰/谷由宿主演算：北京时间工作日 9:00–12:00、14:00–18:00 为「峰」，其余时间和周末为「谷」；
- 金额颜色：平时绿色 `#2e9e4f`，峰时段金色 `#c9a227`（官方红色改成金色，避免像报错）；
- 余额（金额）气泡整体缩到 85%：`--f0` 同时是字号和盒子的锚点，所以字和气泡一起缩；
  规则在 `index.html` 的 `.pet-bubble:not(.is-whisper)`，碎碎念/工作状态气泡带
  `.is-whisper`，尺寸不变。

前提：宠物配置 `display` 必须是 `desktop` 或 `both`，`none` 时根本不建桌面小窗。
余额气泡和其他气泡共用一个槽位（优先级：终态任务 > 碎碎念 > 余额 > 进行中任务），
碎碎念之类短暂顶掉它，气泡消失后余额自动回来。

改气泡大小：把 `DSH_PET_BALANCE_BUBBLE_SCALE` 设成用户环境变量（默认 0.85，允许 0.4–1.5），
重启桌宠即可——启动器每次都会跑构建并同步这个比例；也可以直接改构建脚本里的默认值。

刷新频率在用户配置里：

```jsonc
// D:\DeepSeekHarness\dsh-pet\main-config.jsonc
"eventsRefreshSec": { "balance": 30 }
```

也就是每 30 秒拉一次余额。另外 `hook.js` 在 Codex 每轮 `Stop`（一轮结束、刚花完 token）
之后会立刻触发一次刷新，所以余额在回复结束约 0.2–1 秒内就会更新，不必等下一拍轮询。

- 临时强制重建：`node src/patches/index.js --force`。dsh-pet 升级后启动器会自动重建；
  若上游改动导致锚点找不到，构建会报错并保持原版（余额重新变成不支持/10 秒消失，不会崩）。

## 日记

大肥鱼会把**你让 Codex 干的活**写成一小段日记，带上它自己的情绪和吐槽。
**一天可以写很多条**，每条都标着生成时间（`15:30`），只覆盖"上次写完之后新增的提问"，不会重复。

存放位置：

```
D:\DeepSeekHarness\dsh-pet\diary\
├─ 2026-10-24.md     每天一个文件，里面按时间分小节（## 15:30 · 8 件事）
├─ index.md          全部日记的汇总（最新在前）
├─ viewer.html       阅读页（右键菜单「查看日记」打开的就是它）
└─ .state.json       指纹 / 冷却 / token 用量缓存
```

### 查看

- **桌面端**：右键桌宠 →「查看日记」，用系统默认浏览器打开阅读页；
- **命令行**：`npm run diary:open`（重建并打开）、`npm run diary:view`（只重建）、
  `npm run diary:list`（终端里列一行摘要）。

阅读页按时间**从新到旧**竖排，每张卡片显示日期、星期、时间、这段的条数和 token 用量；
字体是 `assets/fonts/上首软糖体.ttf`，与余额气泡同款。构建阅读页时把字体**内联成
`data:` URL** 写进 `viewer.html`——`file://` 页面对本地字体加载时灵时不灵，内联才能
保证和气泡一模一样（代价是 viewer.html 约 5 MB，本地打开无感）。
字体缺失时回退到气泡同一串后备字体（Yuanti SC / 幼圆 / PingFang / 微软雅黑）。

数据来源是 Codex 自己的会话记录，**当天所有对话、所有项目**，不分 cwd：

- `~/.codex/sessions/**/rollout-*.jsonl`（**递归全部日期目录**——一个会话从哪天开始，
  文件就一直待在那天的目录里，比如 10-21 开的会话今天还在用）
- `~/.codex/archived_sessions/*.jsonl`（已归档的会话）

先用文件的 `mtime` 做廉价预筛（今天动过的文件才可能含今天的消息），再按**每条消息的时间戳**
判断是否属于当天；解析结果按 `size+mtime` 缓存，运行中每分钟检查一次也不会反复解析几 MB 的 JSONL。

只挑 `role: "user"` 的提问，跳过 `environment_context`、`/compact`、任务通知这类系统注入；
同一条会话跨午夜时，前一天/后一天各自归位。

### 省 token 的做法

| 措施 | 数值 |
|---|---|
| 只取用户提问（丢掉助手回复、工具输出） | 输入通常 500～800 token |
| 每条截断 | 140 字 |
| 每天最多 | 40 条（超出取最近的） |
| 输出上限 | 900 token（`deepseek-flash` 会先写 reasoning，预算太小正文会被截断） |
| 会话指纹没变 | 直接跳过，不调用模型 |
| 冷却 | 10 分钟内不重复生成 |

实测：一天 15 条提问 → 输入 513 token，输出 185～582 token。

### 自动执行

`src/watch-codex.js` 里挂了三个时机，**不需要额外计划任务**：

| 时机 | 条件 | 说明 |
|---|---|---|
| Codex 关闭 | 新增提问 **≥ 3 条** | 写一条覆盖这段时间的日记，桌宠头顶弹「日记写好了～（15:30）」，然后桌宠继续留着 |
| 运行中 | 每 60 秒检查，新增 **≥ 12 条** | 一次对话太长时提前写一条，不用等关闭 |
| 跨过午夜 | — | 把前一天残留的补上（同样按 ≥3 条的门槛） |
| **峰时（工作日 9–12、14–18）** | 任意条数 | **不调用模型**，只写进 `diary/.pending.json` 排队；桌宠弹「峰时先不写啦，谷时再补～」 |
| 谷时 + 有排队 | ≥1 条 | 自动补写所有排队的日期（含前几天），写完清空队列 |

没到门槛的提问会**攒着**，等下一次关闭/攒够再一起写，不会丢。两个门槛都能用环境变量调：
`DSH_DIARY_MIN_TURNS_CLOSE`（默认 3）、`DSH_DIARY_MIN_TURNS_MIDRUN`（默认 12）。
手动 `node src/diary.js --force` 则无条件写一条。

档位判断按北京时间：工作日 9:00–12:00、14:00–18:00 是峰，其余时间与周末是谷。
`DSH_DIARY_FORCE_TIER=peak|idle` 可强制档位（测试用），`DSH_DIARY_IGNORE_PEAK=1` 可临时无视峰时限制。

### 写什么

日记内容不限定主题：可以吐槽、抱怨、许愿、聊零食、想别的事情，想到什么写什么；
那串提问只是素材，不是必须逐条复述的提纲。

### 只追加，不改写

- 每写一条新的，**只在当天文件末尾追加**一个 `## HH:mm · N 件事` 小节；
  已经写好的条目一个字节都不会动（`appendEntry` 写完后会校验"旧内容仍是前缀"，
  不成立就抛错）。
- 会重写文件的只有两种情况，且都会先备份到 `diary/archive/`：
  1. 老格式（整天一整段）首次迁移成分小节；
  2. 手动执行 `npm run diary:rebuild`。
- 看门狗和手动命令可能同时想写，用 `diary/.write.lock` 互斥，拿不到锁就跳过这一轮，
  不会把同一条写两遍。

## 印象簿（大肥鱼眼里的你）

从**已经压缩过的日记**里慢慢读出"你是什么样的人"——不是每句话都分析，也不急着下结论。

### 什么时候才下结论

| 阶段 | 条件 | 行为 |
|---|---|---|
| 第一次形成印象 | ≥ **8 篇**日记 或 ≈ **150 条**对话 | 才会请你"说说主人是什么样的人" |
| 之后更新 | 新增 ≥ **4 篇** 或 ≈ **80 条** | 在旧印象基础上小幅修正 |
| 特别的小事 | 每新增 **2 篇**日记 | 单独问一次"有没有值得记住的细节"，模型可以什么都不记 |
| 峰时 | 任意 | 不调用模型，等谷时 |

证据不够时页面显示「我还不打算这么早给你下结论」，并给出当前进度
（已看 5/8 篇、48/150 条），不会硬凑一个性格标签。

### 记什么

- **你是**：身份 / 在做的事（没把握就写"还不确定"）
- **性格**：0–5 个关键词（可以少写甚至不写）
- **习惯 / 偏好**：0–4 条
- **特别的小事**：0–2 条很特别、值得记住的细节（累计保存，最多 10 条）
- **想对你说**：一句大肥鱼自己的话

素材只用最近的日记摘要 + 上一版印象，所以一次分析输入约 1～2k token，
细节捕捉只有几百 token；输出上限 800 / 400 token。

### 存放与查看

```
D:\DeepSeekHarness\dsh-pet\impressions\
├─ profile.json     结构化印象
├─ profile.md       人读版
├─ viewer.html      阅读页（字体与余额气泡一致）
├─ .state.json      进度（上次分析时的日记数/条数）
└─ archive\         早期或重建前的版本
```

右键桌宠 →「我的印象」；或：

```sh
npm run impression         # 手动跑一次（仍受门槛/峰时限制）
npm run impression:view    # 只重建阅读页
npm run impression:open    # 重建并打开
node src/impressions.js --force   # 无视门槛立即分析
```

门槛都能用环境变量调：`DSH_IMPRESSION_FIRST_ENTRIES`(8)、`DSH_IMPRESSION_FIRST_MESSAGES`(150)、
`DSH_IMPRESSION_MIN_ENTRIES`(4)、`DSH_IMPRESSION_MIN_MESSAGES`(80)、`DSH_IMPRESSION_HIGHLIGHT_ENTRIES`(2)。

## 心声线（和桌宠聊天的那条对话）

给桌宠单开一条 Codex 对话当"聊天窗"。这条对话是**双向**的，其它对话仍然是单向素材。

| 对话 | 关系 |
|---|---|
| 被绑定的那条 | **双向**：注入人设 + 日记 + 印象 + 共同记忆；每轮结束把这一问一答写回共享记忆 |
| 其它所有对话 | **单向**：只被日记 / 印象当作素材，看不到桌宠的记忆，也不会被改写 |
| 心声线对话的内容 | 默认**也作为素材**进日记和印象；不想被记录时设 `DSH_DIARY_EXCLUDE_CHAT=1` |

### 说话风格

注入的设定里明确了语气：和日记里的大肥鱼一致——软软的、有点懒散、爱用「～呀啦」、
自称「我」（偶尔「本鱼」）、叫对方「主人」，有点小得意、爱吐槽但不刻薄，
一次三五句，不堆 emoji。设定里还给了两句"只学味道别照抄"的示例。

### 绑定

在你想要当作"和桌宠聊天"的那条对话里执行：

```sh
npm run pet:link      # 绑定这条对话（用最近一次 hook 事件的会话 id）
npm run pet:status    # 看绑到了哪条
npm run pet:unlink    # 解除

node src/chat-link.js --link <sessionId>   # 显式指定
node src/chat-link.js --context            # 预览会注入的上下文
```

绑定关系存在 `D:\DeepSeekHarness\dsh-pet\chat-link.json`。

### 每一轮发生了什么

```
你在这条对话里说话
   └─ UserPromptSubmit
        └─ hook 注入 additionalContext：
             大肥鱼人设 + 最近 3 篇日记 + 印象 + 最近 12 条共同记忆
             并说明"以 大肥鱼 的身份回复"
   └─ 模型以桌宠身份回答
   └─ Stop
        └─ 从 transcript 取"最后一问 + 最后一答"写进 memory.json
```

桌宠自己的聊天窗读写的是**同一个** `D:\DeepSeekHarness\dsh-pet\memory.json`，
所以两边共享记忆（只保留最近 200 条）。

### 边界（可验证）

```
npm run pet:status          # 绑定到哪条对话
node src/chat-link.js --verify
```

`--verify` 会打印：绑定会话拿到的上下文长度、**其它会话拿到的是 `null`**。
实现上 `hook.js` 只对绑定的 `session_id` 调用 `contextFor()`，其它会话一行都拿不到。

| 能力 | 绑定对话 | 其它对话 |
|---|---|---|
| 读取人设 / 日记 / 印象 / 记忆 | ✅ | ❌（hook 不注入） |
| 写入共享记忆 | ✅ | ❌（`recordTurn` 只在绑定会话的 Stop 里跑） |
| 作为日记 / 印象素材 | ✅（可用 `DSH_DIARY_EXCLUDE_CHAT=1` 排除） | ✅（只读素材） |

### 记忆有多短

| 层级 | 上限 |
|---|---|
| 单条落盘 | 400 字（空白折叠、超出截断） |
| 总条数 | 120 条（超出丢最旧的） |
| 每轮注入 | 最近 8 条，每条再截到 80 字 |

所以一轮上下文里"共同记忆"最多约 700 字，不会随聊天变长而膨胀。

### 同步范围

| 内容 | 方向 | 说明 |
|---|---|---|
| 桌宠设定（名字/人设） | 桌宠 → 对话 | 每轮注入，改 `main-config.jsonc` 的 `name` 立即生效 |
| 日记 | 桌宠 → 对话 | 最近 3 篇摘要注入；完整内容看「查看日记」 |
| 印象 | 桌宠 → 对话 | 身份/性格/习惯注入；证据不足时明确写"还没结论" |
| 对话记忆 | 双向 | 对话写入 `memory.json`；桌宠聊天窗也读写它 |

整个过程不额外调用模型（说话的是 Codex 自己），所以**不消耗额外 token**，
也不受峰谷限制。

失败不影响桌宠启停——写入过程最多占 45 秒，异常只记进 `%LOCALAPPDATA%\dsh-pet-codex\watch.log`。

### 手动命令

```sh
npm run diary            # 写今天的（有冷却/指纹判断）
npm run diary:preview    # 只打印将要发给模型的清单，不花 token
npm run diary:list       # 列出已有日记
npm run diary:open       # 重建阅读页并用默认浏览器打开
npm run diary:view       # 只重建阅读页（viewer.html + index.md）

node src/diary.js --date 2026-10-23   # 补某一天
node src/diary.js --force             # 忽略冷却，重写
npm run diary:rebuild                 # 重建当天：旧文件备份到 diary/archive/，按 60 分钟间隔重新分条
```

模型和 key 复用 `D:\DeepSeekHarness\dsh-pet\standalone-ai.json`（`baseUrl` / `model` / `apiKey`）。
想换更便宜的模型或调预算，设环境变量 `DSH_DIARY_MAX_TOKENS`，或直接改 `src/diary.js` 里的 `DEFAULT_MAX_TOKENS`。

隐私：只有**截断后的提问摘要**会发给 DeepSeek，助手回复和工具输出不发送；
文本里形如 `sk-xxxx` 的密钥和 32 位以上的长串会先被替换成 `***`。日记本身只存在本机。

## 行为频率

两个独立的开关，别改错地方：

- **碎碎念间隔**：独立模式由 AI 设置决定（`whisperIntervalSec`，当前 900 秒）；
  在 `http://127.0.0.1:3080/standalone-ai/` 里改，或 POST `/standalone-ai/settings`
  只传 `{"whisperIntervalSec": 900}`（允许 60–86400，其余设置保持不变）。
- **随机乱跑**：用户配置 `main-config.jsonc` 的 `animationWeights.move`
  （当前 1；默认 5）。每次动画结束掷一次骰子，`idle/turn/move` 是百分比，
  剩下的概率落在原地小动作上。改完用右键菜单「工具 → 重载配置」或 POST `/reload` 生效。

```jsonc
"animationWeights": { "idle": 10, "turn": 5, "move": 1 }
```

`fixedEnabled: true` 也能彻底禁掉转向/走位，但会连"东张西望"一起停掉。

## Hook 信任

信任记录已写入 `~/.codex/config.toml` 的 `[hooks.state."..."]`，不需要手动点
“Trust all”。如果以后改了 hook 的命令或超时，信任会失效 → 在 Codex 里重新信任
（启动提示，或 `/hooks` 里按 `t`）。这也是根目录保留 `hook.js` 入口的原因。

## 事件映射

| Codex Hook | 桌宠动作 | 气泡 |
| --- | --- | --- |
| `UserPromptSubmit` | 工作状态-思考冒泡 | 让我想想… |
| `PostToolUse`（8 秒节流） | 工作状态-忙碌点按 | — |
| `PermissionRequest` | 工作状态-原地踱步张望 | 需要你确认一下呢 |
| `Stop` | 工作状态-雀跃庆祝 | 这一轮搞定啦！ |
| `Interrupt` | 工作状态-垂头叹气冒汗 | 哎呀，被打断了… |

`SessionStart` 只负责确保宿主在跑，不播动画。

整个动作走「取锁 → 播放 → 释放锁」，不会和桌宠自己的待机 / 碎碎念打架。

## 文件

- `hook.js`：Hook 入口 shim（保持 config.toml 里的路径和信任不变）
- `src/hook.js`：事件入口（读 stdin 的 JSON、找宿主、必要时拉起、调 API）
- `src/watch-codex.js`：看门狗，Codex 启动时拉起桌宠，关闭时写日记后自己退出（桌宠留着）
- `src/standalone-launcher.js`：隐藏启动器（先重建补丁，再拉起独立模式，失败回退原版）
- `src/patches/`：生成 `lib/standalone-codex.js` + 就地补丁
- `src/config.js`：路径 / 端口 / 状态目录常量
- `config/*.sample.*`：脱敏配置样例（桌宠 / AI / Codex hooks）
- `install/apply-hooks.js`：写入或移除 `config.toml` 的 hook 段
- `install/register-task.ps1` / `unregister-task.ps1`：注册 / 移除计划任务
- `scripts/start-watch.vbs`：计划任务的隐藏入口（路径自解析）
- `%LOCALAPPDATA%\dsh-pet-codex\launch-standalone.vbs`：自动拉起用，每次生成
- 触发器：计划任务 `dsh-pet-on-codex-launch`（见上节）；`scripts/legacy/` 是已停用的旧开机项
- 配置在 `~/.codex/config.toml` 的 `[[hooks.*]]` 与 `[hooks.state.*]` 段

## 自检

```sh
"C:/PROGRA~1/nodejs/node.exe" "D:/WORK/Codex-DeepSeek-pet/hook.js" --check
```

输出 `dsh-pet OK (standalone) · 127.0.0.1:3080 · pet=main` 即正常，括号里是宿主类型
（`standalone` / `dsh`）；`dsh-pet not found` 表示宿主没起来（下次 Codex 会话会自动拉起）。

最近一次 hook 事件记录在 `%LOCALAPPDATA%\dsh-pet-codex\last-event.json`；
详细日志（设 `DSH_PET_CODEX_DEBUG=1` 后写入）在 `%LOCALAPPDATA%\dsh-pet-codex\debug.log`。

想看代码怎么串起来的（hook → HTTP → 桌宠 → 日记），见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；版本变更见 [CHANGELOG.md](CHANGELOG.md)。

## 端口发现

独立模式从 runtime 文件读端口（默认 3080，被占用时自动顺延）；
DSH 的 Web 端口是随机的，脚本先读缓存 `%LOCALAPPDATA%\dsh-pet-codex\port.json`，
失效时扫一遍本机 LISTENING 端口，用 `GET /dsh-pet-7340/config` 探出插件所在端口。

## 手动开关桌宠

隐藏启动（和 hook 用同一份逻辑）：

```sh
wscript "%LOCALAPPDATA%\dsh-pet-codex\launch-standalone.vbs"
```

或直接跑启动器：

```sh
"C:/PROGRA~1/nodejs/node.exe" "D:/WORK/Codex-DeepSeek-pet/src/standalone-launcher.js"
```

关闭：桌宠右键菜单退出，或带 token 请求 `POST http://127.0.0.1:3080/shutdown`。

## 不想要“自动拉起”

- 不想被 Codex 启动触发：禁用计划任务 `dsh-pet-on-codex-launch`
  （`Disable-ScheduledTask -TaskName dsh-pet-on-codex-launch`）；
- 连 hook 的兜底也不要：删除 `src/hook.js` 里的 `ensureHost()` 调用。

## 停用

删掉 `~/.codex/config.toml` 里 `# dsh-pet 桌宠联动` 之后的所有 `[[hooks.*]]`、`[hooks.state.*]`
段即可；也可以保留配置、在 `/hooks` 里把对应 hook 设为 disabled。
