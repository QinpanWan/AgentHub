(function () {
  'use strict';

  var runtime = window.__DSH_CONTEXT_RUNTIME__;
  if (!runtime || !runtime.React) return;

  var React = runtime.React;
  var h = React.createElement;
  var REFRESH_MS = 4000;
  var CHART_H = 112;
  var BAR_W = 14;
  var BAR_GAP = 2;
  var PITCH = BAR_W + BAR_GAP;

  var CATS = [
    { key: 'system', label: '系统', color: 'var(--color-indigo-500)' },
    { key: 'tools', label: '工具定义', color: 'var(--color-amber-500)' },
    { key: 'user', label: '用户', color: 'var(--color-green-500)' },
    { key: 'inject', label: '注入', color: 'var(--color-purple-500)' },
    { key: 'skill', label: '技能', color: 'var(--color-orange-500)' },
    { key: 'assistant', label: '助手', color: 'var(--color-blue-500)' },
    { key: 'tool', label: '工具结果', color: 'var(--color-teal-500)' },
  ];

  function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  function fmt(value) {
    var n = Math.round(num(value));
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  function fmtSigned(value) {
    var n = Math.round(num(value));
    return (n > 0 ? '+' : '') + fmt(n);
  }

  function fmtDuration(ms) {
    var value = Math.max(0, num(ms));
    if (value < 1000) return Math.round(value) + 'ms';
    var s = value / 1000;
    if (s < 60) return s.toFixed(1).replace(/\.0$/, '') + 's';
    var m = s / 60;
    if (m < 60) return m.toFixed(1).replace(/\.0$/, '') + 'm';
    return (m / 60).toFixed(1).replace(/\.0$/, '') + 'h';
  }

  function dateLabel(ts) {
    var value = num(ts);
    if (!value) return '';
    var d = new Date(value);
    if (!Number.isFinite(d.getTime())) return '';
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var hh = String(d.getHours()).padStart(2, '0');
    var mi = String(d.getMinutes()).padStart(2, '0');
    return mm + '-' + dd + ' ' + hh + ':' + mi;
  }

  function agentLabel(agent) {
    if (agent === 'codex') return 'Codex';
    if (agent === 'claude') return 'Claude';
    if (agent === 'dsh') return 'dsh';
    return String(agent || 'Agent');
  }

  function shortText(text, max) {
    var value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return '(无标题会话)';
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  }

  function aggregate(points, granularity) {
    if (granularity !== 'turn' || points.length === 0) return points;
    var out = [];
    for (var i = 0; i < points.length; i++) {
      var point = points[i];
      var last = out.length > 0 ? out[out.length - 1] : null;
      if (last && num(last.turn) === num(point.turn)) {
        var merged = Object.assign({}, point, {
          stepCount: num(last.stepCount) + 1,
        });
        if (last.activeMs !== undefined || point.activeMs !== undefined) {
          merged.activeMs = num(last.activeMs) + num(point.activeMs);
        }
        out[out.length - 1] = merged;
      } else {
        out.push(Object.assign({}, point, { stepCount: 1 }));
      }
    }
    return out;
  }

  function withMode(points, mode) {
    if (mode !== 'delta') {
      return points.map(function (point) {
        return Object.assign({}, point, { _total: num(point.total), _up: num(point.total), _down: 0, _net: 0 });
      });
    }
    return points.map(function (point, index) {
      var previous = index > 0 ? points[index - 1] : null;
      var up = 0;
      var down = 0;
      var net = 0;
      var deltas = {};
      for (var i = 0; i < CATS.length; i++) {
        var key = CATS[i].key;
        var delta = num(point[key]) - (previous ? num(previous[key]) : 0);
        deltas[key] = delta;
        if (delta > 0) up += delta;
        else if (delta < 0) down -= delta;
        net += delta;
      }
      return Object.assign({}, point, { _total: up, _up: up, _down: down, _net: net, _deltas: deltas });
    });
  }

  function pointLabel(point, index, granularity, stepCountOf) {
    var turn = num(point.turn);
    if (granularity === 'turn') {
      var count = num(point.stepCount) || 1;
      return '第 ' + turn + ' 轮' + (count > 1 ? ' · ' + count + ' 步' : '');
    }
    return '第 ' + turn + ' 轮 · 第 ' + num(point.step) + ' 步';
  }

  function buildTurnGroups(points) {
    var groups = [];
    for (var i = 0; i < points.length; i++) {
      var point = points[i];
      var last = groups.length > 0 ? groups[groups.length - 1] : null;
      if (last && num(last.turn) === num(point.turn)) {
        last.count += 1;
        last.end = i;
      } else {
        groups.push({ turn: num(point.turn), count: 1, start: i, end: i });
      }
    }
    return groups;
  }

  function TrendCard() {
    var [data, setData] = React.useState(null);
    var [error, setError] = React.useState(null);
    var [selected, setSelected] = React.useState('');
    var [granularity, setGranularity] = React.useState('step');
    var [mode, setMode] = React.useState('total');
    var [dna, setDna] = React.useState(false);
    var [adaptive, setAdaptive] = React.useState(false);
    var [durationOn, setDurationOn] = React.useState(false);
    var [overviewOn, setOverviewOn] = React.useState(false);
    var [hovered, setHovered] = React.useState(null);
    var [pinned, setPinned] = React.useState(null);
    var [view, setView] = React.useState({ from: 0, to: 0 });
    var scrollRef = React.useRef(null);

    React.useEffect(function () {
      var alive = true;
      var timer = null;

      function load() {
        var body = {
          part: 'trend',
          scope: { range: '30d', coverage: 'all' },
        };
        if (selected) body.sessionId = selected;
        fetch('/api/dsh-context/overview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        }).then(function (response) {
          return response.json().then(function (json) {
            if (!response.ok || !json || json.ok !== true) {
              throw new Error((json && json.error) || ('HTTP ' + response.status));
            }
            return json.value && json.value.trend ? json.value.trend : null;
          });
        }).then(function (trend) {
          if (!alive || !trend) return;
          setData(trend);
          setError(null);
          var next = trend.selected || (trend.sessions && trend.sessions[0] ? trend.sessions[0].id : '');
          if (next && next !== selected) setSelected(next);
        }).catch(function (err) {
          if (alive) setError(err && err.message ? err.message : String(err));
        });
      }

      load();
      timer = setInterval(load, REFRESH_MS);
      return function () {
        alive = false;
        if (timer) clearInterval(timer);
      };
    }, [selected]);

    var rawPoints = data && Array.isArray(data.points) ? data.points : [];
    var points = React.useMemo(function () {
      return aggregate(rawPoints, granularity);
    }, [rawPoints, granularity]);
    var shown = React.useMemo(function () {
      return withMode(points, mode);
    }, [points, mode]);

    var updateView = React.useCallback(function () {
      var el = scrollRef.current;
      var total = shown.length;
      if (!el || overviewOn || total === 0) {
        setView({ from: 0, to: Math.max(0, total - 1) });
        return;
      }
      var from = Math.max(0, Math.floor(el.scrollLeft / PITCH));
      var to = Math.min(total - 1, Math.max(from, Math.floor((el.scrollLeft + el.clientWidth - 1) / PITCH)));
      setView(function (prev) {
        return prev.from === from && prev.to === to ? prev : { from: from, to: to };
      });
    }, [shown.length, overviewOn]);

    React.useEffect(function () {
      updateView();
      var el = scrollRef.current;
      if (el && !overviewOn) el.scrollLeft = el.scrollWidth;
    }, [updateView, overviewOn]);

    var visible = adaptive && !overviewOn && view.to >= view.from
      ? shown.slice(view.from, view.to + 1)
      : shown;
    var maxTotal = 1;
    var maxActive = 0;
    for (var i = 0; i < visible.length; i++) {
      maxTotal = Math.max(maxTotal, num(visible[i]._total));
      maxActive = Math.max(maxActive, num(visible[i].activeMs));
    }

    var groups = React.useMemo(function () { return buildTurnGroups(shown); }, [shown]);
    var durationRuns = React.useMemo(function () {
      if (!durationOn || shown.length === 0) return [];
      var runs = [];
      var run = [];
      var scale = CHART_H / Math.max(1, maxActive);
      for (var i = 0; i < shown.length; i++) {
        var point = shown[i];
        if (point.activeMs === undefined) {
          if (run.length > 0) runs.push(run.join(' '));
          run = [];
          continue;
        }
        var x = ((i + 0.5) / shown.length) * 100;
        var y = Math.round((CHART_H - num(point.activeMs) * scale) * 100) / 100;
        run.push(x.toFixed(3) + ',' + y);
      }
      if (run.length > 0) runs.push(run.join(' '));
      return runs;
    }, [durationOn, shown, maxActive]);

    var hoveredPoint = hovered && shown[hovered.index] ? shown[hovered.index] : null;
    var tipLeft = hovered && shown.length > 0
      ? (overviewOn ? ((hovered.index + 0.5) / shown.length) * 100 + '%' : hovered.index * PITCH + BAR_W / 2 + 'px')
      : '0px';
    var selectedInfo = data && data.sessions
      ? data.sessions.find(function (item) { return item.id === selected; }) || null
      : null;

    function toggleDna() {
      var next = !dna;
      setDna(next);
      if (next) setOverviewOn(false);
    }

    function toggleAdaptive() {
      var next = !adaptive;
      setAdaptive(next);
      if (next) setOverviewOn(false);
    }

    function toggleOverview() {
      var next = !overviewOn;
      setOverviewOn(next);
      if (next) {
        setDna(false);
        setAdaptive(false);
      }
    }

    function renderSegment(point, cat) {
      var value = mode === 'delta' && point._deltas
        ? num(point._deltas[cat.key])
        : num(point[cat.key]);
      if (value <= 0) return null;
      var height = Math.max(1, Math.round(value / maxTotal * CHART_H));
      return h('div', {
        key: cat.key,
        className: 'ah-trend-seg',
        'data-cat': cat.key,
        style: { height: height + 'px', background: cat.color },
      });
    }

    var chartStyle = overviewOn
      ? { width: '100%' }
      : { width: Math.max(1, shown.length * PITCH) + 'px' };

    return h('div', { className: 'lc-card ah-trend-card' + (dna ? ' ah-trend-dna' : '') },
      h('div', { className: 'lc-card-title' },
        h('span', { className: 'lc-card-title-text' }, '上下文趋势'),
        h('span', { className: 'lc-gran ah-trend-mods', role: 'group', 'aria-label': '趋势模式' },
          h('button', {
            type: 'button',
            className: 'lc-gran-btn' + (dna ? ' lc-gran-on' : ''),
            title: '把每根柱子画成该次请求的上下文指纹',
            onClick: toggleDna,
          }, 'DNA 模式'),
          h('button', {
            type: 'button',
            className: 'lc-gran-btn' + (adaptive ? ' lc-gran-on' : ''),
            title: '按当前可视范围重新缩放柱高',
            onClick: toggleAdaptive,
          }, '自适应'),
          h('button', {
            type: 'button',
            className: 'lc-gran-btn' + (durationOn ? ' lc-gran-on' : ''),
            title: '叠加每步活跃耗时曲线',
            onClick: function () { setDurationOn(function (value) { return !value; }); },
          }, '耗时'),
          h('button', {
            type: 'button',
            className: 'lc-gran-btn' + (overviewOn ? ' lc-gran-on' : ''),
            title: '把全部步骤/轮次铺满当前可视宽度',
            onClick: toggleOverview,
          }, '总览')
        ),
        h('div', { className: 'ah-trend-ctl' },
          h('div', { className: 'lc-gran', role: 'group', 'aria-label': '趋势粒度' },
            h('button', {
              type: 'button',
              className: 'lc-gran-btn' + (granularity === 'step' ? ' lc-gran-on' : ''),
              onClick: function () { setGranularity('step'); },
            }, '步骤'),
            h('button', {
              type: 'button',
              className: 'lc-gran-btn' + (granularity === 'turn' ? ' lc-gran-on' : ''),
              onClick: function () { setGranularity('turn'); },
            }, '轮次')
          ),
          h('div', { className: 'lc-gran', role: 'group', 'aria-label': '展示方式' },
            h('button', {
              type: 'button',
              className: 'lc-gran-btn' + (mode === 'total' ? ' lc-gran-on' : ''),
              onClick: function () { setMode('total'); },
            }, '全量'),
            h('button', {
              type: 'button',
              className: 'lc-gran-btn' + (mode === 'delta' ? ' lc-gran-on' : ''),
              onClick: function () { setMode('delta'); },
            }, '增量')
          )
        )
      ),
      h('div', { className: 'ah-trend-sub' },
        h('select', {
          className: 'ah-trend-select',
          value: selected,
          onChange: function (event) { setSelected(event.target.value); },
          'aria-label': '选择会话',
        }, (data && data.sessions ? data.sessions : []).map(function (item) {
          return h('option', { key: item.id, value: item.id },
            agentLabel(item.agent) + ' · ' + shortText(item.title, 34) + ' · ' + dateLabel(item.updatedAt));
        })),
        h('span', { className: 'ah-trend-live' },
          h('span', { className: 'ah-trend-dot' }),
          '实时 · ' + (REFRESH_MS / 1000) + 's'
        ),
        selectedInfo ? h('span', { className: 'ah-trend-meta' },
          selectedInfo.points + ' 点 · ' + selectedInfo.turns + ' 轮 · ' + selectedInfo.steps + ' 步'
        ) : null
      ),
      error ? h('div', { className: 'lc-empty' }, '趋势数据加载失败：' + error) : null,
      !error && shown.length === 0 ? h('div', { className: 'lc-empty' }, '发起一轮对话后，这里会展示每次模型请求的上下文构成') : null,
      !error && shown.length > 0 ? h('div', { className: 'ah-trend-body' },
        h('div', { className: 'ah-trend-chartrow' },
          h('div', { className: 'ah-trend-axis' },
            h('span', { className: 'ah-trend-axis-top' }, fmt(maxTotal)),
            h('span', { className: 'ah-trend-axis-mid' }, fmt(maxTotal / 2)),
            h('span', { className: 'ah-trend-axis-bot' }, '0')
          ),
          h('div', { className: 'ah-trend-chartwrap' },
            h('div', {
              ref: scrollRef,
              className: 'ah-trend-scroll' + (overviewOn ? ' ah-trend-fit' : ''),
              onScroll: updateView,
            },
              h('div', { className: 'ah-trend-chart', style: chartStyle },
                h('div', { className: 'ah-trend-grid ah-trend-grid-top' }),
                h('div', { className: 'ah-trend-grid ah-trend-grid-mid' }),
                h('div', { className: 'ah-trend-grid ah-trend-grid-bot' }),
                shown.map(function (point, index) {
                  var hoveredNow = hovered && hovered.index === index;
                  var pinnedNow = pinned !== null && pinned === point.seq;
                  return h('div', {
                    key: String(point.seq) + '-' + index,
                    className: 'ah-trend-bar'
                      + (hoveredNow ? ' ah-trend-bar-hovered' : '')
                      + (pinnedNow ? ' ah-trend-bar-pinned' : ''),
                    style: overviewOn ? undefined : { width: BAR_W + 'px' },
                    role: 'button',
                    tabIndex: 0,
                    'aria-label': pointLabel(point, index, granularity),
                    onMouseEnter: function () { setHovered({ index: index }); },
                    onMouseLeave: function () { setHovered(null); },
                    onClick: function () { setPinned(pinnedNow ? null : point.seq); },
                    onKeyDown: function (event) {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setPinned(pinnedNow ? null : point.seq);
                      }
                    },
                  },
                    h('div', { className: 'ah-trend-stack' }, CATS.map(function (cat) {
                      return renderSegment(point, cat);
                    }))
                  );
                }),
                durationOn && durationRuns.length > 0 ? h('svg', {
                  className: 'ah-trend-duration',
                  viewBox: '0 0 100 112',
                  preserveAspectRatio: 'none',
                  'aria-hidden': 'true',
                }, durationRuns.map(function (pointsText, index) {
                  return h('polyline', { key: index, points: pointsText });
                })) : null,
                hoveredPoint ? h('div', {
                  className: 'ah-trend-tip',
                  style: { left: tipLeft },
                },
                  h('span', pointLabel(hoveredPoint, hovered.index, granularity)),
                  h('span', mode === 'delta'
                    ? '增量 +' + fmt(hoveredPoint._up) + ' / -' + fmt(hoveredPoint._down) + '（净 ' + fmtSigned(hoveredPoint._net) + '）'
                    : '上下文 ' + fmt(hoveredPoint.total) + ' tokens'),
                  durationOn && hoveredPoint.activeMs !== undefined ? h('span', '耗时 ' + fmtDuration(hoveredPoint.activeMs)) : null
                ) : null
              )
            ),
            h('div', { className: 'ah-trend-turns', style: overviewOn ? { width: '100%' } : { width: Math.max(1, shown.length * PITCH) + 'px' } },
              groups.map(function (group) {
                var width = overviewOn ? (group.count / shown.length) * 100 + '%' : group.count * PITCH - BAR_GAP + 'px';
                return h('div', {
                  key: String(group.turn) + '-' + group.start,
                  className: 'ah-trend-turn',
                  style: { width: width },
                  title: '第 ' + group.turn + ' 轮 · ' + group.count + ' 步',
                }, 'T' + group.turn);
              })
            )
          )
        ),
        h('div', { className: 'ah-trend-legend' }, CATS.map(function (cat) {
          return h('span', { key: cat.key, className: 'ah-trend-legend-item' },
            h('span', { className: 'ah-trend-swatch', style: { background: cat.color } }),
            cat.label
          );
        }))
      ) : null
    );
  }

  window.__AGENTHUB_TREND__ = { TrendCard: TrendCard };
})();
