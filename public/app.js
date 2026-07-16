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
    renderReferences(data.references || []);
    renderEval();
    show('eval');
    window.scrollTo(0, 0);
  }

  function renderReferences(refs) {
    const ul = $('#referenceList');
    ul.innerHTML = '';
    refs.forEach((r) => {
      const li = document.createElement('li');
      li.textContent = r;
      ul.appendChild(li);
    });
  }

  // -------------------------------------------------------------------------
  // 阶段二：渲染打分列表
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

      const scoreEl = document.createElement('div');
      scoreEl.className = 'manager-score';
      scoreEl.textContent = '未评分';

      head.appendChild(nameEl);
      head.appendChild(scoreEl);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'slider';
      slider.min = '0';
      slider.max = '100';
      slider.step = '1';
      slider.value = '50';
      // 使用 dataset.scored 标记是否已经交互过
      slider.dataset.scored = '0';

      const onInput = () => {
        slider.dataset.scored = '1';
        item.classList.remove('unscored', 'highlight');
        item.classList.add('scored');
        scoreEl.textContent = slider.value + ' 分';
        refreshDuplicateHint();
      };
      slider.addEventListener('input', onInput);
      slider.addEventListener('change', onInput);

      item.appendChild(head);
      item.appendChild(slider);
      list.appendChild(item);
    });
  }

  /** 收集当前评分（仅已交互过的） */
  function collectScores() {
    const result = [];
    document.querySelectorAll('.manager-item').forEach((item) => {
      const slider = item.querySelector('.slider');
      const scored = slider.dataset.scored === '1';
      result.push({
        managerId: Number(item.dataset.managerId),
        score: scored ? Number(slider.value) : null,
        scored,
        item,
      });
    });
    return result;
  }

  /** 实时高亮重复分数 */
  function refreshDuplicateHint() {
    const scores = collectScores().filter((s) => s.scored);
    const counts = new Map();
    scores.forEach((s) => counts.set(s.score, (counts.get(s.score) || 0) + 1));

    document.querySelectorAll('.manager-item').forEach((item) => {
      const slider = item.querySelector('.slider');
      const scoreEl = item.querySelector('.manager-score');
      if (slider.dataset.scored !== '1') return;
      const val = Number(slider.value);
      if (counts.get(val) > 1) {
        item.classList.add('duplicate');
        scoreEl.textContent = val + ' 分（重复）';
      } else {
        item.classList.remove('duplicate');
        scoreEl.textContent = val + ' 分';
      }
    });
  }

  // -------------------------------------------------------------------------
  // 提交
  // -------------------------------------------------------------------------
  async function handleSubmit() {
    $('#submitError').textContent = '';
    const collected = collectScores();

    // 1. 未评分校验：滚动到第一个未评分并高亮
    const firstUnscored = collected.find((s) => !s.scored);
    if (firstUnscored) {
      document.querySelectorAll('.manager-item').forEach((i) => i.classList.remove('highlight'));
      firstUnscored.item.classList.add('highlight');
      firstUnscored.item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('#submitError').textContent = '请为所有测评对象评分（已定位到未评分对象）';
      return;
    }

    // 2. 重复分数校验
    const seen = new Set();
    let dup = null;
    for (const s of collected) {
      if (seen.has(s.score)) {
        dup = s;
        break;
      }
      seen.add(s.score);
    }
    if (dup) {
      refreshDuplicateHint();
      dup.item.classList.add('highlight');
      dup.item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('#submitError').textContent = '存在重复分数，每个分数只能使用一次';
      return;
    }

    // 3. 提交后端
    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = '提交中…';
    const data = await api('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: state.name,
        group: GROUP,
        scores: collected.map((s) => ({ managerId: s.managerId, score: s.score })),
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
