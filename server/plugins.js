// AgentHub 插件与技能管理:dsh 插件(plugins-src + profile 依赖)与 Skills 扫描
import fs from 'node:fs';
import path from 'node:path';
import { PLUGINS_SRC_DIR, PROFILE_PKG, PROFILE_DIR, PRESETS_DIR, BACKUP_DIR, DSH_DIR } from './config.js';

export class Plugins {
  constructor({ config, logstore }) {
    this.config = config;
    this.logstore = logstore;
  }

  // —— dsh 插件 ——
  listDshPlugins() {
    const out = [];
    if (!fs.existsSync(PLUGINS_SRC_DIR)) return out;
    let profile = {};
    try {
      profile = JSON.parse(fs.readFileSync(PROFILE_PKG, 'utf8'));
    } catch { /* 解析失败按空处理 */ }
    const deps = profile.dependencies || {};
    // bundles 实际嵌套在 dsh.profile.bundles(不是顶层 dsh.profile.bundles)
    const bundles = (profile.dsh && profile.dsh.profile && profile.dsh.profile.bundles) || [];
    // cordis.patch.yml 里 insert 挂载的插件也算启用
    const patched = this._patchedNames();

    const scanDir = (dir, scope) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const abs = path.join(dir, e.name);
        if (e.name.startsWith('@')) { scanDir(abs, e.name); continue; } // scope 二级目录
        const fullName = scope ? `${scope}/${e.name}` : e.name;
        let name = fullName, desc = '', version = '';
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8'));
          name = pkg.name || fullName;
          desc = (pkg.description || '').slice(0, 160);
          version = pkg.version || '';
        } catch { /* 无 package.json */ }
        const linked = Object.prototype.hasOwnProperty.call(deps, name);
        const bundled = bundles.includes(name);
        const viaPatch = patched.has(name);
        out.push({
          id: fullName,
          name,
          version,
          desc,
          dir: abs,
          type: 'dsh-plugin',
          enabled: (linked && bundled) || viaPatch,
          linkedOnly: linked && !bundled,
          bundledOnly: !linked && bundled,
          viaPatch,
          hasReadme: fs.existsSync(path.join(abs, 'README.md')),
          hasClient: fs.existsSync(path.join(abs, 'lib', 'client.js'))
        });
      }
    };
    scanDir(PLUGINS_SRC_DIR, null);
    return out;
  }

  // 从 cordis.patch.yml 提取 insert 挂载的插件包名(如 deveco-bridge/codex-bridge)
  _patchedNames() {
    const set = new Set();
    for (const f of ['cordis.patch.yml', 'cordis.yaml', 'cordis.yml']) {
      const p = path.join(PROFILE_DIR, f);
      if (!fs.existsSync(p)) continue;
      try {
        const txt = fs.readFileSync(p, 'utf8');
        const re = /name:\s*['"]?(@?[a-zA-Z0-9_@/-]+)['"]?/g;
        let m;
        while ((m = re.exec(txt)) !== null) {
          const n = m[1];
          if (n && n !== 'cordis-plugin-loader' && !n.startsWith('cordis')) set.add(n);
        }
      } catch { /* ignore */ }
    }
    return set;
  }

  // —— Skills:扫描候选目录 ——
  listSkills() {
    const out = [];
    const seen = new Set();
    const roots = [
      path.join(PROFILE_DIR, 'skills'),
      path.join(PROFILE_DIR, 'skills', 'global'),
      path.join(PROFILE_DIR),
      path.join(PRESETS_DIR),
      path.join(DSH_DIR, 'node_modules', '@deepseek-ai')
    ];
    const disabled = new Set((this.config.skills && this.config.skills.disabled) || []);
    for (const root of roots) {
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dir = path.join(root, e.name);
        if (!fs.existsSync(path.join(dir, 'SKILL.md')) && !fs.existsSync(path.join(dir, 'skill.md')) &&
            !fs.existsSync(path.join(dir, 'skill.json'))) continue;
        // 过滤:非技能名的目录(如 node_modules 里的无关包)
        if (!/skill/i.test(e.name) && !fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
        if (seen.has(dir)) continue;
        seen.add(dir);
        let desc = '';
        try {
          const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
          desc = md.split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 2).join(' ').slice(0, 160);
        } catch {
          try {
            const sj = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'));
            desc = (sj.description || '').slice(0, 160);
          } catch { /* ignore */ }
        }
        out.push({
          id: e.name,
          name: e.name,
          desc,
          dir,
          type: 'skill',
          enabled: !disabled.has(e.name),
          root: path.basename(root)
        });
      }
    }
    return out;
  }

  toggleSkill(id) {
    const list = this.listSkills();
    const skill = list.find(s => s.id === id);
    if (!skill) throw new Error(`未找到技能:${id}`);
    const disabled = new Set((this.config.skills && this.config.skills.disabled) || []);
    if (disabled.has(id)) disabled.delete(id); else disabled.add(id);
    if (!this.config.skills) this.config.skills = {};
    this.config.skills.disabled = [...disabled];
    return { id, enabled: !disabled.has(id) };
  }

  // —— dsh 插件启停:改 profile package.json(带备份,需 confirm;重启 dsh 生效) ——
  toggleDshPlugin(id, { confirm } = {}) {
    if (!confirm) throw new Error('修改 dsh 配置文件需显式确认(confirm:true),且会要求重启 dsh 生效');
    const plugin = this.listDshPlugins().find(p => p.id === id);
    if (!plugin) throw new Error(`未找到插件:${id}`);
    if (!fs.existsSync(PROFILE_PKG)) throw new Error(`profile 配置文件不存在:${PROFILE_PKG}`);

    let profile;
    try { profile = JSON.parse(fs.readFileSync(PROFILE_PKG, 'utf8')); }
    catch (e) { throw new Error(`profile package.json 解析失败,已中止(不写任何内容):${e.message}`); }

    const deps = profile.dependencies || {};
    const bundles = profile['dsh.profile.bundles'] || [];
    if (!Object.prototype.hasOwnProperty.call(deps, plugin.name)) {
      throw new Error(`插件 ${plugin.name} 不在 profile dependencies 中,平台只管理已注册的 link 插件`);
    }
    const depVal = deps[plugin.name];
    if (typeof depVal !== 'string' || !depVal.startsWith('link:')) {
      throw new Error(`插件 ${plugin.name} 的依赖类型为 ${depVal},非 link: 形式,平台不自动改动`);
    }

    const targetEnabled = !plugin.enabled;
    // 备份
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = path.join(BACKUP_DIR, `profile-package.${ts}.json`);
    fs.copyFileSync(PROFILE_PKG, bak);

    try {
      if (targetEnabled) {
        deps[plugin.name] = `link:./plugins-src/${plugin.id}`;
        if (!bundles.includes(plugin.name)) bundles.push(plugin.name);
      } else {
        delete deps[plugin.name];
        profile['dsh.profile.bundles'] = bundles.filter(b => b !== plugin.name);
      }
      profile.dependencies = deps;
      fs.writeFileSync(PROFILE_PKG, JSON.stringify(profile, null, 2));
    } catch (e) {
      // 失败还原
      try { fs.copyFileSync(bak, PROFILE_PKG); } catch { /* ignore */ }
      throw new Error(`写入失败,已还原备份:${e.message}`);
    }
    this.logstore.push('system', 'info', `[plugins] ${plugin.name} → ${targetEnabled ? '启用' : '禁用'}(备份 ${path.basename(bak)},重启 dsh 后生效)`);
    return { id: plugin.id, name: plugin.name, enabled: targetEnabled, backup: bak, restartRequired: true };
  }
}
