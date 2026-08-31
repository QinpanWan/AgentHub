// AgentHub 资源监控:/proc + ps 双通道,2s 轮询,环形历史
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const HZ = 100; // 时钟频率

// —— CPU/SoC 型号:仿鸿蒙设备信息应用读取 ——
// 鸿蒙应用一般经 @ohos.systemParameter.getSync('ro.soc.model'/'ro.board.platform'…)
// 或 @ohos.deviceInfo.chipType 读系统属性;Linux 侧等价物是 getprop/build.prop,
// 拿不到再回退 /proc/cpuinfo(Android/鸿蒙通用),最后按 implementer/part 解码核心。
const ARM_IMPLS = {
  '0x41': 'ARM', '0x42': 'Broadcom', '0x43': 'Cavium', '0x44': 'DEC',
  '0x46': 'Fujitsu', '0x48': 'HiSilicon', '0x49': 'Infineon', '0x4d': 'Freescale',
  '0x4e': 'NVIDIA', '0x50': 'APM', '0x51': 'Qualcomm', '0x56': 'Marvell',
  '0x61': 'Apple', '0x66': 'Faraday', '0x69': 'Intel', '0x6d': 'Microsoft', '0xc0': 'Ampere'
};
const ARM_PARTS = {
  '0x41': { '0xd03': 'Cortex-A53', '0xd05': 'Cortex-A55', '0xd07': 'Cortex-A57', '0xd08': 'Cortex-A72', '0xd09': 'Cortex-A73', '0xd0a': 'Cortex-A75', '0xd0b': 'Cortex-A76', '0xd0c': 'Cortex-A77', '0xd0d': 'Cortex-A78', '0xd40': 'Cortex-A76', '0xd41': 'Cortex-A76AE', '0xd42': 'Cortex-A77', '0xd43': 'Cortex-A78', '0xd44': 'Cortex-X1', '0xd46': 'Cortex-A78AE', '0xd49': 'Cortex-X2', '0xd4a': 'Cortex-X3', '0xd4b': 'Cortex-X4', '0xd80': 'Cortex-A520', '0xd81': 'Cortex-A720' },
  '0x48': { '0xd40': 'Cortex-A76', '0xd41': 'Cortex-A76AE', '0xd42': 'Cortex-A77', '0xd43': 'Cortex-A78', '0xd44': 'Cortex-X1', '0xd49': 'Cortex-X2' },
  '0x51': { '0x800': 'Kryo 260/280', '0x801': 'Kryo 260/280 Gold', '0x802': 'Kryo 260/280 Silver', '0x803': 'Kryo 385 Gold', '0x804': 'Kryo 385 Silver', '0x205': 'Kryo 460 Gold', '0x211': 'Kryo 660 Gold', '0x212': 'Kryo 660 Silver' }
};
const SOC_PROPS = ['ro.soc.model', 'ro.chipname', 'ro.board.platform', 'ro.hardware', 'ro.product.board'];
const SOC_PROP_FILES = ['/system/build.prop', '/vendor/build.prop', '/odm/etc/build.prop', '/product/etc/build.prop'];

// 读系统属性(等价鸿蒙 @ohos.systemParameter.getSync):先 getprop 命令,再常见 build.prop 文件
function readProp(name) {
  try {
    const v = execFileSync('getprop', [name], { encoding: 'utf8', timeout: 1000 }).trim();
    if (v) return v; // 属性不存在时 getprop 返回空串
  } catch { /* 无 getprop 命令 */ }
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const f of SOC_PROP_FILES) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(new RegExp(`^${esc}=(.*)$`, 'm'));
      if (m && m[1].trim()) return m[1].trim();
    } catch { /* ignore */ }
  }
  return '';
}

let _cpuModel = null; // 型号不变,只读一次
// 归一化华为/麒麟命名:鸿蒙设备信息应用展示为 "Hisilicon Kirin X90"
function normalizeSoc(model) {
  if (!model) return model;
  const m = model.match(/^(?:huawei\s*)?kirin\s*x?\s*([\d]+)/i);
  return m ? `Hisilicon Kirin X${m[1]}` : model;
}
function cpuModel() {
  if (_cpuModel !== null) return _cpuModel;
  let model = '';
  // 1) 系统属性(鸿蒙设备信息应用主路线)
  const soc = readProp('ro.soc.model');
  if (soc) {
    const vendor = readProp('ro.soc.manufacturer');
    model = vendor && !soc.toLowerCase().includes(vendor.toLowerCase()) ? `${vendor} ${soc}` : soc;
  } else {
    for (const k of ['ro.chipname', 'ro.board.platform', 'ro.hardware', 'ro.product.board']) {
      model = readProp(k);
      if (model) break;
    }
  }
  // 2) /proc/cpuinfo:model name(x86)→ Hardware(ARM SoC,如 HUAWEI KirinX90)
  if (!model) {
    try {
      const text = fs.readFileSync('/proc/cpuinfo', 'utf8');
      const get = (key) => {
        const m = text.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'));
        return m ? m[1].trim() : '';
      };
      model = get('model name') || get('Hardware');
      if (!model) {
        const impl = get('CPU implementer').toLowerCase();
        const part = get('CPU part').toLowerCase();
        const impName = ARM_IMPLS[impl];
        if (impName) {
          const partName = (ARM_PARTS[impl] || {})[part];
          model = partName ? `${impName} ${partName}` : `${impName} (part ${part || '?'})`;
        } else {
          model = get('Processor'); // 兜底:通用 AArch64 描述
        }
      }
    } catch { /* ignore */ }
  }
  _cpuModel = normalizeSoc(model) || null;
  return _cpuModel;
}

// —— 磁盘使用率:探测真实存储分区 ——
// 鸿蒙上根目录是 tmpfs(/mnt/hmdfs/100,16G 且几乎恒空),df -k / 恒得 1%,
// 前端「存储剩余」会错显示成 99%。真实用户数据在 userdata 分区,挂载点随版本
// 而变(/data/service/el1/public/startup/profile 等),故对候选路径各跑一次 df,
// 取容量最大者(即真实存储),并记住命中路径,减少后续探测开销。
const DISK_CANDIDATES = [
  '/data/service/el1/public/startup/profile', // 鸿蒙 userdata 分区
  '/storage/Users/currentUser',               // 工作区所在 hmdfs 视图
  '/data',
  '/'
];
let _diskBestPath = null;
function readDiskUsePct() {
  const paths = _diskBestPath ? [_diskBestPath] : DISK_CANDIDATES;
  let best = null;
  for (const p of paths) {
    try {
      const stdout = execFileSync('df', ['-k', p], { encoding: 'utf8', timeout: 3000 });
      const line = String(stdout).split('\n')[1];
      if (!line) continue;
      const m = line.trim().split(/\s+/);
      const total = Number(m[1]);
      const use = Number((m[4] || '').replace('%', ''));
      if (m.length < 5 || !Number.isFinite(total) || !Number.isFinite(use)) continue;
      if (!best || total > best.total) best = { total, use, path: p };
    } catch { /* 该候选不可达,继续下一个 */ }
  }
  if (!best) { _diskBestPath = null; return null; }
  _diskBestPath = best.path;
  return Math.round(best.use);
}


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
    const out = { cpu: 0, mem: 0, memUsed: 0, memTotal: 0, load1: 0, load5: 0, load15: 0, disk: null, uptime: 0, cpuModel: null };
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
      this._diskCache = readDiskUsePct();
    }
    out.disk = this._diskCache;
    out.cpuModel = cpuModel();
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
