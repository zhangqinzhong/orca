# Orca Agent 编排系统架构

## 概述

Orca 的编排系统采用 **Coordinator + Worker** 架构，运行在 Electron 主进程中。一个 Coordinator 管理多个 Worker Agent，通过 SQLite 持久化状态，通过 PTY stdin 注入任务指令。

核心文件：
- `src/main/runtime/orchestration/coordinator.ts` — 轮询调度引擎
- `src/main/runtime/orchestration/db.ts` — SQLite 持久化（5 张表）
- `src/main/runtime/orchestration/preamble.ts` — 注入到 Worker 终端的任务指令
- `src/main/runtime/orchestration/types.ts` — 核心类型定义
- `src/main/runtime/orchestration/groups.ts` — Agent 组寻址
- `src/main/runtime/orchestration/lifecycle-reconciliation.ts` — 生命周期验证
- `src/main/runtime/orchestration/formatter.ts` — 消息横幅格式化
- `src/main/runtime/rpc/methods/orchestration.ts` — RPC API 层
- `src/main/runtime/rpc/methods/orchestration-gates.ts` — 决策门 + 运行控制
- `src/main/runtime/orca-runtime.ts` — Runtime 集成（推送、心跳、退出处理）

## 一、整体架构

```
  CLI / RPC 客户端
        │
        ▼
  ┌─────────────────────┐
  │ Coordinator 实例     │  轮询循环，每次 tick：
  │                      │    processMessages()    读取收件箱
  │  coordinator.ts      │    processEscalations() 处理上报
  │                      │    processDecisionGates()检查阻塞门
  │  tick() 循环         │    warnStaleDispatches()警告挂起
  │  sleep(2000ms)       │    dispatchReadyTasks() 分配新任务
  └────────┬────────────┘    checkConvergence()   检查完成
           │
           │ CoordinatorRuntime 接口
           ▼
  ┌─────────────────────┐
  │ Orca Runtime        │  管理终端、PTY、句柄
  │                      │  push-on-idle 消息送达
  │  orca-runtime.ts     │  agent 退出时 failDispatch
  │                      │  heartbeat / worker_done 路由
  └────────┬────────────┘
           │
           │ SQLite 持久化
           ▼
  ┌─────────────────────┐
  │ OrchestrationDb      │  messages / tasks / dispatch_contexts
  │                      │  decision_gates / coordinator_runs
  │  db.ts               │  5 张表，schema v5
  └─────────────────────┘
```

## 二、Coordinator 轮询循环

`Coordinator` 是核心调度引擎。

### 状态机阶段

```
decomposing → dispatching → monitoring → merging → done
```

### run() → executeLoop()

```typescript
async run() {
  this.db.createCoordinatorRun({ runId, worktree, spec })
}

async executeLoop() {
  this.decompose()          // 验证有预创建的任务
  while (!this.stopped) {
    await this.tick()
    await sleep(2000)        // 2 秒间隔
  }
  this.checkConvergence()   // 写入最终状态
}
```

### tick() 六步

```typescript
private async tick() {
  this.processMessages()       // 1. 读取收件箱
  this.processEscalations()    // 2. 处理上报
  this.processDecisionGates()  // 3. 检查阻塞门
  this.warnStaleDispatches()   // 4. 警告挂起 Worker
  await this.dispatchReadyTasks() // 5. 分配新任务
  return this.checkConvergence() // 6. 检查是否全部完成
}
```

一次只有一个 Coordinator 可以运行（DB 级别 `getActiveCoordinatorRun()` 保证）。

## 三、任务生命周期

### 状态机

```
pending → ready → dispatched → completed
                      ↓            ↑
                   failed ──→ (重试 < 3 次)
                      ↓
                 circuit_broken → task failed
                      ↑
                  blocked (等待决策门裁决)
```

### 创建任务

通过 RPC `orchestration.taskCreate`：

```typescript
createTask({ spec, deps, createdBy }) {
  const id = `task_${randomHex(12)}`
  const status = deps.length > 0 ? 'pending' : 'ready'
  // 插入 tasks 表
}
```

### DAG 依赖解析

依赖以 JSON 数组存储。任务完成时自动检查并提升依赖已满足的 pending 任务：

```typescript
// 当任务完成时
updateTaskStatus(taskId, 'completed')
  → promoteReadyTasks(taskId)
    // 扫描所有 pending 任务
    // 如果某任务的所有 deps 都 completed → status = 'ready'
```

无环检测——循环依赖只会导致任务永远 pending。

### 分配任务

`dispatchReadyTasks()` 的完整流程：

1. 查询所有 ready 任务
2. 并发限制检查：`slots = maxConcurrent - dispatched.length`（默认 4）
3. 获取可用终端（排除 Coordinator 自己的、已有活跃 dispatch 的、断开的）
4. 若无空闲终端则创建新终端，标题为 `"Worker: <spec 前 40 字符>"`
5. 对每个 (task, terminal) 执行 `dispatchTask()`

### dispatchTask() 核心

```
步骤 A: 基线漂移检查
  if worktree 落后 > 20 commits && 未标记 allow-stale-base:
    跳过（不消耗熔断预算，下个 tick 重试）

步骤 B: 创建 dispatch_context
  createDispatchContext(taskId, terminalHandle)
  → 锁定终端、继承 failure_count、设置 status='dispatched'

步骤 C: 构建并注入 Preamble
  preamble = buildDispatchPreamble({ taskId, dispatchId, spec, ... })
  runtime.sendTerminal(handle, { text: preamble, enter: true })

步骤 D: 熔断检查
  if sendTerminal 失败:
    failDispatch() → failure_count + 1
    if failure_count >= 3: circuit_broken → task failed
```

## 四、Preamble 注入

Preamble 是注入到 Worker 终端 PTY 的任务指令文本。由 `buildDispatchPreamble()` 构建：

```
=== DISPATCH ===
Coordinator: term_abc123
Task ID: task_def456
Dispatch ID: disp_ghi789

## CLI Commands

# Worker Done
orca orchestration send --to <coordinator> --type worker_done \
  --subject "success|failure" --body "<summary>" \
  --task-id <taskId> --dispatch-id <dispatchId>

# Heartbeat (每 5 分钟)
orca orchestration send --to <coordinator> --type heartbeat \
  --subject "alive" --task-id <taskId> --dispatch-id <dispatchId> \
  --phase "<当前阶段>"

# 提问
orca orchestration ask --to <coordinator> \
  --subject "<问题>" --task-id <taskId>

# 上报
orca orchestration send --to <coordinator> --type escalation \
  --subject "<问题>" --body "<详情>" --task-id <taskId>

# 检查收件箱
orca orchestration check --task-id <taskId>

## After Worker Done
完成后保持 10 分钟，每 2 分钟轮询一次收件箱，等待后续任务

[如果存在 base drift：显示最近 5 commits]

=== TASK ===
<用户的任务 spec>
```

## 五、Agent 间通信

### 消息表结构

| 字段 | 说明 |
|------|------|
| id | `msg_<xx>` |
| from_handle | 发送方终端句柄 |
| to_handle | 接收方（点对点或组地址） |
| type | 8 种类型之一 |
| thread_id | ask/check 线程 ID |
| read | 是否已读 |
| delivered_at | push-on-idle 送达时间戳 |

### 消息类型

```
status | dispatch | worker_done | merge_ready | escalation
handoff | decision_gate | heartbeat
```

### Push-on-Idle 机制

这是 Worker 收到消息的核心方式：

```
Agent 变为 idle
  ↓
Runtime 检测到状态转换 (agentStatus === 'idle')
  ↓
deliverPendingMessages(leaf):
  1. 查询该终端未送达的消息
  2. 格式化为横幅文本
  3. 写入 PTY stdin
  4. 500ms 后发 \r 提交
  5. 标记为已送达
```

Worker 不需要轮询——消息在它空闲时自动推送到终端。

### Ask（阻塞问答）

```typescript
// Worker 端
orca orchestration ask --to <coordinator> --subject "需要人工决策"

// Coordinator 收到后创建 decision_gate，阻塞任务
// 人工通过 gateResolve 裁决
orca orchestration gateResolve --gate-id <id> --resolution "通过"
// → 任务重新 ready，下次分配时 preamble 后面附上裁决结果
```

## 六、决策门

决策门是人工干预检查点：

```
Worker ask → Coordinator 收到 → 创建 decision_gate (pending)
  → 任务状态 → blocked
  → 人工裁决 gateResolve(approved/rejected)
  → 门状态 → resolved
  → 任务状态 → ready（重新排队分配）
  → 下次 dispatch 时 preamble 附上 "--- DECISION GATE RESOLVED ---"
```

## 七、心跳和熔断

### 心跳

- Preamble 指示 Worker 每 **5 分钟**发送心跳
- 包含 `--phase` 参数描述当前进度
- `recordHeartbeat(dispatchId, at)` 写入 `last_heartbeat_at`

### 挂起检测

- `HUNG_THRESHOLD_MS = 10 分钟`（心跳间隔的 2 倍）
- `warnStaleDispatches()` 扫描无心跳的 dispatch
- 只警告，不自动失败

### 熔断器

```
failure_count 累积（跨 dispatch 继承）

第 1 次失败 → failed → 任务 → ready（重试）
第 2 次失败 → failed → 任务 → ready（重试）
第 3 次失败 → circuit_broken → 任务 → failed（不再重试）
```

基线漂移导致的跳过不计入 failure_count。

### Agent 崩溃处理

Runtime 检测到 agent 进程退出时：
```typescript
failActiveDispatchOnExit(leaf, exitCode):
  1. 立即失败当前 dispatch
  2. 向 Coordinator 发送 escalation 消息
  3. 不等待心跳超时
```

## 八、终端分配

### 句柄系统

- 终端创建时分配 `term_<uuid>` 句柄
- 作为 `ORCA_TERMINAL_HANDLE` 环境变量传给 agent 进程
- 句柄映射到 `(tabId, leafId, ptyId)` — PTY 转移时失效

### 分配规则

```typescript
getAvailableTerminals(worktree):
  1. 列出该 worktree 下所有终端
  2. 排除 Coordinator 自己的终端
  3. 排除已有活跃 dispatch 的终端
  4. 排除断开/不可写的终端
  5. 若没有空闲终端 → 创建新终端
```

### 终端复用

- Worker done 后，终端保持 10 分钟等待后续任务
- DB 级别通过 `assignee_handle` 锁防止双重分配
- 同一终端可以先后执行不同任务

## 九、组寻址

支持向多个 Worker 同时发消息：

| 组地址 | 目标 |
|--------|------|
| `@all` | 除发送方外的所有终端 |
| `@idle` | 所有空闲终端 |
| `@claude` | 标题含 "claude" 的终端 |
| `@codex` | 标题含 "codex" 的终端 |
| `@gemini` | 标题含 "gemini" 的终端 |
| `@worktree:<id>` | 指定 worktree 的全部终端 |

解析发生在发送时。每条消息独立插入（共享 thread_id），独立追踪已读状态。

注意：`worker_done` 和 `heartbeat` 不能发到组地址。

## 十、完整流程图

```
1. 创建任务
   $ orca orchestration task-create --spec "修复 bug" --deps '["task_01"]'
   → 状态 pending（等待 task_01 完成）

2. 启动 Coordinator
   $ orca orchestration run --spec "日常维护" --worktree main
   → 创建 coordinator_runs 记录
   → 后台启动轮询循环

3. 调度循环（每 2 秒）
   tick():
   ├── processMessages()
   │   ├── worker_done → 标记任务完成 → promoteReadyTasks()
   │   ├── heartbeat → 记录心跳
   │   └── escalation → 失败 dispatch
   ├── processEscalations()
   ├── processDecisionGates()
   ├── warnStaleDispatches()  // >10 分钟无心跳
   ├── dispatchReadyTasks()
   │   ├── 查 ready 任务
   │   ├── 查空闲终端（或无则创建）
   │   ├── 检查 base drift
   │   ├── 创建 dispatch context
   │   ├── 构建 preamble
   │   └── 注入到 Worker PTY
   └── checkConvergence()

4. Worker 收到 preamble → 看到 "=== TASK ===" → 开始工作
   每 5 分钟: orca orchestration send --type heartbeat

5. Worker 完成:
   orca orchestration send --type worker_done --task-id X --dispatch-id Y
   → Coordinator 收件箱 → reconcileLifecycleMessage() 验证
   → updateTaskStatus('completed')
   → promoteReadyTasks()（推进 DAG）

6. Push-on-Idle:
   Worker 变为 idle → deliverPendingMessages()
   → 未读消息推送到终端 stdin

7. 完成:
   Coordinator 发现所有任务 completed/failed
   → coordinator_runs 状态 → completed
```

## 十一、关键设计决策

1. **无中心消息队列** — 消息存储在 SQLite，Worker 通过 push-on-idle 接收，不依赖内存队列
2. **终端即 Worker** — 没有虚拟 Worker 概念，每个 Worker 就是一个真实的终端 PTY
3. **Preamble 即协议** — Worker 通过注入的 CLI 命令与 Coordinator 通信，不需要额外的 RPC 通道
4. **熔断器跨 dispatch 累积** — 同一个 task 的 failure_count 在重试间继承
5. **基线漂移保护** — 默认拒绝在落后超过 20 commits 的 worktree 上分配任务
6. **决策门不恢复 dispatch** — 裁决后任务重新排队，Worker 需要重新连接

## 十二、编排系统 vs 普通终端流程

| | 普通终端 | 编排 Worker |
|------|------|------|
| 交互方式 | 人在终端输入 | Preamble 自动注入 |
| 消息传递 | 无 | SQLite + push-on-idle |
| 任务分配 | 手动 | Coordinator 自动 |
| 状态追踪 | 无 | DAG + dispatch context |
| 失败处理 | 手动 | 熔断器 + 自动重试 |
| 并发 | 单个 | 最多 4 个并发 Worker |
