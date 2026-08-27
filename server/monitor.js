// AgentHub 资源监控:/proc + ps 双通道,2s 轮询,环形历史
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const HZ = 100; // 时钟频率

export class Monitor {
  constructor({ pollMs = 2000, historySize = 300 } = {}) {
    this.pollMs = pollMs;
    this.historySize = historySize;
    this.history = [];
    this.latest = null;
    this._prevStat = null;
    this._prevProc = new Map();
    this._diskCache = null;
    this._diskAt = 0;
    this._timer = null;
    this._lastTickAt = 0;
  }

  start() {
    this._tick();
    this._timer = setInterval(() => this._tick(), this.pollMs);
    if (this._timer.unref) this._timer.unref();
  }
  stop() { if (this._timer) clearInterval(this._timer); }

  _tick() {
    const now = Date.now();
    if (now - this._lastTickAt < 300) return; // 防抖
    this._lastTickAt = now;
    try {
      const sys = this._system();
      const procs = this._ps();
      const snap = { ts: now, sys, procs };
      this.latest = snap;
      this.history.push(snap);
      if (this.history.length > this.historySize) this.history.shift();
    } catch (e) {
      // 单轮失败不致命
    }
  }

  _system() {
    const out = { cpu: 0, mem: 0, memUsed: 0, memTotal: 0, load1: 0, load5: 0, load15: 0, disk: null, uptime: 0 };
    try {
      const stat = fs.readFileSync('/proc/stat', 'utf8');
      const line = stat.split('\n').find(l => l.startsWith('cpu '));
      if (line) {
        const parts = line.split(/\s+/).slice(1).map(Number);
        const idle = (parts[3] || 0) + (parts[4] || 0);
        const total = parts.reduce((a, b) => a + (b || 0), 0);
        if (this._prevStat && total > this._prevStat.total) {
          const dTotal = total - this._prevStat.total;
          const dIdle = idle - this._prevStat.idle;
          out.cpu = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 1000) / 10 : 0;
        }
        this._prevStat = { total, idle };
      }
    } catch { /* ignore */ }
    try {
      const mem = fs.readFileSync('/proc/meminfo', 'utf8');
      // 注意:必须带 'm' 标志,^ 才匹配每一行(否则只有第一行 MemTotal 能匹配,MemAvailable 永远取到 0 → 内存 100%)
      const g = (k) => { const m = mem.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')); return m ? Number(m[1]) : 0; };
      const total = g('MemTotal');
      // MemAvailable 缺失时按 Linux 标准回退: Free + Buffers + Cached(+SReclaimable),再不行只用 Free
      let avail = g('MemAvailable');
      if (!avail) avail = g('MemFree') + g('Buffers') + g('Cached') + g('SReclaimable');
      if (!avail) avail = g('MemFree');
      out.memTotal = total > 0 ? Math.round(total / 1024) : 0;
      out.memUsed = total > 0 ? Math.round((total - avail) / 1024) : 0;
      out.mem = total > 0 ? Math.round(((total - avail) / total) * 1000) / 10 : 0;
      this._memTotal = total > 0 ? total * 1024 : null; // 供进程 mem% 计算
    } catch { /* ignore */ }
    try {
      const [l1, l5, l15] = fs.readFileSync('/proc/loadavg', 'utf8').split(/\s+/);
      out.load1 = Number(l1) || 0; out.load5 = Number(l5) || 0; out.load15 = Number(l15) || 0;
    } catch { /* ignore */ }
    try { out.uptime = Math.round(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) || 0); } catch { /* ignore */ }
    if (Date.now() - this._diskAt > 30000) {
      this._diskAt = Date.now();
      try {
        const stdout = execFileSync('df', ['-k', '/'], { encoding: 'utf8', timeout: 3000 });
        const line = String(stdout).split('\n')[1];
        if (line) {
          const m = line.trim().split(/\s+/);
          if (m.length >= 5) this._diskCache = Math.round(Number(m[4].replace('%', '')));
        }
      } catch { this._diskCache = null; }
    }
    out.disk = this._diskCache;
    return out;
  }

  // 进程表:优先 /proc 直读(鸿蒙 ps 不支持 GNU -o 字段),ps -ef 兜底
  _ps() {
    const out = new Map();
    const now = Date.now();
    let pids = [];
    try {
      for (const d of fs.readdirSync('/proc')) {
        if (/^\d+$/.test(d)) pids.push(Number(d));
      }
    } catch { /* ignore */ }

    if (!pids.length) {
      // 兜底:ps -ef 只取 pid/comm/args(cpu/mem 无法从 -ef 得到)
      try {
        const stdout = execFileSync('ps', ['-ef'], { encoding: 'utf8', timeout: 4000 });
        for (const raw of String(stdout).split('\n')) {
          const m = raw.trim().match(/^\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
          if (!m) continue;
          const pid = Number(m[1]);
          const args = m[2];
          out.set(pid, { pid, cpu: 0, mem: 0, rss: 0, comm: (args.split(/\s+/)[0] || '').slice(0, 32), args: args.slice(0, 300) });
        }
      } catch { /* ignore */ }
      return out;
    }

    for (const pid of pids) {
      const entry = { pid, cpu: 0, mem: 0, rss: 0, comm: '', args: '' };
      try {
        entry.comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim().slice(0, 32);
      } catch { continue; } // 进程已退出
      try {
        const cl = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        entry.args = cl.replace(/\0/g, ' ').trim().slice(0, 300);
      } catch { /* ignore */ }
      try {
        const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const r = st.lastIndexOf(')');
        const fields = st.slice(r + 1).trim().split(/\s+/);
        const utime = Number(fields[11] || 0);
        const stime = Number(fields[12] || 0);
        const prev = this._prevProc.get(pid);
        if (prev) {
          const dTicks = utime + stime - prev.ticks;
          const dMs = now - prev.ts;
          if (dMs > 0 && dTicks >= 0) entry.cpu = Math.round((dTicks / HZ / (dMs / 1000)) * 1000) / 10;
        }
        this._prevProc.set(pid, { ticks: utime + stime, ts: now });
      } catch { /* ignore */ }
      try {
        const sm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(/\s+/);
        entry.rss = (Number(sm[1]) || 0) * 4096;
        if (this._memTotal) entry.mem = Math.round((entry.rss / this._memTotal) * 1000) / 10;
      } catch { /* ignore */ }
      out.set(pid, entry);
    }
    if (this._prevProc.size > 3000) {
      for (const pid of this._prevProc.keys()) if (!out.has(pid)) this._prevProc.delete(pid);
    }
    return out;
  }

  matchProcs(procs, matchers) {
    const hits = [];
    if (!procs) return hits;
    for (const p of procs.values()) {
      for (const m of matchers) {
        try { if (m(p)) { hits.push(p); break; } } catch { /* ignore */ }
      }
    }
    return hits;
  }

  // 聚合一组进程的 cpu/mem/rss
  aggregate(procs) {
    let cpu = 0, mem = 0, rss = 0;
    for (const p of procs) { cpu += p.cpu || 0; mem += p.mem || 0; rss += p.rss || 0; }
    return { cpu: Math.round(cpu * 10) / 10, mem: Math.round(mem * 10) / 10, rss, pids: procs.map(p => p.pid) };
  }
}
