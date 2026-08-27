// AgentHub 配置模块:路径解析 / 默认配置 / 持久化合并 / 凭据兜底
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
export const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
export const ASSETS_DIR = path.join(ROOT, 'assets');
export const HEADLESS_PATCH = path.join(ASSETS_DIR, 'harmony-headless.patch.yml');
export const WEB_DIR = path.join(ROOT, 'web');

const HOME = os.homedir();
export const DSH_DIR = process.env.DSH_DIR || path.join(HOME, 'dsh-test');
export const DSH_BIN = path.join(DSH_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
export const DSH_WEB_SCRIPT = process.env.DSH_WEB_SCRIPT || path.join(HOME, 'bin', 'dsh-web.sh');
export const DSH_WEB_PID = process.env.DSH_WEB_PID || path.join(HOME, 'dsh-web.pid');
export const DSH_WEB_PORT = Number(process.env.DSH_WEB_PORT || 3080);
export const PROFILE_DIR = path.join(HOME, '.dsh', 'profiles', 'web');
export const PLUGINS_SRC_DIR = path.join(PROFILE_DIR, 'plugins-src');
export const PROFILE_PKG = path.join(PROFILE_DIR, 'package.json');
export const PRESETS_DIR = path.join(HOME, '.dsh', '.agent-presets');

export const DEFAULT_PORT = Number(process.env.HUB_PORT || 8899);
export const DEFAULT_HOST = '127.0.0.1';

export function ensureDirs() {
  for (const d of [DATA_DIR, LOGS_DIR, BACKUP_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  }
}

export function defaultConfig() {
  return {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    pollMs: 2000,          // 监控轮询间隔
    historySize: 300,      // 监控历史点数
    maxTaskMinutes: 30,    // 任务超时上限(分钟)
    queueLimit: 20,        // 单 Agent 排队上限
    workspaces: { roots: [] }, // 工作区根目录(空=默认 ~/WorkBuddy,~/dsh-kb)
    memory: {              // 团队共享上下文与共享记忆
      inject: true,        // 提交任务时自动注入共享上下文/相关记忆
      maxContextChars: 3000, // 共享上下文单次注入上限(字符)
      recallLimit: 6,      // 相关记忆单次召回条数
      maxInjectedChars: 6000 // 注入内容总长上限(字符)
    },
    agents: {
      codex: {
        enabled: true,
        models: ['auto', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
        defaultModel: 'auto',
        effortMap: { low: 'deepseek-v4-flash', medium: 'deepseek-v4-flash', high: 'deepseek-v4-pro' },
        provider: { name: 'DeepSeek', baseURL: '', apiKeyEnv: 'DEEPSEEK_API_KEY' },
        permissionMode: 'auto' // auto=任务内工具操作自动批准;confirm=提交前在群聊确认
      },
      claude: {
        enabled: true,
        // DeepSeek Anthropic 兼容端点实测仅 deepseek-v4-flash 有渠道;deepseek-v4-pro(含[1m])返回 503 无渠道并重试数分钟
        models: ['auto', 'deepseek-v4-flash'],
        defaultModel: 'auto',
        effortMap: { low: 'deepseek-v4-flash', medium: 'deepseek-v4-flash', high: 'deepseek-v4-flash' },
        provider: { name: 'DeepSeek(Anthropic 兼容)', baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN' },
        permissionMode: 'auto',
        note: 'claude 经 npx @anthropic-ai/claude-code 运行;DeepSeek 兼容端点当前仅有 deepseek-v4-flash 渠道(pro 系列 503),强度低/中/高均映射 flash。凭据建议写入 ~/.zshrc(export ANTHROPIC_AUTH_TOKEN=…),平台自动读取'
      },
      dsh: {
        enabled: true,
        models: ['auto', 'deepseek-v4-flash', 'deepseek-v4-pro'],
        defaultModel: 'auto',
        effortMap: { low: 'deepseek-v4-flash', medium: 'deepseek-v4-flash', high: 'deepseek-v4-pro' },
        provider: { name: '跟随预设', baseURL: '', apiKeyEnv: '' },
        permissionMode: 'auto',
        note: 'dsh 任务经 headless 模式执行,模型、思考强度与提供商由 ~/.dsh/settings.yaml 的对话预设决定,此处仅作记录'
      }
    }
  };
}

export function loadConfig() {
  ensureDirs();
  const base = defaultConfig();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      migrate(user, base);
      return mergeDeep(base, user);
    }
  } catch (e) {
    console.error('[config] 读取用户配置失败,回退默认:', e.message);
  }
  return base;
}

// 旧配置迁移:检测到旧版 claude(Anthropic 原生模型)时替换为 DeepSeek 兼容层默认
function migrate(user, base) {
  try {
    const c = user && user.agents && user.agents.claude;
    if (c && Array.isArray(c.models) && c.models.includes('claude-sonnet-4-5')) {
      const def = base.agents.claude;
      user.agents.claude = { ...def, enabled: c.enabled !== false };
      console.log('[config] 已迁移 claude 配置 → DeepSeek 兼容层默认');
    }
  } catch { /* ignore */ }
}

export function saveConfig(cfg) {
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function mergeDeep(base, extra) {
  for (const k of Object.keys(extra || {})) {
    if (extra[k] && typeof extra[k] === 'object' && !Array.isArray(extra[k]) &&
        base[k] && typeof base[k] === 'object') {
      mergeDeep(base[k], extra[k]);
    } else {
      base[k] = extra[k];
    }
  }
  return base;
}

// —— 凭据兜底:从 ~/.dsh/.credentials.yaml 提取 API Key(仅注入环境,绝不落日志) ——
function readCredentials() {
  try {
    const f = path.join(HOME, '.dsh', '.credentials.yaml');
    if (!fs.existsSync(f)) return '';
    return fs.readFileSync(f, 'utf8');
  } catch { return ''; }
}

export function resolveKey(envName, yamlPattern) {
  if (process.env[envName]) return process.env[envName];
  const txt = readCredentials();
  if (!txt) return null;
  const re = new RegExp(`^\\s*[#]?\\s*(${yamlPattern})\\s*[:=]\\s*["']?([^"'\\s]+)`, 'm');
  const m = txt.match(re);
  return m ? m[2] : null;
}

export function deepSeekKey() {
  return resolveKey('DEEPSEEK_API_KEY', 'deepseek[_-]?api[_-]?key|api[_-]?key');
}

// 解析 ~/.zshrc:export 变量与 alias(平台进程不继承交互 shell 环境,需自行读取)
let _zshrcCache = null;
export function parseZshrc() {
  if (_zshrcCache) return _zshrcCache;
  const out = { exports: {}, aliases: {} };
  try {
    const f = path.join(HOME, '.zshrc');
    if (!fs.existsSync(f)) return out;
    const txt = fs.readFileSync(f, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?([^"'\s#]*)["']?\s*$/);
      if (m) out.exports[m[1]] = m[2];
      const a = line.match(/^\s*alias\s+([A-Za-z0-9_]+)\s*=\s*["']([^"']+)["']/);
      if (a) out.aliases[a[1]] = a[2];
    }
  } catch { /* ignore */ }
  _zshrcCache = out;
  return out;
}

export function zshEnv(name) {
  const z = parseZshrc();
  return process.env[name] || z.exports[name] || null;
}

export function anthropicKey() {
  return resolveKey('ANTHROPIC_API_KEY', 'anthropic[_-]?api[_-]?key|claude[_-]?api[_-]?key');
}

// dsh headless 的 node 选择:
//   - /data/service 的 v24 node 在本机 headless 启动会原生 errno 崩溃(鸿蒙已知问题),不可用
//   - PATH 上的 deveco node v22.7 + agent-hub 扩展补丁(禁用 session-persistence-jsonl 等)可正常跑
// 解析顺序: DSH_NODE 环境变量 → PATH node(默认)
export function resolveDshNode() {
  if (process.env.DSH_NODE) return process.env.DSH_NODE;
  return 'node';
}
