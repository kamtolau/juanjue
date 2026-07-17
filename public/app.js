'use strict';

/* 项目领导班子民主测评 —— 测评页逻辑 */

(function () {
  const $ = (sel) => document.querySelector(sel);

  const views = {
    landing: $('#landingView'),
    closed: $('#closedView'),
    name: $('#nameView'),
    eval: $('#evalView'),
    done: $('#doneView'),
  };

  /** 从路径识别问卷类别：/leader → leader，/manager → manager，其余 → null */
  function detectGroup() {
    const p = location.pathname.replace(/\/+$/, '');
    if (p.endsWith('/leader')) return 'leader';
    if (p.endsWith('/manager')) return 'manager';
    return null;
  }
  const GROUP = detectGroup();

  const state = {
    name: '',
    managers: [],
    dimensions: [],
  };

  function show(view) {
    Object.values(views).forEach((v) => v.classList.add('hidden'));
    if (views[view]) views[view].classList.remove('hidden');
  }

  async function api(url, options) {
    const res = await fetch(url, options);
    let data;
    try {
      data = await res.json();
    } catch (_) {
      data = { ok: false, error: '网络异常' };
    }
    return data;
  }

  // -------------------------------------------------------------------------
  // 初始化：读取配置
  // -------------------------------------------------------------------------
  async function init() {
    // 未指定问卷 → 显示落地选择页
    if (!GROUP) {
      $('#pageTitle').textContent = '项目民主测评';
      document.title = '项目民主测评';
      show('landing');
      return;
    }
    const cfg = await api('/api/config?group=' + GROUP);
    if (cfg && cfg.title) {
      $('#pageTitle').textContent = cfg.title;
      document.title = cfg.title;
    }
    if (!cfg || !cfg.surveyOpen) {
      show('closed');
      return;
    }
    show('name');
    $('#nameInput').focus();
  }

  // -------------------------------------------------------------------------
  // 阶段一：姓名核验
  // -------------------------------------------------------------------------
  async function handleEnter() {
    const name = $('#nameInput').value.trim();
    $('#nameError').textContent = '';
    if (!name) {
      $('#nameError').textContent = '请输入姓名';
      return;
    }
    const btn = $('#enterBtn');
    btn.disabled = true;
    btn.textContent = '核验中…';
    const data = await api('/api/check-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, group: GROUP }),
    });
    btn.disabled = false;
    btn.textContent = '进入测评';

    if (!data.ok || !data.canEnter) {
      $('#nameError').textContent = data.error || '无法进入测评';
      return;
    }

    state.name = data.name;
    state.managers = data.managers || [];
    state.dimensions = data.dimensions || [];
    renderDimensions(state.dimensions);
    renderEval();
    show('eval');
    window.scrollTo(0, 0);
  }

  function renderDimensions(dims) {
    const ol = $('#dimensionList');
    ol.innerHTML = '';
    dims.forEach((d) => {
      const li = document.createElement('li');
      li.className = 'dimension-item';
      const name = document.createElement('div');
      name.className = 'dimension-name';
      name.textContent = d.name;
      const desc = document.createElement('div');
      desc.className = 'dimension-desc';
      desc.textContent = d.desc || '';
      li.appendChild(name);
      li.appendChild(desc);
      ol.appendChild(li);
    });
  }

  // -------------------------------------------------------------------------
  // 阶段二：渲染打分列表（每位对象 4 个维度分）
  // -------------------------------------------------------------------------
  function renderEval() {
    $('#evalName').textContent = state.name;
    const list = $('#managerList');
    list.innerHTML = '';

    state.managers.forEach((m) => {
      const item = document.createElement('div');
      item.className = 'manager-item unscored';
      item.dataset.managerId = m.id;

      const head = document.createElement('div');
      head.className = 'manager-head';

      const nameEl = document.createElement('div');
      nameEl.className = 'manager-name';
      nameEl.textContent = m.name;

      const totalEl = document.createElement('div');
      totalEl.className = 'manager-score manager-total';
      totalEl.textContent = '总分 —';

      head.appendChild(nameEl);
      head.appendChild(totalEl);
      item.appendChild(head);

      // 4 个维度滑块
      const dimsWrap = document.createElement('div');
      dimsWrap.className = 'dims-wrap';

      state.dimensions.forEach((d) => {
        const dimRow = document.createElement('div');
        dimRow.className = 'dim-row';
        dimRow.dataset.dimKey = d.key;

        const dimHead = document.createElement('div');
        dimHead.className = 'dim-head';

        const dimName = document.createElement('span');
        dimName.className = 'dim-name';
        dimName.textContent = d.name;

        const dimScore = document.createElement('span');
        dimScore.className = 'dim-score';
        dimScore.textContent = '未评分';

        dimHead.appendChild(dimName);
        dimHead.appendChild(dimScore);

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'slider';
        slider.min = '0';
        slider.max = '100';
        slider.step = '1';
        slider.value = '50';
        slider.dataset.scored = '0';

        const onInput = () => {
          slider.dataset.scored = '1';
          item.classList.remove('unscored', 'highlight');
          refreshManager(item);
          refreshTotals();
        };
        slider.addEventListener('input', onInput);
        slider.addEventListener('change', onInput);

        dimRow.appendChild(dimHead);
        dimRow.appendChild(slider);
        dimsWrap.appendChild(dimRow);
      });

      item.appendChild(dimsWrap);
      list.appendChild(item);
    });
  }

  /** 读取某位对象的 4 个维度分；未交互的维度值为 null */
  function readManager(item) {
    const dims = {};
    let allScored = true;
    item.querySelectorAll('.dim-row').forEach((row) => {
      const slider = row.querySelector('.slider');
      const scored = slider.dataset.scored === '1';
      if (!scored) allScored = false;
      dims[row.dataset.dimKey] = scored ? Number(slider.value) : null;
    });
    const vals = Object.values(dims);
    const total = allScored ? vals.reduce((a, b) => a + b, 0) : null;
    return { managerId: Number(item.dataset.managerId), dims, total, allScored, item };
  }

  /** 刷新单个对象：维度分显示、维度内重复高亮、卡片评分态、总分 */
  function refreshManager(item) {
    const rows = Array.from(item.querySelectorAll('.dim-row'));
    const scoredVals = [];
    rows.forEach((row) => {
      const slider = row.querySelector('.slider');
      if (slider.dataset.scored === '1') scoredVals.push(Number(slider.value));
    });
    const counts = new Map();
    scoredVals.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));

    let anyScored = false;
    rows.forEach((row) => {
      const slider = row.querySelector('.slider');
      const dimScore = row.querySelector('.dim-score');
      if (slider.dataset.scored !== '1') {
        dimScore.textContent = '未评分';
        row.classList.remove('duplicate');
        return;
      }
      anyScored = true;
      const val = Number(slider.value);
      if (counts.get(val) > 1) {
        row.classList.add('duplicate');
        dimScore.textContent = val + ' 分（重复）';
      } else {
        row.classList.remove('duplicate');
        dimScore.textContent = val + ' 分';
      }
    });

    item.classList.toggle('scored', anyScored);
    item.classList.toggle('unscored', !anyScored);
  }

  /** 刷新所有对象的总分显示，并高亮跨对象重复的总分 */
  function refreshTotals() {
    const items = Array.from(document.querySelectorAll('.manager-item'));
    const totals = [];
    items.forEach((item) => {
      const info = readManager(item);
      totals.push(info.allScored ? info.total : null);
    });
    const counts = new Map();
    totals.forEach((t) => {
      if (t != null) counts.set(t, (counts.get(t) || 0) + 1);
    });
    items.forEach((item, i) => {
      const totalEl = item.querySelector('.manager-total');
      const t = totals[i];
      if (t == null) {
        totalEl.textContent = '总分 —';
        item.classList.remove('total-dup');
        return;
      }
      if (counts.get(t) > 1) {
        totalEl.textContent = '总分 ' + t + '（重复）';
        item.classList.add('total-dup');
      } else {
        totalEl.textContent = '总分 ' + t;
        item.classList.remove('total-dup');
      }
    });
  }

  // -------------------------------------------------------------------------
  // 提交
  // -------------------------------------------------------------------------
  async function handleSubmit() {
    $('#submitError').textContent = '';
    const items = Array.from(document.querySelectorAll('.manager-item'));
    const collected = items.map((item) => readManager(item));

    const focusOn = (item, msg) => {
      items.forEach((i) => i.classList.remove('highlight'));
      item.classList.add('highlight');
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('#submitError').textContent = msg;
    };

    // 1. 完整性：每位对象的 4 个维度都必须评分
    const incomplete = collected.find((c) => !c.allScored);
    if (incomplete) {
      focusOn(incomplete.item, '请为每位对象的 4 个维度都评分（已定位到未完成对象）');
      return;
    }

    // 2. 单人 4 个维度分不能重复
    const dimDup = collected.find((c) => {
      const vals = Object.values(c.dims);
      return new Set(vals).size !== vals.length;
    });
    if (dimDup) {
      refreshManager(dimDup.item);
      focusOn(dimDup.item, '同一对象的 4 个维度分不能重复');
      return;
    }

    // 3. 所有对象的总分不能重复
    const seen = new Set();
    let totalDup = null;
    for (const c of collected) {
      if (seen.has(c.total)) {
        totalDup = c;
        break;
      }
      seen.add(c.total);
    }
    if (totalDup) {
      refreshTotals();
      focusOn(totalDup.item, '存在重复总分，每位对象的总分（4 项之和）不能重复');
      return;
    }

    // 4. 提交后端
    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = '提交中…';
    const data = await api('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: state.name,
        group: GROUP,
        scores: collected.map((c) => ({ managerId: c.managerId, ...c.dims })),
      }),
    });
    btn.disabled = false;
    btn.textContent = '提交测评';

    if (!data.ok) {
      $('#submitError').textContent = data.error || '提交失败';
      return;
    }

    $('#doneText').textContent = data.message || '感谢您的参与！';
    show('done');
    window.scrollTo(0, 0);
  }

  // -------------------------------------------------------------------------
  // 事件绑定
  // -------------------------------------------------------------------------
  $('#enterBtn').addEventListener('click', handleEnter);
  $('#nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleEnter();
  });
  $('#submitBtn').addEventListener('click', handleSubmit);

  init();
})();
