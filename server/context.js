// dsh-context 面板的三 Agent 遥测聚合层。
// 输入：Codex rollout JSONL、Claude projects JSONL、dsh session_projcache JSON。
// 输出：dsh-context 0.84.x 的 overview/skills/balance/version 接口契约。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';

const HOME = os.homedir();
const CODEX_DIR = path.join(HOME, '.codex', 'sessions');
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');
const DSH_SESSION_DIR = path.join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions');
const DSH_COST_LEDGER = path.join(HOME, '.dsh', 'storages', 'cost-meter', 'ledger.json');
const CACHE_DIR = path.join(HOME, '.cache', 'agenthub-context');
const CACHE_FILE = path.join(CACHE_DIR, 'cache.json');
const CACHE_VERSION = 3;
const DAY_MS = 86_400_000;
const RECENT_PARSE_MS = 32 * DAY_MS;
const SCAN_TTL_MS = 5_000;
const PAGE_SIZE = 12;
const MAX_SERIES = 1200;
const MAX_TREND_POINTS = 1200;
const PLUGIN_VERSION = '0.84.1';

const AGENTS = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'dsh', label: 'dsh' },
];
const AGENT_LABEL = Object.fromEntries(AGENTS.map(a => [a.id, a.label]));
const CAT_KEYS = ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'];
const RING_ORDER = ['system', 'tools', 'user', 'inject', 'skill', 'toolCalls', 'thinking', 'answers'];

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function nonNeg(value) {
  const n = num(value);
  return n > 0 ? n : 0;
}
function clampDayKey(key) {
  return typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}
function dayKey(ts) {
  const d = new Date(num(ts) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function startOfDay(key) {
  const k = clampDayKey(key);
  if (!k) return null;
  const d = new Date(`${k}T00:00:00`);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}
function endOfDay(key) {
  const start = startOfDay(key);
  return start === null ? null : start + DAY_MS - 1;
}
function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else wide++;
  }
  return Math.max(1, Math.ceil(ascii / 4 + wide / 1.6));
}
function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
function emptyParts() {
  return { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 };
}
function emptyUsage() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}
function usageTotal(usage) {
  const u = usage || {};
  return nonNeg(u.input) + nonNeg(u.cacheRead) + nonNeg(u.cacheWrite) + nonNeg(u.output);
}
function emptyRecord(agent, file, id) {
  return {
    agent,
    file,
    id: String(id || path.basename(file)),
    title: '',
    cwd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model: '',
    usage: emptyUsage(),
    parts: emptyParts(),
    turns: 0,
    steps: 0,
    calls: 0,
    toolCalls: 0,
    toolsMs: 0,
    wallMs: 0,
    contextTotal: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
    lastUser: '',
    reasoningTokens: 0,
    answerTokens: 0,
    callTokens: 0,
    days: {},
    timing: null,
    tools: {},
    cmds: {},
    skills: {},
    costUsd: null,
    archived: false,
    source: agent,
    series: [],
  };
}

function seriesPoint(rec, { time, seq, turn, step, total, prompt, activeMs }) {
  const context = Math.max(0, Math.round(nonNeg(total)));
  const parts = {};
  let sum = 0;
  for (const key of CAT_KEYS) {
    const value = nonNeg(rec.parts && rec.parts[key]);
    parts[key] = value;
    sum += value;
  }
  if (context > 0 && sum > 0) {
    const scale = context / sum;
    for (const key of CAT_KEYS) parts[key] = Math.round(parts[key] * scale);
  } else if (context > 0) {
    parts.assistant = context;
  }
  const point = {
    time: Math.max(0, Math.round(nonNeg(time))),
    seq: Math.max(0, Math.round(nonNeg(seq))),
    turn: Math.max(0, Math.round(nonNeg(turn))),
    step: Math.max(0, Math.round(nonNeg(step))),
    total: context,
    prompt: Math.max(0, Math.round(nonNeg(prompt))),
  };
  const active = Math.max(0, Math.round(nonNeg(activeMs)));
  if (active > 0) point.activeMs = active;
  for (const key of CAT_KEYS) point[key] = parts[key];
  return point;
}

function pushSeries(rec, point) {
  if (!Array.isArray(rec.series)) rec.series = [];
  rec.series.push(point);
  if (rec.series.length > MAX_SERIES) rec.series.splice(0, rec.series.length - MAX_SERIES);
}
function ensureDay(rec, key) {
  const k = clampDayKey(key) || dayKey(rec.updatedAt);
  let day = rec.days[k];
  if (!day) {
    day = {
      tokens: 0,
      requests: 0,
      turns: 0,
      usage: emptyUsage(),
      calls: 0,
      toolCalls: 0,
      toolsMs: 0,
      wallMs: 0,
      firstTs: 0,
      lastTs: 0,
      tools: {},
      cmds: {},
      skills: {},
      costUsd: null,
    };
    rec.days[k] = day;
  }
  return day;
}
function touchDay(rec, ts) {
  const day = ensureDay(rec, dayKey(ts));
  if (!day.firstTs || ts < day.firstTs) day.firstTs = ts;
  if (!day.lastTs || ts > day.lastTs) day.lastTs = ts;
  return day;
}
function addUsageToDay(rec, ts, usage, calls = 1) {
  const day = touchDay(rec, ts);
  const input = nonNeg(usage.input);
  const cacheRead = nonNeg(usage.cacheRead);
  const cacheWrite = nonNeg(usage.cacheWrite);
  const output = nonNeg(usage.output);
  day.usage.input += input;
  day.usage.cacheRead += cacheRead;
  day.usage.cacheWrite += cacheWrite;
  day.usage.output += output;
  day.tokens += input + cacheRead + cacheWrite + output;
  day.requests += calls > 0 ? 1 : 0;
  day.calls += calls;
  rec.usage.input += input;
  rec.usage.cacheRead += cacheRead;
  rec.usage.cacheWrite += cacheWrite;
  rec.usage.output += output;
  return day;
}
function addTally(table, name, ts, count = 1) {
  const key = String(name || '').trim();
  if (!key) return;
  const prev = table[key] || { n: 0, last: 0 };
  prev.n += Math.max(1, count);
  prev.last = Math.max(prev.last, num(ts));
  table[key] = prev;
}
function addDayTally(rec, ts, field, name, count = 1) {
  const day = touchDay(rec, ts);
  addTally(day[field], name, ts, count);
  addTally(rec[field], name, ts, count);
}
function addPart(rec, key, tokens) {
  if (Object.prototype.hasOwnProperty.call(rec.parts, key)) rec.parts[key] += nonNeg(tokens);
}
function scaleParts(parts, target) {
  const total = CAT_KEYS.reduce((sum, key) => sum + nonNeg(parts[key]), 0);
  if (!(target > 0)) return;
  if (!(total > 0)) {
    parts.assistant = target;
    return;
  }
  const scale = target / total;
  for (const key of CAT_KEYS) parts[key] = Math.round(nonNeg(parts[key]) * scale);
}
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const item of content) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object') {
      if (typeof item.text === 'string') out.push(item.text);
      else if (typeof item.thinking === 'string') out.push(item.thinking);
      else if (typeof item.content === 'string') out.push(item.content);
    }
  }
  return out.join('\n');
}
function isInjectedUserText(text) {
  const value = String(text || '').trim();
  return value.startsWith('# AGENTS.md instructions')
    || value.startsWith('<environment_context>')
    || value.startsWith('<skills_instructions>')
    || value.startsWith('<user_instructions>');
}
function commandProgram(command) {
  let text = String(command || '').trim();
  if (!text) return '';
  text = text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, '');
  const parts = text.split(/\s+/);
  let first = parts[0] || '';
  if (first === 'cd' && parts.length > 1) first = parts[2] || '';
  first = first.replace(/^['"]|['"]$/g, '');
  const base = first.split('/').pop() || '';
  if (!base || base === '&&' || base === ';') return '';
  return base.slice(0, 60);
}
function normalizeModel(model) {
  return String(model || '').toLowerCase().replace(/\[[^\]]*\]/g, '').trim();
}

class Pricing {
  constructor(config) {
    const prices = config && config.prices ? config.prices : {};
    this.models = prices.models || {};
    this.default = prices.default || this.models['deepseek-v4-flash'] || { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 };
  }
  rateFor(model) {
    const m = normalizeModel(model);
    if (!m) return this.default;
    for (const [name, rate] of Object.entries(this.models)) {
      if (m === name.toLowerCase() || m.includes(name.toLowerCase())) return rate;
    }
    if (m.includes('deepseek') && m.includes('pro')) return this.models['deepseek-v4-pro'] || this.default;
    if (m.includes('deepseek')) return this.models['deepseek-v4-flash'] || this.default;
    return null;
  }
  cost(model, usage) {
    const rate = this.rateFor(model);
    if (!rate) return null;
    const u = usage || {};
    const cacheMiss = num(rate.cacheMiss);
    const cacheHit = num(rate.cacheHit);
    const output = num(rate.output);
    const value = (nonNeg(u.input) * cacheMiss
      + nonNeg(u.cacheWrite) * cacheMiss
      + nonNeg(u.cacheRead) * cacheHit
      + nonNeg(u.output) * output) / 1_000_000;
    return Number.isFinite(value) ? value : null;
  }
}

function rangeWindow(range, day, now) {
  if (day) {
    const start = startOfDay(day);
    const end = endOfDay(day);
    if (start !== null && end !== null) return { start, end };
  }
  if (range && typeof range === 'object' && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    return range.start > range.end ? { start: range.end, end: range.start } : { start: range.start, end: range.end };
  }
  if (range === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { start: d.getTime(), end: null };
  }
  return { start: now - (range === '7d' ? 7 : 30) * DAY_MS, end: null };
}
function inWindow(ts, window) {
  return ts >= window.start && (window.end === null || ts <= window.end);
}
function dayInWindow(key, window) {
  const floor = dayKey(window.start);
  const ceiling = window.end === null ? null : dayKey(window.end);
  return (!floor || key >= floor) && (!ceiling || key <= ceiling);
}
function dayHasActivity(day) {
  return !!day && (day.tokens > 0 || day.requests > 0 || day.turns > 0 || day.toolCalls > 0 || day.toolsMs > 0);
}
function readScope(body) {
  const raw = body && typeof body.scope === 'object' && body.scope ? body.scope : {};
  const range = typeof raw.range === 'string' || (raw.range && typeof raw.range === 'object') ? raw.range : '30d';
  return {
    range,
    coverage: raw.coverage === 'active' || raw.coverage === 'archived' ? raw.coverage : 'all',
    day: typeof raw.day === 'string' && raw.day ? raw.day : null,
    group: typeof raw.group === 'string' && raw.group ? raw.group : null,
    query: typeof raw.query === 'string' ? raw.query.trim().toLowerCase().slice(0, 500) : '',
  };
}

export class ContextInsights {
  constructor({ runner, agents, logstore } = {}) {
    this.runner = runner;
    this.agents = agents;
    this.logstore = logstore;
    this.records = new Map();
    this.cacheMeta = new Map();
    this.pendingOld = new Set();
    this.fileCount = 0;
    this.unparsed = 0;
    this.pricing = new Pricing(null);
    this.ledgerById = new Map();
    this.ledgerMtime = 0;
    this.ledgerTotal = { tokens: 0, costUsd: 0 };
    this._cacheReady = null;
    this._scanPromise = null;
    this._bgPromise = null;
    this._lastScan = 0;
    this._scanned = false;
    this._allParsed = false;
    this._persistTimer = null;
    this._dirty = false;
  }

  async _ensureLoaded() {
    if (!this._cacheReady) this._cacheReady = this._load();
    return this._cacheReady;
  }

  async _load() {
    await this._loadLedger();
    try {
      const raw = await fsp.readFile(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === CACHE_VERSION && parsed.files && typeof parsed.files === 'object') {
        for (const [key, entry] of Object.entries(parsed.files)) {
          if (!entry || !entry.record || !Number.isFinite(entry.mtimeMs) || !Number.isFinite(entry.size)) continue;
          this.cacheMeta.set(key, entry);
          if (entry.record.agent && entry.record.id) this.records.set(key, entry.record);
        }
      }
    } catch { /* cache miss/corrupt */ }
  }

  async _loadLedger() {
    try {
      const stat = await fsp.stat(DSH_COST_LEDGER);
      if (stat.mtimeMs === this.ledgerMtime && this.pricing) return;
      const data = JSON.parse(await fsp.readFile(DSH_COST_LEDGER, 'utf8'));
      this.ledgerMtime = stat.mtimeMs;
      this.pricing = new Pricing(data && data.config ? data.config : null);
      const byId = new Map();
      for (const [day, entry] of Object.entries((data && data.days) || {})) {
        if (!entry || !Array.isArray(entry.sessions)) continue;
        for (const session of entry.sessions) {
          if (!session || !session.id) continue;
          const list = byId.get(session.id) || [];
          list.push({
            day,
            usage: {
              input: nonNeg(session.input),
              cacheRead: nonNeg(session.cacheRead),
              cacheWrite: nonNeg(session.cacheWrite),
              output: nonNeg(session.output),
            },
            calls: nonNeg(session.calls),
            costUsd: session.cost === undefined || session.cost === null ? null : num(session.cost),
          });
          byId.set(session.id, list);
        }
      }
      this.ledgerById = byId;
    } catch {
      this.ledgerById = new Map();
      this.pricing = new Pricing(null);
    }
  }

  _schedulePersist() {
    this._dirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      void this._persist();
    }, 1500);
    this._persistTimer.unref?.();
  }

  async _persist() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      const files = {};
      for (const [key, entry] of this.cacheMeta) {
        if (entry && entry.record) files[key] = entry;
      }
      const tmp = CACHE_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, savedAt: Date.now(), files }));
      await fsp.rename(tmp, CACHE_FILE);
    } catch (err) {
      try { this.logstore?.push('system', 'warn', `[context] 缓存写入失败: ${err.message}`); } catch { /* ignore */ }
    }
  }

  async _walk(dir, suffix, out) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return out; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await this._walk(full, suffix, out);
      else if (entry.isFile() && entry.name.endsWith(suffix)) {
        try {
          const stat = await fsp.stat(full);
          out.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch { /* skip */ }
      }
    }
    return out;
  }

  async _scan(includeOld) {
    await this._loadLedger();
    const files = [];
    await this._walk(CODEX_DIR, '.jsonl', files);
    await this._walk(CLAUDE_DIR, '.jsonl', files);
    await this._walk(DSH_SESSION_DIR, '.json', files);
    const wanted = new Set();
    const jobs = [];
    const now = Date.now();
    for (const file of files) {
      const agent = file.path.startsWith(CODEX_DIR) ? 'codex'
        : file.path.startsWith(CLAUDE_DIR) ? 'claude' : 'dsh';
      const key = `${agent}|${file.path}`;
      wanted.add(key);
      const cached = this.cacheMeta.get(key);
      const fresh = !!cached && Math.abs(cached.mtimeMs - file.mtimeMs) < 1.5 && cached.size === file.size;
      if (fresh && cached.record) {
        this.records.set(key, cached.record);
        continue;
      }
      const old = now - file.mtimeMs > RECENT_PARSE_MS;
      if (agent === 'dsh' || !old || includeOld) jobs.push({ ...file, agent, key });
      else {
        this.pendingOld.add(key);
        if (!cached || !cached.record) this.records.delete(key);
      }
    }
    for (const key of [...this.records.keys()]) {
      if (!wanted.has(key)) this.records.delete(key);
    }
    for (const key of [...this.cacheMeta.keys()]) {
      if (!wanted.has(key)) this.cacheMeta.delete(key);
    }
    await runPool(jobs, 3, file => this._parseFile(file));
    this.fileCount = files.length;
    this.unparsed = 0;
    for (const key of this.pendingOld) if (!this.records.has(key)) this.unparsed++;
    this._allParsed = this.pendingOld.size === 0;
    this._lastScan = Date.now();
    this._scanned = true;
    this._schedulePersist();
    if (this.pendingOld.size > 0) this._scheduleBackground();
  }

  _scheduleBackground() {
    if (this._bgPromise) return this._bgPromise;
    this._bgPromise = (async () => {
      const keys = [...this.pendingOld];
      for (let i = 0; i < keys.length; i += 2) {
        await new Promise(resolve => setTimeout(resolve, 80));
        const chunk = keys.slice(i, i + 2);
        await runPool(chunk, 2, key => {
          const cached = this.cacheMeta.get(key);
          if (!cached) return undefined;
          return this._parseFile({ path: cached.record?.file || key.slice(key.indexOf('|') + 1), agent: cached.record?.agent || key.split('|')[0], key, mtimeMs: cached.mtimeMs, size: cached.size });
        });
      }
      for (const key of keys) this.pendingOld.delete(key);
      this.unparsed = 0;
      this._allParsed = true;
      this._lastScan = 0;
      this._schedulePersist();
    })().finally(() => { this._bgPromise = null; });
    return this._bgPromise;
  }

  async _parseFile(file) {
    let record = null;
    file.withSeries = file.withSeries !== false && (Date.now() - nonNeg(file.mtimeMs) <= RECENT_PARSE_MS);
    try {
      if (file.agent === 'codex') record = await this._parseCodex(file);
      else if (file.agent === 'claude') record = await this._parseClaude(file);
      else record = await this._parseDsh(file);
    } catch (err) {
      try { this.logstore?.push('system', 'warn', `[context] 解析 ${file.path} 失败: ${err.message}`); } catch { /* ignore */ }
      return;
    }
    if (!record || !record.id) return;
    record.file = file.path;
    record.source = file.agent;
    record.updatedAt = Math.max(record.updatedAt || 0, file.mtimeMs || 0);
    this.records.set(file.key, record);
    this.cacheMeta.set(file.key, { mtimeMs: file.mtimeMs, size: file.size, record });
    this._dirty = true;
  }

  async _parseCodex(file) {
    const rec = emptyRecord('codex', file.path, path.basename(file.path, '.jsonl'));
    const stream = fs.createReadStream(file.path, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let prev = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    let lastInput = 0;
    let lastOutput = 0;
    let lastContextWindow = 0;
    let firstTs = 0;
    let lastTs = 0;
    const turns = new Set();
    let pointSeq = 0;
    let turnNo = 0;
    let stepNo = 0;
    let lastPointTs = 0;
    let sawMeta = false;
    for await (const line of rl) {
      if (!line) continue;
      const data = safeJson(line);
      if (!data) continue;
      const ts = Date.parse(data.timestamp || '') || file.mtimeMs;
      if (!firstTs) firstTs = ts;
      lastTs = ts;
      const payload = data.payload || {};
      if (data.type === 'session_meta') {
        sawMeta = true;
        rec.id = String(payload.id || payload.session_id || rec.id);
        rec.cwd = String(payload.cwd || rec.cwd || '');
        rec.createdAt = Date.parse(payload.timestamp || data.timestamp || '') || ts;
        const base = payload.base_instructions && payload.base_instructions.text;
        if (typeof base === 'string' && base) addPart(rec, 'system', estimateTokens(base));
        continue;
      }
      if (data.type === 'turn_context') {
        if (payload.model) rec.model = String(payload.model);
        if (payload.cwd) rec.cwd = String(payload.cwd);
        continue;
      }
      if (data.type === 'compacted') {
        rec.parts = emptyParts();
        const msg = payload.message || payload.summary || '';
        addPart(rec, 'inject', estimateTokens(String(msg)));
        continue;
      }
      if (data.type === 'event_msg') {
        if (payload.type === 'task_started') {
          const turnKey = payload.turn_id ? String(payload.turn_id) : `turn-${ts}`;
          if (!turns.has(turnKey)) {
            turns.add(turnKey);
            touchDay(rec, ts).turns++;
            turnNo = turns.size;
            stepNo = 0;
          }
          if (Number.isFinite(payload.model_context_window)) lastContextWindow = payload.model_context_window;
        } else if (payload.type === 'token_count') {
          const info = payload.info || {};
          const total = info.total_token_usage || {};
          const last = info.last_token_usage || total;
          const current = {
            input: nonNeg(total.input_tokens),
            cached: nonNeg(total.cached_input_tokens),
            cacheWrite: nonNeg(total.cache_write_input_tokens),
            output: nonNeg(total.output_tokens),
            reasoning: nonNeg(total.reasoning_output_tokens),
          };
          const reset = current.input < prev.input || current.output < prev.output;
          const delta = reset ? current : {
            input: Math.max(0, current.input - prev.input),
            cached: Math.max(0, current.cached - prev.cached),
            cacheWrite: Math.max(0, current.cacheWrite - prev.cacheWrite),
            output: Math.max(0, current.output - prev.output),
            reasoning: Math.max(0, current.reasoning - prev.reasoning),
          };
          const usage = {
            input: Math.max(0, delta.input - delta.cached),
            cacheRead: delta.cached,
            cacheWrite: delta.cacheWrite,
            output: delta.output,
          };
          if (usageTotal(usage) > 0) addUsageToDay(rec, ts, usage, 1);
          rec.reasoningTokens += delta.reasoning;
          prev = current;
          lastInput = nonNeg(last.input_tokens);
          lastOutput = nonNeg(last.output_tokens);
          lastContextWindow = nonNeg(info.model_context_window) || lastContextWindow;
          if (file.withSeries) {
            const total = lastInput + lastOutput;
            if (total > 0) {
              stepNo += 1;
              pointSeq += 1;
              pushSeries(rec, seriesPoint(rec, {
                time: ts,
                seq: pointSeq,
                turn: turnNo || 1,
                step: stepNo,
                total,
                prompt: lastInput,
                activeMs: lastPointTs > 0 ? Math.min(30 * 60_000, Math.max(0, ts - lastPointTs)) : 0,
              }));
              lastPointTs = ts;
            }
          }
        } else if (payload.type === 'item_completed') {
          const item = payload.item || {};
          if (item.type === 'AgentMessage') {
            const text = contentText(item.content);
            const tokens = estimateTokens(text);
            addPart(rec, 'assistant', tokens);
            rec.answerTokens += tokens;
            if (item.phase === 'final' && text.trim()) rec.lastUser = rec.lastUser || '';
          } else if (item.type === 'CommandExecution') {
            const started = nonNeg(item.started_at_ms);
            const ended = nonNeg(item.completed_at_ms);
            const ms = started > 0 && ended >= started ? ended - started : 0;
            if (ms > 0) {
              const day = touchDay(rec, ts);
              day.toolsMs += ms;
              rec.toolsMs += ms;
            }
            const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
            for (const entry of parsed.slice(0, 1)) {
              if (entry && typeof entry.cmd === 'string') addDayTally(rec, ts, 'cmds', commandProgram(entry.cmd));
            }
          }
        }
        continue;
      }
      if (data.type !== 'response_item') continue;
      if (payload.type === 'message') {
        const role = payload.role;
        const text = contentText(payload.content);
        const tokens = estimateTokens(text);
        if (role === 'developer') addPart(rec, 'inject', tokens);
        else if (role === 'assistant') addPart(rec, 'assistant', tokens);
        else if (role === 'user') {
          addPart(rec, 'user', tokens);
          if (!isInjectedUserText(text)) {
            const clean = text.trim();
            if (clean) {
              if (!rec.title) rec.title = clean.replace(/\s+/g, ' ').slice(0, 160);
              rec.lastUser = clean.replace(/\s+/g, ' ').slice(0, 400);
            }
          }
        }
      } else if (payload.type === 'reasoning') {
        const text = contentText(payload.content || payload.summary);
        const tokens = estimateTokens(text);
        addPart(rec, 'assistant', tokens);
        rec.reasoningTokens += tokens;
      } else if (payload.type === 'function_call') {
        const name = String(payload.name || 'tool');
        addDayTally(rec, ts, 'tools', name);
        touchDay(rec, ts).toolCalls++;
        rec.toolCalls++;
        let argsText = String(payload.arguments || '');
        let args = null;
        if (argsText) {
          args = safeJson(argsText);
          const tokens = estimateTokens(argsText);
          addPart(rec, 'assistant', tokens);
          rec.callTokens += tokens;
        }
        if (name === 'exec_command' && args && typeof args.cmd === 'string') {
          addDayTally(rec, ts, 'cmds', commandProgram(args.cmd));
        }
        if (name === 'skill' && args) addDayTally(rec, ts, 'skills', String(args.name || args.skill || name));
      } else if (payload.type === 'function_call_output') {
        addPart(rec, 'tool', estimateTokens(contentText(payload.output || payload.content)));
      }
    }
    rl.close();
    stream.destroy();
    rec.turns = turns.size || Math.max(1, Object.keys(rec.days).length);
    if (!turns.size && rec.turns > 0) ensureDay(rec, dayKey(rec.updatedAt || lastTs)).turns += rec.turns;
    rec.steps = rec.toolCalls + Object.values(rec.days).reduce((sum, day) => sum + day.calls, 0);
    rec.calls = Object.values(rec.days).reduce((sum, day) => sum + day.calls, 0);
    rec.createdAt = rec.createdAt || firstTs || file.mtimeMs;
    rec.updatedAt = lastTs || file.mtimeMs;
    rec.contextWindow = lastContextWindow || 258400;
    rec.maxOutputTokens = 0;
    rec.contextTotal = lastInput + lastOutput;
    scaleParts(rec.parts, lastInput || rec.contextTotal);
    rec.wallMs = Math.max(0, lastTs - firstTs);
    rec.timing = {
      wallMs: rec.wallMs,
      ttftMs: 0,
      genMs: Math.max(0, rec.wallMs - rec.toolsMs),
      calls: rec.calls,
      toolsMs: rec.toolsMs,
      toolCalls: rec.toolCalls,
      tools: {},
    };
    for (const [name, entry] of Object.entries(rec.tools)) {
      rec.timing.tools[name] = { calls: entry.n, ms: 0 };
    }
    for (const day of Object.values(rec.days)) {
      if (!day.wallMs && day.firstTs && day.lastTs) day.wallMs = Math.max(0, day.lastTs - day.firstTs);
    }
    if (!rec.title) rec.title = rec.lastUser || `Codex · ${rec.id.slice(0, 8)}`;
    if (!sawMeta) rec.title = rec.title || `Codex · ${rec.id.slice(0, 8)}`;
    this._finishRecord(rec);
    return rec;
  }

  async _parseClaude(file) {
    const rec = emptyRecord('claude', file.path, path.basename(file.path, '.jsonl'));
    const stream = fs.createReadStream(file.path, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let firstTs = 0;
    let lastTs = 0;
    let lastContext = 0;
    let pointSeq = 0;
    let stepNo = 0;
    let lastPointTs = 0;
    for await (const line of rl) {
      if (!line) continue;
      const data = safeJson(line);
      if (!data) continue;
      const ts = Date.parse(data.timestamp || '') || file.mtimeMs;
      if (!firstTs) firstTs = ts;
      lastTs = ts;
      if (data.cwd) rec.cwd = String(data.cwd);
      if (data.sessionId) rec.id = String(data.sessionId);
      if (data.type === 'user') {
        const message = data.message || {};
        const content = message.content;
        const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
        let userText = '';
        let hasToolResult = false;
        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'tool_result') {
            hasToolResult = true;
            addPart(rec, 'tool', estimateTokens(contentText(block.content)));
          } else if (block.type === 'text' && typeof block.text === 'string') {
            userText += (userText ? '\n' : '') + block.text;
          }
        }
        if (userText) {
          const clean = userText.trim();
          if (clean && !isInjectedUserText(clean)) {
            addPart(rec, 'user', estimateTokens(clean));
            if (!hasToolResult) {
              rec.turns++;
              touchDay(rec, ts).turns++;
              stepNo = 0;
            }
            if (!rec.title) rec.title = clean.replace(/\s+/g, ' ').slice(0, 160);
            rec.lastUser = clean.replace(/\s+/g, ' ').slice(0, 400);
          }
        }
        continue;
      }
      if (data.type !== 'assistant') continue;
      const message = data.message || {};
      const usage = message.usage || {};
      const input = nonNeg(usage.input_tokens);
      const cacheRead = nonNeg(usage.cache_read_input_tokens);
      const cacheWrite = nonNeg(usage.cache_creation_input_tokens);
      const output = nonNeg(usage.output_tokens);
      if (input + cacheRead + cacheWrite + output > 0) {
        addUsageToDay(rec, ts, { input, cacheRead, cacheWrite, output }, 1);
        lastContext = input + cacheRead + cacheWrite + output;
      }
      if (message.model) rec.model = String(message.model);
      rec.steps++;
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'thinking') {
          const tokens = estimateTokens(block.thinking || '');
          addPart(rec, 'assistant', tokens);
          rec.reasoningTokens += tokens;
        } else if (block.type === 'text') {
          const tokens = estimateTokens(block.text || '');
          addPart(rec, 'assistant', tokens);
          rec.answerTokens += tokens;
        } else if (block.type === 'tool_use') {
          const name = String(block.name || 'tool');
          const args = block.input || {};
          const tokens = estimateTokens(JSON.stringify(args));
          addPart(rec, 'assistant', tokens);
          rec.callTokens += tokens;
          rec.toolCalls++;
          touchDay(rec, ts).toolCalls++;
          addDayTally(rec, ts, 'tools', name);
          if ((name === 'Bash' || name === 'bash') && typeof args.command === 'string') {
            addDayTally(rec, ts, 'cmds', commandProgram(args.command));
          }
          if (name === 'Skill') addDayTally(rec, ts, 'skills', String(args.skill || args.name || name));
        }
      }
      if (file.withSeries && lastContext > 0) {
        stepNo += 1;
        pointSeq += 1;
        pushSeries(rec, seriesPoint(rec, {
          time: ts,
          seq: pointSeq,
          turn: rec.turns || 1,
          step: stepNo,
          total: lastContext,
          prompt: input + cacheRead + cacheWrite,
          activeMs: lastPointTs > 0 ? Math.min(30 * 60_000, Math.max(0, ts - lastPointTs)) : 0,
        }));
        lastPointTs = ts;
      }
    }
    rl.close();
    stream.destroy();
    const model = normalizeModel(rec.model);
    rec.contextWindow = /\[1m\]/i.test(rec.model || '') || model.includes('1m') ? 1_000_000 : 200_000;
    rec.maxOutputTokens = 32_000;
    rec.contextTotal = lastContext;
    scaleParts(rec.parts, lastContext);
    if (!rec.turns && (rec.steps > 0 || rec.toolCalls > 0)) {
      rec.turns = 1;
      ensureDay(rec, dayKey(lastTs || file.mtimeMs)).turns += 1;
    }
    rec.createdAt = rec.createdAt || firstTs || file.mtimeMs;
    rec.updatedAt = lastTs || file.mtimeMs;
    rec.calls = rec.steps;
    rec.wallMs = Math.max(0, lastTs - firstTs);
    rec.timing = {
      wallMs: rec.wallMs,
      ttftMs: 0,
      genMs: rec.wallMs,
      calls: rec.calls,
      toolsMs: 0,
      toolCalls: rec.toolCalls,
      tools: {},
    };
    for (const [name, entry] of Object.entries(rec.tools)) rec.timing.tools[name] = { calls: entry.n, ms: 0 };
    for (const day of Object.values(rec.days)) {
      if (!day.wallMs && day.firstTs && day.lastTs) day.wallMs = Math.max(0, day.lastTs - day.firstTs);
    }
    if (!rec.title) rec.title = rec.lastUser || `Claude · ${rec.id.slice(0, 8)}`;
    this._finishRecord(rec);
    return rec;
  }

  async _parseDsh(file) {
    const raw = JSON.parse(await fsp.readFile(file.path, 'utf8'));
    const data = raw && raw.record ? raw.record : raw;
    if (!data || typeof data !== 'object') return null;
    const id = path.basename(file.path, '.json');
    const rec = emptyRecord('dsh', file.path, id);
    const identity = data.identity || {};
    const rows = data.rows || {};
    const title = (rows.title && rows.title.val) || '';
    const tokenUsage = (rows.tokenUsage && rows.tokenUsage.val) || {};
    const totals = tokenUsage.totals || {};
    const pressure = (rows.contextPressure && rows.contextPressure.val) || {};
    const stats = (rows.sessionStats && rows.sessionStats.val) || {};
    const timeline = (rows.contextTimeline && rows.contextTimeline.val) || {};
    const outline = (rows.turnOutline && rows.turnOutline.val) || {};
    rec.id = String(id);
    rec.title = String(title || '').trim();
    rec.cwd = String(identity.cwd || '');
    rec.createdAt = nonNeg(identity.createdAt) || file.mtimeMs;
    const lastReq = Array.isArray(timeline.requests) && timeline.requests.length ? timeline.requests[timeline.requests.length - 1] : null;
    rec.updatedAt = Math.max(file.mtimeMs, nonNeg(lastReq && lastReq.time), rec.createdAt);
    rec.model = String(timeline.lastModel || timeline.model || '');
    rec.usage = {
      input: nonNeg(totals.uncachedInputTokens),
      cacheRead: nonNeg(totals.cacheReadTokens),
      cacheWrite: nonNeg(totals.cacheWriteTokens),
      output: nonNeg(totals.outputTokens),
    };
    const sums = timeline.sums || {};
    rec.parts = {
      system: nonNeg(timeline.systemTokens),
      tools: nonNeg(timeline.toolsTokens),
      user: nonNeg(sums.user),
      inject: nonNeg(sums.inject),
      skill: nonNeg(sums.skill),
      assistant: nonNeg(sums.assistant),
      tool: nonNeg(sums.tool),
    };
    if (file.withSeries && Array.isArray(timeline.requests)) {
      for (let i = Math.max(0, timeline.requests.length - MAX_SERIES); i < timeline.requests.length; i++) {
        const req = timeline.requests[i];
        if (!req || typeof req !== 'object') continue;
        const total = nonNeg(req.total);
        if (total <= 0) continue;
        pushSeries(rec, seriesPoint(rec, {
          time: nonNeg(req.time),
          seq: nonNeg(req.seq) || i + 1,
          turn: nonNeg(req.turn),
          step: nonNeg(req.step),
          total,
          prompt: nonNeg(req.prompt),
          activeMs: nonNeg(req.activeMs),
        }));
      }
    }
    rec.contextTotal = CAT_KEYS.reduce((sum, key) => sum + rec.parts[key], 0);
    rec.contextWindow = nonNeg(pressure.contextWindow) || nonNeg(timeline.contextWindow) || 1_000_000;
    rec.maxOutputTokens = nonNeg(timeline.maxOutputTokens) || 256_000;
    rec.turns = nonNeg(stats.turns) || nonNeg(timeline.totals && timeline.totals.turns);
    rec.steps = nonNeg(stats.steps) || nonNeg(timeline.totals && timeline.totals.steps);
    rec.calls = nonNeg(timeline.timing && timeline.timing.calls) || rec.steps;
    rec.toolCalls = nonNeg(timeline.timing && timeline.timing.toolCalls);
    rec.toolsMs = nonNeg(timeline.timing && timeline.timing.toolsMs);
    rec.wallMs = nonNeg(timeline.timing && timeline.timing.wallMs);
    rec.lastUser = String(timeline.lastUser || '').slice(0, 400);
    rec.reasoningTokens = nonNeg(timeline.generatedReasoning);
    rec.answerTokens = nonNeg(timeline.generatedAnswerTokens);
    rec.callTokens = nonNeg(timeline.generatedCallTokens);
    rec.timing = timeline.timing || null;
    rec.archived = false;
    const ledger = this.ledgerById.get(id) || [];
    if (ledger.length > 0) {
      for (const item of ledger) {
        const day = ensureDay(rec, item.day);
        day.usage.input += item.usage.input;
        day.usage.cacheRead += item.usage.cacheRead;
        day.usage.cacheWrite += item.usage.cacheWrite;
        day.usage.output += item.usage.output;
        day.tokens += usageTotal(item.usage);
        day.requests += item.calls;
        day.calls += item.calls;
        day.costUsd = day.costUsd === null ? item.costUsd : (item.costUsd === null ? day.costUsd : day.costUsd + item.costUsd);
      }
    } else {
      const day = ensureDay(rec, dayKey(rec.updatedAt));
      day.usage = { ...rec.usage };
      day.tokens = usageTotal(rec.usage);
      day.requests = rec.calls;
      day.calls = rec.calls;
    }
    const lastDayKey = dayKey(rec.updatedAt);
    const lastDay = ensureDay(rec, lastDayKey);
    lastDay.turns += rec.turns;
    lastDay.toolCalls += rec.toolCalls;
    lastDay.toolsMs += rec.toolsMs;
    lastDay.wallMs = Math.max(lastDay.wallMs, rec.wallMs);
    for (const [name, count] of Object.entries(timeline.toolTally || {})) {
      addDayTally(rec, rec.updatedAt, 'tools', name, nonNeg(count) || 1);
    }
    for (const [name, count] of Object.entries(timeline.programTally || {})) {
      addDayTally(rec, rec.updatedAt, 'cmds', name, nonNeg(count) || 1);
    }
    const skillNames = timeline.totals && timeline.totals.skills ? Object.keys(timeline.totals.skills) : [];
    for (const name of skillNames) addDayTally(rec, rec.updatedAt, 'skills', name, 1);
    if (!rec.title) {
      const turnsList = Array.isArray(outline.turns) ? outline.turns : [];
      const first = turnsList.find(t => t && typeof t.prompt === 'string' && t.prompt.trim());
      rec.title = first ? String(first.prompt).replace(/\s+/g, ' ').slice(0, 160) : `dsh · ${id.slice(0, 8)}`;
    }
    if (!rec.lastUser) {
      const turnsList = Array.isArray(outline.turns) ? outline.turns : [];
      for (let i = turnsList.length - 1; i >= 0; i--) {
        const prompt = turnsList[i] && turnsList[i].prompt;
        if (typeof prompt === 'string' && prompt.trim()) { rec.lastUser = prompt.trim().slice(0, 400); break; }
      }
    }
    // 把工具/命令/技能归类到最近活动日，保证 tally 的 last 时间可用。
    for (const key of Object.keys(rec.days)) {
      if (key < lastDayKey) {
        for (const field of ['tools', 'cmds', 'skills']) {
          for (const [name, value] of Object.entries(rec.days[key][field] || {})) {
            addTally(rec.days[lastDayKey][field], name, value.last, value.n);
            delete rec.days[key][field][name];
          }
        }
      }
    }
    this._finishRecord(rec);
    return rec;
  }

  _finishRecord(rec) {
    let cost = 0;
    let priced = false;
    for (const day of Object.values(rec.days || {})) {
      if (day.costUsd === null || day.costUsd === undefined) {
        const value = this.pricing.cost(rec.model, day.usage);
        day.costUsd = value;
      }
      if (day.costUsd !== null && day.costUsd !== undefined) {
        cost += day.costUsd;
        priced = true;
      }
    }
    rec.costUsd = priced ? cost : null;
    if (!rec.createdAt) rec.createdAt = rec.updatedAt || Date.now();
    if (!rec.updatedAt) rec.updatedAt = rec.createdAt;
    if (!rec.contextTotal) rec.contextTotal = usageTotal(rec.usage);
    if (!rec.contextWindow) rec.contextWindow = 0;
  }

  _runningKeys() {
    const tasks = this.runner && typeof this.runner.list === 'function' ? this.runner.list(100) : [];
    return tasks.filter(t => t && (t.status === 'running' || t.status === 'queued'));
  }

  rows() {
    const now = Date.now();
    const tasks = this._runningKeys();
    const out = [];
    for (const rec of this.records.values()) {
      if (!rec || !rec.id) continue;
      const recent = now - rec.updatedAt < 180_000;
      const activeTask = tasks.find(t => t.agentId === rec.agent
        && Math.abs((t.startedAt || t.createdAt || 0) - rec.createdAt) < 15 * 60_000);
      const running = !!activeTask || (recent && (rec.agent === 'codex' || rec.agent === 'dsh'));
      out.push({
        ...rec,
        running,
        archived: false,
        group: AGENT_LABEL[rec.agent] || rec.agent,
        agent: rec.agent,
        createdAt: rec.createdAt || rec.updatedAt,
        updatedAt: rec.updatedAt || rec.createdAt,
        costUsd: rec.costUsd === undefined ? null : rec.costUsd,
      });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  async snapshot({ includeOld = false } = {}) {
    await this._ensureLoaded();
    if (includeOld && this.pendingOld.size > 0) {
      if (this._bgPromise) await this._bgPromise;
    }
    const stale = !this._scanned || Date.now() - this._lastScan > SCAN_TTL_MS;
    if (stale || includeOld) {
      if (!this._scanPromise) {
        this._scanPromise = this._scan(includeOld).catch(err => {
          try { this.logstore?.push('system', 'warn', `[context] 扫描失败: ${err.message}`); } catch { /* ignore */ }
        }).finally(() => { this._scanPromise = null; });
      }
      await this._scanPromise;
    }
    return this.rows();
  }

  _scopeFilters(body) {
    const scope = readScope(body);
    const now = Date.now();
    return {
      scope,
      window: rangeWindow(scope.range, scope.day, now),
    };
  }

  _match(row, filters, { ignoreGroup = false, ignorePick = false } = {}) {
    const scope = filters.scope;
    if (scope.coverage !== 'all' && row.archived !== (scope.coverage === 'archived')) return false;
    if (!ignoreGroup && scope.group) {
      if (scope.group === '__ungrouped__') {
        if (row.group) return false;
      } else if (row.group !== scope.group) return false;
    }
    let inScope = inWindow(row.updatedAt, filters.window);
    if (!inScope) {
      for (const [key, day] of Object.entries(row.days || {})) {
        if (dayInWindow(key, filters.window) && dayHasActivity(day)) { inScope = true; break; }
      }
    }
    if (!inScope) return false;
    if (scope.day) {
      const day = row.days && row.days[scope.day];
      if (!dayHasActivity(day)) return false;
    }
    if (scope.query) {
      const q = scope.query;
      const lastUser = String(row.lastUser || '').toLowerCase();
      if (!String(row.title || '').toLowerCase().includes(q)
        && !String(row.cwd || '').toLowerCase().includes(q)
        && !lastUser.includes(q)) return false;
    }
    if (!ignorePick && filters.pick) {
      const dayAdmit = key => scope.day ? key === scope.day : dayInWindow(key, filters.window);
      let found = false;
      for (const [key, day] of Object.entries(row.days || {})) {
        if (!dayAdmit(key)) continue;
        if (day[filters.pick.field] && day[filters.pick.field][filters.pick.name]) { found = true; break; }
      }
      if (!found) return false;
    }
    return true;
  }

  _activity(row, filters) {
    const scope = filters.scope;
    const admit = key => scope.day ? key === scope.day : dayInWindow(key, filters.window);
    const usage = emptyUsage();
    const tools = {};
    const cmds = {};
    const skills = {};
    let tokens = 0;
    let turns = 0;
    let requests = 0;
    let calls = 0;
    let toolCalls = 0;
    let toolsMs = 0;
    let wallMs = 0;
    let cost = 0;
    let priced = false;
    for (const [key, day] of Object.entries(row.days || {})) {
      if (!admit(key)) continue;
      usage.input += nonNeg(day.usage && day.usage.input);
      usage.cacheRead += nonNeg(day.usage && day.usage.cacheRead);
      usage.cacheWrite += nonNeg(day.usage && day.usage.cacheWrite);
      usage.output += nonNeg(day.usage && day.usage.output);
      tokens += nonNeg(day.tokens);
      turns += nonNeg(day.turns);
      requests += nonNeg(day.requests);
      calls += nonNeg(day.calls);
      toolCalls += nonNeg(day.toolCalls);
      toolsMs += nonNeg(day.toolsMs);
      wallMs += nonNeg(day.wallMs);
      if (day.costUsd !== null && day.costUsd !== undefined) { cost += day.costUsd; priced = true; }
      for (const [name, value] of Object.entries(day.tools || {})) addTally(tools, name, value.last, value.n);
      for (const [name, value] of Object.entries(day.cmds || {})) addTally(cmds, name, value.last, value.n);
      for (const [name, value] of Object.entries(day.skills || {})) addTally(skills, name, value.last, value.n);
    }
    if (!calls) calls = requests;
    return { usage, tokens, turns, requests, calls, toolCalls, toolsMs, wallMs, costUsd: priced ? cost : null, tools, cmds, skills };
  }

  _summary(allRows, rows, filters) {
    let tokens = 0;
    let turns = 0;
    let calls = 0;
    let toolCalls = 0;
    let toolsMs = 0;
    let wallMs = 0;
    let cost = 0;
    let priced = false;
    let usageSessions = 0;
    let costSessions = 0;
    const parts = emptyParts();
    let reasoning = 0;
    let answers = 0;
    let callTokens = 0;
    for (const row of rows) {
      const activity = this._activity(row, filters);
      tokens += activity.tokens;
      turns += activity.turns;
      calls += activity.calls;
      toolCalls += activity.toolCalls;
      toolsMs += activity.toolsMs;
      wallMs += activity.wallMs;
      if (activity.costUsd !== null) { cost += activity.costUsd; priced = true; costSessions++; }
      if (usageTotal(activity.usage) > 0) usageSessions++;
      for (const key of CAT_KEYS) parts[key] += nonNeg(row.parts && row.parts[key]);
      reasoning += nonNeg(row.reasoningTokens);
      answers += nonNeg(row.answerTokens);
      callTokens += nonNeg(row.callTokens);
    }
    const billed = this._billedParts(parts, tokens, reasoning, answers, callTokens);
    const usageRows = rowsUsage(rows, filters);
    const cacheBase = sumUsage(usageRows, 'input') + sumUsage(usageRows, 'cacheRead') + sumUsage(usageRows, 'cacheWrite');
    const cacheRead = sumUsage(usageRows, 'cacheRead');
    const cacheHit = cacheBase > 0 ? `${Math.floor((cacheRead / cacheBase) * 100)}.${String(Math.floor(((cacheRead / cacheBase) * 10000) % 100)).padStart(2, '0')}` : null;
    const timing = this._aggregateTiming(rows);
    return {
      sessions: rows.length,
      sessionsTotal: allRows.length + this.unparsed,
      sessionsArchived: 0,
      archivedScoped: 0,
      tokens,
      turns,
      costUsd: priced ? cost : null,
      costSessions,
      usageSessions,
      cacheHit,
      tokenParts: billed.length > 0 ? billed : null,
      timing,
      windowTiming: { calls, toolCalls, toolsMs, wallMs },
      coverage: { complete: true, remaining: 0, failed: 0, running: false, total: rows.length, covered: rows.length, unsupported: 0 },
    };
  }

  _billedParts(parts, target, reasoning, answers, calls) {
    const values = {};
    for (const key of CAT_KEYS) values[key] = nonNeg(parts[key]);
    const contextTotal = CAT_KEYS.reduce((sum, key) => sum + values[key], 0);
    if (!(target > 0)) return [];
    if (!(contextTotal > 0)) return [{ key: 'answers', value: target }];
    const scale = target / contextTotal;
    const assistant = values.assistant * scale;
    const reasoningShare = reasoning > 0 || answers > 0 || calls > 0
      ? reasoning / Math.max(1, reasoning + answers + calls)
      : 0.4;
    const answersShare = reasoning > 0 || answers > 0 || calls > 0
      ? answers / Math.max(1, reasoning + answers + calls)
      : 0.4;
    const callsShare = reasoning > 0 || answers > 0 || calls > 0
      ? calls / Math.max(1, reasoning + answers + calls)
      : 0.2;
    const out = {
      system: values.system * scale,
      tools: values.tools * scale,
      user: values.user * scale,
      inject: values.inject * scale,
      skill: values.skill * scale,
      toolCalls: values.tool * scale + assistant * callsShare,
      thinking: assistant * reasoningShare,
      answers: assistant * answersShare,
    };
    return RING_ORDER
      .map(key => ({ key, value: Math.round(nonNeg(out[key])) }))
      .filter(item => item.value > 0);
  }

  _aggregateTiming(rows) {
    if (rows.length === 0) return null;
    let out = null;
    for (const row of rows) {
      const timing = row.timing;
      if (!timing) continue;
      if (!out) {
        out = {
          wallMs: nonNeg(timing.wallMs),
          ttftMs: nonNeg(timing.ttftMs),
          genMs: nonNeg(timing.genMs),
          calls: nonNeg(timing.calls),
          toolsMs: nonNeg(timing.toolsMs),
          toolCalls: nonNeg(timing.toolCalls),
          tools: {},
        };
        for (const [name, value] of Object.entries(timing.tools || {})) out.tools[name] = { calls: nonNeg(value.calls), ms: nonNeg(value.ms) };
        continue;
      }
      out.wallMs += nonNeg(timing.wallMs);
      out.ttftMs += nonNeg(timing.ttftMs);
      out.genMs += nonNeg(timing.genMs);
      out.calls += nonNeg(timing.calls);
      out.toolsMs += nonNeg(timing.toolsMs);
      out.toolCalls += nonNeg(timing.toolCalls);
      for (const [name, value] of Object.entries(timing.tools || {})) {
        const prev = out.tools[name] || { calls: 0, ms: 0 };
        out.tools[name] = { calls: prev.calls + nonNeg(value.calls), ms: prev.ms + nonNeg(value.ms) };
      }
    }
    return out;
  }

  _days(allRows, filters) {
    const totals = new Map();
    for (const row of allRows) {
      if (filters.scope.coverage !== 'all' && row.archived !== (filters.scope.coverage === 'archived')) continue;
      for (const [key, day] of Object.entries(row.days || {})) {
        if (!dayHasActivity(day)) continue;
        const entry = totals.get(key) || { key, tokens: 0, sessions: 0, cost: 0, priced: false };
        entry.tokens += nonNeg(day.tokens);
        entry.sessions += 1;
        if (day.costUsd !== null && day.costUsd !== undefined) { entry.cost += day.costUsd; entry.priced = true; }
        totals.set(key, entry);
      }
    }
    return [...totals.values()]
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map(entry => ({ key: entry.key, tokens: Math.round(entry.tokens), sessions: entry.sessions, costUsd: entry.priced ? entry.cost : null }));
  }

  _groupCounts(scoped) {
    const counts = new Map();
    for (const row of scoped) counts.set(row.group, (counts.get(row.group) || 0) + 1);
    const out = [];
    for (const agent of AGENTS) {
      out.push({ key: agent.label, count: counts.get(agent.label) || 0 });
    }
    return out;
  }

  _page(rows, filters, sort, page) {
    const scoped = rows.filter(row => this._match(row, filters, { ignoreGroup: true, ignorePick: true }));
    const filtered = rows.filter(row => this._match(row, filters));
    const sorted = [...filtered];
    if (sort === 'tokens') sorted.sort((a, b) => usageTotal(b.usage) - usageTotal(a.usage));
    else if (sort === 'context') sorted.sort((a, b) => (b.contextTotal || 0) - (a.contextTotal || 0));
    else sorted.sort((a, b) => b.updatedAt - a.updatedAt);
    const count = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    const index = Math.min(Math.max(0, page), count - 1);
    return {
      items: sorted.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE).map(row => this._pageRow(row)),
      index,
      count,
      total: sorted.length,
      scopeTotal: scoped.length,
      groups: this._groupCounts(scoped),
    };
  }

  _pageRow(row) {
    const parts = CAT_KEYS.map(key => ({ key, value: Math.round(nonNeg(row.parts && row.parts[key])) })).filter(part => part.value > 0);
    const out = {
      id: row.id,
      title: row.title || row.id,
      updatedAt: row.updatedAt,
      running: !!row.running,
      archived: !!row.archived,
      group: row.group,
      tokens: Math.round(usageTotal(row.usage)),
      turns: nonNeg(row.turns),
      parts,
      total: Math.round(nonNeg(row.contextTotal)),
      costUsd: row.costUsd === null || row.costUsd === undefined ? null : row.costUsd,
    };
    if (row.cwd) out.cwd = row.cwd;
    if (row.steps) out.steps = row.steps;
    if (row.contextWindow) out.contextWindow = row.contextWindow;
    if (row.maxOutputTokens) out.maxOutputTokens = row.maxOutputTokens;
    if (row.model) out.model = row.model;
    if (row.lastUser) out.lastUser = row.lastUser;
    out.createdDay = dayKey(row.createdAt || row.updatedAt);
    return out;
  }

  _tally(rows, filters, field) {
    const stats = new Map();
    for (const row of rows) {
      if (!this._match(row, filters, { ignorePick: true })) continue;
      const activity = this._activity(row, filters);
      const table = activity[field] || {};
      for (const [name, value] of Object.entries(table)) {
        const prev = stats.get(name) || { name, n: 0, sessions: 0, last: 0 };
        prev.n += nonNeg(value.n);
        prev.last = Math.max(prev.last, nonNeg(value.last));
        prev.sessions += 1;
        stats.set(name, prev);
      }
    }
    return [...stats.values()].sort((a, b) => (b.n - a.n) || (b.last - a.last) || (a.name < b.name ? -1 : 1));
  }

  async overview(body) {
    const part = body && body.part;
    if (!['summary', 'days', 'page', 'tally', 'trend'].includes(part)) throw new Error('unknown overview part');
    const filters = this._scopeFilters(body);
    filters.pick = body && body.pick && ['skills', 'tools', 'cmds'].includes(body.pick.field) && body.pick.name
      ? { field: body.pick.field, name: String(body.pick.name) } : null;
    const includeOld = filters.scope.day
      ? (startOfDay(filters.scope.day) || 0) < Date.now() - RECENT_PARSE_MS
      : (filters.window.start || 0) < Date.now() - RECENT_PARSE_MS;
    const allRows = await this.snapshot({ includeOld });
    const revision = this._revision(allRows);
    const rows = allRows.filter(row => this._match(row, filters));
    const sort = body && ['recent', 'tokens', 'context'].includes(body.sort) ? body.sort : 'recent';
    const page = Math.max(0, Math.floor(num(body && body.page)));
    const tally = body && ['skills', 'tools', 'cmds'].includes(body.tally) ? body.tally : 'skills';
    if (part === 'summary') {
      return { revision, pricingReady: true, summary: this._summary(allRows, rows, filters) };
    }
    if (part === 'days') {
      return { revision, pricingReady: true, days: this._days(allRows, filters) };
    }
    if (part === 'tally') {
      return { revision, pricingReady: true, tally: { field: tally, stats: this._tally(allRows, filters, tally) } };
    }
    if (part === 'trend') {
      return { revision, pricingReady: true, trend: this._trend(rows, body) };
    }
    return { revision, pricingReady: true, page: this._page(allRows, filters, sort, page) };
  }

  _trend(rows, body) {
    const sessions = [];
    for (const row of rows) {
      if (!row || !Array.isArray(row.series) || row.series.length === 0) continue;
      sessions.push({
        id: row.id,
        agent: row.agent,
        group: row.group,
        title: row.title || row.id,
        updatedAt: row.updatedAt,
        turns: nonNeg(row.turns),
        steps: nonNeg(row.steps),
        total: nonNeg(row.contextTotal),
        points: row.series.length,
      });
    }
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const wanted = body && typeof body.sessionId === 'string' ? body.sessionId : '';
    let selected = wanted ? sessions.find(item => item.id === wanted) || null : null;
    if (!selected) selected = sessions[0] || null;
    const record = selected ? rows.find(row => row.id === selected.id && Array.isArray(row.series)) : null;
    const points = record ? record.series.slice(-MAX_TREND_POINTS) : [];
    return {
      sessions: sessions.slice(0, 80),
      selected: selected ? selected.id : null,
      title: selected ? selected.title : '',
      agent: selected ? selected.agent : '',
      points,
    };
  }

  _revision(rows) {
    const digest = crypto.createHash('sha1');
    digest.update(String(rows.length));
    for (const row of rows) digest.update(`${row.agent}|${row.id}|${row.updatedAt}|${usageTotal(row.usage)};`);
    return digest.digest('hex').slice(0, 16);
  }

  async skills() {
    const rows = await this.snapshot({ includeOld: false });
    const found = new Map();
    for (const row of rows) {
      for (const [name, entry] of Object.entries(row.skills || {})) {
        const prev = found.get(name) || { name, source: row.group, description: '' };
        found.set(name, prev);
        if (entry && entry.last > (prev.last || 0)) prev.last = entry.last;
      }
    }
    return { skills: [...found.values()] };
  }

  version() {
    return { ready: true, failed: false, checkedAt: Date.now(), current: PLUGIN_VERSION, latest: null, updateAvailable: false };
  }

  balance() {
    return { isAvailable: false, balances: [] };
  }

  backfill() {
    return { started: false, complete: true, remaining: 0, failed: 0, running: false };
  }
}

function rowsUsage(rows, filters) {
  return rows.map(row => {
    const usage = emptyUsage();
    for (const [key, day] of Object.entries(row.days || {})) {
      const admit = filters.scope.day ? key === filters.scope.day : dayInWindow(key, filters.window);
      if (!admit) continue;
      usage.input += nonNeg(day.usage && day.usage.input);
      usage.cacheRead += nonNeg(day.usage && day.usage.cacheRead);
      usage.cacheWrite += nonNeg(day.usage && day.usage.cacheWrite);
      usage.output += nonNeg(day.usage && day.usage.output);
    }
    return usage;
  });
}
function sumUsage(list, key) {
  let sum = 0;
  for (const usage of list) sum += nonNeg(usage[key]);
  return sum;
}
async function runPool(items, limit, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      if (item === undefined) continue;
      await worker(item);
    }
  });
  await Promise.all(workers);
}
