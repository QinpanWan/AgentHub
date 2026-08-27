// AgentHub HTTP 层:静态托管 + REST API + SSE 任务流
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { WEB_DIR, DSH_WEB_SCRIPT, DSH_WEB_PID, DSH_WEB_PORT, saveConfig, DSH_DIR } from './config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8'
};

export function createServer({ config, logstore, monitor, agents, runner, plugins, workspaces }) {
  const state = { config, logstore, monitor, agents, runner, plugins, workspaces };

  const server = http.createServer((req, res) => {
    try {
      handle(req, res, state);
    } catch (e) {
      sendErr(res, 500, `服务器内部错误:${e.message}`);
    }
  });
  return server;
}

// ============ 请求处理 ============
async function handle(req, res, s) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const method = req.method;

  // 静态资源
  if (method === 'GET' && (p === '/' || (!p.startsWith('/api') && !p.startsWith('/assets')))) {
    return serveStatic(res, p);
  }
  if (p.startsWith('/api/')) {
    return handleApi(req, res, s, method, p, u);
  }
  sendErr(res, 404, 'Not Found');
}

async function handleApi(req, res, s, method, p, u) {
  const { config, logstore, monitor, agents, runner, plugins, workspaces } = s;
  const seg = p.split('/').filter(Boolean); // ['api', ...]

  // —— 健康检查 ——
  if (p === '/api/health') return sendJson(res, { ok: true, ts: Date.now(), version: '1.0.0' });

  // —— 状态总览 ——
  if (p === '/api/status' && method === 'GET') {
    const dsh = dshServiceStatus();
    const sys = (monitor.latest && monitor.latest.sys) || null;
    // 组装"当前活动":平台任务 → 任务内容;外部进程 → 命令行;dsh 服务 → 服务日志尾
    const agentsList = agents.snapshot().map(a => {
      let activity = null;
      if (a.taskId) {
        const t = runner.get(a.taskId);
        if (t) {
          activity = { type: 'task', taskId: a.taskId, prompt: String(t.prompt || '').slice(0, 90), since: t.startedAt, status: t.status };
        }
      } else if (a.proc.pids && a.proc.pids.length) {
        // dsh 常驻服务:附加其服务日志尾行(展示它正在处理的会话)
        const extra = (a.id === 'dsh' && dsh.running && dsh.logTail)
          ? ' | 服务日志: ' + dsh.logTail.split('\n').pop().slice(0, 120)
          : '';
        activity = { type: 'process', pids: a.proc.pids, args: (a.proc.args || '') + extra };
      } else if (a.id === 'dsh' && dsh.running) {
        activity = { type: 'service', port: dsh.port, logTail: dsh.logTail || '' };
      }
      const recent = logstore.query({ agent: a.id, limit: 3 }).map(l => l.text);
      return { ...a, activity, recentLog: recent.join(' | ').slice(0, 240) };
    });
    return sendJson(res, {
      ts: Date.now(),
      system: sys,
      agents: agentsList,
      counts: {
        tasks: runner.counts(),
        errors: logstore.errorCount(),
        plugins: plugins.listDshPlugins().length,
        skills: plugins.listSkills().length
      },
      dshService: dsh,
      config: { pollMs: config.pollMs, maxTaskMinutes: config.maxTaskMinutes, queueLimit: config.queueLimit, port: config.port }
    });
  }

  // —— Agents ——
  if (p === '/api/agents' && method === 'GET') {
    return sendJson(res, { agents: agents.snapshot() });
  }
  let m = p.match(/^\/api\/agents\/(codex|claude|dsh)\/(start|stop|probe)$/);
  if (m && method === 'POST') {
    const agent = agents.get(m[1]);
    if (!agent) return sendErr(res, 404, 'Agent 不存在');
    if (m[2] === 'probe') {
      agents.probeAll();
      return sendJson(res, { ok: true, agent: agents.snapshot().find(a => a.id === m[1]) });
    }
    if (m[2] === 'start') {
      agent.cfg.enabled = true;
      saveConfig(config);
      agents.probeAll();
      logstore.push('system', 'info', `[agents] ${agent.name} 已启用`);
      return sendJson(res, { ok: true, agent: agents.snapshot().find(a => a.id === m[1]) });
    }
    if (m[2] === 'stop') {
      // 停用:禁用 + 终止其运行中任务
      agent.cfg.enabled = false;
      saveConfig(config);
      for (const t of runner.list(100)) {
        if (t.agentId === m[1] && (t.status === 'running' || t.status === 'queued')) runner.cancel(t.id);
      }
      logstore.push('system', 'info', `[agents] ${agent.name} 已停用(运行中任务已终止)`);
      return sendJson(res, { ok: true, agent: agents.snapshot().find(a => a.id === m[1]) });
    }
  }

  // —— 监控 ——
  if (p === '/api/monitor' && method === 'GET') {
    const n = Math.min(Number(u.searchParams.get('n') || 120), 500);
    const hist = monitor.history.slice(-n);
    const series = {
      sys: { cpu: [], mem: [], load: [] },
      agents: { codex: { cpu: [], mem: [] }, claude: { cpu: [], mem: [] }, dsh: { cpu: [], mem: [] } }
    };
    for (const h of hist) {
      series.sys.cpu.push({ ts: h.ts, v: h.sys.cpu });
      series.sys.mem.push({ ts: h.ts, v: h.sys.mem });
      series.sys.load.push({ ts: h.ts, v: h.sys.load1 });
      for (const id of ['codex', 'claude', 'dsh']) {
        const agg = agents.aggregateFrom(id, h.procs);
        series.agents[id].cpu.push({ ts: h.ts, v: agg.cpu });
        series.agents[id].mem.push({ ts: h.ts, v: agg.mem });
      }
    }
    return sendJson(res, {
      latest: monitor.latest,
      series
    });
  }

  // —— 客户端错误上报(前端 window.onerror 转发,便于远程定位) ——
  if (p === '/api/client-error' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const msg = String(body.msg || body.message || 'client error').slice(0, 500);
    const stack = String(body.stack || '').slice(0, 800);
    const url = String(body.url || '').slice(0, 200);
    logstore.push('client', 'error', `[${url}] ${msg}${stack ? ' | ' + stack : ''}`);
    return sendJson(res, { ok: true });
  }

  // —— 日志 / 报错 ——
  if (p === '/api/logs' && method === 'GET') {
    const agent = u.searchParams.get('agent') || undefined;
    const limit = Number(u.searchParams.get('limit') || 200);
    return sendJson(res, { logs: logstore.query({ agent, limit }) });
  }
  if (p === '/api/errors' && method === 'GET') {
    const limit = Number(u.searchParams.get('limit') || 200);
    return sendJson(res, { errors: logstore.errorsList(limit), stats: logstore.errorStats(24) });
  }
  if (p === '/api/errors' && method === 'DELETE') {
    logstore.clearErrors();
    return sendJson(res, { ok: true });
  }

  // —— 任务 ——
  if (p === '/api/tasks' && method === 'POST') {
    const body = await readBody(req);
    try {
      const task = runner.submit({
        agentId: body.agentId,
        model: body.model || 'auto',
        effort: body.effort || 'medium',
        prompt: body.prompt
      });
      return sendJson(res, { ok: true, task }, 201);
    } catch (e) {
      return sendErr(res, 400, e.message);
    }
  }
  if (p === '/api/tasks' && method === 'GET') {
    return sendJson(res, { tasks: runner.list(Number(u.searchParams.get('limit') || 30)) });
  }
  m = p.match(/^\/api\/tasks\/([a-f0-9-]+)$/);
  if (m && method === 'GET') {
    const task = runner.get(m[1]);
    if (!task) return sendErr(res, 404, '任务不存在');
    return sendJson(res, { task });
  }
  m = p.match(/^\/api\/tasks\/([a-f0-9-]+)\/stream$/);
  if (m && method === 'GET') {
    return sseStream(req, res, runner, m[1]);
  }
  m = p.match(/^\/api\/tasks\/([a-f0-9-]+)\/cancel$/);
  if (m && method === 'POST') {
    const ok = runner.cancel(m[1]);
    return sendJson(res, { ok });
  }

  // —— 一键巡检 ——
  if (p === '/api/oneclick/inspect' && method === 'POST') {
    return oneClickInspect(res, s);
  }

  // —— 插件 / 技能 ——
  if (p === '/api/plugins' && method === 'GET') {
    return sendJson(res, { plugins: plugins.listDshPlugins() });
  }
  m = p.match(/^\/api\/plugins\/([^/]+)\/toggle$/);
  if (m && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    try {
      const r = plugins.toggleDshPlugin(decodeURIComponent(m[1]), { confirm: !!body.confirm });
      return sendJson(res, { ok: true, ...r });
    } catch (e) {
      return sendErr(res, 400, e.message);
    }
  }
  if (p === '/api/skills' && method === 'GET') {
    return sendJson(res, { skills: plugins.listSkills() });
  }
  m = p.match(/^\/api\/skills\/([^/]+)\/toggle$/);
  if (m && method === 'POST') {
    try {
      const r = plugins.toggleSkill(decodeURIComponent(m[1]));
      saveConfig(config);
      return sendJson(res, { ok: true, ...r });
    } catch (e) {
      return sendErr(res, 400, e.message);
    }
  }

  // —— 设置 ——
  if (p === '/api/settings' && method === 'GET') {
    return sendJson(res, { settings: config });
  }
  if (p === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    try {
      // 只允许合并特定字段,防越权写死
      const patch = {};
      if (body.pollMs && Number(body.pollMs) >= 500) patch.pollMs = Number(body.pollMs);
      if (body.maxTaskMinutes && Number(body.maxTaskMinutes) >= 1) patch.maxTaskMinutes = Number(body.maxTaskMinutes);
      if (body.workspaces && Array.isArray(body.workspaces.roots)) {
        patch.workspaces = { roots: body.workspaces.roots.map(String).slice(0, 10) };
      }
      if (body.agents && typeof body.agents === 'object') {
        patch.agents = {};
        for (const id of ['codex', 'claude', 'dsh']) {
          const a = body.agents[id];
          if (!a) continue;
          const cur = config.agents[id] || {};
          const na = { ...cur };
          if (Array.isArray(a.models) && a.models.length) na.models = a.models.map(String).slice(0, 12);
          if (a.defaultModel) na.defaultModel = String(a.defaultModel);
          if (a.effortMap && typeof a.effortMap === 'object') na.effortMap = { ...cur.effortMap, ...a.effortMap };
          if (a.provider && typeof a.provider === 'object') {
            na.provider = {
              name: String(a.provider.name || cur.provider?.name || '').slice(0, 30),
              baseURL: String(a.provider.baseURL || '').slice(0, 300),
              apiKeyEnv: String(a.provider.apiKeyEnv || '').slice(0, 60)
            };
          }
          if (a.permissionMode === 'auto' || a.permissionMode === 'confirm') na.permissionMode = a.permissionMode;
          if (typeof a.enabled === 'boolean') na.enabled = a.enabled;
          patch.agents[id] = na;
        }
      }
      Object.assign(config, patch);
      saveConfig(config);
      return sendJson(res, { ok: true, settings: config });
    } catch (e) {
      return sendErr(res, 400, `保存设置失败:${e.message}`);
    }
  }

  // —— dsh 服务(web 3080)控制 ——
  if (p === '/api/dsh/service' && method === 'GET') {
    return sendJson(res, { service: dshServiceStatus() });
  }
  m = p.match(/^\/api\/dsh\/(start|stop|restart)$/);
  if (m && method === 'POST') {
    try {
      const r = dshServiceControl(m[1], logstore);
      return sendJson(res, r);
    } catch (e) {
      return sendErr(res, 500, e.message);
    }
  }

  // —— 工作区(只读浏览) ——
  if (p === '/api/workspaces' && method === 'GET') {
    try { return sendJson(res, { workspaces: workspaces.list() }); }
    catch (e) { return sendErr(res, 400, e.message); }
  }
  if (p === '/api/workspaces/explore' && method === 'GET') {
    const dir = u.searchParams.get('path') || '';
    try { return sendJson(res, { dir: workspaces.explore(dir) }); }
    catch (e) { return sendErr(res, 400, e.message); }
  }
  if (p === '/api/workspaces/preview' && method === 'GET') {
    const file = u.searchParams.get('path') || '';
    try { return sendJson(res, { file: workspaces.preview(file) }); }
    catch (e) { return sendErr(res, 400, e.message); }
  }

  sendErr(res, 404, `未知接口:${p}`);
}

// ============ dsh web 服务控制 ============
function dshServiceStatus() {
  const out = { running: false, pid: null, port: DSH_WEB_PORT, script: null, logTail: '' };
  try {
    if (fs.existsSync(DSH_WEB_SCRIPT)) out.script = DSH_WEB_SCRIPT;
  } catch { /* ignore */ }
  try {
    if (fs.existsSync(DSH_WEB_PID)) {
      const pid = Number(String(fs.readFileSync(DSH_WEB_PID, 'utf8')).trim());
      if (pid > 0) {
        try { process.kill(pid, 0); out.running = true; out.pid = pid; } catch { out.running = false; }
      }
    }
  } catch { /* ignore */ }
  // 兜底:按进程匹配
  if (!out.running) {
    try {
      const ps = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 3000 });
      for (const line of String(ps).split('\n')) {
        if (line.includes('dsh/lib/bin.js') && line.includes('--profile web')) {
          const pid = Number(line.trim().split(/\s+/)[0]);
          if (pid > 0) { out.running = true; out.pid = pid; break; }
        }
      }
    } catch { /* ignore */ }
  }
  if (out.running) {
    try {
      const tail = fs.readFileSync(process.env.DSH_WEB_LOG || path.join(os.homedir(), 'dsh-web.log'), 'utf8');
      out.logTail = tail.split('\n').slice(-3).join('\n').slice(0, 400);
    } catch { /* ignore */ }
  }
  return out;
}

function dshServiceControl(action, logstore) {
  if (action === 'start' || action === 'restart') {
    if (action === 'restart') {
      try {
        const ps = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 3000 });
        for (const line of String(ps).split('\n')) {
          if (line.includes('dsh/lib/bin.js')) {
            const pid = Number(line.trim().split(/\s+/)[0]);
            if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ } }
          }
        }
      } catch { /* ignore */ }
    }
    const script = dshServiceStatus().script || DSH_WEB_SCRIPT;
    if (!fs.existsSync(script)) {
      throw new Error(`未找到 dsh 启动脚本:${script}(可设置 DSH_WEB_SCRIPT 环境变量)`);
    }
    const child = spawn('sh', [script], { detached: true, stdio: 'ignore' });
    child.unref();
    logstore.push('system', 'info', `[dsh] 请求${action}(脚本 ${path.basename(script)})`);
    return { ok: true, action, note: `已发起 ${action},dsh web 将在 3080 端口就绪` };
  }
  if (action === 'stop') {
    let killed = 0;
    try {
      const ps = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 3000 });
      for (const line of String(ps).split('\n')) {
        if (line.includes('dsh/lib/bin.js')) {
          const pid = Number(line.trim().split(/\s+/)[0]);
          if (pid > 0) { try { process.kill(pid, 'SIGTERM'); killed++; } catch { /* ignore */ } }
        }
      }
    } catch { /* ignore */ }
    try {
      if (fs.existsSync(DSH_WEB_PID)) {
        const pid = Number(String(fs.readFileSync(DSH_WEB_PID, 'utf8')).trim());
        if (pid > 0) { try { process.kill(pid, 'SIGTERM'); killed++; } catch { /* ignore */ } }
      }
    } catch { /* ignore */ }
    logstore.push('system', 'info', `[dsh] 停止请求,终止 ${killed} 个进程`);
    return { ok: true, action: 'stop', killed };
  }
  throw new Error(`未知操作:${action}`);
}

// ============ 一键巡检 ============
async function oneClickInspect(res, s) {
  const { agents, logstore } = s;
  const results = [];
  const order = ['codex', 'claude', 'dsh'];
  for (const id of order) {
    const agent = agents.get(id);
    if (!agent || !agent.enabled()) {
      results.push({ agentId: id, ok: false, error: '已停用,跳过' });
      continue;
    }
    agent.ensureProbed();
    if (!agent.available) {
      results.push({ agentId: id, ok: false, error: agent.detail || '不可用' });
      continue;
    }
    const t0 = Date.now();
    let ok = false, snippet = '', error = '';
    try {
      const cmd = agent.cmd();
      const args = agent.buildArgs('auto', 'low', 'Reply with exactly: OK');
      const cwd = agent.cwd();
      const env = { ...process.env, ...agent.buildEnv() };
      const out = await runOnce(cmd, args, cwd, env, 120000);
      ok = out.code === 0;
      snippet = out.output.replace(/\s+/g, ' ').trim().slice(0, 120);
      error = out.code === 0 ? '' : `exit ${out.code}: ${out.errTail}`;
    } catch (e) {
      error = String(e.message || e).slice(0, 150);
    }
    const ms = Date.now() - t0;
    logstore.push(id, ok ? 'info' : 'error', `[巡检] ${agent.name} ${ok ? 'OK' : 'FAIL'} (${ms}ms) ${snippet || error}`);
    results.push({ agentId: id, ok, ms, snippet, error });
  }
  sendJson(res, { ok: true, results });
}

function runOnce(cmd, args, cwd, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errTail = '';
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', d => { output = (output + d.toString()).slice(-20000); });
    child.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-3000); });
    child.on('error', e => resolve({ code: -1, output, errTail: String(e.message) }));
    child.on('close', (code) => { clearTimeout(t); resolve({ code, output, errTail }); });
  });
}

// ============ SSE 任务流 ============
function sseStream(req, res, runner, taskId) {
  const task = runner.get(taskId);
  if (!task) return sendErr(res, 404, '任务不存在');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');
  let ended = false;
  const send = (ev) => { if (!ended) { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* ignore */ } } };
  for (const ev of runner.replayEvents(task)) send(ev);
  const live = ['queued', 'running'].includes(task.status);
  if (!live) {
    send({ type: 'end', status: task.status });
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  const off = runner.onEvent(taskId, (ev) => {
    send(ev);
    if (['done', 'failed', 'cancelled'].includes(ev.type)) {
      // 先发 end 帧再置 ended(ended 守卫会吞掉 send)
      send({ type: 'end', status: ev.type });
      ended = true;
      off();
      clearInterval(hb);
      try { res.end(); } catch { /* ignore */ }
    }
  });
  const hb = setInterval(() => { if (!ended) { try { res.write(': ping\n\n'); } catch { /* ignore */ } } }, 15000);
  req.on('close', () => { ended = true; off(); clearInterval(hb); try { res.end(); } catch { /* ignore */ } });
}

// ============ 工具 ============
function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendErr(res, code, msg) {
  sendJson(res, { ok: false, error: msg }, code);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`JSON 解析失败:${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, p) {
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR)) return sendErr(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return sendErr(res, 404, 'Not Found');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache' // 开发期保证刷新即拿到最新前端文件
    });
    res.end(buf);
  });
}
