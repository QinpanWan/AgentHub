(function () {
  'use strict';

  var runtime = window.__DSH_CONTEXT_RUNTIME__;
  var errorEl = document.getElementById('boot-error');
  var mounted = false;

  function fail(message) {
    var text = String(message || 'dsh-context 面板加载失败');
    if (errorEl) {
      errorEl.style.display = 'block';
      errorEl.textContent = text;
    }
    try { window.parent.postMessage({ type: 'agenthub:context-error', message: text }, '*'); } catch (_) {}
    console.error('[dsh-context panel]', text);
  }

  if (!runtime) return fail('dsh-context 运行时未加载');
  var React = runtime.React;
  var createRoot = runtime.createRoot;
  var ReactDOM = runtime.ReactDOM;
  var state = runtime.state;

  function textOf(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(textOf).join('');
    if (value && typeof value === 'object') {
      if (typeof value.text === 'string') return value.text;
      if (typeof value.thinking === 'string') return value.thinking;
    }
    return '';
  }

  var dictionaries = null;
  var active = 'zh';
  var listeners = new Set();

  function template(value, params) {
    if (typeof value !== 'string') return String(value);
    if (!params) return value;
    return value.replace(/\{([A-Za-z0-9_]+)\}/g, function (_all, key) {
      return params[key] === undefined ? _all : String(params[key]);
    });
  }

  function lookup(key, params) {
    var table = null;
    if (dictionaries) table = dictionaries[active] || dictionaries.zh || dictionaries.en || null;
    var value = table && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
    return template(value === null || value === undefined ? key : value, params);
  }

  function notify() {
    for (var fn of listeners) {
      try { fn(); } catch (_) {}
    }
  }

  var locale = {
    register: function (_ns, next) {
      dictionaries = next || dictionaries;
      notify();
      return function () {};
    },
    bind: function (_ns) {
      return function (key, params) { return lookup(key, params); };
    },
    getLocale: function () { return { active: active }; },
    subscribe: function (fn) {
      listeners.add(fn);
      return function () { listeners.delete(fn); };
    },
  };

  var pageComponent = null;
  var effects = [];

  function safeCall(label, fn, fallback) {
    try {
      return fn();
    } catch (err) {
      console.error('[dsh-context panel] ' + label, err);
      try { window.parent.postMessage({ type: 'agenthub:context-error', message: label + ': ' + (err && (err.stack || err.message) || err) }, '*'); } catch (_) {}
      return fallback;
    }
  }

  var sessions = {
    refresh: function () { return Promise.resolve(); },
    getSnapshot: function () { return { current: null }; },
    refreshProjections: function () { return Promise.resolve(); },
    subagentAddress: function () { return undefined; },
  };

  var services = {
    sessions: sessions,
    uiWorkspace: {
      openSession: function (id) {
        try { window.parent.postMessage({ type: 'agenthub:context-open-session', sessionId: id }, '*'); } catch (_) {}
      },
    },
    pluginNavigation: {
      openBundle: function () {
        try { window.parent.postMessage({ type: 'agenthub:context-open-settings' }, '*'); } catch (_) {}
        return true;
      },
    },
  };

  var slots = {
    entries: function () { return []; },
    inject: function (name, callback) {
      return safeCall('slot inject ' + name, function () { return callback(); }, function () {});
    },
    register: function (definition, component) {
      if (definition && definition.name === 'main'
        && (definition.key === 'dsh-context' || definition.id === 'dsh-context')) {
        pageComponent = component;
      }
      return function () {};
    },
  };

  var fakeCtx = {
    locale: locale,
    slots: slots,
    get: function (name) { return services[name]; },
    effect: function (fn, label) {
      var dispose = safeCall('effect ' + (label || ''), fn, undefined);
      if (typeof dispose === 'function') effects.push(dispose);
      return function () {};
    },
    inject: function (_deps, callback) {
      return safeCall('inject dependencies', function () { return callback(fakeCtx); }, function () {});
    },
  };

  function mount() {
    if (mounted) return;
    var exported = state.exports;
    if (!exported || typeof exported.apply !== 'function') {
      var errors = state.errors && state.errors.length ? '\n' + state.errors.join('\n') : '';
      return fail('dsh-context 模块未正确加载' + errors);
    }
    safeCall('apply', function () { exported.apply(fakeCtx); });
    if (typeof pageComponent !== 'function') {
      return fail('dsh-context 未注册「上下文洞察」页面组件');
    }

    function TrendAwarePanel() {
      var hostRef = React.useRef(null);
      var hostState = React.useState(null);
      var host = hostState[0];
      var setHost = hostState[1];

      React.useEffect(function () {
        var observer = null;

        function findSlot() {
          var body = document.querySelector('.lc-ov-body');
          if (body) return { parent: body, before: body.firstChild };
          var content = document.querySelector('.lc-ov-pagecontent');
          if (content) {
            var head = content.querySelector('.lc-ov-pagehead');
            return { parent: content, before: head ? head.nextSibling : content.firstChild };
          }
          return null;
        }

        function attach() {
          var slot = findSlot();
          if (!slot) return false;
          var mount = document.getElementById('agenthub-trend-host');
          if (!mount) {
            mount = document.createElement('div');
            mount.id = 'agenthub-trend-host';
          }
          if (mount.parentNode !== slot.parent) {
            slot.parent.insertBefore(mount, slot.before);
          }
          if (hostRef.current !== mount) {
            hostRef.current = mount;
            setHost(mount);
          }
          return true;
        }

        attach();
        if (typeof MutationObserver === 'function') {
          observer = new MutationObserver(function () { attach(); });
          observer.observe(document.getElementById('root'), { childList: true, subtree: true });
        }
        return function () {
          if (observer) observer.disconnect();
          var mount = document.getElementById('agenthub-trend-host');
          if (mount && mount.parentNode) mount.parentNode.removeChild(mount);
          hostRef.current = null;
        };
      }, []);

      var page = React.createElement(pageComponent, {});
      var Trend = window.__AGENTHUB_TREND__;
      if (host && ReactDOM && typeof ReactDOM.createPortal === 'function'
        && Trend && typeof Trend.TrendCard === 'function') {
        return React.createElement(React.Fragment, null,
          page,
          ReactDOM.createPortal(React.createElement(Trend.TrendCard, {}), host)
        );
      }
      return page;
    }

    var root = createRoot(document.getElementById('root'));
    root.render(React.createElement(TrendAwarePanel, {}));
    mounted = true;
    try { window.parent.postMessage({ type: 'agenthub:context-ready' }, '*'); } catch (_) {}
  }

  window.addEventListener('error', function (event) {
    if (!mounted) fail((event && event.message) || '脚本加载错误');
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    if (!mounted) fail((reason && (reason.stack || reason.message)) || reason || 'Promise 未处理');
  });

  // client.js 是同步脚本，正常情况下到此已经完成模块注册。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
