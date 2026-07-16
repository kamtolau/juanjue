'use strict';

/* 测评管理后台 —— 前端逻辑 */

(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const TOKEN_KEY = 'admin_token';
  let token = localStorage.getItem(TOKEN_KEY) || '';

  // ---- 网络封装 ----
  async function api(url, options = {}) {
    const opts = Object.assign({ headers: {} }, options);
    opts.headers = Object.assign(
      { 'Content-Type': 'application/json' },
      opts.headers,
      token ? { Authorization: 'Bearer ' + token } : {}
    );
    const res = await fetch(url, opts);
    if (res.status === 401) {
      handleLogout();
      throw new Error('未授权');
    }
    let data;
    try {
      data = await res.json();
    } catch (_) {
      data = { ok: false, error: '网络异常' };
    }
    return data;
  }

  // ---- Toast ----
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  // ---- 确认弹窗 ----
  function confirmDialog(text) {
    return new Promise((resolve) => {
      $('#modalText').textContent = text;
      $('#modal').classList.remove('hidden');
      const ok = $('#modalOk');
      const cancel = $('#modalCancel');
      const cleanup = () => {
        $('#modal').classList.add('hidden');
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
      };
      const onOk = () => {
        cleanup();
        resolve(true);
      };
      const onCancel = () => {
        cleanup();
        resolve(false);
      };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
    });
  }

  // ---- 登录 / 退出 ----
  async function handleLogin() {
    const password = $('#pwdInput').value;
    $('#loginError').textContent = '';
    if (!password) {
      $('#loginError').textContent = '请输入密码';
      return;
    }
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!data.ok) {
      $('#loginError').textContent = data.error || '登录失败';
      return;
    }
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    enterAdmin();
  }

  function handleLogout() {
    token = '';
    localStorage.removeItem(TOKEN_KEY);
    $('#mainView').classList.add('hidden');
    $('#loginView').classList.remove('hidden');
    $('#pwdInput').value = '';
  }

  function enterAdmin() {
    $('#loginView').classList.add('hidden');
    $('#mainView').classList.remove('hidden');
    loadOverview();
    switchTab('control');
  }

  // ---- Tabs ----
  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-panel').forEach((p) => p.classList.add('hidden'));
    $('#tab-' + name).classList.remove('hidden');
    if (name === 'summary') loadSummary();
    if (name === 'submissions') loadSubmissions();
    if (name === 'managers') loadManagers();
  }

  // ---- 概览 ----
  async function loadOverview() {
    const data = await api('/api/admin/overview');
    if (!data.ok) return;
    const badge = $('#statusText');
    badge.textContent = data.surveyOpen ? '开放中' : '已关闭';
    badge.className = 'status-badge ' + (data.surveyOpen ? 'open' : 'closed');
    $('#statValid').textContent = data.validCount;
    $('#statVoided').textContent = data.voidedCount;
    $('#statManagers').textContent = data.managerCount;
    $('#publicUrlInput').value = data.publicUrl || '';
  }

  async function toggleSurvey() {
    const cur = $('#statusText').textContent === '开放中';
    const data = await api('/api/admin/survey-open', {
      method: 'POST',
      body: JSON.stringify({ open: !cur }),
    });
    if (data.ok) {
      toast(data.surveyOpen ? '测评已开放' : '测评已关闭');
      loadOverview();
    }
  }

  async function savePublicUrl() {
    const url = $('#publicUrlInput').value.trim();
    const data = await api('/api/admin/public-url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    if (data.ok) toast('公网地址已保存');
  }

  async function genQrcode() {
    $('#qrError').textContent = '';
    const url = $('#publicUrlInput').value.trim();
    const query = url ? '?url=' + encodeURIComponent(url) : '';
    const data = await api('/api/admin/qrcode' + query);
    if (!data.ok) {
      $('#qrError').textContent = data.error || '生成失败';
      $('#qrBox').classList.add('hidden');
      return;
    }
    $('#qrImg').src = data.dataUrl;
    $('#qrDownload').href = data.dataUrl;
    $('#qrUrl').textContent = data.url;
    $('#qrBox').classList.remove('hidden');
  }

  // ---- 导出 ----
  async function doExport() {
    // 通过 fetch 带 token 下载
    try {
      const res = await fetch('/api/admin/export', {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!res.ok) {
        toast('导出失败');
        return;
      }
      const blob = await res.blob();
      const dispo = res.headers.get('Content-Disposition') || '';
      let filename = '民主测评导出.xlsx';
      const m = /filename\*=UTF-8''([^;]+)/.exec(dispo);
      if (m) filename = decodeURIComponent(m[1]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (_) {
      toast('导出失败');
    }
  }

  async function clearData() {
    const ok = await confirmDialog('确定要清空全部提交数据吗？此操作不可恢复（测评对象与设置保留）。');
    if (!ok) return;
    const data = await api('/api/admin/clear', { method: 'POST' });
    if (data.ok) {
      toast('提交数据已清空');
      loadOverview();
    }
  }

  // ---- 汇总 ----
  async function loadSummary() {
    const data = await api('/api/admin/summary');
    const body = $('#summaryBody');
    body.innerHTML = '';
    if (!data.ok) return;
    data.summary.forEach((r) => {
      const tr = document.createElement('tr');
      const rankCls = r.rank <= 3 ? `rank-badge rank-${r.rank}` : '';
      tr.innerHTML =
        `<td><span class="${rankCls}">${r.rank}</span></td>` +
        `<td style="text-align:left">${escapeHtml(r.manager)}</td>` +
        `<td>${r.avg}</td><td>${r.max}</td><td>${r.min}</td><td>${r.count}</td>`;
      body.appendChild(tr);
    });
  }

  // ---- 提交明细 ----
  async function loadSubmissions() {
    const data = await api('/api/admin/submissions');
    const list = $('#subsList');
    list.innerHTML = '';
    if (!data.ok) return;
    if (data.submissions.length === 0) {
      list.innerHTML = '<p class="hint">暂无提交记录</p>';
      return;
    }
    data.submissions.forEach((sub) => {
      const item = document.createElement('div');
      item.className = 'sub-item' + (sub.voidedAt ? ' voided' : '');

      const chips = sub.scores
        .map((s) => `<span class="score-chip">${escapeHtml(s.manager_name)} <b>${s.score}</b></span>`)
        .join('');

      const voidBtn = sub.voidedAt
        ? ''
        : `<button class="btn btn-danger btn-sm" data-void="${sub.id}">作废该提交</button>`;

      item.innerHTML =
        `<div class="sub-head">
           <span class="sub-name">${escapeHtml(sub.name)}</span>
           <span class="sub-badge ${sub.voidedAt ? 'voided' : 'valid'}">${sub.status}</span>
         </div>
         <div class="sub-time">提交时间：${fmt(sub.createdAt)}${
          sub.voidedAt ? '　|　作废时间：' + fmt(sub.voidedAt) : ''
        }</div>
         <div class="sub-scores">${chips}</div>
         <div class="sub-actions">${voidBtn}</div>`;
      list.appendChild(item);
    });

    list.querySelectorAll('[data-void]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-void');
        const ok = await confirmDialog('确定作废该提交吗？作废后不参与统计，该姓名可重新提交。');
        if (!ok) return;
        const res = await api('/api/admin/submissions/' + id + '/void', { method: 'POST' });
        if (res.ok) {
          toast('已作废');
          loadSubmissions();
          loadOverview();
        }
      });
    });
  }

  // ---- 对象管理 ----
  async function loadManagers() {
    const data = await api('/api/admin/managers');
    const list = $('#managersList');
    list.innerHTML = '';
    if (!data.ok) return;
    data.managers.forEach((m, idx) => {
      const row = document.createElement('div');
      row.className = 'manager-row' + (m.active ? '' : ' inactive');

      const nameInput = document.createElement('input');
      nameInput.className = 'm-name';
      nameInput.value = m.name;

      // 失焦保存名称
      nameInput.addEventListener('blur', async () => {
        const val = nameInput.value.trim();
        if (!val || val === m.name) {
          nameInput.value = m.name;
          return;
        }
        const res = await api('/api/admin/managers/' + m.id, {
          method: 'PUT',
          body: JSON.stringify({ name: val }),
        });
        if (res.ok) {
          m.name = val;
          toast('名称已更新');
        } else {
          nameInput.value = m.name;
          toast(res.error || '更新失败');
        }
      });

      const index = document.createElement('div');
      index.className = 'm-index';
      index.textContent = idx + 1;

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn btn-sm ' + (m.active ? 'btn-ghost' : 'btn-outline');
      toggleBtn.textContent = m.active ? '停用' : '启用';
      toggleBtn.addEventListener('click', async () => {
        const res = await api('/api/admin/managers/' + m.id + '/active', {
          method: 'POST',
          body: JSON.stringify({ active: !m.active }),
        });
        if (res.ok) {
          toast(res.active ? '已启用' : '已停用');
          loadManagers();
          loadOverview();
        }
      });

      row.appendChild(index);
      row.appendChild(nameInput);
      if (!m.active) {
        const tag = document.createElement('span');
        tag.className = 'tag-off';
        tag.textContent = '已停用';
        row.appendChild(tag);
      }
      row.appendChild(toggleBtn);
      list.appendChild(row);
    });
  }

  async function addManager() {
    const name = $('#newManagerInput').value.trim();
    $('#managerError').textContent = '';
    if (!name) {
      $('#managerError').textContent = '请输入测评对象名称';
      return;
    }
    const res = await api('/api/admin/managers', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      $('#newManagerInput').value = '';
      toast('已新增');
      loadManagers();
      loadOverview();
    } else {
      $('#managerError').textContent = res.error || '新增失败';
    }
  }

  // ---- 工具 ----
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmt(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
      d.getMinutes()
    )}:${p(d.getSeconds())}`;
  }

  // ---- 事件绑定 ----
  $('#loginBtn').addEventListener('click', handleLogin);
  $('#pwdInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
  });
  $('#logoutBtn').addEventListener('click', handleLogout);
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#toggleSurveyBtn').addEventListener('click', toggleSurvey);
  $('#savePublicUrlBtn').addEventListener('click', savePublicUrl);
  $('#genQrBtn').addEventListener('click', genQrcode);
  $('#exportBtn').addEventListener('click', doExport);
  $('#clearBtn').addEventListener('click', clearData);
  $('#refreshSummaryBtn').addEventListener('click', loadSummary);
  $('#refreshSubsBtn').addEventListener('click', loadSubmissions);
  $('#refreshManagersBtn').addEventListener('click', loadManagers);
  $('#addManagerBtn').addEventListener('click', addManager);
  $('#newManagerInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addManager();
  });

  // ---- 启动：校验已有 token ----
  (async function boot() {
    if (token) {
      try {
        const data = await api('/api/admin/verify');
        if (data.ok) {
          enterAdmin();
          return;
        }
      } catch (_) {
        /* 落到登录页 */
      }
    }
    handleLogout();
  })();
})();
