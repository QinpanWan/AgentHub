// AgentHub 任务执行器:每 Agent 单任务串行 + 排队,SSE 事件流,取消,持久化
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { TASKS_FILE } from './config.js';

const MAX_OUTPUT = 200000; // 单任务输出上限(字符)
const MAX_EVENTS = 800;

export class Runner {
  constructor({ agents, logstore, config }) {
    this.agents = agents;
    this.logstore = logstore;
    this.config = config;
    this.tasks = new Map();        // id -> task
    this.queues = new Map();       // agentId -> [taskId]
    this.running = new Map();      // agentId -> taskId
    this.children = new Map();     // taskId -> child
    this.listeners = new Map();    // taskId -> Set<cb>
    this._persistTimer = null;
    this._loadPersisted();
  }

  _loadPersisted() {
    try {
      if (fs.existsSync(TASKS_FILE)) {
        const arr = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
        if (Array.isArray(arr)) {
          for (const t of arr.slice(-50)) {
            if (t && t.id) this.tasks.set(t.id, { ...t, events: (t.events || []).slice(-MAX_EVENTS) });
          }
        }
      }
    } catch { /* ignore */ }
  }

  _persist() {
    const arr = [...this.tasks.values()].slice(-50).map(t => ({
      id: t.id, agentId: t.agentId, model: t.model, effort: t.effort,
      prompt: (t.prompt || '').slice(0, 500),
      status: t.status, createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
      exitCode: t.exitCode, error: t.error ? String(t.error).slice(0, 300) : null,
      output: (t.output || '').slice(-5000)
    }));
    try { fs.writeFileSync(TASKS_FILE, JSON.stringify(arr, null, 2)); } catch { /* ignore */ }
  }

  submit({ agentId, model, effort, prompt }) {
    if (!agentId || !this.agents.get(agentId)) throw new Error(`未知 Agent:${agentId}`);
    const agent = this.agents.get(agentId);
    if (!agent.enabled()) throw new Error(`${agent.name} 已停用,请先在 Agent 管理页开启`);
    agent.ensureProbed();
    if (!agent.available) throw new Error(`${agent.name} 不可用:${agent.detail || '未知原因'}`);
    if (!prompt || !String(prompt).trim()) throw new Error('任务内容不能为空');

    const q = this.queues.get(agentId) || [];
    if (q.length >= (this.config.queueLimit || 20)) throw new Error(`${agent.name} 排队已满(${q.length} 个),请稍后再试`);

    const task = {
      id: crypto.randomUUID().slice(0, 8),
      agentId, model: model || 'auto', effort: effort || 'medium',
      prompt: String(prompt),
      status: 'queued', createdAt: Date.now(), startedAt: null, finishedAt: null,
      exitCode: null, error: null, output: '', events: [],
      maxMinutes: this.config.maxTaskMinutes || 30,
      _seq: 0 // 事件序号(SSE 重连重放去重用)
    };
    this.tasks.set(task.id, task);
    q.push(task.id);
    this.queues.set(agentId, q);
    this._emit(task, { type: 'queued', ts: Date.now() });
    this._pump(agentId);
    return this.get(task.id);
  }

  get(id) {
    const t = this.tasks.get(id);
    return t ? { ...t } : null;
  }

  list(limit = 30) {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(t => ({
      id: t.id, agentId: t.agentId, model: t.model, effort: t.effort,
      prompt: (t.prompt || '').slice(0, 120),
      status: t.status, createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
      exitCode: t.exitCode, error: t.error ? String(t.error).slice(0, 200) : null
    }));
  }

  counts() {
    let running = 0, queued = 0, done = 0, failed = 0, cancelled = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'running') running++;
      else if (t.status === 'queued') queued++;
      else if (t.status === 'done') done++;
      else if (t.status === 'failed') failed++;
      else if (t.status === 'cancelled') cancelled++;
    }
    return { running, queued, done, failed, cancelled, total: this.tasks.size };
  }

  onEvent(taskId, cb) {
    if (!this.listeners.has(taskId)) this.listeners.set(taskId, new Set());
    this.listeners.get(taskId).add(cb);
    return () => { const s = this.listeners.get(taskId); if (s) s.delete(cb); };
  }

  _emit(task, ev) {
    ev.seq = ++task._seq; // 单调递增序号,客户端据此跳过重连重放
    task.events.push(ev);
    if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
    const s = this.listeners.get(task.id);
    if (s) for (const cb of s) { try { cb(ev); } catch { /* ignore */ } }
  }

  _pump(agentId) {
    if (this.running.has(agentId)) return;
    const q = this.queues.get(agentId) || [];
    if (!q.length) return;
    const taskId = q.shift();
    this.queues.set(agentId, q);
    const task = this.tasks.get(taskId);
    if (!task) return this._pump(agentId);
    this.running.set(agentId, taskId);
    this._run(task).finally(() => {
      this.running.delete(agentId);
      const agent = this.agents.get(agentId);
      if (agent) agent.taskId = null;
      this._persist();
      this._pump(agentId);
    });
  }

  async _run(task) {
    const agent = this.agents.get(task.agentId);
    if (!agent) return this._fail(task, 'Agent 不存在');
    task.status = 'running';
    task.startedAt = Date.now();
    agent.taskId = task.id;
    agent.lastActivityAt = Date.now();
    this._emit(task, { type: 'started', ts: Date.now(), agentId: agent.id });

    let cmd, args, cwd, env;
    try {
      cmd = agent.cmd();
      args = agent.buildArgs(task.model, task.effort, task.prompt);
      cwd = agent.cwd();
      env = { ...process.env, ...agent.buildEnv() };
    } catch (e) {
      return this._fail(task, `构建执行命令失败:${e.message}`);
    }

    this.logstore.push(task.agentId, 'info', `[task ${task.id}] 开始: ${cmd} ${args.slice(0, 4).map(a => a.length > 60 ? a.slice(0, 60) + '…' : a).join(' ')}`);

    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    this.children.set(task.id, child);
    task._childPid = child.pid;

    // 进程组终止:杀整组(防 npx/dsh 等父进程退出后子进程残留为孤儿)
    const killTree = (sig) => {
      try { process.kill(-child.pid, sig); } catch { /* 组已不存在 */ }
      try { child.kill(sig); } catch { /* ignore */ }
    };
    const timeout = setTimeout(() => {
      killTree('SIGTERM');
      setTimeout(() => { try { killTree('SIGKILL'); } catch { /* ignore */ } }, 3000).unref?.();
      task._timedOut = true;
    }, agent.timeoutMs(task.maxMinutes));
    if (timeout.unref) timeout.unref();

    const buf = { out: '', err: '' };
    const pushChunk = (text, kind) => {
      task.output += text;
      if (task.output.length > MAX_OUTPUT) {
        task.output = task.output.slice(-MAX_OUTPUT);
        task._truncated = true;
      }
      this._emit(task, { type: 'chunk', ts: Date.now(), text, stream: kind });
    };
    const onData = (kind) => (chunk) => {
      const text = chunk.toString();
      buf[kind] += text;
      let idx;
      while ((idx = buf[kind].indexOf('\n')) >= 0) {
        const line = buf[kind].slice(0, idx);
        buf[kind] = buf[kind].slice(idx + 1);
        this.logstore.push(task.agentId, kind === 'err' ? 'stderr' : 'stdout', `[task ${task.id}] ${line.slice(0, 1000)}`);
      }
      pushChunk(text, kind);
    };
    // NDJSON 输出解析(codex --json):逐行解析,只把 agent_message 文本作为输出事件,
    // 绕开交互 banner / 警告 / 重复渲染
    let ndjsonBuf = '';
    const handleNdjsonLine = (line) => {
      if (!line.trim()) return;
      try {
        const ev = JSON.parse(line);
        this.logstore.push(task.agentId, 'stdout', `[task ${task.id}] ndjson:${line.slice(0, 300)}`);
        if (ev.type === 'item.completed' && ev.item) {
          if (ev.item.type === 'agent_message' && ev.item.text) {
            pushChunk(String(ev.item.text), 'out');
          } else if (ev.item.type === 'command_execution' && ev.item.command) {
            // 工具调用透明化:展示 Agent 执行的命令(结果由模型在回复中转述,不重复)
            pushChunk(`\n[🛠 执行命令] ${String(ev.item.command).slice(0, 140)}\n`, 'tool');
          }
          // error 事件(如模型元数据警告)不进输出,避免噪音
        }
      } catch {
        this.logstore.push(task.agentId, 'stdout', `[task ${task.id}] (非JSON行) ${line.slice(0, 200)}`);
      }
    };
    const onNdjsonData = (chunk) => {
      ndjsonBuf += chunk.toString();
      let idx;
      while ((idx = ndjsonBuf.indexOf('\n')) >= 0) {
        const line = ndjsonBuf.slice(0, idx);
        ndjsonBuf = ndjsonBuf.slice(idx + 1);
        handleNdjsonLine(line);
      }
    };
    if (agent.outputParser === 'ndjson') {
      child.stdout.on('data', onNdjsonData);
      child.stdout.on('end', () => { if (ndjsonBuf.trim()) handleNdjsonLine(ndjsonBuf); });
      // NDJSON 模式:stderr 只进日志(交互提示/warning 噪音不进气泡),错误详情在失败时补入 output
      child.stderr.on('data', (chunk) => {
        buf.err += chunk.toString();
        let idx;
        while ((idx = buf.err.indexOf('\n')) >= 0) {
          const line = buf.err.slice(0, idx);
          buf.err = buf.err.slice(idx + 1);
          this.logstore.push(task.agentId, 'stderr', `[task ${task.id}] ${line.slice(0, 1000)}`);
        }
      });
      child.stderr.on('end', () => {
        if (buf.err.trim()) this.logstore.push(task.agentId, 'stderr', `[task ${task.id}] ${buf.err.trim().slice(0, 1000)}`);
      });
    } else {
      child.stdout.on('data', onData('out'));
      child.stderr.on('data', onData('err'));
      // 兜底:stderr 可能带错误模式但无换行
      child.stderr.on('end', () => {
        if (buf.err.trim()) this.logstore.push(task.agentId, 'stderr', `[task ${task.id}] ${buf.err.trim()}`);
      });
    }

    const code = await new Promise((resolve) => {
      child.on('error', (e) => { this.logstore.push(task.agentId, 'error', `[task ${task.id}] spawn 错误:${e.message}`); resolve({ err: e.message }); });
      child.on('close', (c, sig) => resolve({ code: c, sig }));
    });

    clearTimeout(timeout);
    this.children.delete(task.id);
    task.finishedAt = Date.now();
    agent.lastActivityAt = Date.now();

    if (code && code.err) return this._fail(task, `启动失败:${code.err}`);
    if (task._timedOut) return this._fail(task, `执行超时(${task.maxMinutes} 分钟),已终止`);
    if (code.sig === 'SIGTERM' || code.sig === 'SIGKILL') {
      if (task.status === 'cancelled') return; // 取消流程已置状态
      return this._fail(task, `进程被信号终止(${code.sig})`);
    }
    if (code.code === 0) {
      task.status = 'done';
      task.exitCode = 0;
      this._emit(task, { type: 'done', ts: Date.now(), exitCode: 0 });
      this.logstore.push(task.agentId, 'info', `[task ${task.id}] 完成(exit 0)`);
    } else {
      task.status = 'failed';
      task.exitCode = code.code;
      task.error = `退出码 ${code.code}`;
      // NDJSON 模式:把 stderr 错误详情补进输出(气泡可见 API 错误等)
      if (agent.outputParser === 'ndjson' && buf.err.trim()) {
        task.output += `\n\n[stderr] ${buf.err.trim().slice(-800)}`;
      }
      this._emit(task, { type: 'failed', ts: Date.now(), exitCode: code.code });
      this.logstore.push(task.agentId, 'error', `[task ${task.id}] 失败(exit ${code.code})`);
    }
  }

  _fail(task, msg) {
    task.status = 'failed';
    task.error = msg;
    task.finishedAt = Date.now();
    this._emit(task, { type: 'failed', ts: Date.now(), error: msg });
    this.logstore.push(task.agentId, 'error', `[task ${task.id}] ${msg}`);
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === 'running') {
      task.status = 'cancelled';
      task.finishedAt = Date.now();
      task.error = '用户取消';
      const child = this.children.get(id);
      if (child) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ignore */ }
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ } }, 4000).unref?.();
      }
      this._emit(task, { type: 'cancelled', ts: Date.now() });
      return true;
    }
    if (task.status === 'queued') {
      task.status = 'cancelled';
      task.finishedAt = Date.now();
      task.error = '排队中取消';
      const q = this.queues.get(task.agentId) || [];
      this.queues.set(task.agentId, q.filter(x => x !== id));
      this._emit(task, { type: 'cancelled', ts: Date.now() });
      return true;
    }
    return false;
  }

  // 供 http 层注册 SSE 时重放历史事件
  replayEvents(task) {
    return task.events.slice();
  }
}
