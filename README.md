# AgentHub · 鸿蒙 PC 跨 Agent 管理平台

集中管理 **Codex / Claude / dsh** 三个 Agent 的轻量管理平台：实时资源与工作状况监控、报错收集、对话窗任务派发（选 Agent / 选模型 / 选思考强度）、Agent 启停、插件与技能管理。纯 Node 零依赖，Web UI 商务简约风，部署启动走 **HiShell 指令**（`sh hish ...`）。

- 运行时：Node ≥ 18（本机实测 v22.7.0）
- 服务：127.0.0.1:8899（可用 `HUB_PORT` 覆盖）
- 依赖：**零 npm 依赖**（仅 node 内置模块），无原生二进制

---

## 架构

```
┌────────────────────────── HiShell 终端 (sh hish start) ─────────────────────────┐
│                                                                                   │
│  AgentHub  (server/index.js, 纯 Node, 零依赖)                                     │
│  ├── monitor    /proc 直读 + ps 兜底, 2s 采样系统/进程 CPU、内存、负载、磁盘        │
│  ├── runner     任务队列(每 Agent 串行) + SSE 流式输出 + 取消 + 持久化             │
│  ├── logstore   环形日志 + stderr 错误模式识别 + 落盘 data/logs/                   │
│  ├── agents     codex / claude / dsh 执行器(探测·启停·模型/强度映射)              │
│  └── plugins    dsh 插件(plugins-src)与 Skills 扫描·启停(带备份)                  │
│        │                                                                          │
│        ├──→ codex exec (DeepSeek 直连)                                            │
│        ├──→ claude -p (未安装时优雅降级)                                          │
│        └──→ node dsh/bin.js --profile headless (鸿蒙适配补丁)                     │
└──────── Web UI (web/, 商务简约风, 无框架) ◀── 浏览器 http://127.0.0.1:8899 ────────┘
```

## 快速开始（HiShell）

在鸿蒙 PC 的 **HiShell 终端**中：

```sh
sh hish deploy        # 首次部署:校验 node、建数据目录、检查 headless 补丁
sh hish start         # 启动(幂等,带健康检查,失败自动回滚提示)
sh hish status        # 运行状态 + 最近日志
sh hish stop          # 停止
sh hish restart       # 重启
sh hish log           # 跟踪日志
sh hish test          # 单元自测(无需服务在线)
```

然后浏览器访问 **http://127.0.0.1:8899**。

## 功能

| 页面 | 能力 |
|---|---|
| 概览 | 系统资源(CPU/内存/磁盘/负载)、Agent 在线状态与进程占用、任务计数、一键巡检全部 Agent、最近任务 |
| 任务控制台 | 对话窗写下任务 → 点选 Agent(Codex/Claude/dsh) → 选模型 → 选思考强度(低/中/高) → 发送;SSE 实时滚动输出;取消;历史重跑/查看 |
| Agent 管理 | 每 Agent 可用性探测、版本、进程占用、启用/停用(停用即终止其运行中任务)、强度映射展示 |
| 运行监控 | 系统 + 三 Agent 实时 CPU/内存条、趋势曲线(最近 200 点)、pid 明细 |
| 日志与报错 | 实时日志(按 Agent 过滤)、报错收集(错误模式识别 + 24h 分布 + 上下文) |
| 插件与技能 | dsh 插件(plugins-src)浏览/启停(改 profile 配置,自动备份,需重启 dsh 生效)、Skills 浏览/开关 |
| 设置 | 轮询间隔/任务超时/排队上限、每 Agent 模型列表与强度映射、dsh Web 服务(3080)启停重启、HiShell 说明 |

**思考强度与模型**：`低/中/高` 映射到模型（可在设置页调整），如 Codex 默认 低→`deepseek-v4-flash`、高→`deepseek-v4-pro`；Codex 若支持 `--reasoning-effort` 会自动附加原生强度参数（探测时检测）。

## Agent 支持矩阵（本机实测）

| Agent | 命令 | 状态 | 备注 |
|---|---|---|---|
| Codex | `codex exec --skip-git-repo-check` | ✅ 实测通过 | 直连 DeepSeek,自动注入 `DEEPSEEK_API_KEY`(读 `~/.dsh/.credentials.yaml`)、`SSL_CERT_FILE`、`CODEX_HOME/TMPDIR` |
| dsh | `node .../dsh/lib/bin.js --profile headless` | ✅ 实测通过 | 使用 agent-hub 内置扩展补丁(禁 zstd 持久化与原生插件行);node 用 PATH 版(鸿蒙 v24 node 会原生崩溃,已规避) |
| Claude | `claude -p` | ⚠ 未安装 | 平台正常管理;任务会明确提示安装命令 `npm i -g @anthropic-ai/claude-code` |

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/status` | 系统 + Agents + 计数 + dsh 服务状态 |
| GET | `/api/agents` | Agent 快照 |
| POST | `/api/agents/:id/start\|stop\|probe` | 启停/重探测 |
| GET | `/api/monitor?n=` | 系统与逐 Agent 历史序列 |
| GET | `/api/logs?agent=&limit=` | 日志 |
| GET/DELETE | `/api/errors` | 报错列表/清空 |
| POST | `/api/tasks` | 提交任务 `{agentId, model, effort, prompt}` |
| GET | `/api/tasks` `/api/tasks/:id` | 任务列表/详情 |
| GET | `/api/tasks/:id/stream` | SSE 事件流(`queued/started/chunk/done/failed/cancelled/end`) |
| POST | `/api/tasks/:id/cancel` | 取消 |
| POST | `/api/oneclick/inspect` | 一键巡检全部 Agent |
| GET | `/api/plugins` `/api/skills` | 插件/技能列表 |
| POST | `/api/plugins/:id/toggle` | 启停 dsh 插件(需 `confirm:true`,自动备份,重启 dsh 生效) |
| POST | `/api/skills/:id/toggle` | 技能开关(平台侧) |
| GET/POST | `/api/settings` | 配置读写 |
| GET | `/api/dsh/service` | dsh Web(3080)服务状态 |
| POST | `/api/dsh/start\|stop\|restart` | dsh Web 服务控制 |

## 配置

- 默认配置内置在 `server/config.js`；用户覆盖写入 `data/config.json`（设置页修改后自动保存）。
- 环境变量：`HUB_PORT`（端口）、`HUB_NODE`（node 路径）、`DSH_NODE`（dsh headless 用 node）、`DSH_DIR`（dsh 安装目录，默认 `~/dsh-test`）、`DSH_WEB_SCRIPT`（dsh web 启动脚本，默认 `~/bin/dsh-web.sh`）。
- 数据目录：`data/`（配置、日志、任务历史、备份）。

## 鸿蒙适配要点（实测沉淀）

1. **进程监控不走 `ps -o 'pid=,pcpu=...'`**：鸿蒙 ps(busybox/toybox)不支持 GNU 字段写法 → 平台改为 `/proc` 直读（comm/cmdline/stat/statm），ps 仅兜底。
2. **dsh headless 需要扩展补丁**：`dsh-session-persistence-jsonl` 依赖 `node:zlib` 的 zstd 导出（Node≥22.15），而本机 PATH node 为 v22.7；且 `/data/service` 的 v24 node 在 headless 下会原生 errno 崩溃。agent-hub 内置补丁额外禁用了 `session-persistence-jsonl`、`session-checkpoint-policy`，使 v22.7 可完整跑 headless（一次性任务不依赖会话持久化）。
3. **凭据自动注入**：从 `~/.dsh/.credentials.yaml` 解析 `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` 注入执行环境，不落盘、不打印。
4. **dsh 插件启停是共享资源变更**：修改 `~/.dsh/profiles/web/package.json` 前自动备份到 `data/backups/`，需显式确认，且要求重启 dsh 才生效；Skills 开关为平台侧记录。

## 限制

- Claude CLI 未安装时其任务会明确报错（平台会给出安装指引），不阻塞其他 Agent。
- dsh headless 每次任务需完整拉起 harness（约 5-10s 启动开销），任务为每 Agent 串行排队。
- 服务仅绑定 127.0.0.1，供本机/局域网内直连使用，未内置鉴权（鸿蒙个人环境默认信任）。

## 致谢

- 鸿蒙 dsh 适配方案与 headless 补丁来源：[Entity-Him/dsh-harmonyos-pc](https://github.com/Entity-Him/dsh-harmonyos-pc)（MIT）
- Codex 鸿蒙移植方案：[Entity-Him/codex-harmonyos](https://github.com/Entity-Him/codex-harmonyos)（MIT）

MIT License。
