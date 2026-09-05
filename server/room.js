// AgentHub 多 Agent 群聊:房间/消息持久化 + 群聊 prompt 组装 + @ 转派 + 卡住自动求助
// 区别于旧任务控制台(单 Agent 一次性派发),这里以「房间」为会话单元:
//   - 多条 Agent 与用户在同一时间线对话,可 @ 其他 Agent 请求帮助;
//   - 每次派发都会把最近群聊原文(上一条/上几句)注入 prompt,Agent 无需翻整份 MEMORY.md;
//   - Agent 回复中出现 @agentId 时平台自动转派给对应 Agent,形成接力。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ROOMS_FILE } from './config.js';

const MAX_ROOMS = 40;        // 最多保留房间数
const MAX_MESSAGES = 500;    // 每房间消息条数上限
const ROOM_ID_LEN = 8;

function now() { return Date.now(); }
function uid(prefix = '') { return prefix + crypto.randomUUID().slice(0, 8); }

function clamp(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// 从文本中解析 @agentId(codex|claude|dsh),返回去重后的 id 数组
export function detectMentions(text, agentIds = ['codex', 'claude', 'dsh']) {
  if (!text) return [];
  const re = new RegExp(`@(${agentIds.join('|')})\\b`, 'g');
  const found = [];
  let m;
  while ((m = re.exec(String(text)))) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

// 取 @mention 之后、到下一个 @ 或换行/句点前的请求片段
export function extractMentionText(text, mention) {
  const t = String(text || '');
  const re = new RegExp(`@${mention}\\b[\\s:：]*([^@\\n]*)`, 'i');
  const m = t.match(re);
  if (!m) return '';
  return (m[1] || '').trim().split(/[\n。;；]/)[0].trim().slice(0, 600);
}

// 把最近消息压成紧凑群聊原文(供 prompt 注入)
export function renderTranscript(messages, { limit = 12, maxChars = 12000 } = {}) {
  const arr = (messages || []).slice(-limit);
  const out = [];
  let used = 0;
  for (const m of arr) {
    const live = m.role === 'agent' && (m.status === 'running' || m.status === 'queued');
    let who, text;
    if (m.role === 'system') {
      who = '系统';
      text = `[系统] ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 300)}`;
    } else if (m.role === 'user') {
      who = '用户(我)';
      text = String(m.text || '');
    } else {
      who = `@${m.authorId || ''}(${m.authorName || m.authorId || ''})`;
      text = String(m.text || '');
    }
    const target = m.target && m.target !== 'auto' && m.target !== 'all' ? ` → ${m.target}` : '';
    const suffix = live ? '(…进行中)' : '';
    const line = `- [${who}${target}${suffix}] ${text.replace(/\s+/g, ' ').slice(0, 600)}`;
    out.push(line);
    used += line.length;
    if (used >= maxChars) break;
  }
  return out.join('\n');
}

// 组装后裁剪:优先保留「本次请求」及其后的内容(尾部),只从头部裁掉更早的上下文/记忆,
// 避免原先“一刀切截尾”把当前任务截断、导致 Agent 只能去翻整份 MEMORY.md 的问题。
export function fitPrompt(full, budget) {
  if (full.length <= budget) return full;
  const idx = full.lastIndexOf('【本次请求】');
  const body = idx >= 0 ? full.slice(idx) : '';
  const head = idx >= 0 ? full.slice(0, idx) : full;
  const HDR = '【本次请求】\n';
  let safeBody = body;
  let safeHead = head;
  if (safeBody.length >= budget) {
    // 极长请求:保留「本次请求」标题 + 请求内容尾部,丢弃更早上下文(宁可丢上下文也不丢当前任务)
    const rest = safeBody.startsWith(HDR) ? safeBody.slice(HDR.length) : safeBody;
    safeBody = (safeBody.startsWith(HDR) ? HDR : '') + rest.slice(-(budget - HDR.length));
    safeHead = '';
  } else {
    const space = budget - safeBody.length;
    safeHead = safeHead.slice(-space);
    if (space < head.length) safeHead = '…(更早的群聊已省略)\n' + safeHead;
  }
  return safeHead + safeBody;
}

export class RoomHub {
  constructor({ agents }) {
    this.agents = agents;      // Agents 注册表,用于解析名称/图标/可用性
    this.rooms = new Map();
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(ROOMS_FILE)) {
        const arr = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
        if (Array.isArray(arr)) {
          for (const r of arr) {
            if (r && r.id) {
              // 落盘文件里不应包含 Node 计时器等运行时对象,统一重置 timers
              this.rooms.set(r.id, { ...r, messages: (r.messages || []).slice(-MAX_MESSAGES), timers: {} });
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  _persist() {
    // 只落盘最近 MAX_ROOMS 个房间、每房最近 MAX_MESSAGES 条消息
    const arr = [...this.rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ROOMS)
      .map(r => {
        const { timers, groupId, ...rest } = r; // 剥离运行时计时器/当前批次组号,不落盘
        return { ...rest, messages: (r.messages || []).slice(-MAX_MESSAGES) };
      });
    try { fs.writeFileSync(ROOMS_FILE, JSON.stringify(arr, null, 2)); } catch { /* ignore */ }
  }

  // —— Agent 信息解析 ——
  _agentInfo(id) {
    const a = this.agents ? this.agents.get(id) : null;
    return {
      id,
      name: a ? a.name : (id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude' : 'dsh'),
      icon: a ? (a.icon || '◈') : '◈',
      enabled: a ? a.enabled() : false,
      available: a ? !!a.available : false
    };
  }

  participantIds(room) {
    return (room.agents || []).filter(id => id !== 'user');
  }

  // —— 房间 CRUD ——
  listRooms() {
    return [...this.rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30).map(r => {
      const msgs = r.messages || [];
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      return {
        id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt,
        messages: msgs.length, agents: r.agents,
        last: last ? { role: last.role, authorId: last.authorId, authorName: last.authorName, text: last.text, status: last.status, createdAt: last.createdAt } : null,
        running: msgs.some(m => m.role === 'agent' && (m.status === 'running' || m.status === 'queued'))
      };
    });
  }

  getRoom(id) { return this.rooms.get(id) || null; }

  // 供 HTTP 返回的净化视图:剥离 timers/当前批次组号等运行时对象,避免把 Node Timeout 序列化后循环引用
  publicRoom(id) {
    const room = this.rooms.get(id);
    if (!room) return null;
    const { timers, groupId, ...rest } = room;
    return { ...rest, timers: {}, groupId: null };
  }

  createRoom({ title, agents } = {}) {
    const room = {
      id: uid('r'),
      title: String(title || '').trim() || '默认群聊',
      agents: Array.isArray(agents) && agents.length ? agents.filter(Boolean) : ['codex', 'claude', 'dsh'],
      createdAt: now(), updatedAt: now(),
      messages: [],
      turns: 0,          // 当前用户消息派发的 Agent 轮次
      groupId: null,     // 当前群发一批任务的 group
      timers: {}         // taskId -> stuck timer
    };
    this.rooms.set(room.id, room);
    this._persist();
    return room;
  }

  addMessage(roomId, msg) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const full = {
      id: uid('m'), role: msg.role || 'user', createdAt: msg.createdAt || now(), updatedAt: msg.createdAt || now(),
      authorId: msg.authorId, authorName: msg.authorName, icon: msg.icon,
      target: msg.target, text: String(msg.text || ''), model: msg.model, effort: msg.effort,
      taskId: msg.taskId, status: msg.status || null, mentions: msg.mentions || [],
      groupId: msg.groupId || null
    };
    room.messages.push(full);
    // 去掉转派占位(role=agent 且无 taskId 的未开始消息保留),并裁剪
    if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
    room.updatedAt = now();
    this._persist();
    return full;
  }

  getMessage(roomId, messageId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return room.messages.find(m => m.id === messageId) || null;
  }

  updateMessage(roomId, messageId, patch) {
    const room = this.rooms.get(roomId);
    const msg = room && room.messages.find(m => m.id === messageId);
    if (!msg) return null;
    Object.assign(msg, patch, { updatedAt: now() });
    room.updatedAt = now();
    this._persist();
    return msg;
  }

  getMessages(roomId, { limit = 100 } = {}) {
    const room = this.rooms.get(roomId);
    return room ? (room.messages || []).slice(-clamp(limit, 1, MAX_MESSAGES, 100)) : [];
  }

  // 最近对话原文(供注入)
  transcript(roomId, { limit, maxChars } = {}) {
    const room = this.rooms.get(roomId);
    if (!room) return '';
    const cfg = (this.roomCfg || {}).transcriptLimit || 12;
    return renderTranscript(room.messages, { limit: limit || cfg, maxChars: maxChars || 12000 });
  }

  // 参与且可用的 Agent(用于广播/转派目标)
  availableParticipants(room, excludeId) {
    return (room.agents || []).filter(id => id !== 'user' && id !== excludeId).map(id => this._agentInfo(id)).filter(a => a.enabled && a.available);
  }

  // 删除房间
  deleteRoom(id) {
    const ok = this.rooms.delete(id);
    if (ok) this._persist();
    return ok;
  }
}

// —— 群聊编排:派发轮次、prompt 组装、@ 转派、卡住自动求助 ——
export class RoomChat {
  constructor({ roomHub, runner, memory, config, logstore }) {
    this.roomHub = roomHub;
    this.runner = runner;
    this.memory = memory || null;
    this.config = config;
    this.logstore = logstore;
    // 记录 taskId -> { roomId, messageId, groupId, mentionDepth, authorId }
    this.turnMap = new Map();
  }

  _rcfg() { return (this.config.room) || {}; }

  // 组装给某个 Agent 的 prompt:最近群聊原文(权威衔接) + 协作规则 + 按需记忆摘要 + 本次请求
  // 关键改进:本次请求永远放在尾部并保底不被截断;记忆只做少量召回,不整份倒入,让 Agent 自然衔接上一条对话。
  composeRoomPrompt(room, { agentId, text, useMemory = true }) {
    const cfg = this._rcfg();
    const agentName = agentId === 'codex' ? 'Codex' : agentId === 'claude' ? 'Claude' : 'dsh';
    const made = this.roomHub.transcript(room.id, { limit: cfg.transcriptLimit || 12, maxChars: cfg.maxChars || 12000 });
    const ctx = made ? `【群聊上下文·最新在最后】\n${made}\n` : '【群聊上下文】(暂无,这是本群第一条对话)\n';
    const others = (room.agents || []).filter(id => id !== 'user' && id !== agentId);
    const invite = others.length ? `可呼叫的同伴:${others.map(id => '@' + id).join(', ')}` : '这是单人群聊,没有可呼叫的同伴';
    const rule = `【群聊协作规则】
你是群聊成员 ${agentName}(${agentId})。这是一场多 Agent 协作群聊,请以【群聊上下文】为准直接对接上一条消息,不要翻整份 ~/MEMORY.md;确需长期记忆时才引用。
- 任务太重、卡住或缺少某方面能力时,直接在回复中用 @agentId 呼叫同伴,例如"@${others[0] || 'codex'} 请帮我处理余下部分"(边说边 @ 也行,平台会并行转派)。
- 被 @ 时只负责 @ 你的那部分请求,完成后简要说明;除非确实需要,否则不要再次呼叫别人,避免无限接力。
- ${invite}。
`;
    let mid = '';
    if (useMemory && this.memory) {
      // 只注入「置顶/简短共享上下文 + 少量相关记忆」:以对话上下文为主,避免把整份记忆倒给 Agent
      const brief = this.memory.contextBrief({ agent: agentId, maxChars: Math.min(cfg.memoryBriefChars || 700, 700) });
      const lastUser = [...(room.messages || [])].reverse().find(m => m.role === 'user');
      const q = lastUser ? (lastUser.text || '') : text;
      const rec = this.memory.recall(q, { agent: agentId, limit: Math.min(cfg.memoryRecall || 3, 5) });
      const parts = [];
      if (brief) parts.push(brief);
      if (rec.length) parts.push(rec.map(m => `- ${m.content}`).join('\n'));
      if (parts.length) mid = `【团队共享上下文/相关记忆】\n${parts.join('\n')}\n`;
    }
    const body = `【本次请求】\n${String(text || '').trim()}`;
    return fitPrompt(`${ctx}\n${rule}\n${mid}\n${body}`, cfg.maxChars || 12000);
  }

  // 提交一条用户消息到房间,返回 { room, userMessage, turns }
  submit(roomId, { prompt, target, model, effort, useMemory = true } = {}) {
    const room = this.roomHub.getRoom(roomId);
    if (!room) throw new Error('房间不存在');
    const text = String(prompt || '').trim();
    if (!text) throw new Error('消息内容不能为空');

    const mentions = detectMentions(text, room.agents);
    const cfg = this._rcfg();

    // 解析本轮要派发的 Agent
    let targets = [];
    if (target && target !== 'auto' && target !== 'all') targets = [target];
    else if (target === 'all' || (cfg.broadcast !== false && target === 'all')) targets = room.agents.filter(id => id !== 'user');
    else if (mentions.length) targets = mentions;
    else if (target === 'all' && cfg.broadcast === false) targets = room.agents.filter(id => id !== 'user');
    // 兜底:默认首个可用的参与 Agent
    if (!targets.length) {
      const first = this.roomHub.availableParticipants(room)[0];
      targets = first ? [first.id] : [...room.agents.filter(id => id !== 'user')].slice(0, 1);
    }

    // 过滤不可用/未启用的 Agent;target 显式指定时仍校验并提示
    const usable = targets.map(id => this.roomHub._agentInfo(id)).filter(a => a.enabled && a.available);
    const dead = targets.filter(id => !usable.some(a => a.id === id));
    if (!usable.length) throw new Error(dead.length ? `Agent ${dead.map(id => '@' + id).join(',')} 不可用或已停用` : '没有可用 Agent 处理这条消息');

    const groupId = uid('g');
    room.groupId = groupId;
    room.turns = 0;

    const userMsg = this.roomHub.addMessage(roomId, {
      role: 'user', text, target: target || (mentions.length ? 'auto' : (usable[0] && usable[0].id)),
      model, effort, mentions, groupId
    });

    const turns = [];
    for (const a of usable) {
      const t = this._dispatchTurn(room, {
        targetAgentId: a.id, fromText: text, model, effort, groupId,
        mentionDepth: 0, fresh: true, useMemory
      });
      if (t) turns.push(t);
    }
    return { room: this.roomHub.publicRoom(roomId), userMessage: userMsg, turns };
  }

  // 派发一个 Agent 轮次;返回 { message, task, groupId }
  _dispatchTurn(room, { targetAgentId, fromText, model, effort, groupId = room.groupId, mentionDepth = 0, fresh = false, useMemory = true }) {
    const cfg = this._rcfg();
    if (!fresh && room.turns >= (cfg.turnBudget || 8)) return null;
    const info = this.roomHub._agentInfo(targetAgentId);
    if (!info.enabled || !info.available) return null;

    const promptText = fromText;
    const prompt = this.composeRoomPrompt(room, { agentId: targetAgentId, text: promptText, useMemory });

    const msg = this.roomHub.addMessage(room.id, {
      role: 'agent', authorId: targetAgentId, authorName: info.name, icon: info.icon,
      target: null, text: '', model, effort, status: 'queued', groupId
    });

    let task;
    try {
      task = this.runner.submit({
        agentId: targetAgentId, model, effort,
        prompt,
        useMemory: false,   // 群聊上下文已由 composeRoomPrompt 组装,禁用 memory 二次注入
        room: { roomId: room.id, messageId: msg.id, groupId }
      });
    } catch (e) {
      this.roomHub.updateMessage(room.id, msg.id, { text: `派发失败: ${e.message}`, status: 'failed' });
      return null;
    }

    room.turns += 1;
    this.roomHub.updateMessage(room.id, msg.id, { taskId: task.id });
    const msgWithTask = this.roomHub.getMessage(room.id, msg.id);
    const rec = { roomId: room.id, messageId: msg.id, groupId, mentionDepth, authorId: targetAgentId, lastChunkAt: now(), useMemory, dispatchSet: new Set() };
    this.turnMap.set(task.id, rec);

    // 监听任务事件:维护房间消息的实时文本/状态 + @ 转派 + 卡住求助
    const off = this.runner.onEvent(task.id, (ev) => {
      if (ev.type === 'started') {
        rec.lastChunkAt = now();
        this.roomHub.updateMessage(room.id, msg.id, { status: 'running' });
      } else if (ev.type === 'chunk') {
        rec.lastChunkAt = now();
        const cur = this.roomHub.getMessage(room.id, msg.id);
        if (cur) {
          const text = (cur.text + ev.text).slice(-200000);
          this.roomHub.updateMessage(room.id, msg.id, { text });
          // 运行中检测 @ 求助:Agent 边说边 @ 同伴 → 立即并行转派,形成真正的群聊接力
          this._dispatchLiveMentions(room, task, rec, text);
        }
      } else if (ev.type === 'done' || ev.type === 'failed' || ev.type === 'cancelled') {
        this._clearStuck(room, task.id);
        this._finalizeTurn(room, msg.id, task, ev.type, off);
      }
    });

    // 卡住自动求助:stuckMinutes 内无任何输出 → 自动 @ 其他 Agent
    const stuckMs = ((cfg.stuckMinutes || 0) || 0) * 60000;
    if (stuckMs > 0 && cfg.autoEscalate !== false && mentionDepth < (cfg.mentionDepth || 2)) {
      let timer;
      timer = setTimeout(() => {
        if (this.turnMap.has(task.id) && (Date.now() - rec.lastChunkAt) >= stuckMs) {
          this._escalate(room, task.id, info, promptText, mentionDepth, groupId);
        }
        this._clearStuck(room, task.id);
      }, stuckMs);
      if (timer.unref) timer.unref();
      room.timers[task.id] = timer;
    }

    return { message: msgWithTask || msg, task, groupId };
  }

  _finalizeTurn(room, messageId, task, status, off) {
    const rec = this.turnMap.get(task.id);
    if (!rec) return;
    this.turnMap.delete(task.id);
    if (off) try { off(); } catch { /* ignore */ }

    const finalText = String(task.output || '').trim() || (task.error ? String(task.error).trim() : '');
    const msg = this.roomHub.updateMessage(room.id, messageId, { status, text: finalText });

    // 只有 done 才触发 @ 转派:失败/取消不再接力,避免死循环
    if (status === 'done' && msg) {
      rec.dispatchSet = rec.dispatchSet || new Set();
      const mentions = detectMentions(finalText, room.agents);
      if (mentions.length) {
        const curDepth = rec.mentionDepth || 0;
        const cfg = this._rcfg();
        if (curDepth < (cfg.mentionDepth || 2)) {
          let dispatched = 0;
          for (const mid of mentions) {
            if (mid === rec.authorId) continue;
            if (rec.dispatchSet.has(mid)) continue; // 运行中已转派过的不再重复
            if (room.turns >= (cfg.turnBudget || 8)) break;
            const seg = extractMentionText(finalText, mid) || `请继续处理群聊中 @${rec.authorId} 提到的问题。`;
            const ctx = `@${mid} 群聊成员 @${rec.authorId} 呼叫你:${seg}`;
            // 记录一条"呼叫"消息(发起方为请求的 Agent,便于时间线可读)
            this.roomHub.addMessage(room.id, {
              role: 'system', text: `⟳ 检测到 @${rec.authorId} 呼叫 @${mid}`, authorId: 'system' });
            const t = this._dispatchTurn(room, {
              targetAgentId: mid, fromText: ctx, model: task.model, effort: task.effort,
              groupId: rec.groupId, mentionDepth: curDepth + 1, useMemory: rec.useMemory
            });
            if (t) { rec.dispatchSet.add(mid); dispatched += 1; }
          }
          if (dispatched) this.logstore.push('system', 'info', `[rooms] ${room.id} @${rec.authorId} 呼叫同伴转派 ${dispatched} 个轮次`);
        }
      }
    } else {
      // 失败/取消后:更新房间的待处理状态,让用户可见
      if (msg && msg.status === 'failed') this.roomHub.addMessage(room.id, { role: 'system', text: `⚠ @${rec.authorId} 本轮${msg.text ? ':' + msg.text : '失败'}`, authorId: 'system' });
    }
  }

  _escalate(room, taskId, info, promptText, mentionDepth, groupId) {
    const rec = this.turnMap.get(taskId);
    if (!rec) return;
    const helper = this.roomHub.availableParticipants(room, rec.authorId)[0];
    if (!helper) return;
    rec.dispatchSet = rec.dispatchSet || new Set();
    if (rec.dispatchSet.has(helper.id)) return;
    // 若该同伴在本组已有正在运行/排队的轮次,不重复转派,避免接力死循环
    if (this._isBusyInGroup(room, helper.id, groupId)) return;
    // 记录卡住系统消息
    this.roomHub.addMessage(room.id, {
      role: 'system', text: `⟳ @${rec.authorId} 已 ${((this._rcfg().stuckMinutes || 0))} 分钟无输出,自动请求 @${helper.id} 协助`,
      authorId: 'system'
    });
    const ctx = `@${helper.id} 群聊成员 @${rec.authorId} 卡住,请你接手: ${promptText}`;
    const t = this._dispatchTurn(room, { targetAgentId: helper.id, fromText: ctx, groupId, mentionDepth: mentionDepth + 1, useMemory: rec.useMemory });
    if (t) rec.dispatchSet.add(helper.id);
    this.logstore.push('system', 'warn', `[rooms] ${room.id} @${rec.authorId} 卡住自动求助 @${helper.id}`);
  }

  // 运行中检测 @ 求助:Agent 一边输出一边 @ 同伴,立即并行转派,形成实时群聊接力
  _dispatchLiveMentions(room, task, rec, text) {
    if (!rec || task.status !== 'running') return;
    rec.dispatchSet = rec.dispatchSet || new Set();
    const mentions = detectMentions(text, room.agents);
    if (!mentions.length) return;
    const cfg = this._rcfg();
    const curDepth = rec.mentionDepth || 0;
    if (curDepth >= (cfg.mentionDepth || 2)) return;
    for (const mid of mentions) {
      if (mid === rec.authorId) continue;
      if (rec.dispatchSet.has(mid)) continue;
      if (room.turns >= (cfg.turnBudget || 8)) break;
      if (this._isBusyInGroup(room, mid, rec.groupId)) continue;
      const seg = extractMentionText(text, mid) || `请接手 @${rec.authorId} 提到的后续问题`;
      const ctx = `@${mid} 群聊成员 @${rec.authorId} 正在处理并 @你:${seg}`;
      this.roomHub.addMessage(room.id, { role: 'system', text: `⟳ @${rec.authorId} 运行中 @${mid} 求助`, authorId: 'system' });
      const t = this._dispatchTurn(room, {
        targetAgentId: mid, fromText: ctx, model: task.model, effort: task.effort,
        groupId: rec.groupId, mentionDepth: curDepth + 1, useMemory: rec.useMemory
      });
      if (t) rec.dispatchSet.add(mid);
    }
  }

  _isBusyInGroup(room, agentId, groupId) {
    return (room.messages || []).some(m => m.authorId === agentId && m.groupId === groupId && (m.status === 'running' || m.status === 'queued'));
  }

  _clearStuck(room, taskId) {
    const t = room.timers && room.timers[taskId];
    if (t) { clearTimeout(t); delete room.timers[taskId]; }
  }
}

export function initRooms({ agents, runner, memory, config, logstore }) {
  const roomHub = new RoomHub({ agents });
  const roomChat = new RoomChat({ roomHub, runner, memory, config, logstore });
  return { roomHub, roomChat };
}
