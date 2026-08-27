// AgentHub 自测套件
//   L1(默认,无需服务): 配置/日志/监控/Agent 探测/任务执行器(用假 Agent)
//   L2(--http): 需服务在线,走真实 HTTP 端点;真实 codex 任务(不可用时 SKIP)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.HUB_PORT || 8899);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0, skip = 0;
const t = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ================= L1 =================
async function l1() {
  console.log('\n[L1] 单元级(无需服务在线)');

  // 1. 配置加载
  console.log('  配置模块:');
  const cfg = (await import(path.join(ROOT, 'server', 'config.js'))).loadConfig();
  t('默认配置含三个 Agent', cfg.agents && cfg.agents.codex && cfg.agents.claude && cfg.agents.dsh);
  t('配置含 pollMs/historySize', cfg.pollMs > 0 && cfg.historySize > 0);

  // 2. 日志与报错
  console.log('  日志与报错:');
  const { LogStore } = await import(path.join(ROOT, 'server', 'logstore.js'));
  const ls = new LogStore();
  ls.push('test', 'info', 'hello world');
  ls.push('test', 'stderr', 'something failed badly in module X');
  ls.push('test', 'stderr', 'warning only, no error');
  t('日志记录', ls.query({ agent: 'test' }).length === 3);
  t('错误识别(stderr 报错被收集)', ls.errorsList().length === 1, `实际 ${ls.errorsList().length}`);
  t('错误白名单(warning 不收集)', ls.errorsList().every(e => !/warning/i.test(e.line)));
  ls.injectError('test', 'EPERM: operation not permitted on link()');
  t('错误识别(EPERM 模式)', ls.errorsList().some(e => e.line.includes('EPERM')));
  t('错误统计桶', ls.errorStats(24).length === 24);

  // 3. 监控
  console.log('  监控:');
  const { Monitor } = await import(path.join(ROOT, 'server', 'monitor.js'));
  const mon = new Monitor({ pollMs: 100, historySize: 50 });
  mon._tick(); mon._tick();
  await sleep(50);
  const sys = (mon.latest && mon.latest.sys) || {};
  t('系统快照(cpu/mem/load 字段)', typeof sys.cpu === 'number' && typeof sys.mem === 'number' && typeof sys.load1 === 'number');
  t('进程表为 Map', mon.latest && mon.latest.procs instanceof Map);
  t('历史环形缓冲', mon.history.length >= 1 && mon.history.length <= 50);
  const agg = mon.aggregate([{ cpu: 12.3, mem: 4.5, rss: 1234, pid: 1 }]);
  t('进程聚合', agg.cpu === 12.3 && agg.mem === 4.5 && agg.pids[0] === 1);

  // 4. Agent 探测
  console.log('  Agent 探测(只读):');
  const { Agents } = await import(path.join(ROOT, 'server', 'agents.js'));
  const agents = new Agents({ config: cfg, logstore: ls, monitor: mon });
  agents.probeAll();
  const snap = agents.snapshot();
  t('三个 Agent 注册', snap.length === 3 && snap.map(a => a.id).join(',') === 'codex,claude,dsh');
  for (const a of snap) t(`  ${a.name} 探测有结果`, typeof a.available === 'boolean', a.detail || '');
  const c = agents.get('codex');
  const args = c.buildArgs('auto', 'high', 'hello');
  t('codex 命令构建', Array.isArray(args) && args[0] === 'exec' && args.includes('hello'));
  const d = agents.get('dsh');
  const dargs = d.buildArgs('auto', 'low', 'hello');
  t('dsh 命令构建(headless)', Array.isArray(dargs) && dargs.includes('--profile') && dargs.includes('headless'));

  // 5. 任务执行器(假 Agent)
  console.log('  任务执行器(假 Agent):');
  const TASKS_FILE = path.join(ROOT, 'data', 'tasks.json');
  let origTasks = '';
  try { origTasks = fs.readFileSync(TASKS_FILE, 'utf8'); } catch { /* ignore */ }
  const { Runner } = await import(path.join(ROOT, 'server', 'runner.js'));
  const fakeAgent = {
    id: 'echo', name: 'echo', available: true, taskId: null, lastActivityAt: 0,
    enabled: () => true,
    ensureProbed() {},
    cmd: () => 'node',
    buildArgs: () => ['-e', 'console.log("HELLO_FROM_RUNNER"); console.error("SYNTH error L1");'],
    buildEnv: () => ({}),
    cwd: () => ROOT,
    timeoutMs: () => 30000
  };
  const runner = new Runner({
    agents: { get: () => fakeAgent },
    logstore: ls,
    config: { queueLimit: 20, maxTaskMinutes: 1 }
  });
  const tk = runner.submit({ agentId: 'echo', model: 'auto', effort: 'low', prompt: 'test' });
  t('任务提交返回 queued/running', tk.status === 'queued' || tk.status === 'running');
  await waitTerminal(runner, tk.id, 15000);
  const tk2 = runner.get(tk.id);
  t('假任务执行成功', tk2.status === 'done' && tk2.exitCode === 0, JSON.stringify({ st: tk2.status, code: tk2.exitCode }));
  t('输出捕获 stdout', (tk2.output || '').includes('HELLO_FROM_RUNNER'));
  t('stderr 进入报错收集', ls.errorsList().some(e => e.line.includes('SYNTH error L1')));

  // 取消与排队
  const blocker = runner.submit({ agentId: 'echo', model: 'auto', effort: 'low', prompt: 'block' });
  runner.cancel(blocker.id);
  await sleep(200);
  t('排队任务可取消', runner.get(blocker.id).status === 'cancelled');

  // 提交即落盘:服务在任务排队/运行期间重启也不丢任务
  const tk3 = runner.submit({ agentId: 'echo', model: 'auto', effort: 'low', prompt: 'persist-check' });
  const persistedNow = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  t('任务提交即落盘', Array.isArray(persistedNow) && persistedNow.some(x => x.id === tk3.id && ['queued', 'running'].includes(x.status)));
  runner.cancel(tk3.id);
  await sleep(300);

  // 重启恢复:新 Runner 实例(模拟服务重启)把持久化的 running/queued 任务重新入队
  const recId = 'rec' + Date.now().toString(36).slice(-5);
  fs.writeFileSync(TASKS_FILE, JSON.stringify([
    { id: recId, agentId: 'echo', model: 'auto', effort: 'low', prompt: 'recover-running', status: 'running', createdAt: Date.now(), startedAt: Date.now(), finishedAt: null, exitCode: null, error: null, output: '', events: [] },
    { id: recId + 'q', agentId: 'echo', model: 'auto', effort: 'low', prompt: 'recover-queued', status: 'queued', createdAt: Date.now(), startedAt: null, finishedAt: null, exitCode: null, error: null, output: '', events: [] }
  ]));
  const slowAgent = { ...fakeAgent, buildArgs: () => ['-e', 'setTimeout(()=>{}, 8000);'] };
  const runner3 = new Runner({ agents: { get: () => slowAgent }, logstore: ls, config: { queueLimit: 20, maxTaskMinutes: 1 } });
  const rec = runner3.get(recId);
  t('重启后 running 任务重新入队', rec && ['queued', 'running'].includes(rec.status), JSON.stringify(rec && rec.status));
  const recq = runner3.get(recId + 'q');
  t('重启后 queued 任务重新入队', recq && ['queued', 'running'].includes(recq.status), JSON.stringify(recq && recq.status));
  t('重启后计数不为零', runner3.counts().running + runner3.counts().queued >= 2);
  runner3.cancel(recId);
  runner3.cancel(recId + 'q');
  await sleep(300);
  try { fs.writeFileSync(TASKS_FILE, origTasks); } catch { /* ignore */ }

  // 6. 插件扫描
  console.log('  插件/技能扫描:');
  const { Plugins } = await import(path.join(ROOT, 'server', 'plugins.js'));
  const pl = new Plugins({ config: cfg, logstore: ls });
  const dshPlugins = pl.listDshPlugins();
  t('dsh 插件扫描不抛错', Array.isArray(dshPlugins));
  const skills = pl.listSkills();
  t('技能扫描不抛错', Array.isArray(skills));
}

async function waitTerminal(runner, id, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const tk = runner.get(id);
    if (tk && !['queued', 'running'].includes(tk.status)) return tk;
    await sleep(100);
  }
  return runner.get(id);
}

// ================= L2 =================
async function l2() {
  console.log('\n[L2] HTTP 端到端(需 AgentHub 服务在线)');
  const http = await import('node:http');
  const get = (p) => new Promise((resolve, reject) => {
    const req = http.get(BASE + p, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve({ code: res.statusCode, data: JSON.parse(b) }); }
        catch { resolve({ code: res.statusCode, data: null, raw: b }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('请求超时')); });
  });
  const post = (p, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve({ code: res.statusCode, data: JSON.parse(b) }); } catch { resolve({ code: res.statusCode, data: null, raw: b }); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(data); req.end();
  });
  const del = (p) => new Promise((resolve, reject) => {
    const req = http.request(BASE + p, { method: 'DELETE' }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve({ code: res.statusCode, data: JSON.parse(b) }); } catch { resolve({ code: res.statusCode, data: null }); } });
    });
    req.on('error', reject); req.setTimeout(5000, () => { req.destroy(); reject(new Error('超时')); });
    req.end();
  });

  const r1 = await get('/api/health');
  t('GET /api/health', r1.code === 200 && r1.data && r1.data.ok === true, `code=${r1.code}`);

  const r2 = await get('/api/status');
  t('GET /api/status', r2.code === 200 && r2.data && Array.isArray(r2.data.agents) && r2.data.agents.length === 3);
  const codexAvail = r2.data && r2.data.agents.find(a => a.id === 'codex').available;

  const r3 = await get('/api/monitor?n=5');
  t('GET /api/monitor(series)', r3.code === 200 && r3.data && r3.data.series && r3.data.series.agents && r3.data.series.agents.codex);

  const r4 = await get('/api/logs?limit=10');
  t('GET /api/logs', r4.code === 200 && Array.isArray(r4.data.logs));

  const r5 = await get('/api/errors');
  t('GET /api/errors(stats)', r5.code === 200 && Array.isArray(r5.data.errors) && r5.data.stats.length === 24);

  const r6 = await get('/api/plugins');
  t('GET /api/plugins', r6.code === 200 && Array.isArray(r6.data.plugins));
  const r7 = await get('/api/skills');
  t('GET /api/skills', r7.code === 200 && Array.isArray(r7.data.skills));

  // 任务:排队取消
  let r8 = await post('/api/tasks', { agentId: 'codex', model: 'auto', effort: 'low', prompt: 'L2 queue test' });
  const queuedId = r8.data && r8.data.task && r8.data.task.id;
  t('POST /api/tasks 排队', r8.code === 201 && queuedId, r8.data ? r8.data.error : '');
  if (queuedId) {
    const rc = await post(`/api/tasks/${queuedId}/cancel`, {});
    t('取消排队任务', rc.code === 200 && rc.data.ok === true);
  }

  // 真实 codex 任务(环境可用才跑)
  if (codexAvail) {
    console.log('  [真实任务] codex · "Reply with exactly: OK" (最多 180s)');
    const r9 = await post('/api/tasks', { agentId: 'codex', model: 'auto', effort: 'low', prompt: 'Reply with exactly: OK' });
    const tid = r9.data && r9.data.task && r9.data.task.id;
    t('codex 任务提交', r9.code === 201 && tid, r9.data ? r9.data.error : '');
    if (tid) {
      let final = null;
      for (let i = 0; i < 180; i++) {
        await sleep(1000);
        const rd = await get(`/api/tasks/${tid}`);
        if (rd.data && rd.data.task && !['queued', 'running'].includes(rd.data.task.status)) { final = rd.data.task; break; }
      }
      if (final) {
        t('codex 真实任务完成', final.status === 'done', `status=${final.status} error=${final.error || ''}`);
        t('codex 输出包含 OK', /OK/i.test(final.output || ''), (final.output || '').slice(0, 120));
      } else {
        t('codex 真实任务完成', false, '180s 未结束');
      }
    }
  } else {
    console.log('  ⚠ codex 不可用,真实任务 SKIP(环境依赖)');
    skip++;
  }

  // 设置读写(写回原值,不破坏配置)
  const r10 = await get('/api/settings');
  if (r10.code === 200 && r10.data.settings) {
    const cur = r10.data.settings;
    const r11 = await post('/api/settings', { pollMs: cur.pollMs, maxTaskMinutes: cur.maxTaskMinutes });
    t('POST /api/settings', r11.code === 200 && r11.data.ok === true);
  } else {
    t('GET /api/settings', false, `code=${r10.code}`);
  }

  // 静态
  const staticHtml = await new Promise(resolve => {
    const req = http.get(BASE + '/', res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ code: res.statusCode, html: b }));
    });
    req.on('error', () => resolve({ code: 0, html: '' }));
  });
  t('静态首页可访问', staticHtml.code === 200 && staticHtml.html.includes('AgentHub'));
  const staticCss = await new Promise(resolve => {
    const req = http.get(BASE + '/style.css', res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
  });
  t('style.css 可访问', staticCss === 200);
  const delR = await del('/api/errors');
  t('DELETE /api/errors', delR.code === 200);
}

// ================= 主流程 =================
const withHttp = process.argv.includes('--http');
console.log(`AgentHub 自测 · ${withHttp ? 'HTTP 端到端模式' : '单元模式'} · node ${process.version}`);

try { await l1(); } catch (e) { fail++; console.log('  ❌ L1 异常:', e.message); }
if (withHttp) { try { await l2(); } catch (e) { fail++; console.log('  ❌ L2 异常:', e.message); } }

console.log(`\n结果: ${pass} 通过, ${fail} 失败, ${skip} 跳过`);
process.exit(fail > 0 ? 1 : 0);
