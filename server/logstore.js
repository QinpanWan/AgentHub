// AgentHub 日志与报错收集:环形缓冲 + 落盘 + 错误模式识别
import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from './config.js';

const ERROR_RE = /(error|fail(ed|ure)?|exception|traceback|EPERM|EACCES|ENOENT|EADDRINUSE|EAGAIN|refused|timeout(?!\s*\(\d)|crash|panic|core dump|崩溃|失败|异常|拒绝连接)/i;
const ERROR_WHITELIST = /(no error|0 error|without error|not an error|errors?:?\s*0|error: none|no errors|warning|experimental|deprecat|debugger listening|--errors|error\(\d|error code)/i;

export class LogStore {
  constructor() {
    this.lines = [];
    this.errors = [];
    this.maxLines = 1200;
    this.maxErrors = 500;
    this._fds = new Map();
  }

  _fd(agent) {
    const safe = String(agent || 'system').replace(/[^a-zA-Z0-9_-]/g, '_') || 'system';
    let fd = this._fds.get(safe);
    if (!fd) {
      try {
        fd = fs.openSync(path.join(LOGS_DIR, `${safe}.log`), 'a');
        this._fds.set(safe, fd);
      } catch { fd = null; }
    }
    return fd;
  }

  push(agent, level, text) {
    const ts = Date.now();
    const line = String(text == null ? '' : text).replace(/\n$/, '');
    if (!line) return;
    this.lines.push({ ts, agent, level, text: line.slice(0, 2000) });
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    const fd = this._fd(agent);
    if (fd != null) {
      try { fs.writeSync(fd, `[${new Date(ts).toISOString()}] [${level}] ${line}\n`); } catch { /* ignore */ }
    }
    if (level === 'stderr' || level === 'error') this._detect(agent, line);
  }

  _detect(agent, text) {
    if (!text || /^\s*$/.test(text)) return;
    if (!ERROR_RE.test(text)) return;
    if (ERROR_WHITELIST.test(text)) return;
    this.errors.push({
      ts: Date.now(),
      agent,
      source: 'stderr',
      line: text.slice(0, 300),
      context: this._recentContext(agent, 3)
    });
    if (this.errors.length > this.maxErrors) this.errors.splice(0, this.errors.length - this.maxErrors);
  }

  _recentContext(agent, n) {
    const out = [];
    for (let i = this.lines.length - 1; i >= 0 && out.length < n; i--) {
      if (this.lines[i].agent === agent) out.unshift(this.lines[i].text.slice(0, 200));
    }
    return out;
  }

  // 供测试/演示注入
  injectError(agent, text) { this._detect(agent, text); }

  query({ agent, level, limit = 200 } = {}) {
    let out = this.lines;
    if (agent) out = out.filter(l => l.agent === agent);
    if (level) out = out.filter(l => l.level === level);
    return out.slice(-limit);
  }

  errorsList(limit = 200) { return this.errors.slice(-limit); }
  clearErrors() { this.errors = []; }
  errorCount() { return this.errors.length; }

  // 最近 hours 小时逐小时错误数(数组,末位为当前小时)
  errorStats(hours = 24) {
    const now = Date.now();
    const buckets = new Array(hours).fill(0);
    for (const e of this.errors) {
      const h = Math.floor((now - e.ts) / 3600000);
      if (h >= 0 && h < hours) buckets[hours - 1 - h]++;
    }
    return buckets;
  }
}
