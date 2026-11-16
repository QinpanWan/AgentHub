// dsh-context 原版 bundle 的浏览器运行时桥。
// 仅提供 React / ReactDOM / UI primitives 与 DSH 模块加载器，
// 不修改、不重写 dsh-context 的页面组件和样式。
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives';

const modules = {
  'react': React,
  'react-dom': ReactDOM,
  'react/jsx-runtime': JSXRuntime,
  '@deepseek-ai/dsh-client-ui-primitives': Primitives,
};

const state = {
  exports: null,
  errors: [],
  definitions: [],
};

window.__DSH_CONTEXT_RUNTIME__ = {
  React,
  ReactDOM,
  createRoot,
  JSXRuntime,
  Primitives,
  state,
  requireModule(name) {
    if (!Object.prototype.hasOwnProperty.call(modules, name)) {
      throw new Error(`dsh-context runtime: unsupported module ${name}`);
    }
    return modules[name];
  },
};

window.__ModuleLoader__ = {
  load(definition) {
    state.definitions.push(definition && definition.id ? definition.id : 'unknown');
    if (!definition || typeof definition.factory !== 'function') {
      state.errors.push('dsh-context runtime: invalid module definition');
      return undefined;
    }
    try {
      const exported = definition.factory(window.__DSH_CONTEXT_RUNTIME__.requireModule);
      if (definition.id === 'dsh-context') state.exports = exported;
      return exported;
    } catch (err) {
      state.errors.push(String(err && (err.stack || err.message) || err));
      throw err;
    }
  },
};
