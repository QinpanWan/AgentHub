/* AgentHub Web 前端 */
'use strict';

// ================= 工具 =================
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = ts => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
const fmtClock = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const fmtDate = ts => new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtDur = ms => ms == null ? '—' : (ms < 1000 ? ms + 'ms' : ms < 60000 ? (ms / 1000).toFixed(1) + 's' : (ms / 60000).toFixed(1) + 'm');
const fmtBytes = kb => kb >= 1048576 ? (kb / 1048576).toFixed(1) + ' GB' : kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB';
const badge = s => ({ done: ['badge-ok', '已完成'], failed: ['badge-err', '失败'], running: ['badge-blue', '运行中'], queued: ['badge-warn', '排队中'], cancelled: ['badge-dim', '已取消'] }[s] || ['badge-dim', s]);

// Agent"当前活动"渲染:任务 / 外部进程 / dsh 服务
function activityHtml(a) {
  const act = a.activity;
  if (!act) return '<span class="muted small">空闲</span>';
  if (act.type === 'task') return `<span class="badge badge-blue">任务 #${esc(act.taskId)}</span> <span class="small">${esc(act.prompt)}</span>`;
  if (act.type === 'process') return `<span class="badge badge-warn">进程活跃</span> <span class="small">${esc(act.args || ('pid ' + (act.pids || []).join(',')))}</span>`;
  if (act.type === 'service') return `<span class="badge badge-ok">服务运行中</span> <span class="small">${esc((act.logTail || '').split('\n').pop().slice(0, 90))}</span>`;
  return '<span class="muted small">空闲</span>';
}

async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 10000);
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      signal: ctrl.signal,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3200);
}

// 页面级错误捕获:红色 toast + 持久错误栏 + 上报服务端(便于远程定位)
function showErr(msg) {
  let bar = $('#client-err-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'client-err-bar';
    bar.style.cssText = 'position:fixed;left:12px;bottom:12px;right:12px;z-index:400;background:#7a3b2e;color:#f5ecdd;border-radius:10px;padding:10px 14px;font-size:12px;font-family:monospace;box-shadow:0 8px 24px rgba(40,30,15,.4);max-height:38vh;overflow:auto;white-space:pre-wrap;word-break:break-all;border:1px solid rgba(255,255,255,.1);';
    document.body.appendChild(bar);
  }
  const line = document.createElement('div');
  line.style.cssText = 'padding:4px 0;border-bottom:1px solid rgba(255,255,255,.15);';
  line.textContent = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg;
  bar.appendChild(line);
  while (bar.children.length > 8) bar.removeChild(bar.firstChild);
}
function reportClientError(msg, stack) {
  try {
    const body = JSON.stringify({ msg: String(msg).slice(0, 500), stack: String(stack || '').split('\n').slice(0, 6).join(' | ').slice(0, 800), url: location.href });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/client-error', new Blob([body], { type: 'application/json' }));
    else fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => { });
  } catch { /* ignore */ }
}
window.addEventListener('error', e => {
  const msg = String(e.message || (e.error && e.error.message) || '未知错误');
  const st = (e.error && e.error.stack) ? String(e.error.stack).split('\n').slice(0, 3).join(' → ') : '';
  const full = msg + (st ? ' | ' + st : '');
  try { toast('页面错误: ' + full, 'err'); } catch { /* ignore */ }
  showErr('页面错误: ' + full);
  reportClientError(msg, st);
});
window.addEventListener('unhandledrejection', e => {
  const r = e.reason || {};
  const msg = String((r && r.message) || r || 'Promise 未处理');
  const st = (r && r.stack) ? String(r.stack).split('\n').slice(0, 3).join(' → ') : '';
  const full = msg + (st ? ' | ' + st : '');
  try { toast('未处理异常: ' + full, 'err'); } catch { /* ignore */ }
  showErr('未处理异常: ' + full);
  reportClientError(msg, st);
});

function confirmModal({ title, body, warn, okText = '确认执行', danger = false }) {
  return new Promise(resolve => {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal">
        <h3>${esc(title)}</h3>
        <p>${esc(body)}</p>
        ${warn ? `<div class="modal-warn">⚠ ${esc(warn)}</div>` : ''}
        <div class="modal-actions">
          <button class="btn" data-m="cancel">取消</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-m="ok">${esc(okText)}</button>
        </div>
      </div>`;
    root.classList.remove('hidden');
    const done = v => { root.classList.add('hidden'); root.innerHTML = ''; resolve(v); };
    root.querySelector('[data-m=cancel]').onclick = () => done(false);
    root.querySelector('[data-m=ok]').onclick = () => done(true);
    root.addEventListener('click', e => { if (e.target === root) done(false); });
  });
}

function drawSpark(canvas, data, color = '#a4713f', maxV) {
  if (!canvas || !data || !data.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  const pts = data.slice(-200);
  let max = maxV != null ? maxV : Math.max(...pts.map(p => p.v), 1);
  const step = pts.length > 1 ? w / (pts.length - 1) : w;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = i * step, y = h - (Math.min(p.v, max) / max) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
}

// ================= 状态 =================
const state = {
  status: null, monitor: null, view: 'overview',
  console: { agent: 'codex', model: 'auto', effort: 'medium', taskId: null, es: null, messages: [], submitting: false },
  logsTab: 'logs', logsAgent: 'all',
  timers: []
};

const TITLES = { overview: '概览', console: '任务控制台', agents: 'Agent 管理', monitor: '运行监控', logs: '日志与报错', plugins: '插件与技能', workspaces: '工作区', settings: '设置' };

// 设置页:各 Agent 预设模型清单与提供商选项
const PRESET_MODELS = {
  codex: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp', 'gpt-5.6-sol', 'gpt-5.4'],
  claude: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', 'claude-3-7-sonnet'],
  dsh: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']
};
const PROVIDER_OPTIONS = ['DeepSeek', 'OpenAI', 'Anthropic', '自定义', '跟随预设'];

function route() {
  const h = (location.hash.replace('#/', '') || 'overview');
  const view = TITLES[h] ? h : 'overview';
  switchView(view);
}
function switchView(view) {
  state.view = view;
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  $$('.view').forEach(v => v.classList.add('hidden'));
  const vEl = $('#view-' + view);
  if (vEl) vEl.classList.remove('hidden');
  $('#page-title').textContent = TITLES[view] || view;
  // 视图切换本身不依赖渲染成功:子渲染失败只提示,不阻塞导航
  try { closeTaskStream(); } catch { /* ignore */ }
  try { loadView(view); } catch (e) { toast('视图加载错误: ' + e.message, 'err'); }
}
window.addEventListener('hashchange', route);

function loadView(view) {
  clearInterval(state._viewTimer);
  try {
    if (view === 'monitor') { refreshMonitorData(); state._viewTimer = setInterval(refreshMonitorData, 3000); }
    else if (view === 'logs') { renderLogsView(); refreshLogs(); state._viewTimer = setInterval(refreshLogs, 3000); }
    else if (view === 'plugins') { refreshPlugins(); }
    else if (view === 'workspaces') { renderWorkspaces(); }
    else if (view === 'console') {
      refreshTaskList();
      if (state.status && Array.isArray(state.status.agents) && state.status.agents.length) {
        initConsoleForm();
      } else {
        // Agent 状态未就绪(轮询未返回):先占位,就绪后自动重建
        const el = $('#view-console');
        if (el) el.innerHTML = `<div class="card"><div class="small muted"><span class="spin"></span>正在加载 Agent 列表…</div></div>`;
        state._consolePending = true;
      }
    }
    else if (view === 'settings') { loadSettings(); }
    else if (view === 'overview') { refreshStatus(); refreshTaskList(); }
    else if (view === 'agents') { refreshStatus(); }
  } catch (e) { toast('视图加载错误: ' + e.message, 'err'); }
}
async function refreshStatus() {
  try {
    const d = await api('/api/status');
    state.status = d;
    state._failCount = 0;
    hideConnBanner();
    updateChips(d);
    // 控制台表单曾因状态未就绪而占位:状态到位后重建(仅一次)
    if (state.view === 'console' && state._consolePending && Array.isArray(d.agents) && d.agents.length) {
      state._consolePending = false;
      initConsoleForm();
    }
    if (state.view === 'overview') { renderOverview(d); refreshTaskList(); }
    else if (state.view === 'agents') renderAgents(d);
    else if (state.view === 'monitor') renderMonitorTop(d);
  } catch (e) {
    // 连续 3 次失败提示连接中断(服务重启/宕机时给用户明确反馈)
    state._failCount = (state._failCount || 0) + 1;
    if (state._failCount >= 3) showConnBanner();
  }
}
function showConnBanner() {
  let b = $('#conn-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'conn-banner';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:500;background:#7a3b2e;color:#f5ecdd;text-align:center;padding:6px 12px;font-size:12.5px;border-bottom:1px solid rgba(255,255,255,.15);';
    document.body.appendChild(b);
  }
  b.textContent = '⚠ 与 AgentHub 服务的连接中断,正在自动重连…';
}
function hideConnBanner() {
  const b = $('#conn-banner');
  if (b) b.remove();
}

function updateChips(d) {
  const s = d.system || {};
  $('#chip-cpu').textContent = `CPU ${s.cpu ?? '--'}%`;
  $('#chip-mem').textContent = `MEM ${s.mem ?? '--'}%`;
  const chip = $('#dsh-chip');
  const ds = d.dshService || {};
  chip.textContent = ds.running ? `dsh 服务 · 运行中 (pid ${ds.pid})` : 'dsh 服务 · 已停止';
  chip.className = 'chip ' + (ds.running ? 'chip-ok' : 'chip-err');
}
setInterval(() => { $('#chip-clock').textContent = fmtClock(); }, 1000);
setInterval(refreshStatus, 3000);

async function refreshMonitorData() {
  try { state.monitor = await api('/api/monitor?n=200'); renderMonitor(); } catch { /* ignore */ }
}
async function refreshLogs() {
  if (state.logsTab === 'errors') return refreshErrors();
  try {
    const q = state.logsAgent === 'all' ? '' : `&agent=${encodeURIComponent(state.logsAgent)}`;
    const d = await api(`/api/logs?limit=300${q}`);
    renderLogLines(d.logs);
  } catch { /* ignore */ }
}
async function refreshErrors() {
  try {
    const d = await api('/api/errors?limit=200');
    renderErrors(d.errors, d.stats);
  } catch { /* ignore */ }
}
async function refreshPlugins() {
  try {
    const [p, sk] = await Promise.all([api('/api/plugins'), api('/api/skills')]);
    renderPlugins(p.plugins, sk.skills);
  } catch { /* ignore */ }
}
async function refreshTaskList() {
  try {
    const d = await api('/api/tasks?limit=20');
    renderTaskHistory(d.tasks);
  } catch { /* ignore */ }
}

// ================= 概览 =================
function renderOverview(d) {
  const el = $('#view-overview');
  const sys = d.system || {};
  const agents = d.agents || [];
  const on = agents.filter(a => a.available && a.enabled).length;
  const tasks = d.counts.tasks || {};
  const running = tasks.running + tasks.queued;
  const recent = state._recentTasks || [];

  el.innerHTML = `
    <div class="grid grid-4">
      <div class="stat-card"><div class="stat-num ${on === agents.length ? 'ok' : 'accent'}">${on}<span class="muted small"> / ${agents.length}</span></div><div class="stat-label">Agent 可用 · 在线</div></div>
      <div class="stat-card"><div class="stat-num accent">${running}</div><div class="stat-label">运行中 / 排队任务</div></div>
      <div class="stat-card"><div class="stat-num ${d.counts.errors > 0 ? 'err' : 'ok'}">${d.counts.errors}</div><div class="stat-label">已收集报错</div></div>
      <div class="stat-card"><div class="stat-num">${(sys.load1 ?? 0).toFixed(2)}</div><div class="stat-label">系统负载 (1min)</div></div>
    </div>

    <div class="grid grid-2 mt16">
      <div class="card">
        <div class="card-title">系统资源 <span class="sub">实时仪表</span></div>
        <div class="gauge-grid">
          ${gaugeCard('CPU', sys.cpu)}
          ${gaugeCard('内存', sys.mem)}
          ${gaugeCard('磁盘', sys.disk)}
          <div class="gauge-box">
            <div class="gauge-load">
              <div><span class="load-num">${(sys.load1 ?? 0).toFixed(2)}</span></div>
              <div class="small muted" style="margin-top:2px">5min ${(sys.load5 ?? 0).toFixed(2)} · 15min ${(sys.load15 ?? 0).toFixed(2)}</div>
            </div>
            <div class="gauge-label">负载</div>
          </div>
        </div>
        <div class="mt8 small muted">内存 ${fmtBytes(sys.memUsed || 0)} / ${fmtBytes(sys.memTotal || 0)} · 已运行 ${fmtDur((sys.uptime || 0) * 1000)}</div>
      </div>
      <div class="card">
        <div class="card-title">Agent 状态 <span class="sub">${d.counts.plugins} 插件 · ${d.counts.skills} 技能</span></div>
        <table>
          <tr><th>Agent</th><th>状态</th><th>进程占用</th><th>当前活动</th></tr>
          ${agents.map(a => `
            <tr>
              <td><b>${esc(a.name)}</b> <span class="muted small">${esc(a.version || '')}</span></td>
              <td>${a.enabled ? (a.available ? '<span class="dot dot-ok"></span>可用' : '<span class="dot dot-err"></span>不可用') : '<span class="dot dot-dim"></span>已停用'}${a.proc.pids.length ? `<span class="badge badge-warn" style="margin-left:6px">进程活跃</span>` : ''}</td>
              <td class="small">CPU ${a.proc.cpu.toFixed(1)}% · MEM ${a.proc.mem.toFixed(1)}%</td>
              <td class="small">${activityHtml(a)}</td>
            </tr>`).join('')}
        </table>
        <div class="mt12"><button class="btn btn-primary btn-sm" data-action="oneclick">一键巡检全部 Agent</button></div>
      </div>
    </div>

    <div class="card mt16">
      <div class="card-title">最近任务</div>
      ${recent.length ? taskTable(recent) : '<div class="muted small">暂无任务,去「任务控制台」发起第一个任务</div>'}
    </div>
  `;
  $('#view-overview').dataset.ready = '1';
}

// SVG 半圆仪表盘(0-100)
function gaugeCard(label, val) {
  const v = val == null ? 0 : Math.min(100, Math.max(0, val));
  const color = v > 85 ? '#b5533f' : v > 65 ? '#c98a2d' : '#6f8f6f';
  const r = 50, len = Math.PI * r;
  const dash = (len * v / 100).toFixed(1);
  return `<div class="gauge-box">
    <svg viewBox="0 0 120 74" style="width:100%;display:block;margin:0 auto">
      <path d="M 10 60 A 50 50 0 0 1 110 60" fill="none" stroke="#ece4d2" stroke-width="11" stroke-linecap="round"/>
      <path d="M 10 60 A 50 50 0 0 1 110 60" fill="none" stroke="${color}" stroke-width="11" stroke-linecap="round" stroke-dasharray="${dash} ${len.toFixed(1)}"/>
      <text x="60" y="50" text-anchor="middle" font-size="22" font-weight="800" fill="${color}" font-family="monospace">${val == null ? '--' : Math.round(v)}<tspan font-size="11" fill="#8a7d6a">%</tspan></text>
    </svg>
    <div class="gauge-label">${label}</div>
  </div>`;
}

function taskTable(tasks) {
  return `<div class="history-table"><table>
    <tr><th>时间</th><th>ID</th><th>Agent</th><th>任务</th><th>状态</th><th>耗时</th><th></th></tr>
    ${tasks.map(t => `
      <tr>
        <td class="small muted">${fmtDate(t.createdAt)}</td>
        <td class="mono small">#${esc(t.id)}</td>
        <td>${esc(t.agentId)}</td>
        <td class="prompt-cell" title="${esc(t.prompt)}">${esc(t.prompt)}</td>
        <td><span class="badge ${badge(t.status)[0]}">${badge(t.status)[1]}</span></td>
        <td class="small muted">${t.startedAt ? fmtDur((t.finishedAt || Date.now()) - t.startedAt) : '—'}</td>
        <td><button class="btn btn-ghost btn-sm" data-action="view-task" data-id="${t.id}">查看</button></td>
      </tr>`).join('')}
  </table></div>`;
}

function renderTaskHistory(tasks) {
  state._recentTasks = tasks;
  const box = $('#task-history');
  if (box) box.innerHTML = tasks.length ? taskTable(tasks) : '<div class="muted small">暂无任务</div>';
}

// ================= 任务控制台(群聊) =================
const AGENT_COLORS = { codex: '#b08968', claude: '#a4713f', dsh: '#c98a2d' };

function initConsoleForm() {
  const el = $('#view-console');
  try {
    const agents = (state.status && state.status.agents) || [];
    const cur = state.console.agent;
    const curA = agents.find(a => a.id === cur);
    // 模型列表兜底:服务端配置缺失/为空时补常用档位,保证下拉始终有选项
    let models = (curA && Array.isArray(curA.models) && curA.models.length) ? curA.models : ['auto', 'deepseek-v4-flash', 'deepseek-v4-pro'];
    if (!models.includes('auto')) models = ['auto', ...models];
    const agentOpts = agents.length
      ? agents.map(a => `<option value="${esc(a.id)}" ${a.id === cur ? 'selected' : ''} ${(!a.enabled || !a.available) ? 'disabled' : ''}>${esc(a.name)}${!a.enabled ? '(已停用)' : !a.available ? '(不可用)' : ''}</option>`).join('')
      : ['codex', 'claude', 'dsh'].map(id => `<option value="${id}" ${id === cur ? 'selected' : ''}>${id}</option>`).join('');
    el.innerHTML = `
    <div class="card chat-card">
      <div id="chat-status" class="chat-status hidden"></div>
      <div class="chat-area" id="chat-area">
        <div class="chat-empty">👋 群聊模式:选好要发送的 Agent(含模型/思考强度),写下消息,回车或点发送。<br>各 Agent 的回复以气泡形式显示,并标注回复方。</div>
      </div>
      <div class="chat-input">
        <div class="chat-selects">
          <label>发送给</label>
          <select id="f-agent">
            ${agentOpts}
          </select>
          <label>模型</label>
          <select id="f-model">
            ${models.map(m => `<option value="${esc(m)}" ${m === state.console.model ? 'selected' : ''}>${m === 'auto' ? '自动(按思考强度)' : esc(m)}</option>`).join('')}
          </select>
          <label>强度</label>
          <div class="seg" style="width:196px">
            <button data-action="set-effort" data-v="low" class="${state.console.effort === 'low' ? 'sel' : ''}">低</button>
            <button data-action="set-effort" data-v="medium" class="${state.console.effort === 'medium' ? 'sel' : ''}">中</button>
            <button data-action="set-effort" data-v="high" class="${state.console.effort === 'high' ? 'sel' : ''}">高</button>
          </div>
          <button class="btn btn-sm" data-action="oneclick" id="btn-inspect">一键巡检</button>
          <span class="muted small" id="console-hint"></span>
        </div>
        <div class="chat-row">
          <textarea id="f-prompt" placeholder="给 ${esc(curA ? curA.name : '')} 的消息:直接写下要它做的事…(Ctrl+Enter 发送)"></textarea>
          <div class="chat-btns">
            <button class="btn btn-primary" data-action="submit-task" id="btn-send">发送</button>
            <button class="btn btn-danger ${state.console.taskId ? '' : 'hidden'}" data-action="cancel-task" id="btn-cancel">停止</button>
          </div>
        </div>
      </div>
    </div>`;
    $('#f-agent').addEventListener('change', e => {
      state.console.agent = e.target.value;
      state.console.model = 'auto';
      const a = ((state.status && state.status.agents) || []).find(x => x.id === state.console.agent);
      const models = (a && Array.isArray(a.models) && a.models.length) ? a.models : ['auto', 'deepseek-v4-flash', 'deepseek-v4-pro'];
      const sel = $('#f-model');
      sel.innerHTML = models.map(m => `<option value="${esc(m)}">${m === 'auto' ? '自动(按思考强度)' : esc(m)}</option>`).join('');
      $('#f-prompt').placeholder = `给 ${a ? a.name : ''} 的消息:直接写下要它做的事…(Ctrl+Enter 发送)`;
    });
    $('#f-model').addEventListener('change', e => { state.console.model = e.target.value; });
    $('#f-prompt').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitTask(); }
    });
    renderChat();
    loadChatHistory();
  } catch (e) {
    try { el.innerHTML = `<div class="card"><div class="card-title">任务控制台</div><div class="small" style="color:var(--red)">控制台渲染失败:${esc(e && e.message)}</div></div>`; } catch { /* ignore */ }
  }
}

// —— 群聊渲染 ——
function renderChat() {
  const area = $('#chat-area');
  if (!area) return;
  const msgs = state.console.messages;
  if (!msgs.length) return;
  area.innerHTML = msgs.map(chatMsgHtml).join('');
  area.scrollTop = area.scrollHeight;
}
function chatMsgHtml(m) {
  const name = m.role === 'user' ? '我' : (m.agentName || m.agentId);
  const color = m.role === 'user' ? '#8a7d6a' : (AGENT_COLORS[m.agentId] || '#a4713f');
  const live = m.status === 'running' || m.status === 'queued';
  const stBadge = !live && m.status
    ? `<span class="badge ${badge(m.status)[0]}" style="font-size:10.5px">${badge(m.status)[1]}</span>` : '';
  return `
    <div class="chat-msg ${m.role === 'user' ? 'user' : ''}" id="chat-msg-${esc(m.id)}">
      <div class="chat-avatar" style="background:${color}">${m.role === 'user' ? '我' : esc(m.icon || '◈')}</div>
      <div class="chat-bubble">
        <div class="chat-head">
          <span class="chat-name">${esc(name)}</span>
          ${m.model && m.model !== 'auto' ? `<span class="mono">${esc(m.model)}</span>` : ''}
          ${m.effort ? `<span>强度:${esc(m.effort)}</span>` : ''}
          ${live ? `<span class="badge badge-blue" style="font-size:10.5px">${m.status === 'running' ? '运行中' : '排队中'}</span>` : stBadge}
          ${m.taskId ? `<span class="mono muted" style="font-size:10.5px">#${esc(m.taskId)}</span>` : ''}
        </div>
        <div class="chat-text">${esc(m.text || '')}${live ? '<span class="chat-typing"></span>' : ''}</div>
      </div>
    </div>`;
}
function appendMsgToDom(m) {
  const area = $('#chat-area');
  if (!area) return;
  const empty = area.querySelector('.chat-empty');
  if (empty) empty.remove();
  area.insertAdjacentHTML('beforeend', chatMsgHtml(m));
  area.scrollTop = area.scrollHeight;
}
function updateMsgInDom(m) {
  const node = $('#chat-msg-' + m.id);
  if (node) node.outerHTML = chatMsgHtml(m);
  const area = $('#chat-area');
  if (area) area.scrollTop = area.scrollHeight;
}

async function loadChatHistory() {
  try {
    const d = await api('/api/tasks?limit=10');
    const tasks = d.tasks.slice().reverse();
    for (const t of tasks) {
      if (state.console.messages.some(m => m.taskId === t.id)) continue;
      const a = ((state.status && state.status.agents) || []).find(x => x.id === t.agentId);
      state.console.messages.push({ id: 'u' + t.id, role: 'user', agentId: t.agentId, agentName: a ? a.name : t.agentId, model: t.model, effort: t.effort, text: t.prompt, status: null });
      state.console.messages.push({ id: 't' + t.id, role: 'agent', agentId: t.agentId, agentName: a ? a.name : t.agentId, icon: a ? a.icon : '◈', model: t.model, effort: t.effort, text: '', status: t.status, taskId: t.id });
    }
    renderChat();
  } catch { /* ignore */ }
}

async function submitTask() {
  // 防抖:发送中禁止重复提交
  if (state.console.submitting) return toast('正在发送,请稍候', 'err');
  const prompt = $('#f-prompt').value.trim();
  if (!prompt) return toast('请先填写消息内容', 'err');
  const agentId = state.console.agent;
  const model = state.console.model;
  const effort = state.console.effort;
  const a = ((state.status && state.status.agents) || []).find(x => x.id === agentId);
  if (a && !a.available) return toast(`${a.name} 不可用:${a.detail || ''}`, 'err');
  // 权限模式=confirm:先在群聊里出确认卡片(授予工具权限后才发送)
  if (a && (a.permissionMode || 'auto') === 'confirm') {
    if (state.console.pendingConfirm) return toast('已有待确认的发送,请先处理', 'err');
    const sysId = 's' + Date.now();
    state.console.pendingConfirm = { agentId, model, effort, prompt, sysId, agentName: a.name };
    const area = $('#chat-area');
    if (area) {
      const empty = area.querySelector('.chat-empty');
      if (empty) empty.remove();
      area.insertAdjacentHTML('beforeend', `
        <div class="chat-msg" id="chat-msg-${sysId}">
          <div class="chat-avatar" style="background:#8a7d6a">⚠</div>
          <div class="chat-bubble">
            <div class="chat-head"><span class="chat-name">系统</span></div>
            <div class="chat-text">是否授予 <b>${esc(a.name)}</b> 本次任务的工具执行权限(执行命令/读写文件)?授予后任务运行中的工具操作将自动批准。</div>
            <div class="chat-actions">
              <button class="btn btn-sm btn-primary" data-action="approve-send">授予并发送</button>
              <button class="btn btn-sm" data-action="reject-send">拒绝</button>
            </div>
          </div>
        </div>`);
      area.scrollTop = area.scrollHeight;
    }
    return;
  }
  await sendTask({ agentId, model, effort, prompt });
}

async function sendTask({ agentId, model, effort, prompt }) {
  if (state.console.submitting) return toast('正在发送,请稍候', 'err');
  const a = ((state.status && state.status.agents) || []).find(x => x.id === agentId);
  state.console.submitting = true;
  const userMsg = { id: 'u' + Date.now(), role: 'user', agentId, agentName: a ? a.name : agentId, model, effort, text: prompt, status: null };
  const agentMsg = { id: 't' + Date.now(), role: 'agent', agentId, agentName: a ? a.name : agentId, icon: a ? a.icon : '◈', model, effort, text: '', status: 'queued', taskId: null };
  state.console.messages.push(userMsg, agentMsg);
  appendMsgToDom(userMsg);
  appendMsgToDom(agentMsg);
  $('#f-prompt').value = '';
  try {
    const d = await api('/api/tasks', { method: 'POST', body: { agentId, model, effort, prompt } });
    agentMsg.taskId = d.task.id;
    state.console.taskId = d.task.id;
    $('#btn-cancel').classList.remove('hidden');
    openTaskStream(d.task.id, agentMsg);
  } catch (e) {
    agentMsg.text = '发送失败: ' + e.message;
    agentMsg.status = 'failed';
    updateMsgInDom(agentMsg);
    toast(e.message, 'err');
  } finally { state.console.submitting = false; }
}

function openTaskStream(id, msg) {
  closeTaskStream();
  const es = new EventSource(`/api/tasks/${id}/stream`);
  state.console.es = es;
  const t0 = Date.now();
  // 等待提示条:实时显示已等待时长,避免"卡死"错觉
  const statusEl = $('#chat-status');
  if (statusEl) {
    statusEl.classList.remove('hidden');
    statusEl.innerHTML = `<span class="spin"></span>${esc(msg.agentName || msg.agentId)} 正在回复… <b class="chat-waited">已等待 0s</b>${msg.model && msg.model !== 'auto' ? ` · ${esc(msg.model)}` : ''}`;
    state.console._waitedTimer = setInterval(() => {
      const w = statusEl.querySelector('.chat-waited');
      if (w) w.textContent = '已等待 ' + Math.round((Date.now() - t0) / 1000) + 's';
    }, 1000);
  }
  let lastSeq = 0; // SSE 重连重放去重:跳过序号 ≤ 已处理的事件
  es.onmessage = ev => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    if (d.seq != null) {
      if (d.seq <= lastSeq) return;
      lastSeq = d.seq;
    }
    if (d.type === 'started') {
      msg.status = 'running';
      updateMsgInDom(msg);
    } else if (d.type === 'chunk') {
      msg.text += d.text;
      if (msg.text.length > 200000) msg.text = msg.text.slice(-200000);
      updateMsgInDom(msg);
    } else if (d.type === 'done') {
      msg.text += `\n\n[完成] exit 0 · ${fmtDur(Date.now() - t0)}`;
      msg.status = 'done';
      updateMsgInDom(msg);
      finalizeTask('done');
    } else if (d.type === 'failed') {
      msg.text += `\n\n[失败] ${d.error || ('exit ' + d.exitCode)} · ${fmtDur(Date.now() - t0)}`;
      msg.status = 'failed';
      updateMsgInDom(msg);
      finalizeTask('failed');
    } else if (d.type === 'cancelled') {
      msg.text += '\n\n[已取消]';
      msg.status = 'cancelled';
      updateMsgInDom(msg);
      finalizeTask('cancelled');
    } else if (d.type === 'end') {
      closeTaskStream();
    }
  };
  es.onerror = () => { /* 断线由页面轮询兜底 */ };
}

function finalizeTask(st) {
  state.console.taskId = null;
  clearWaitStatus();
  $('#btn-cancel').classList.add('hidden');
  setTimeout(() => closeTaskStream(), 500);
}
function clearWaitStatus() {
  if (state.console._waitedTimer) { clearInterval(state.console._waitedTimer); state.console._waitedTimer = null; }
  const s = $('#chat-status');
  if (s) s.classList.add('hidden');
}
function closeTaskStream() {
  if (state.console.es) { try { state.console.es.close(); } catch { /* ignore */ } state.console.es = null; }
}

async function viewTask(id) {
  try {
    const d = await api('/api/tasks/' + id);
    const t = d.task;
    closeTaskStream();
    if (state.view !== 'console') switchView('console');
    if (!state.console.messages.some(m => m.taskId === id)) {
      const a = ((state.status && state.status.agents) || []).find(x => x.id === t.agentId);
      state.console.messages.push({ id: 'u' + id, role: 'user', agentId: t.agentId, agentName: a ? a.name : t.agentId, model: t.model, effort: t.effort, text: t.prompt, status: null });
      state.console.messages.push({ id: 't' + id, role: 'agent', agentId: t.agentId, agentName: a ? a.name : t.agentId, icon: a ? a.icon : '◈', model: t.model, effort: t.effort, text: (t.output || '(无输出)') + (t.error ? `\n\n[错误] ${t.error}` : ''), status: t.status, taskId: id });
      renderChat();
    }
  } catch (e) { toast(e.message, 'err'); }
}

async function oneClickInspect() {
  const btn = $('#btn-inspect');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>巡检中…'; }
  try {
    const d = await api('/api/oneclick/inspect', { method: 'POST' });
    const lines = d.results.map(r =>
      `${r.agentId}: ${r.ok ? '✅ OK' : '❌ FAIL'} ${r.ms != null ? '(' + fmtDur(r.ms) + ')' : ''} ${r.ok ? (r.snippet || '') : (r.error || '')}`
    );
    toast('巡检完成: ' + d.results.filter(r => r.ok).length + '/' + d.results.length + ' 通过');
    const box = $('#console-hint');
    if (box) box.innerHTML = '<b>巡检结果</b><br>' + lines.map(esc).join('<br>');
    refreshStatus();
  } catch (e) { toast('巡检失败: ' + e.message, 'err'); }
  if (btn) { btn.disabled = false; btn.innerHTML = '一键巡检'; }
}

// ================= Agent 管理 =================
function renderAgents(d) {
  const el = $('#view-agents');
  const agents = d.agents || [];
  el.innerHTML = `
    <div class="agent-grid">
      ${agents.map(a => `
        <div class="agent-card">
          <div class="agent-head">
            <div class="agent-ico">${esc(a.icon)}</div>
            <div>
              <div class="agent-name">${esc(a.name)} ${a.running ? '<span class="badge badge-blue">任务运行中</span>' : ''}</div>
              <div class="agent-sub">${esc(a.desc)}</div>
            </div>
          </div>
          <div class="kv">
            <span class="k">状态</span><span>${a.enabled ? (a.available ? '<span class="dot dot-ok"></span>已安装·可用' : '<span class="dot dot-err"></span>不可用') : '<span class="dot dot-dim"></span>已停用'} ${a.version ? `<span class="muted small">${esc(a.version)}</span>` : ''} ${a.proc.pids.length ? `<span class="badge badge-warn">进程活跃(${a.proc.pids.length})</span>` : ''}</span>
            <span class="k">进程占用</span><span class="mono small">CPU ${a.proc.cpu.toFixed(1)}% · MEM ${a.proc.mem.toFixed(1)}% · RSS ${fmtBytes(a.proc.rss)}${a.proc.pids.length ? ' · pid ' + a.proc.pids.join(',') : ''}</span>
            <span class="k">当前活动</span><span class="small">${activityHtml(a)}</span>
            <span class="k">最近活动</span><span class="small muted" title="${esc(a.recentLog || '')}">${esc(a.recentLog ? a.recentLog.slice(0, 120) : '(无日志)')}</span>
            <span class="k">默认模型</span><span class="mono small">${esc(a.defaultModel)}</span>
            <span class="k">强度映射</span><span class="mono small">低:${esc(a.effortMap.low || '-')} 中:${esc(a.effortMap.medium || '-')} 高:${esc(a.effortMap.high || '-')}</span>
            ${a.supportsReasoningEffort ? '<span class="k">能力</span><span class="small">支持 --reasoning-effort 原生强度参数</span>' : ''}
            ${a.note ? `<span class="k">说明</span><span class="small muted">${esc(a.note)}</span>` : ''}
          </div>
          ${a.detail && !a.available ? `<div class="small" style="color:var(--red);background:#faf0ec;border:1px solid #e8c9c1;border-radius:8px;padding:7px 11px;">${esc(a.detail)}</div>` : ''}
          <div class="flex mt12">
            ${a.enabled
              ? `<button class="btn btn-danger btn-sm" data-action="agent-stop" data-id="${a.id}">停用</button>`
              : `<button class="btn btn-primary btn-sm" data-action="agent-start" data-id="${a.id}">启用</button>`}
            <button class="btn btn-sm" data-action="agent-probe" data-id="${a.id}">重新探测</button>
          </div>
        </div>`).join('')}
    </div>
    <div class="card mt16">
      <div class="card-title">说明</div>
      <div class="small muted">
        · <b>可用</b>=CLI 已安装且可执行;<b>已停用</b>=平台侧开关,停用会终止该 Agent 的运行中任务并拒绝新任务。<br>
        · 模型与思考强度映射可在「设置」页调整;dsh 的模型/强度由 <code class="mono">~/.dsh/settings.yaml</code> 对话预设决定。<br>
        · 进程占用为实时采样(2s),包含该 Agent 的 CLI 进程与其派发的任务进程。
      </div>
    </div>
  `;
}

// ================= 运行监控 =================
function renderMonitorTop(d) {
  const sys = d.system || {};
  const agents = d.agents || [];
  const el = $('#view-monitor');
  if (!el || !el.dataset.ready) return;
  const sysRowHtml = document.querySelector('#view-monitor [data-mon=sys]');
  if (sysRowHtml) {
    sysRowHtml.innerHTML = `
      <div class="name">系统</div>
      <div class="flex"><div class="bar ${sys.cpu > 85 ? 'red' : sys.cpu > 65 ? 'amber' : 'green'}" style="flex:1"><i style="width:${Math.min(sys.cpu,100)}%"></i></div><span class="num">${sys.cpu ?? 0}%</span></div>
      <div class="flex"><div class="bar ${sys.mem > 85 ? 'red' : sys.mem > 65 ? 'amber' : 'green'}" style="flex:1"><i style="width:${Math.min(sys.mem,100)}%"></i></div><span class="num">${sys.mem ?? 0}%</span></div>
      <div class="num muted small">load ${(sys.load1 ?? 0).toFixed(2)}</div>
      <div class="num muted small">磁盘 ${sys.disk ?? '--'}%</div>`;
  }
  const rows = document.querySelectorAll('#view-monitor [data-mon=agent]');
  rows.forEach(row => {
    const a = agents.find(x => x.id === row.dataset.id);
    if (!a) return;
    row.querySelector('[data-cpu]').textContent = a.proc.cpu.toFixed(1) + '%';
    row.querySelector('[data-mem]').textContent = a.proc.mem.toFixed(1) + '%';
    const barCpu = row.querySelector('[data-bar-cpu]'); if (barCpu) barCpu.style.width = Math.min(a.proc.cpu, 100) + '%';
    const barMem = row.querySelector('[data-bar-mem]'); if (barMem) barMem.style.width = Math.min(a.proc.mem, 100) + '%';
  });
}

function renderMonitor() {
  const el = $('#view-monitor');
  if (!el || state.view !== 'monitor') return;
  const m = state.monitor;
  const sys = (m.latest && m.latest.sys) || {};
  const agents = (state.status && state.status.agents) || [];
  const s = m.series;
  if (!el.dataset.ready) {
    el.innerHTML = `
      <div class="card">
        <div class="card-title">实时资源占用 <span class="sub">2 秒采样 · 最近 ${(s.sys.cpu.length || 0)} 点</span></div>
        <div class="mon-row" data-mon="sys">
          <div class="name">系统</div>
          <div class="flex"><div class="bar green" style="flex:1"><i data-bar-cpu style="width:0%"></i></div><span class="num" data-cpu>--</span></div>
          <div class="flex"><div class="bar green" style="flex:1"><i data-bar-mem style="width:0%"></i></div><span class="num" data-mem>--</span></div>
          <div class="num muted small">load --</div>
          <div class="num muted small">磁盘 --</div>
        </div>
        <div class="small muted mt8">CPU / 内存 / 负载 / 磁盘</div>
      </div>
      <div class="card mt16">
        <div class="card-title">Agent 进程占用</div>
        <div id="mon-agents"></div>
      </div>
      <div class="card mt16">
        <div class="card-title">趋势曲线 <span class="sub">CPU% 最近 200 点</span></div>
        <div class="grid grid-4" id="mon-sparks"></div>
      </div>`;
    el.dataset.ready = '1';
  }
  renderMonitorTop(state.status);
  // agent 行
  const ag = $('#mon-agents');
  if (ag) {
    ag.innerHTML = agents.map(a => `
      <div class="mon-row" data-mon="agent" data-id="${a.id}">
        <div class="name">${esc(a.icon)} ${esc(a.name)} ${a.running ? '<span class="badge badge-blue">运行</span>' : ''}</div>
        <div class="flex"><div class="bar ${a.proc.cpu > 85 ? 'red' : a.proc.cpu > 65 ? 'amber' : 'green'}" style="flex:1"><i data-bar-cpu style="width:${Math.min(a.proc.cpu,100)}%"></i></div><span class="num" data-cpu>${a.proc.cpu.toFixed(1)}%</span></div>
        <div class="flex"><div class="bar ${a.proc.mem > 50 ? 'amber' : 'green'}" style="flex:1"><i data-bar-mem style="width:${Math.min(a.proc.mem,100)}%"></i></div><span class="num" data-mem>${a.proc.mem.toFixed(1)}%</span></div>
        <div class="num muted small">${a.proc.pids.length ? 'pid ' + a.proc.pids.join(',') : '无进程'}</div>
        <div class="num muted small" title="${esc((a.activity && (a.activity.prompt || a.activity.args || '')) || '')}">${a.activity ? (a.activity.type === 'task' ? ('#任务 ' + (a.activity.prompt || '').slice(0, 28)) : a.activity.type === 'process' ? (a.activity.args || '进程活跃').slice(0, 36) : '服务运行中') : '空闲'}</div>
      </div>`).join('');
  }
  // sparklines
  const sp = $('#mon-sparks');
  if (sp) {
    const items = [
      ['系统 CPU', s.sys.cpu, '#8a6d4f'],
      ['Codex', s.agents.codex.cpu, '#b08968'],
      ['Claude', s.agents.claude.cpu, '#a4713f'],
      ['dsh', s.agents.dsh.cpu, '#c98a2d']
    ];
    sp.innerHTML = items.map(([name, data, color]) =>
      `<div class="card" style="padding:10px"><div class="small muted" style="margin-bottom:4px">${name}</div><canvas class="spark" data-spark="${esc(name)}"></canvas></div>`).join('');
    setTimeout(() => {
      sp.querySelectorAll('[data-spark]').forEach((cv, i) => drawSpark(cv, items[i][1], items[i][2]));
    }, 30);
  }
}

// ================= 日志与报错 =================
function renderLogsView() {
  const el = $('#view-logs');
  el.innerHTML = `
    <div class="card">
      <div class="tabs">
        <button data-action="logs-tab" data-tab="logs" class="${state.logsTab === 'logs' ? 'sel' : ''}">实时日志</button>
        <button data-action="logs-tab" data-tab="errors" class="${state.logsTab === 'errors' ? 'sel' : ''}">报错收集</button>
      </div>
      <div class="flex between mt8">
        <div class="flex">
          <label class="small muted">Agent 过滤</label>
          <select id="logs-agent" style="border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:12px">
            <option value="all">全部</option>
            <option value="system">system</option>
            <option value="codex">codex</option>
            <option value="claude">claude</option>
            <option value="dsh">dsh</option>
          </select>
        </div>
        <button class="btn btn-sm" data-action="clear-errors">清空报错</button>
      </div>
      <div class="log-area mt12" id="log-area"></div>
    </div>`;
  const sel = $('#logs-agent');
  sel.value = state.logsAgent;
  sel.addEventListener('change', () => { state.logsAgent = sel.value; refreshLogs(); });
  refreshLogs();
}

function renderLogLines(logs) {
  const area = $('#log-area');
  if (!area) return;
  const frag = document.createDocumentFragment();
  for (const l of logs.slice(-300)) {
    const div = document.createElement('div');
    div.className = 'log-line';
    div.innerHTML = `<span class="log-time">${fmtTime(l.ts)}</span><span class="log-agent">${esc(l.agent)}</span><span class="log-lvl-${esc(l.level)}">${esc(l.level)}</span>`;
    const txt = document.createElement('span');
    txt.textContent = l.text;
    div.appendChild(txt);
    frag.appendChild(div);
  }
  area.innerHTML = '';
  area.appendChild(frag);
  area.scrollTop = area.scrollHeight;
}

function renderErrors(errors, stats) {
  const area = $('#log-area');
  if (!area) return;
  area.innerHTML = '';
  const max = Math.max(...stats, 1);
  const bars = stats.map((v, i) => {
    const h = Math.max(v > 0 ? 3 : 0, Math.round((v / max) * 40));
    return `<div title="${v} 条" style="flex:1;background:${v ? '#c98a2d' : '#ece4d2'};border-radius:2px;min-width:2px;height:${h}px"></div>`;
  }).join('');
  const head = document.createElement('div');
  head.className = 'mt8';
  head.innerHTML = `<div class="small muted mb8">近 24 小时错误分布</div><div class="flex" style="align-items:flex-end;gap:2px;height:44px;padding:0 2px">${bars}</div>`;
  area.appendChild(head);
  if (!errors.length) {
    const d = document.createElement('div');
    d.className = 'stream-ok mt12'; d.style.cssText = 'color:var(--green);font-family:var(--mono)';
    d.textContent = '✓ 暂无收集到报错';
    area.appendChild(d);
    return;
  }
  const table = document.createElement('div');
  table.style.marginTop = '12px';
  table.innerHTML = `<table>
    <tr><th>时间</th><th>Agent</th><th>消息</th><th>上下文</th></tr>
    ${errors.map(e => `<tr>
      <td class="small muted mono">${fmtTime(e.ts)}</td>
      <td><span class="badge badge-err">${esc(e.agent)}</span></td>
      <td class="err-cell" title="${esc(e.line)}">${esc(e.line)}</td>
      <td class="err-cell small muted">${esc((e.context || []).join(' | '))}</td>
    </tr>`).join('')}
  </table>`;
  area.appendChild(table);
}

// ================= 插件与技能 =================
function renderPlugins(plugins, skills) {
  const el = $('#view-plugins');
  el.innerHTML = `
    <div class="flex between mb12">
      <div class="card-title" style="margin:0">dsh 插件 <span class="sub">${plugins.length} 个 · 启停修改 profile 配置,需重启 dsh 生效</span></div>
      <button class="btn btn-sm" data-action="refresh-plugins">刷新</button>
    </div>
    <div class="plugin-grid">
      ${plugins.length ? plugins.map(p => `
        <div class="plugin-card">
          <div class="plugin-name">${esc(p.name)} ${p.enabled ? '<span class="badge badge-ok">已启用</span>' : '<span class="badge badge-dim">已禁用</span>'}</div>
          <div class="plugin-desc">${esc(p.desc || '(无描述)')}</div>
          <div class="plugin-meta">${esc(p.id)}${p.version ? ' · v' + esc(p.version) : ''}${p.hasClient ? ' · 含客户端' : ''}</div>
          <div class="plugin-actions">
            <button class="btn btn-sm ${p.enabled ? 'btn-danger' : 'btn-primary'}" data-action="plugin-toggle" data-id="${esc(p.id)}" data-name="${esc(p.name)}">${p.enabled ? '禁用' : '启用'}</button>
            <button class="btn btn-sm" data-action="restart-dsh">重启 dsh 生效</button>
          </div>
        </div>`).join('') : '<div class="card muted small" style="grid-column:1/-1">未发现 dsh 插件(plugins-src 为空或不存在)</div>'}
    </div>

    <div class="flex between mt24 mb12">
      <div class="card-title" style="margin:0">Skills <span class="sub">${skills.length} 个 · 平台侧开关,不修改 dsh 配置</span></div>
    </div>
    <div class="plugin-grid">
      ${skills.length ? skills.map(s => `
        <div class="plugin-card">
          <div class="plugin-name">${esc(s.name)} ${s.enabled ? '<span class="badge badge-ok">已启用</span>' : '<span class="badge badge-dim">已禁用</span>'}</div>
          <div class="plugin-desc">${esc(s.desc || '(无描述)')}</div>
          <div class="plugin-meta">来源:${esc(s.root)}</div>
          <div class="plugin-actions">
            <button class="btn btn-sm ${s.enabled ? 'btn-danger' : 'btn-primary'}" data-action="skill-toggle" data-id="${esc(s.id)}">${s.enabled ? '禁用' : '启用'}</button>
          </div>
        </div>`).join('') : '<div class="card muted small" style="grid-column:1/-1">未发现 Skills</div>'}
    </div>

    <div class="card mt16">
      <div class="card-title">说明</div>
      <div class="small muted">
        · dsh 插件启停会<b>直接修改</b> <code class="mono">~/.dsh/profiles/web/package.json</code>(改前自动备份到 data/backups/),需要<b>重启 dsh</b> 才生效;重启会短暂断开 dsh Web 界面(3080)。<br>
        · Skills 开关是平台侧记录(仅影响本平台索引),不影响 dsh 本身加载。
      </div>
    </div>`;
}

// ================= 工作区 =================
async function renderWorkspaces() {
  const el = $('#view-workspaces');
  try {
    const d = await api('/api/workspaces');
    const ws = d.workspaces;
    el.innerHTML = `
      <div class="card">
        <div class="card-title">dsh 工作区 <span class="sub">只读浏览 · 根目录可在设置页配置(默认 ~/WorkBuddy、~/dsh-kb)</span></div>
        <div class="grid grid-3">
          ${ws.length ? ws.map(w => `
            <div class="agent-card">
              <div class="agent-head">
                <div class="agent-ico">▦</div>
                <div>
                  <div class="agent-name">${esc(w.name)}</div>
                  <div class="agent-sub mono small">${esc(w.path)}</div>
                </div>
              </div>
              <div class="kv">
                <span class="k">条目</span><span>${w.files} 项</span>
                <span class="k">大小</span><span>${fmtBytes(Math.round(w.size / 1024))}</span>
                <span class="k">最近修改</span><span class="small">${w.lastModified ? fmtDate(w.lastModified) : '—'}</span>
              </div>
              <div class="small muted">最近条目:</div>
              <div style="max-height:100px;overflow:hidden">
                ${(w.recent || []).map(r => `<div class="mono" style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.dir ? '📁' : '📄'} ${esc(r.name)}<span style="float:right">${r.dir ? '' : fmtBytes(Math.round((r.size || 0) / 1024))}</span></div>`).join('') || '<div class="small muted">(空)</div>'}
              </div>
              <div class="mt12"><button class="btn btn-sm btn-primary" data-action="ws-open" data-path="${esc(w.path)}">浏览</button></div>
            </div>`).join('') : '<div class="muted small">未发现工作区目录(可在设置页配置根路径)</div>'}
        </div>
      </div>
      <div class="card mt16" id="ws-browser" style="display:none">
        <div class="card-title" id="ws-crumb"></div>
        <div id="ws-files"></div>
      </div>
      <div class="card mt16" id="ws-preview-card" style="display:none">
        <div class="card-title" id="ws-preview-title"></div>
        <pre class="log-area" id="ws-preview" style="height:360px;white-space:pre-wrap"></pre>
      </div>`;
  } catch (e) { el.innerHTML = `<div class="card"><div class="small" style="color:var(--red)">加载失败:${esc(e.message)}</div></div>`; }
}

async function wsOpen(path) {
  try {
    const d = await api('/api/workspaces/explore?path=' + encodeURIComponent(path));
    const dir = d.dir;
    $('#ws-browser').style.display = '';
    $('#ws-preview-card').style.display = 'none';
    $('#ws-crumb').innerHTML = `
      ${dir.parent ? `<button class="btn btn-sm" data-action="ws-open" data-path="${esc(dir.parent)}">↑ 上级</button>` : ''}
      <span class="mono small" style="margin-left:8px">${esc(dir.path)}</span>
      <span class="muted small"> · ${dir.count} 项 · ${fmtBytes(Math.round(dir.total / 1024))}</span>`;
    $('#ws-files').innerHTML = `<table>
      <tr><th>名称</th><th>大小</th><th>修改时间</th><th></th></tr>
      ${dir.entries.map(e => `
        <tr>
          <td>${e.dir ? '📁' : '📄'} <span style="font-size:12.5px">${esc(e.name)}</span></td>
          <td class="small muted">${e.dir ? '—' : fmtBytes(Math.round((e.size || 0) / 1024))}</td>
          <td class="small muted">${fmtDate(e.mtime)}</td>
          <td class="flex">
            ${e.dir
              ? `<button class="btn btn-sm" data-action="ws-open" data-path="${esc(path + '/' + e.name)}">进入</button>`
              : `<button class="btn btn-sm" data-action="ws-preview" data-path="${esc(path + '/' + e.name)}">预览</button>`}
            <button class="btn btn-ghost btn-sm" data-action="ws-copy" data-path="${esc(path + '/' + e.name)}">复制路径</button>
          </td>
        </tr>`).join('')}
    </table>`;
  } catch (e) { toast(e.message, 'err'); }
}

async function wsPreview(path) {
  try {
    const d = await api('/api/workspaces/preview?path=' + encodeURIComponent(path));
    const f = d.file;
    $('#ws-preview-card').style.display = '';
    $('#ws-preview-title').innerHTML = `<span class="mono small">${esc(f.path)}</span> <span class="muted small">· ${fmtBytes(Math.round(f.size / 1024))} · ${fmtDate(f.mtime)}${f.truncated ? ' · 已截断' : ''}</span>`;
    $('#ws-preview').textContent = f.preview || '(空文件)';
  } catch (e) { toast(e.message, 'err'); }
}

function wsCopy(path) {
  const ta = document.createElement('textarea');
  ta.value = path;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('路径已复制: ' + path, 'ok'); }
  catch { toast('复制失败,请手动复制: ' + path); }
  ta.remove();
}

// ================= 设置 =================
async function loadSettings() {
  try {
    const d = await api('/api/settings');
    const cfg = d.settings;
    const el = $('#view-settings');
    const st = state.status || {};
    const ds = st.dshService || {};
    el.innerHTML = `
      <div class="settings-grid">
        <div>
          <div class="card">
            <div class="card-title">运行参数</div>
            <div class="field"><label>监控轮询间隔(ms, ≥500)</label><input type="number" id="s-poll" value="${cfg.pollMs}"></div>
            <div class="field"><label>任务超时上限(分钟)</label><input type="number" id="s-timeout" value="${cfg.maxTaskMinutes}"></div>
            <div class="field"><label>任务排队上限</label><input type="number" id="s-queue" value="${cfg.queueLimit}"></div>
            <div class="field"><label>工作区根目录(逗号分隔,留空=默认 ~/WorkBuddy,~/dsh-kb)</label><input type="text" id="s-wsroots" value="${esc((((cfg.workspaces || {}).roots) || []).join(','))}"></div>
            <button class="btn btn-primary" data-action="save-settings">保存设置</button>
          </div>
          <div class="card mt16">
            <div class="card-title">dsh Web 服务(3080)</div>
            <div class="kv">
              <span class="k">状态</span><span>${ds.running ? '<span class="dot dot-ok"></span>运行中' : '<span class="dot dot-err"></span>已停止'}${ds.pid ? ' · pid ' + ds.pid : ''}</span>
              <span class="k">启动脚本</span><span class="mono small">${esc(ds.script || '(未找到,可设 DSH_WEB_SCRIPT)')}</span>
            </div>
            ${ds.logTail ? `<div class="log-area mt8" style="height:80px">${esc(ds.logTail)}</div>` : ''}
            <div class="flex mt12">
              <button class="btn btn-sm" data-action="dsh-start">启动</button>
              <button class="btn btn-sm" data-action="dsh-restart">重启</button>
              <button class="btn btn-sm btn-danger" data-action="dsh-stop">停止</button>
            </div>
            <div class="small muted mt8">⚠ 重启/停止 dsh Web 会短暂断开当前 dsh 界面;AgentHub 自身独立运行不受影响。</div>
          </div>
          <div class="card mt16">
            <div class="card-title">HiShell 部署启动</div>
            <div class="help-box">
              在鸿蒙 PC 的 HiShell 终端中:<br><br>
              <code>sh ./hish deploy</code> &nbsp;首次部署(校验环境、建数据目录)<br>
              <code>sh ./hish start</code> &nbsp;启动平台(幂等)<br>
              <code>sh ./hish status</code> &nbsp;查看运行状态<br>
              <code>sh ./hish stop</code> / <code>sh ./hish restart</code> &nbsp;停止 / 重启<br>
              <code>sh ./hish log</code> &nbsp;跟踪日志<br><br>
              浏览器访问 <code>http://127.0.0.1:${cfg.port}</code>
            </div>
          </div>
        </div>
        <div>
          ${['codex', 'claude', 'dsh'].map(id => {
            const a = cfg.agents[id] || {};
            const models = (a.models || []).filter(m => m !== 'auto');
            const em = a.effortMap || {};
            const prov = a.provider || {};
            const provName = prov.name || 'DeepSeek';
            const modelOpts = (list, cur) => {
              const all = [...new Set(['auto', ...list, cur])].filter(Boolean);
              return all.map(m => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${m === 'auto' ? '自动' : esc(m)}</option>`).join('');
            };
            return `<div class="card">
              <div class="card-title">${id === 'codex' ? '⌘ Codex' : id === 'claude' ? '✦ Claude' : '◈ dsh'} 模型配置</div>
              <div class="field"><label><input type="checkbox" data-aid="${id}" data-k="enabled" ${a.enabled ? 'checked' : ''}> 启用</label></div>
              <div class="field">
                <label>模型列表(从下拉选择或输入自定义,点「添加」加入)</label>
                <div class="mchips" id="chips-${id}">
                  ${models.map(m => `<span class="mchip" data-model="${esc(m)}">${esc(m)}<button class="mchip-x" data-action="del-model" data-aid="${id}" data-model="${esc(m)}">×</button></span>`).join('')}
                </div>
                <div class="flex" style="margin-top:6px">
                  <select data-model-sel="${id}" style="flex:1.2;border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:13px;background:var(--card)">
                    <option value="__preset">— 预设模型 —</option>
                    ${(PRESET_MODELS[id] || []).map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}
                  </select>
                  <input type="text" data-model-input="${id}" placeholder="自定义模型名" style="flex:1.4;border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:13px">
                  <button class="btn btn-sm btn-primary" data-action="add-model" data-aid="${id}">添加</button>
                </div>
              </div>
              <div class="grid grid-2">
                <div class="field"><label>默认模型(auto=按思考强度)</label><select data-aid="${id}" data-k="defaultModel">${modelOpts(models, a.defaultModel || 'auto')}</select></div>
                <div class="field"><label>提供商</label>
                  <select data-aid="${id}" data-k="provider-name">
                    ${PROVIDER_OPTIONS.map(p => `<option value="${esc(p)}" ${p === provName ? 'selected' : ''}>${esc(p)}</option>`).join('')}
                  </select>
                </div>
              </div>
              <div class="grid grid-3">
                <div class="field"><label>思考强度:低 →</label><select data-aid="${id}" data-k="effort-low">${modelOpts(models, em.low || 'auto')}</select></div>
                <div class="field"><label>思考强度:中 →</label><select data-aid="${id}" data-k="effort-medium">${modelOpts(models, em.medium || 'auto')}</select></div>
                <div class="field"><label>思考强度:高 →</label><select data-aid="${id}" data-k="effort-high">${modelOpts(models, em.high || 'auto')}</select></div>
              </div>
              <div class="grid grid-2">
                <div class="field"><label>baseURL(自定义提供商时填写)</label><input type="text" data-aid="${id}" data-k="provider-baseURL" value="${esc(prov.baseURL || '')}" placeholder="留空=提供商默认"></div>
                <div class="field"><label>API Key 环境变量名</label><input type="text" data-aid="${id}" data-k="provider-keyEnv" value="${esc(prov.apiKeyEnv || '')}" placeholder="如 DEEPSEEK_API_KEY"></div>
              </div>
              <div class="field"><label>工具权限</label>
                <select data-aid="${id}" data-k="permission-mode">
                  <option value="auto" ${(a.permissionMode || 'auto') === 'auto' ? 'selected' : ''}>自动批准(任务内工具操作直接执行,流畅)</option>
                  <option value="confirm" ${(a.permissionMode || 'auto') === 'confirm' ? 'selected' : ''}>提交前询问(群聊确认卡片)</option>
                </select>
                <div class="small muted mt8">任务运行中 codex/claude 的工具调用(执行命令/读写文件)无法做逐次 Y/n 交互,平台统一自动批准;选择「提交前询问」可在发送前决定是否授予本次任务权限。</div>
              </div>
              ${a.note ? `<div class="small muted">${esc(a.note)}</div>` : ''}
            </div>`;
          }).join('')}
          <div class="mt12"><button class="btn btn-primary" data-action="save-settings">保存设置</button></div>
        </div>
      </div>`;
  } catch (e) { toast(e.message, 'err'); }
}

async function saveSettings() {
  const body = { agents: {} };
  const poll = $('#s-poll'); if (poll) body.pollMs = Number(poll.value) || 2000;
  const to = $('#s-timeout'); if (to) body.maxTaskMinutes = Number(to.value) || 30;
  const wr = $('#s-wsroots'); if (wr) body.workspaces = { roots: wr.value.split(',').map(s => s.trim()).filter(Boolean) };
  for (const id of ['codex', 'claude', 'dsh']) {
    const enabled = document.querySelector(`[data-aid="${id}"][data-k="enabled"]`);
    const models = [...document.querySelectorAll(`#chips-${id} .mchip`)].map(c => c.dataset.model).filter(Boolean);
    const dm = document.querySelector(`[data-aid="${id}"][data-k="defaultModel"]`);
    const el = document.querySelector(`[data-aid="${id}"][data-k="effort-low"]`);
    const em = document.querySelector(`[data-aid="${id}"][data-k="effort-medium"]`);
    const eh = document.querySelector(`[data-aid="${id}"][data-k="effort-high"]`);
    const pn = document.querySelector(`[data-aid="${id}"][data-k="provider-name"]`);
    const pb = document.querySelector(`[data-aid="${id}"][data-k="provider-baseURL"]`);
    const pk = document.querySelector(`[data-aid="${id}"][data-k="provider-keyEnv"]`);
    const pm = document.querySelector(`[data-aid="${id}"][data-k="permission-mode"]`);
    body.agents[id] = {
      enabled: enabled ? enabled.checked : true,
      models: models.length ? [...new Set(['auto', ...models])] : undefined,
      defaultModel: dm ? dm.value : undefined,
      effortMap: (el && em && eh) ? { low: el.value, medium: em.value, high: eh.value } : undefined,
      provider: pn ? { name: pn.value, baseURL: (pb ? pb.value.trim() : ''), apiKeyEnv: (pk ? pk.value.trim() : '') } : undefined,
      permissionMode: pm ? pm.value : undefined
    };
  }
  try {
    await api('/api/settings', { method: 'POST', body });
    toast('设置已保存', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

// ================= 全局事件委托 =================
document.addEventListener('click', async e => {
  // 侧边栏导航:直接切换视图(不依赖 hashchange,兼容性更稳;仍同步更新 URL hash)
  const navLink = e.target.closest('a[data-view]');
  if (navLink) {
    const v = navLink.dataset.view;
    if (TITLES[v]) {
      const target = '#/' + v;
      if (location.hash !== target) { try { history.replaceState(null, '', target); } catch { /* ignore */ } }
      try { switchView(v); } catch (err) { toast('导航错误: ' + (err && err.message), 'err'); }
    }
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const act = el.dataset.action;
  const id = el.dataset.id;
  try {
    switch (act) {
      case 'pick-agent':
        state.console.agent = id;
        state.console.model = 'auto';
        state.console.effort = 'medium';
        initConsoleForm();
        break;
      case 'set-effort':
        state.console.effort = el.dataset.v;
        $$('#view-console .seg button').forEach(b => b.classList.toggle('sel', b.dataset.v === el.dataset.v));
        break;
      case 'submit-task': submitTask(); break;
      case 'cancel-task':
        if (state.console.taskId) {
          await api('/api/tasks/' + state.console.taskId + '/cancel', { method: 'POST' });
          toast('已请求取消任务');
        }
        break;
      case 'oneclick': oneClickInspect(); break;
      case 'view-task': viewTask(id); break;
      case 'agent-start': await api(`/api/agents/${id}/start`, { method: 'POST' }); toast(id + ' 已启用'); refreshStatus(); break;
      case 'agent-stop': {
        const ok = await confirmModal({ title: `停用 ${id}?`, body: '停用后该 Agent 的运行中任务会被终止,并拒绝新任务。', warn: '可通过「启用」随时恢复。', okText: '停用', danger: true });
        if (!ok) break;
        await api(`/api/agents/${id}/stop`, { method: 'POST' });
        toast(id + ' 已停用', 'ok');
        refreshStatus();
        break;
      }
      case 'agent-probe': await api(`/api/agents/${id}/probe`, { method: 'POST' }); toast('已重新探测'); refreshStatus(); break;
      case 'logs-tab': state.logsTab = el.dataset.tab; renderLogsView(); break;
      case 'clear-errors': await api('/api/errors', { method: 'DELETE' }); toast('已清空报错'); refreshErrors(); break;
      case 'refresh-plugins': refreshPlugins(); break;
      case 'skill-toggle':
        await api('/api/skills/' + encodeURIComponent(id) + '/toggle', { method: 'POST' });
        refreshPlugins();
        break;
      case 'plugin-toggle': {
        const name = el.dataset.name || id;
        const ok = await confirmModal({
          title: `${name} 启停?`, danger: true,
          body: '将直接修改 ~/.dsh/profiles/web/package.json(修改前自动备份到 data/backups/),并需重启 dsh 生效。',
          warn: '重启 dsh 会短暂断开 dsh Web 界面(3080);AgentHub 独立运行不受影响。',
          okText: '确认修改'
        });
        if (!ok) break;
        const r = await api('/api/plugins/' + encodeURIComponent(id) + '/toggle', { method: 'POST', body: { confirm: true } });
        toast(`${r.name} 已${r.enabled ? '启用' : '禁用'},重启 dsh 后生效(备份:${r.backup})`, r.enabled ? 'ok' : '');
        refreshPlugins();
        break;
      }
      case 'restart-dsh': {
        const ok = await confirmModal({ title: '重启 dsh Web 服务?', body: '重启后插件配置生效,dsh 界面(3080)会短暂断开。', okText: '重启', danger: true });
        if (!ok) break;
        const r = await api('/api/dsh/restart', { method: 'POST' });
        toast(r.note || '已发起重启', 'ok');
        break;
      }
      case 'dsh-start': await api('/api/dsh/start', { method: 'POST' }); toast('已发起启动'); loadSettings(); break;
      case 'dsh-stop': {
        const ok = await confirmModal({ title: '停止 dsh Web 服务?', body: 'dsh 界面(3080)将停止;AgentHub 不受影响。', okText: '停止', danger: true });
        if (!ok) break;
        await api('/api/dsh/stop', { method: 'POST' });
        toast('已发起停止');
        setTimeout(loadSettings, 1200);
        break;
      }
      case 'dsh-restart': {
        const ok = await confirmModal({ title: '重启 dsh Web 服务?', body: 'dsh 界面(3080)会短暂断开。', okText: '重启', danger: true });
        if (!ok) break;
        await api('/api/dsh/restart', { method: 'POST' });
        toast('已发起重启');
        setTimeout(loadSettings, 1500);
        break;
      }
      case 'save-settings': saveSettings(); break;
      case 'approve-send': {
        const pc = state.console.pendingConfirm;
        if (!pc) break;
        state.console.pendingConfirm = null;
        const node = $('#chat-msg-' + pc.sysId);
        if (node) node.remove();
        sendTask(pc);
        break;
      }
      case 'reject-send': {
        const pc = state.console.pendingConfirm;
        if (!pc) break;
        state.console.pendingConfirm = null;
        const node = $('#chat-msg-' + pc.sysId);
        if (node) node.remove();
        toast('已拒绝,任务未发送');
        break;
      }
      case 'ws-open': wsOpen(el.dataset.path); break;
      case 'ws-preview': wsPreview(el.dataset.path); break;
      case 'ws-copy': wsCopy(el.dataset.path); break;
      case 'add-model': {
        const aid = el.dataset.aid;
        const sel = document.querySelector(`[data-model-sel="${aid}"]`);
        const inp = document.querySelector(`[data-model-input="${aid}"]`);
        let v = '';
        if (sel && sel.value && sel.value !== '__preset') v = sel.value;
        if (inp && inp.value.trim()) v = inp.value.trim();
        if (!v) { toast('请选择预设模型或输入自定义模型名', 'err'); break; }
        const chips = $('#chips-' + aid);
        if (!chips) break;
        if ([...chips.querySelectorAll('.mchip')].some(c => c.dataset.model === v)) { toast('该模型已在列表中', 'err'); break; }
        const span = document.createElement('span');
        span.className = 'mchip';
        span.dataset.model = v;
        span.innerHTML = esc(v) + `<button class="mchip-x" data-action="del-model" data-aid="${esc(aid)}" data-model="${esc(v)}">×</button>`;
        chips.appendChild(span);
        if (inp) inp.value = '';
        if (sel) sel.value = '__preset';
        break;
      }
      case 'del-model': {
        const chip = el.closest('.mchip');
        if (chip) chip.remove();
        break;
      }
    }
  } catch (err) { toast(err.message, 'err'); }
});

// ================= 启动 =================
route();
refreshStatus();
