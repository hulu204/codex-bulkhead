# codex-bulkhead

让同一台电脑上的多个 Codex 会话共享资源时，减少互相干扰。受 [claude-bulkhead](https://github.com/dooly6276/claude-bulkhead) 启发，复用其 MIT 许可的命令分类器，增加 Codex 原生 hooks、独立任务调度器和本地历史扫描。

Node.js 18+，无运行时 npm 依赖。任务启动器支持 macOS / Linux。**这是协作式保护工具，不是安全沙箱，也不会提高账户的模型额度或修改子代理上限。**

| 功能 | 本版行为 |
|---|---|
| Codex `PreToolUse` | 检查按程序名杀进程、危险删除、破坏性 Git 操作、全盘/并行磁盘扫描 |
| 会话登记 | SessionStart/End、SubagentStart/Stop；不同 actor 独立记录 |
| 工作区保护 | 已登记的其他会话近期使用同一 checkout 时，阻止 checkout、全量暂存等操作 |
| 端口 | 拒绝已知服务启动时的 IPv4 loopback 端口冲突；提供空闲端口建议 |
| `run` | 分配独立端口，按内存余量排队，可选共享并发上限 |
| 生命周期 | 只清理 `run` 自己启动的进程组，不按名字杀进程，不推断其他 Codex 进程归属 |
| `scan` | 只读分析本地 Codex JSONL，不执行历史命令，不返回命令原文 |

## 使用

```sh
git clone https://github.com/hulu204/codex-bulkhead.git
cd codex-bulkhead
node bin/codex-bulkhead doctor
node bin/codex-bulkhead scan --since 30d > scan.json
node bin/codex-bulkhead run --gb 2 -- npm test
node bin/codex-bulkhead status
```

无需安装依赖。也可在审阅源码后 `npm link`，使用 `codex-bulkhead` 命令。不要将个人扫描报告提交到公共仓库。

### Codex 插件

本仓库包含 portable `plugin.json`、`hooks/hooks.json` 和操作 skill，可作为本地插件手动安装。Codex 官方目前支持本地生命周期 hooks；带 hooks 的插件不属于公开插件目录的提交范围。安装后，在 CLI 的 `/hooks` 或桌面 Settings → Hooks 中审阅并信任脚本。**安装、看到配置、`doctor` 成功都不证明 hook 已运行。**

也可在项目 `.codex/hooks.json` 中使用本仓库的 hook 配置，把每个 command 中的 `${PLUGIN_ROOT}` 替换为本仓库的绝对路径。项目配置须受信任，hook 本身也须单独审阅。不要覆盖已有 hooks；将事件处理器合并进现有数组。

官方参考：[Hooks](https://learn.chatgpt.com/docs/hooks)、[插件打包](https://developers.openai.com/plugins/build/plugins)。

### 隔离重任务

```sh
codex-bulkhead run -- sh -c 'npm run dev -- --port "$BULKHEAD_PORT"'
codex-bulkhead run --gb 4 --cwd /path/to/worktree -- npm test
```

`run` 按 argv 启动程序，不自动执行 shell。只有明确使用 `sh -c` 时才做 shell 展开。

新的状态目录默认无固定并发上限。运行前会检查可用内存，保留约 15%（最多 3 GiB）的余量。内存不足的任务按提交顺序等待。可用 `--gb N` 声明预计额外需要的内存（GiB），默认 0 表示未声明。所有任务的声明总额受共享内存预算约束，通常为物理内存的 70%。检查发生在启动前，运行中的任务仍可能使用更多内存。

如需固定并发上限，可在初始化状态目录时传 `--jobs N`。省略该选项会沿用目录已保存的上限。旧版保存的 `maxJobs: 2` 也会保留，因为旧格式无法区分默认值与手动设置。要切换旧目录，先确认没有运行或排队的任务，再把该目录 `limits.json` 的 `maxJobs` 设为 `null`。

`--wait-ms` 默认 60000。`--timeout-ms` 默认 300000，超时返回 124。自定义命令退出码会保留。

`CODEX_BULKHEAD_STATE_DIR` 或 `run --state-dir` 可指定共享状态目录，默认 `~/.codex/bulkhead`。只有共用状态目录的参与者才彼此协调。不要用多个状态目录绕过同一机器的资源预算。

## 扫描与并行度

```sh
codex-bulkhead scan --since 30d
codex-bulkhead scan --since 2026-11-01 --until 2026-11-09T23:59:59+08:00
codex-bulkhead scan --path /path/to/exported/sessions --since 7d
codex-bulkhead scan-db --since 30d
```

默认读取 `~/.codex/sessions` 和 `~/.codex/archived_sessions`。报告区分有起止记录的任务重叠和活跃分钟估算；日志缺失、动态代码、继承的历史内容均会影响覆盖。**规则命中表示值得检查的命令形态，不证明命令被执行、发生损坏或确实应该阻止。** 历史端口占用和可用内存不能从普通会话记录还原。

较新的 Codex 可能将更多历史保存在 `thread_history_1.sqlite`。`scan-db` 使用可选的 Python 3 标准库，只读统计数据库中的完整任务区间；它不读取消息和命令，不把数据库峰值冒充 JSONL 的命令级证据。两种报告覆盖不同，不能相加。可用 `--path` 指定数据库文件。

### 可复现测试

```sh
npm test
npm run test:guards
node bench/parallel.js --levels 1,2,4 --tasks 4
# 以下会消耗真实 Codex 账户额度，需要已有 codex login：
node bench/parallel.js --live --model gpt-6.1-sol --levels 1,2,4,8 --tasks 8 --output reports/live.json
```

实测记录见 [并行测试报告](docs/benchmark.md)。Mock 模式只验证调度器，不能代表模型并行能力。Live 模式验证每个答案，再计算成功率、总时间和 Codex turn 的重叠峰值；失败后停止、不自动重试。

## 已知边界

- hooks 是启发式保护。Codex 在 hook 错误、超时、响应格式错误时可能放行；有些工具路径、已有交互 shell 的 `write_stdin` 不会再次触发前置检查。
- 会话登记使用最近 6 小时的本地记录，不能证明会话此刻正在编辑；未安装本插件的会话不在登记内。子代理的 PreToolUse 若没有 agent_id，无法可靠分辨 actor；同一父会话内的并发写文件仍应使用独立 worktree。
- 端口只是合作任务之间不重复的建议。探测与真正监听之间存在竞争窗口；外部程序仍可能抢占，服务必须检查实际监听结果。IPv6 和特殊绑定配置未保证覆盖。
- SIGINT/SIGTERM/超时只作用于本工具创建的进程组。脱离该进程组的 daemon 不保证被清理。包装进程异常退出时，如果子进程组仍在，名额会保留；无法确认进程已退出也会保守保留。
- 如果进程在持有 admission 锁的短暂窗口被强制终止，后续会报锁超时。工具不自动抢锁；请先确认没有活动任务再人工恢复状态目录。这种故障会停止接纳新任务，不会放宽并发上限。
- 不自动回收任意旧服务，不操作 SSH 远程机器，不修改 Codex 原生并发配置，不自动安装或信任全局 hooks。

## 来源与许可

本项目 MIT。上游作者 Myeongseok-Kang 的版权及完整 MIT 许可保留在 [vendor/claude-bulkhead/LICENSE](vendor/claude-bulkhead/LICENSE)。上游版本、完整 commit 和复用范围见 [PROVENANCE](vendor/claude-bulkhead/PROVENANCE.md)。这不是 OpenAI 或上游作者维护的官方项目。
