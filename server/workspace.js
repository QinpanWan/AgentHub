// AgentHub 工作区管理:dsh 工作区(只读浏览/统计/预览)
// 默认根: ~/WorkBuddy(会话工作区) 与 ~/dsh-kb(知识库/归档),可在设置页配置
// 安全:所有路径必须落在已配置根目录内,防越权读取
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();

export class Workspaces {
  constructor({ config }) {
    this.config = config;
  }

  roots() {
    const cfgRoots = (this.config.workspaces && this.config.workspaces.roots) || [];
    const defaults = [path.join(HOME, 'WorkBuddy'), path.join(HOME, 'dsh-kb')];
    const candidates = cfgRoots.length ? cfgRoots : defaults;
    const out = [];
    for (const r of candidates) {
      if (!r || typeof r !== 'string') continue;
      const abs = path.resolve(r.replace(/^~(?=\/|$)/, HOME));
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) out.push(abs);
      } catch { /* ignore */ }
    }
    return out;
  }

  _inside(abs) {
    return this.roots().some(r => abs === r || abs.startsWith(r + path.sep));
  }

  // 工作区总览:每个根的文件数/大小/最近修改/最近文件
  list() {
    const out = [];
    for (const root of this.roots()) {
      let files = 0, size = 0, last = 0;
      const recent = [];
      try {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          const p = path.join(root, e.name);
          try {
            const st = fs.statSync(p);
            if (st.isDirectory()) { files++; size += 4096; }
            else { files++; size += st.size; }
            if (st.mtimeMs > last) last = st.mtimeMs;
            recent.push({ name: e.name, dir: e.isDirectory(), size: st.size, mtime: st.mtimeMs });
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      recent.sort((a, b) => b.mtime - a.mtime);
      out.push({
        path: root,
        name: path.basename(root) || root,
        files,
        size,
        lastModified: last,
        recent: recent.slice(0, 8)
      });
    }
    return out;
  }

  // 目录浏览(一级),路径必须在工作区内
  explore(dir, limit = 300) {
    const abs = path.resolve(dir);
    if (!this._inside(abs)) throw new Error('路径不在工作区范围内');
    const entries = [];
    let count = 0, total = 0;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      try {
        const st = fs.statSync(p);
        count++;
        total += st.isDirectory() ? 4096 : st.size;
        entries.push({ name: e.name, dir: e.isDirectory(), size: st.isDirectory() ? null : st.size, mtime: st.mtimeMs });
      } catch { /* ignore */ }
    }
    entries.sort((a, b) => (b.dir - a.dir) || (b.mtime - a.mtime));
    return {
      path: abs,
      name: path.basename(abs) || abs,
      parent: abs === this.roots()[0] ? null : path.dirname(abs),
      count,
      total,
      entries: entries.slice(0, limit)
    };
  }

  // 文本预览(≤1MB,≤3000字符,二进制拒绝)
  preview(file, maxChars = 3000) {
    const abs = path.resolve(file);
    if (!this._inside(abs)) throw new Error('路径不在工作区范围内');
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new Error('这是目录,请浏览其内容');
    if (st.size > 1024 * 1024) throw new Error('文件超过 1MB,跳过预览');
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) throw new Error('二进制文件,不支持预览');
    const text = buf.toString('utf8');
    return {
      path: abs,
      size: st.size,
      mtime: st.mtimeMs,
      preview: text.slice(0, maxChars),
      truncated: text.length > maxChars
    };
  }
}
