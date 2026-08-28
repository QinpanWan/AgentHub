// AgentHub 共享记忆与共享上下文系统
// 两类共享资源:
//   contexts —— 团队共享上下文(黑板),提交任务时自动注入 prompt 前奏
//   memories —— 长期共享记忆(要点/决策/结论/片段),可按标签与关键词召回
import fs from 'node:fs';
import crypto from 'node:crypto';
import { MEMORY_FILE, MEMORY_MD_FILE } from './config.js';

const MAX_CONTENT = 8000;   // 单条内容上限(字符)
const MAX_TAGS = 12;        // 单条标签数量上限
const MAX_RECALL = 20;      // 召回条数上限

function normTags(tags) {
  if (tags == null) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[,，、\s]+/);
  return [...new Set(arr.map(s => String(s).trim().replace(/^#/, '')).filter(Boolean))].slice(0, MAX_TAGS);
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export class MemoryHub {
  constructor({ config }) {
    this.config = config;
    this.contexts = [];  // 共享上下文块
    this.memories = [];  // 长期共享记忆
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        this.contexts = Array.isArray(data.contexts) ? data.contexts : [];
        this.memories = Array.isArray(data.memories) ? data.memories : [];
      }
    } catch { /* ignore */ }
  }

  _persist() {
    try {
      fs.writeFileSync(MEMORY_FILE, JSON.stringify({ contexts: this.contexts, memories: this.memories }, null, 2));
    } catch { /* ignore */ }
  }

  stats() {
    return {
      contexts: this.contexts.length,
      pinnedContexts: this.contexts.filter(c => c.pinned).length,
      memories: this.memories.length,
      pinnedMemories: this.memories.filter(m => m.pinned).length,
      tags: [...new Set([...this.contexts, ...this.memories].flatMap(x => x.tags || []))].length
    };
  }

  // ---------- 共享上下文 ----------
  listContexts() {
    return [...this.contexts].sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  }

  getContext(id) { return this.contexts.find(c => c.id === id) || null; }

  addContext(input = {}) {
    const content = String(input.content || '').trim();
    if (!content) throw new Error('上下文内容不能为空');
    const now = Date.now();
    const block = {
      id: crypto.randomUUID().slice(0, 8),
      title: String(input.title || '').trim().slice(0, 80),
      content: content.slice(0, MAX_CONTENT),
      tags: normTags(input.tags),
      agent: String(input.agent || '').trim().slice(0, 20),
      pinned: !!input.pinned,
      createdAt: now,
      updatedAt: now
    };
    this.contexts.push(block);
    this._persist();
    return block;
  }

  updateContext(id, patch = {}) {
    const block = this.getContext(id);
    if (!block) return null;
    if (patch.title !== undefined) block.title = String(patch.title).trim().slice(0, 80);
    if (patch.content !== undefined) {
      const c = String(patch.content).trim();
      if (!c) throw new Error('上下文内容不能为空');
      block.content = c.slice(0, MAX_CONTENT);
    }
    if (patch.tags !== undefined) block.tags = normTags(patch.tags);
    if (patch.agent !== undefined) block.agent = String(patch.agent).trim().slice(0, 20);
    if (patch.pinned !== undefined) block.pinned = !!patch.pinned;
    block.updatedAt = Date.now();
    this._persist();
    return block;
  }

  deleteContext(id) {
    const i = this.contexts.findIndex(c => c.id === id);
    if (i < 0) return false;
    this.contexts.splice(i, 1);
    this._persist();
    return true;
  }

  toggleContextPin(id) {
    const block = this.getContext(id);
    if (!block) return null;
    block.pinned = !block.pinned;
    block.updatedAt = Date.now();
    this._persist();
    return block;
  }

  // 汇总共享上下文为一段提示词前奏文本
  contextBrief({ agent, maxChars = 3000 } = {}) {
    const out = [];
    let used = 0;
    for (const c of this.listContexts()) {
      if (agent && c.agent && c.agent !== agent) continue; // 指定 Agent 的块只注入给该 Agent
      const tagText = c.tags.length ? ` [${c.tags.map(t => `#${t}`).join(' ')}]` : '';
      const meta = (c.agent ? `(来自 ${c.agent})` : '') + (c.pinned ? ' ⭐置顶' : '');
      const line = `- ${c.title ? `**${c.title}**：` : ''}${c.content}${tagText}${meta ? ` ${meta}` : ''}`;
      out.push(line);
      used += line.length + 1;
      if (used >= maxChars) break; // 至少包含当前行,超限即停止追加
    }
    return out.join('\n');
  }

  // ---------- 共享记忆 ----------
  listMemory({ agent, tag, q, limit = 100 } = {}) {
    let out = this.memories.slice().sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
    if (agent) out = out.filter(m => m.agent === agent);
    if (tag) out = out.filter(m => (m.tags || []).includes(tag));
    if (q) out = this._filterByQuery(out, q);
    return out.slice(0, clampInt(limit, 1, 200, 100));
  }

  getMemory(id) { return this.memories.find(m => m.id === id) || null; }

  addMemory(input = {}) {
    const content = String(input.content || '').trim();
    if (!content) throw new Error('记忆内容不能为空');
    const now = Date.now();
    const mem = {
      id: crypto.randomUUID().slice(0, 8),
      content: content.slice(0, MAX_CONTENT),
      tags: normTags(input.tags),
      agent: String(input.agent || '').trim().slice(0, 20),
      source: String(input.source || '').trim().slice(0, 60),
      importance: clampInt(input.importance, 1, 5, 3),
      pinned: !!input.pinned,
      hits: 0,
      createdAt: now,
      updatedAt: now
    };
    this.memories.push(mem);
    this._persist();
    return mem;
  }

  updateMemory(id, patch = {}) {
    const mem = this.getMemory(id);
    if (!mem) return null;
    if (patch.content !== undefined) {
      const c = String(patch.content).trim();
      if (!c) throw new Error('记忆内容不能为空');
      mem.content = c.slice(0, MAX_CONTENT);
    }
    if (patch.tags !== undefined) mem.tags = normTags(patch.tags);
    if (patch.agent !== undefined) mem.agent = String(patch.agent).trim().slice(0, 20);
    if (patch.source !== undefined) mem.source = String(patch.source).trim().slice(0, 60);
    if (patch.importance !== undefined) mem.importance = clampInt(patch.importance, 1, 5, 3);
    if (patch.pinned !== undefined) mem.pinned = !!patch.pinned;
    mem.updatedAt = Date.now();
    this._persist();
    return mem;
  }

  deleteMemory(id) {
    const i = this.memories.findIndex(m => m.id === id);
    if (i < 0) return false;
    this.memories.splice(i, 1);
    this._persist();
    return true;
  }

  toggleMemoryPin(id) {
    const mem = this.getMemory(id);
    if (!mem) return null;
    mem.pinned = !mem.pinned;
    mem.updatedAt = Date.now();
    this._persist();
    return mem;
  }

  _filterByQuery(list, q) {
    const needle = String(q).toLowerCase().trim();
    if (!needle) return list;
    return list.filter(m =>
      m.content.toLowerCase().includes(needle) ||
      (m.tags || []).some(t => t.toLowerCase().includes(needle)) ||
      (m.source || '').toLowerCase().includes(needle) ||
      (m.agent || '').toLowerCase().includes(needle)
    );
  }

  // 关键词召回:按命中度 + 标签 + 重要度/置顶加权,返回最相关记忆
  recall(query, { agent, limit = 6 } = {}) {
    const q = String(query || '').toLowerCase().trim();
    const words = q.split(/[^\p{L}\p{N}_-]+/u).filter(w => w.length >= 2);
    let pool = this.memories.slice();
    if (agent) {
      const only = pool.filter(m => !m.agent || m.agent === agent);
      if (only.length) pool = only;
    }
    const scored = [];
    for (const m of pool) {
      const text = `${m.content}\n${(m.tags || []).join(' ')} ${m.agent} ${m.source}`.toLowerCase();
      let score = 0;
      if (q && text.includes(q)) score += 10;
      for (const w of words) if (text.includes(w)) score += 3;
      score += (m.tags || []).filter(t => words.includes(t.toLowerCase())).length * 4;
      score += (m.importance || 3) / 5;
      if (m.pinned) score += 1.5;
      scored.push({ m, score });
    }
    const out = scored
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, clampInt(limit, 1, MAX_RECALL, 6))
      .map(x => x.m);
    for (const m of out) { m.hits = (m.hits || 0) + 1; }
    if (out.length) this._persist();
    return out;
  }

  // 组合:共享上下文 + 相关记忆 前奏,再拼接任务正文
  composePrompt(base, { agent } = {}) {
    const cfg = this.config.memory || {};
    const brief = this.contextBrief({ agent, maxChars: cfg.maxContextChars || 3000 });
    const recalled = this.recall(base, { agent, limit: Math.min(cfg.recallLimit || 6, 20) });
    const parts = [];
    if (brief) parts.push(`【团队共享上下文】\n${brief}`);
    if (recalled.length) parts.push(`【相关历史记忆】\n${recalled.map(m => `- ${m.content}`).join('\n')}`);
    if (!parts.length) return String(base);
    let prelude = parts.join('\n\n');
    const maxInj = cfg.maxInjectedChars || 6000;
    if (prelude.length > maxInj) prelude = prelude.slice(0, maxInj) + '\n…(共享内容较长,已截断)';
    return `${prelude}\n\n请参考上面的共享上下文与历史记忆,再完成下面的任务。\n\n【任务】\n${String(base)}`;
  }

  // ---------- ~/MEMORY.md(Agent 实际共享记忆文件) ----------
  // Codex/Claude/dsh 在对话中读写 ~/MEMORY.md(经各自 AGENTS.md/CLAUDE.md 约定),
  // 这里将其解析为结构化段落,供「共享记忆」页实时展示。
  memMd() {
    try {
      if (!fs.existsSync(MEMORY_MD_FILE)) {
        return { exists: false, path: MEMORY_MD_FILE, updatedAt: 0, sections: [] };
      }
      const txt = fs.readFileSync(MEMORY_MD_FILE, 'utf8');
      const st = fs.statSync(MEMORY_MD_FILE);
      const sections = [];
      let title = '';
      let buf = [];
      const flush = () => {
        const content = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        if (title || content) sections.push({ title: title || '(前言)', content });
        title = '';
        buf = [];
      };
      for (const line of txt.split('\n')) {
        const m = line.match(/^##\s+(.+)$/);
        if (m) { flush(); title = m[1].trim(); }
        else buf.push(line);
      }
      flush();
      return { exists: true, path: MEMORY_MD_FILE, updatedAt: st.mtimeMs, sections };
    } catch (e) {
      return { exists: false, path: MEMORY_MD_FILE, updatedAt: 0, sections: [], error: String(e.message || e) };
    }
  }

  // 任务完成后自动在 ~/MEMORY.md 追加一条简洁记录(滚动保留最近 N 条),
  // 让「共享记忆」面板在多轮对话后能看到沉淀内容;可在配置 memory.recordTasks=false 关闭。
  recordTask({ agentId, prompt, status, createdAt, finishedAt, error } = {}) {
    try {
      const cfg = (this.config && this.config.memory) || {};
      if (cfg.recordTasks === false) return;
      const p = String(prompt || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!p) return;
      const when = new Date(finishedAt || Date.now());
      const dur = (finishedAt && createdAt) ? Math.max(0, Math.round((finishedAt - createdAt) / 1000)) : 0;
      const icon = status === 'done' ? '✅' : (status === 'failed' ? '❌' : '◾');
      const err = (status === 'failed' && error) ? ` | ${String(error).slice(0, 60)}` : '';
      const line = `- ${when.toISOString().slice(0, 16).replace('T', ' ')} · ${agentId} · ${icon}${status} · ${dur}s${err} | ${p}`;
      let txt = '';
      if (fs.existsSync(MEMORY_MD_FILE)) txt = fs.readFileSync(MEMORY_MD_FILE, 'utf8');
      const HEAD = '## AgentHub 任务记录';
      const lines = txt.split('\n');
      const kept = [];
      let oldRecords = [];
      let inSection = false;
      for (const l of lines) {
        if (/^##\s+/.test(l)) {
          if (l.trim() === HEAD) { inSection = true; continue; }
          if (inSection) { inSection = false; kept.push(l); continue; }
        }
        if (inSection) {
          const t = l.trim();
          if (t.startsWith('-')) oldRecords.push(t);
          continue;
        }
        kept.push(l);
      }
      oldRecords = oldRecords.slice(0, 19);
      const block = [HEAD, '', line, ...oldRecords, ''];
      let out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      out = out ? out + '\n\n' + block.join('\n') : block.join('\n');
      fs.writeFileSync(MEMORY_MD_FILE, out + '\n');
    } catch { /* 记录失败不影响任务流程 */ }
  }
}
