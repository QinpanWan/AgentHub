// AgentHub Agent 注册表:Codex / Claude / dsh
// 每个 Agent 负责:探测可用性、解析模型与思考强度、构建执行命令
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DSH_BIN, HEADLESS_PATCH, DSH_DIR, resolveDshNode, resolveKey, deepSeekKey, parseZshrc, zshEnv } from './config.js';

const HOME = os.homedir();

function safeExec(cmd, args, env, timeout = 8000) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout, env: { ...process.env, ...(env || {}) } }).trim();
  } catch (e) {
    return { err: (e.stderr || e.message || 'unknown').toString().slice(0, 300) };
  }
}

class Agent {
  constructor(def) {
    this.id = def.id;
    this.name = def.name;
    this.icon = def.icon || '◆';
    this.desc = def.desc || '';
    this.cfg = def.cfg;                 // 来自平台配置(模型表等)
    this.available = null;              // null=未探测 true/false
    this.version = null;
    this.detail = '';
    this.probedAt = 0;
    this.taskId = null;                 // 当前运行任务
    this.lastActivityAt = 0;
    this.procs = [];                    // 最近一轮匹配到的进程
    this.supportsReasoningEffort = false;
  }

  enabled() { return !!this.cfg.enabled; }

  resolveModel(model, effort) {
    if (!model || model === 'auto') {
      const m = (this.cfg.effortMap || {})[effort];
      return m || this.cfg.defaultModel || 'auto';
    }
    return model;
  }

  cmd() { return ''; }
  buildEnv() { return {}; }
  buildArgs(model, effort, prompt) { return []; }
  cwd() { return HOME; }
  timeoutMs(maxMinutes) { return (maxMinutes || 30) * 60000; }
  // 输出解析模式:null=原样输出;'ndjson'=按 NDJSON 行解析,只提取 agent_message 文本
  outputParser = null;

  // 探测:子类覆盖
  probe() { this.available = true; }

  ensureProbed() {
    if (this.available !== null && Date.now() - this.probedAt < 60000) return;
    this.probe();
    this.probedAt = Date.now();
  }
}

class CodexAgent extends Agent {
  constructor(cfg) {
    super({ id: 'codex', name: 'Codex', icon: '⌘', desc: 'OpenAI Codex CLI(鸿蒙移植,直连 DeepSeek)', cfg });
  }

  cmd() { return 'codex'; }
  outputParser = 'ndjson'; // codex exec --json:NDJSON 流,提取 agent_message 文本(绕开交互 banner/两遍/警告)

  probe() {
    const v = safeExec('codex', ['--version'], this.buildEnv());
    if (v && typeof v === 'string' && !v.err) {
      this.available = true;
      this.version = v.replace(/^codex-cli\s*/i, '').slice(0, 40);
      this.detail = '';
      // 探测 reasoning-effort 支持
      const h = safeExec('codex', ['exec', '--help'], this.buildEnv());
      this.supportsReasoningEffort = typeof h === 'string' && /reasoning[- ]effort/.test(h);
    } else {
      this.available = false;
      this.version = null;
      this.detail = `未找到 codex 命令(参考 github.com/Entity-Him/codex-harmonyos 安装): ${(v && v.err) || 'command not found'}`;
    }
  }

  buildEnv() {
    const prov = this.cfg.provider || {};
    const env = {};
    // 自定义提供商:baseURL 注入 OPENAI_BASE_URL(codex/OpenAI SDK 标准 env)
    if (prov.baseURL) env.OPENAI_BASE_URL = prov.baseURL;
    const keyEnv = prov.apiKeyEnv || 'DEEPSEEK_API_KEY';
    const key = process.env[keyEnv] || resolveKey(keyEnv, keyEnv);
    if (key) env[keyEnv] = key;
    const ssl = '/etc/ssl/certs/cacert.pem';
    if (fs.existsSync(ssl)) env.SSL_CERT_FILE = ssl;
    env.CODEX_HOME = path.join(HOME, '.codex');
    const tmp = path.join(HOME, '.codex', 'tmp');
    try { fs.mkdirSync(tmp, { recursive: true }); } catch { /* ignore */ }
    env.TMPDIR = tmp;
    return env;
  }

  buildArgs(model, effort, prompt) {
    const args = ['exec', '--json', '--skip-git-repo-check'];
    // 鸿蒙无 bwrap 沙箱(权限被拒),任何沙箱/自动评审模式都会失败;
    // 必须无沙箱直连(等同用户终端权限),否则工具调用任务卡死
    args.push('--dangerously-bypass-approvals-and-sandbox');
    const m = this.resolveModel(model, effort);
    if (m && m !== 'auto') args.push('--model', m);
    args.push(String(prompt || ''));
    return args;
  }
}

class ClaudeAgent extends Agent {
  constructor(cfg) {
    super({ id: 'claude', name: 'Claude', icon: '✦', desc: 'Claude Code CLI(经 npx,支持 DeepSeek 兼容层)', cfg });
  }

  // 解析终端 alias(如 alias claude="npx @anthropic-ai/claude-code@2.1.112")
  pkg() {
    const alias = (parseZshrc().aliases || {}).claude || '';
    const m = alias.match(/@anthropic-ai\/claude-code(?:@([\w.\-]+))?/);
    if (m) return m[1] ? `@anthropic-ai/claude-code@${m[1]}` : '@anthropic-ai/claude-code';
    return '@anthropic-ai/claude-code';
  }

  cmd() { return 'npx'; }

  probe() {
    const pkg = this.pkg();
    // 快速探测:--no-install 只查 npx 缓存,不触发下载
    const v = safeExec('npx', ['--no-install', pkg, '--version'], this.buildEnv(), 15000);
    if (v && typeof v === 'string' && !v.err) {
      this.available = true;
      this.version = v.trim().slice(0, 40);
      this.detail = `经 npx ${pkg} · 终端 alias 已识别`;
      return;
    }
    // 兜底:检查 npx 缓存目录
    try {
      const npxDir = path.join(HOME, '.npm', '_npx');
      let found = 0;
      for (const d of fs.readdirSync(npxDir)) {
        if (fs.existsSync(path.join(npxDir, d, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'))) found++;
      }
      if (found > 0) {
        this.available = true;
        this.version = 'npx 缓存';
        this.detail = `${pkg} 已缓存(${found} 份),可直接执行`;
        return;
      }
    } catch { /* ignore */ }
    this.available = false;
    this.version = null;
    this.detail = `未找到 claude-code。终端里的 claude 是 zsh alias → npx ${pkg};安装:echo 'alias claude="npx @anthropic-ai/claude-code@2.1.112"' >> ~/.zshrc && source ~/.zshrc`;
  }

  buildEnv() {
    const prov = this.cfg.provider || {};
    const env = {};
    // DeepSeek 兼容层:baseURL 与鉴权
    const baseURL = prov.baseURL || zshEnv('ANTHROPIC_BASE_URL') || 'https://api.deepseek.com/anthropic';
    env.ANTHROPIC_BASE_URL = baseURL;
    const keyEnv = prov.apiKeyEnv || 'ANTHROPIC_AUTH_TOKEN';
    let token = process.env[keyEnv] || zshEnv(keyEnv) || resolveKey(keyEnv, keyEnv);
    if (!token) token = deepSeekKey(); // 兼容层 AUTH_TOKEN 即 DeepSeek Key
    if (token) env[keyEnv] = token;
    // 模型档位(DeepSeek 兼容层)
    env.ANTHROPIC_MODEL = zshEnv('ANTHROPIC_MODEL') || 'deepseek-v4-pro[1m]';
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = zshEnv('ANTHROPIC_DEFAULT_OPUS_MODEL') || 'deepseek-v4-pro[1m]';
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = zshEnv('ANTHROPIC_DEFAULT_SONNET_MODEL') || 'deepseek-v4-pro[1m]';
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = zshEnv('ANTHROPIC_DEFAULT_HAIKU_MODEL') || 'deepseek-v4-flash';
    env.CLAUDE_CODE_SUBAGENT_MODEL = zshEnv('CLAUDE_CODE_SUBAGENT_MODEL') || 'deepseek-v4-flash';
    return env;
  }

  buildArgs(model, effort, prompt) {
    const args = ['-y', this.pkg(), '-p', '--dangerously-skip-permissions', '--model', this.resolveModel(model, effort)];
    args.push(String(prompt || ''));
    return args;
  }
}

class DshAgent extends Agent {
  constructor(cfg) {
    super({ id: 'dsh', name: 'dsh', icon: '◈', desc: 'DeepSeek Harness(headless 模式执行任务)', cfg });
  }

  cmd() { return resolveDshNode(); }

  probe() {
    if (!fs.existsSync(DSH_BIN)) {
      this.available = false;
      this.detail = `未找到 dsh 安装:${DSH_BIN}(参考 github.com/Entity-Him/dsh-harmonyos-pc)`;
      return;
    }
    if (!fs.existsSync(HEADLESS_PATCH)) {
      this.available = false;
      this.detail = `缺少 headless 适配补丁:${HEADLESS_PATCH}`;
      return;
    }
    const nodePath = this.cmd();
    const v = safeExec(nodePath, ['--version']);
    if (v && typeof v === 'string' && !v.err) {
      this.available = true;
      this.version = `${v}`;
      this.detail = `headless 补丁已就位,node=${nodePath}(补丁已禁用 zstd 依赖的持久化插件)`;
    } else {
      this.available = false;
      this.detail = `node 不可用(${nodePath}):${(v && v.err) || ''}`;
    }
  }

  buildEnv() { return { NO_COLOR: '1' }; }

  cwd() { return DSH_DIR; }

  buildArgs(model, effort, prompt) {
    return ['--expose-internals', DSH_BIN, '--profile', 'headless', '--patch', HEADLESS_PATCH, String(prompt || '')];
  }
}

export class Agents {
  constructor({ config, logstore, monitor }) {
    this.config = config;
    this.logstore = logstore;
    this.monitor = monitor;
    this.map = new Map();
    for (const id of ['codex', 'claude', 'dsh']) {
      const def = config.agents[id] || {};
      const cls = id === 'codex' ? CodexAgent : (id === 'claude' ? ClaudeAgent : DshAgent);
      this.map.set(id, new cls(def));
    }
    this._probeTimer = null;
  }

  get(id) { return this.map.get(id); }
  list() { return [...this.map.values()]; }

  start() {
    this.probeAll();
    this._probeTimer = setInterval(() => this.probeAll(), 120000); // 每 2 分钟复测
    if (this._probeTimer.unref) this._probeTimer.unref();
  }
  stop() { if (this._probeTimer) clearInterval(this._probeTimer); }

  probeAll() {
    for (const a of this.list()) {
      try { a.probe(); a.probedAt = Date.now(); } catch (e) {
        a.available = false;
        a.detail = String(e.message || e).slice(0, 200);
      }
    }
  }

  // 刷新进程占用:由 monitor 轮询后调用
  refreshProcs() {
    if (!this.monitor || !this.monitor.latest) return;
    const procs = this.monitor.latest.procs;
    for (const id of ['codex', 'claude', 'dsh']) {
      this.get(id).procs = this.monitor.matchProcs(procs, this.matchers(id));
    }
  }

  // 各 Agent 的进程匹配器(只算"活跃任务/服务"进程,不算辅助/残留进程)
  matchers(id) {
    if (id === 'codex') {
      return [
        // 真实任务进程:codex exec ... (含平台派发与用户终端运行)
        p => p.comm === 'codex' && /(^|\s)exec(\s|$)/.test(p.args),
        p => p.comm === 'codex' && p.args.includes('--model'),
        // 平台通过 runner 派发的(路径含 .local/bin/codex)
        p => p.args.includes('.local/bin/codex') && p.args.includes('exec')
      ];
    }
    if (id === 'claude') {
      // npx/node 进程的 args 含 claude-code(用户终端会话与平台派发任务都算)
      return [
        p => p.args.includes('claude-code') || p.args.includes('@anthropic-ai/claude-code')
      ];
    }
    if (id === 'dsh') {
      return [p => p.args.includes('dsh/lib/bin.js')];
    }
    return [];
  }

  // 由快照 procs 计算某 Agent 的占用
  aggregateFrom(id, procs) {
    if (!this.monitor) return { cpu: 0, mem: 0, rss: 0, pids: [] };
    return this.monitor.aggregate(this.monitor.matchProcs(procs, this.matchers(id)));
  }

  snapshot() {
    this.refreshProcs();
    const now = Date.now();
    return this.list().map(a => {
      const agg = this.monitor ? this.monitor.aggregate(a.procs) : { cpu: 0, mem: 0, rss: 0, pids: [] };
      // 进程命令行摘要(用于展示"正在做什么")
      const argLine = a.procs.length
        ? a.procs.slice(0, 2).map(p => p.args || p.comm || '').filter(Boolean).join(' ⏵ ')
        : '';
      const idleFor = a.lastActivityAt ? Math.round((now - a.lastActivityAt) / 1000) : null;
      return {
        id: a.id,
        name: a.name,
        icon: a.icon,
        desc: a.desc,
        enabled: a.enabled(),
        available: a.available,
        version: a.version,
        detail: a.detail,
        probedAt: a.probedAt,
        running: !!a.taskId,
        taskId: a.taskId,
        idleFor,
        proc: { ...agg, args: argLine.slice(0, 140) },
        models: a.cfg.models || [],
        defaultModel: a.cfg.defaultModel || 'auto',
        effortMap: a.cfg.effortMap || {},
        note: a.cfg.note || '',
        supportsReasoningEffort: a.supportsReasoningEffort
      };
    });
  }
}
