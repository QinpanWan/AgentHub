// AgentHub 入口:装配各模块并启动 HTTP 服务
import { loadConfig, ensureDirs, DEFAULT_HOST } from './config.js';
import { LogStore } from './logstore.js';
import { Monitor } from './monitor.js';
import { Agents } from './agents.js';
import { Runner } from './runner.js';
import { Plugins } from './plugins.js';
import { Workspaces } from './workspace.js';
import { createServer } from './http.js';

ensureDirs();
const config = loadConfig();

const logstore = new LogStore();
const monitor = new Monitor({ pollMs: config.pollMs, historySize: config.historySize });
const agents = new Agents({ config, logstore, monitor });
const runner = new Runner({ agents, logstore, config });
const plugins = new Plugins({ config, logstore });
const workspaces = new Workspaces({ config });

// 长稳运行兜底:未捕获异常/未处理拒绝记入日志并继续,不让整个服务崩溃
process.on('uncaughtException', (e) => {
  const msg = `uncaughtException: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`;
  console.error(msg);
  try { logstore.push('system', 'error', msg.slice(0, 800)); } catch { /* ignore */ }
});
process.on('unhandledRejection', (e) => {
  const msg = `unhandledRejection: ${(e && (e.stack || e.message)) || e}`;
  console.error(msg);
  try { logstore.push('system', 'error', String(msg).slice(0, 500)); } catch { /* ignore */ }
});

const server = createServer({ config, logstore, monitor, agents, runner, plugins, workspaces });

monitor.start();
agents.start();

server.listen(config.port, config.host, () => {
  const line = `AgentHub 已启动 → http://${config.host}:${config.port}`;
  console.log(line);
  logstore.push('system', 'info', line);
});

// 优雅退出
function shutdown(sig) {
  console.log(`收到 ${sig},正在退出…`);
  try { monitor.stop(); } catch { /* ignore */ }
  try { agents.stop(); } catch { /* ignore */ }
  try {
    for (const a of agents.list()) {
      if (a.taskId) runner.cancel(a.taskId);
    }
  } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 被占用。可用 HUB_PORT 换端口,或先停掉占用进程。`);
    process.exit(1);
  }
  throw e;
});
