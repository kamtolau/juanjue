'use strict';

/**
 * 项目领导班子民主测评系统 —— 后端服务
 *
 * 页面：
 *   /        测评页
 *   /admin   测评管理后台
 *
 * 环境变量：
 *   PORT             监听端口，默认 3000
 *   ADMIN_PASSWORD   后台管理员密码，默认 admin123（生产环境务必修改）
 */

const path = require('path');
const crypto = require('crypto');

// 加载 .env（Node 20.6+ 内置，无需第三方依赖）；不存在则忽略
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path.join(__dirname, '.env'));
  }
} catch (_) {
  /* 无 .env 文件时静默跳过，改用系统环境变量 */
}

const express = require('express');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');

const { db, nowIso, getSetting, setSetting, transaction } = require('./db');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 规范化姓名：去除首尾空白、合并中间空格 */
function normalizeName(name) {
  return String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
}

/** 问卷类别配置：leader（领导班子）/ manager（管理人员） */
const GROUPS = {
  leader: { key: 'leader', label: '领导班子', title: '项目领导班子民主测评' },
  manager: { key: 'manager', label: '管理人员', title: '项目管理人员民主测评' },
};
/** 校验并返回合法 group，非法返回 null */
function normalizeGroup(g) {
  return GROUPS[g] ? g : null;
}

/** 查询某姓名在指定问卷下当前是否存在有效（未作废）提交 */
const findValidSubmissionStmt = db.prepare(
  'SELECT * FROM submissions WHERE name = ? AND group_key = ? AND voided_at IS NULL LIMIT 1'
);
function findValidSubmission(name, group) {
  return findValidSubmissionStmt.get(name, group);
}

/** 获取指定问卷下全部启用的测评对象（按 sort、id 排序） */
const activeManagersStmt = db.prepare(
  'SELECT id, name, title FROM managers WHERE active = 1 AND group_key = ? ORDER BY sort ASC, id ASC'
);
function getActiveManagers(group) {
  return activeManagersStmt.all(group);
}

/** 生成简单管理员会话令牌（内存存储，重启失效） */
const adminTokens = new Set();
function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.add(token);
  return token;
}
function isValidToken(token) {
  return !!token && adminTokens.has(token);
}

/** 后台鉴权中间件 */
function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-admin-token');
  if (!isValidToken(token)) {
    return res.status(401).json({ ok: false, error: '未授权，请重新登录' });
  }
  next();
}

// ===========================================================================
// 公开测评接口
// ===========================================================================

/** 测评配置：开放状态 + 参考项 */
const EVAL_REFERENCES = ['团结协作', '专业素养', '执行落实力', '担当作为'];

/**
 * 四个评分维度：每个维度 0-100 分。
 *   - 单人的 4 个维度分不能重复
 *   - 所有人的「总分」（4 个维度之和）不能重复
 */
const EVAL_DIMENSIONS = [
  {
    key: 'd1',
    name: '团结协作',
    desc: '领导班子成员是否能够在共同目标指引下，坚持民主集中制原则，相互信任、相互支持、密切配合，形成整体合力推动项目发展。',
  },
  {
    key: 'd2',
    name: '专业素养',
    desc: '领导班子成员深耕各专业条线，业务功底扎实，具备统筹施工、安全、协调等综合专业素养，精准把控项目各类风险。',
  },
  {
    key: 'd3',
    name: '执行落实力',
    desc: '对上级各项工作安排、项目既定计划紧盯不放，全程跟踪督办，闭环管控全过程，整体执行落实高效有力。',
  },
  {
    key: 'd4',
    name: '担当作为',
    desc: '面对工期压力、现场难题、突发状况主动扛责，不推诿、不回避，主动攻坚破难，以实干担当汇聚整体合力，推动项目建设稳步推进。',
  },
];
const DIMENSION_KEYS = EVAL_DIMENSIONS.map((d) => d.key);

app.get('/api/config', (req, res) => {
  const group = normalizeGroup(req.query.group);
  if (!group) {
    return res.status(400).json({ ok: false, error: '缺少测评类别' });
  }
  res.json({
    ok: true,
    group,
    title: GROUPS[group].title,
    label: GROUPS[group].label,
    references: EVAL_REFERENCES,
    dimensions: EVAL_DIMENSIONS,
    surveyOpen: getSetting('survey_open', '1') === '1',
  });
});

/**
 * 姓名核验：判断该姓名在指定问卷下能否进入测评
 * 返回 canEnter=true 表示未提交过（可进入）
 */
app.post('/api/check-name', (req, res) => {
  if (getSetting('survey_open', '1') !== '1') {
    return res.json({ ok: false, canEnter: false, error: '测评已关闭' });
  }
  const group = normalizeGroup(req.body && req.body.group);
  if (!group) {
    return res.json({ ok: false, canEnter: false, error: '缺少测评类别' });
  }
  const name = normalizeName(req.body && req.body.name);
  if (!name) {
    return res.json({ ok: false, canEnter: false, error: '请输入姓名' });
  }
  if (findValidSubmission(name, group)) {
    return res.json({ ok: false, canEnter: false, error: '该姓名已提交过本问卷，不可重复填写' });
  }
  res.json({
    ok: true,
    canEnter: true,
    name,
    group,
    managers: getActiveManagers(group),
    references: EVAL_REFERENCES,
    dimensions: EVAL_DIMENSIONS,
  });
});

/**
 * 提交测评
 * body: { name, group, scores: [{ managerId, score }] }
 */
app.post('/api/submit', (req, res) => {
  if (getSetting('survey_open', '1') !== '1') {
    return res.status(400).json({ ok: false, error: '测评已关闭' });
  }

  const group = normalizeGroup(req.body && req.body.group);
  if (!group) {
    return res.status(400).json({ ok: false, error: '缺少测评类别' });
  }

  const name = normalizeName(req.body && req.body.name);
  if (!name) {
    return res.status(400).json({ ok: false, error: '请输入姓名' });
  }

  // 姓名唯一性再次校验（同问卷内）
  if (findValidSubmission(name, group)) {
    return res.status(400).json({ ok: false, error: '该姓名已提交过本问卷，不可重复填写' });
  }

  const managers = getActiveManagers(group);
  const managerIds = new Set(managers.map((m) => m.id));

  const rawScores = Array.isArray(req.body && req.body.scores) ? req.body.scores : [];

  // 归一化并做完整性 / 范围 / 维度唯一性校验
  // 每个 manager 记录：{ dims: {d1,d2,d3,d4}, total }
  const scoreByManager = new Map();
  for (const item of rawScores) {
    const mid = Number(item && item.managerId);
    if (!managerIds.has(mid)) {
      return res.status(400).json({ ok: false, error: '存在无效的测评对象' });
    }

    const dims = {};
    const dimVals = [];
    for (const key of DIMENSION_KEYS) {
      const v = Number(item && item[key]);
      if (!Number.isInteger(v) || v < 0 || v > 100) {
        return res.status(400).json({ ok: false, error: '每个维度分必须为 0-100 的整数' });
      }
      dims[key] = v;
      dimVals.push(v);
    }

    // 单人 4 个维度分不可重复
    if (new Set(dimVals).size !== dimVals.length) {
      return res
        .status(400)
        .json({ ok: false, error: '同一测评对象的 4 个维度分不能重复' });
    }

    const total = dimVals.reduce((a, b) => a + b, 0);
    scoreByManager.set(mid, { dims, total });
  }

  // 完整性：每个启用对象都必须打分
  for (const m of managers) {
    if (!scoreByManager.has(m.id)) {
      return res.status(400).json({ ok: false, error: '存在未评分的测评对象' });
    }
  }

  // 唯一性：所有人的总分不可重复
  const usedTotals = new Set();
  for (const { total } of scoreByManager.values()) {
    if (usedTotals.has(total)) {
      return res
        .status(400)
        .json({ ok: false, error: '每位测评对象的总分不能重复，存在重复总分' });
    }
    usedTotals.add(total);
  }

  // 写入（事务）
  const insertSubmission = db.prepare(
    'INSERT INTO submissions (name, group_key, created_at, voided_at) VALUES (?, ?, ?, NULL)'
  );
  const insertScore = db.prepare(
    'INSERT INTO scores (submission_id, manager_id, score, d1, d2, d3, d4) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  try {
    transaction(() => {
      // 事务内二次确认唯一（防并发）
      if (findValidSubmission(name, group)) {
        throw new Error('DUPLICATE');
      }
      const info = insertSubmission.run(name, group, nowIso());
      const submissionId = info.lastInsertRowid;
      for (const [mid, { dims, total }] of scoreByManager.entries()) {
        insertScore.run(submissionId, mid, total, dims.d1, dims.d2, dims.d3, dims.d4);
      }
    });
  } catch (err) {
    if (err.message === 'DUPLICATE') {
      return res.status(400).json({ ok: false, error: '该姓名已提交过本问卷，不可重复填写' });
    }
    console.error('提交失败：', err);
    return res.status(500).json({ ok: false, error: '提交失败，请稍后再试' });
  }

  res.json({ ok: true, message: '提交成功，感谢您的参与！' });
});

// ===========================================================================
// 后台管理接口
// ===========================================================================

/** 登录 */
app.post('/api/admin/login', (req, res) => {
  const password = String((req.body && req.body.password) || '');
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: '密码错误' });
  }
  res.json({ ok: true, token: issueToken() });
});

/** 校验令牌是否有效（前端刷新用） */
app.get('/api/admin/verify', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

/** 概览：开放状态、公网地址、统计数字 */
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const validByGroupStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM submissions WHERE voided_at IS NULL AND group_key = ?"
  );
  const leaderValid = validByGroupStmt.get('leader').n;
  const managerValid = validByGroupStmt.get('manager').n;
  const voidedCount = db
    .prepare('SELECT COUNT(*) AS n FROM submissions WHERE voided_at IS NOT NULL')
    .get().n;
  res.json({
    ok: true,
    surveyOpen: getSetting('survey_open', '1') === '1',
    publicUrl: getSetting('public_url', ''),
    leaderValid,
    managerValid,
    validCount: leaderValid + managerValid,
    voidedCount,
  });
});

/** 开放 / 关闭测评 */
app.post('/api/admin/survey-open', requireAdmin, (req, res) => {
  const open = !!(req.body && req.body.open);
  setSetting('survey_open', open ? '1' : '0');
  res.json({ ok: true, surveyOpen: open });
});

/** 设置公网测评地址 */
app.post('/api/admin/public-url', requireAdmin, (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  setSetting('public_url', url);
  res.json({ ok: true, publicUrl: url });
});

/** 生成测评二维码（返回 dataURL）。可传 url，否则用已保存的公网地址 */
app.get('/api/admin/qrcode', requireAdmin, async (req, res) => {
  const url = String(req.query.url || getSetting('public_url', '') || '').trim();
  if (!url) {
    return res.status(400).json({ ok: false, error: '请先设置公网测评地址' });
  }
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 1 });
    res.json({ ok: true, url, dataUrl });
  } catch (err) {
    console.error('二维码生成失败：', err);
    res.status(500).json({ ok: false, error: '二维码生成失败' });
  }
});

// ---- 测评对象管理 ----------------------------------------------------------

/** 列出全部测评对象（含停用） */
app.get('/api/admin/managers', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      "SELECT id, name, title, sort, active, group_key FROM managers " +
        "ORDER BY (group_key = 'leader') DESC, sort ASC, id ASC"
    )
    .all();
  res.json({ ok: true, managers: rows, groups: GROUPS });
});

/** 新增测评对象 */
app.post('/api/admin/managers', requireAdmin, (req, res) => {
  const name = normalizeName(req.body && req.body.name);
  if (!name) {
    return res.status(400).json({ ok: false, error: '请输入测评对象名称' });
  }
  const group = normalizeGroup(req.body && req.body.group) || 'leader';
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM managers').get().m;
  const info = db
    .prepare(
      'INSERT INTO managers (name, title, sort, active, group_key, created_at) VALUES (?, ?, ?, 1, ?, ?)'
    )
    .run(name, '', maxSort + 1, group, nowIso());
  res.json({ ok: true, id: info.lastInsertRowid });
});

/** 修改测评对象名称 */
app.put('/api/admin/managers/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const name = normalizeName(req.body && req.body.name);
  if (!name) {
    return res.status(400).json({ ok: false, error: '请输入测评对象名称' });
  }
  const info = db.prepare('UPDATE managers SET name = ? WHERE id = ?').run(name, id);
  if (info.changes === 0) {
    return res.status(404).json({ ok: false, error: '测评对象不存在' });
  }
  res.json({ ok: true });
});

/** 停用 / 启用测评对象 */
app.post('/api/admin/managers/:id/active', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const active = !!(req.body && req.body.active);
  const info = db.prepare('UPDATE managers SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  if (info.changes === 0) {
    return res.status(404).json({ ok: false, error: '测评对象不存在' });
  }
  res.json({ ok: true, active });
});

// ---- 提交明细 / 汇总 -------------------------------------------------------

/** 提交明细列表 */
app.get('/api/admin/submissions', requireAdmin, (req, res) => {
  const subs = db.prepare('SELECT * FROM submissions ORDER BY id DESC').all();
  const scoreStmt = db.prepare(
    `SELECT s.manager_id, s.score, s.d1, s.d2, s.d3, s.d4, m.name AS manager_name
       FROM scores s JOIN managers m ON m.id = s.manager_id
      WHERE s.submission_id = ?`
  );
  const result = subs.map((sub) => {
    const scores = scoreStmt.all(sub.id);
    return {
      id: sub.id,
      name: sub.name,
      group: sub.group_key,
      groupLabel: (GROUPS[sub.group_key] || {}).label || sub.group_key,
      createdAt: sub.created_at,
      voidedAt: sub.voided_at,
      status: sub.voided_at ? '已作废' : '有效',
      scores,
    };
  });
  res.json({ ok: true, submissions: result });
});

/** 汇总排名（仅统计有效提交），按指定问卷分组计算、组内排名 */
function computeSummary(group) {
  const managers = db
    .prepare('SELECT id, name FROM managers WHERE group_key = ? ORDER BY sort ASC, id ASC')
    .all(group);
  const rows = managers.map((m) => {
    const agg = db
      .prepare(
        `SELECT COUNT(*) AS n, AVG(s.score) AS avg, MAX(s.score) AS max, MIN(s.score) AS min,
                AVG(s.d1) AS avg1, AVG(s.d2) AS avg2, AVG(s.d3) AS avg3, AVG(s.d4) AS avg4
           FROM scores s
           JOIN submissions sub ON sub.id = s.submission_id
          WHERE s.manager_id = ? AND sub.voided_at IS NULL`
      )
      .get(m.id);
    const round2 = (v) => (v == null ? 0 : Number(Number(v).toFixed(2)));
    return {
      managerId: m.id,
      manager: m.name,
      count: agg.n || 0,
      avg: agg.n ? round2(agg.avg) : 0,
      max: agg.n ? agg.max : 0,
      min: agg.n ? agg.min : 0,
      d1: agg.n ? round2(agg.avg1) : 0,
      d2: agg.n ? round2(agg.avg2) : 0,
      d3: agg.n ? round2(agg.avg3) : 0,
      d4: agg.n ? round2(agg.avg4) : 0,
    };
  });
  // 按平均分降序排名
  rows.sort((a, b) => b.avg - a.avg);
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

app.get('/api/admin/summary', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    groups: [
      { key: 'leader', label: GROUPS.leader.label, rows: computeSummary('leader') },
      { key: 'manager', label: GROUPS.manager.label, rows: computeSummary('manager') },
    ],
  });
});

/** 作废某条提交（记录作废时间，不参与统计，该姓名可重新提交） */
app.post('/api/admin/submissions/:id/void', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
  if (!sub) {
    return res.status(404).json({ ok: false, error: '提交记录不存在' });
  }
  if (sub.voided_at) {
    return res.json({ ok: true, message: '该提交已是作废状态' });
  }
  db.prepare('UPDATE submissions SET voided_at = ? WHERE id = ?').run(nowIso(), id);
  res.json({ ok: true });
});

/** 清空全部提交数据（保留测评对象与设置） */
app.post('/api/admin/clear', requireAdmin, (req, res) => {
  transaction(() => {
    db.prepare('DELETE FROM scores').run();
    db.prepare('DELETE FROM submissions').run();
  });
  res.json({ ok: true });
});

// ---- Excel 导出 ------------------------------------------------------------

app.get('/api/admin/export', requireAdmin, async (req, res) => {
  const scoreStmt = db.prepare(
    'SELECT manager_id, score, d1, d2, d3, d4 FROM scores WHERE submission_id = ?'
  );

  const workbook = new ExcelJS.Workbook();
  workbook.creator = '项目民主测评系统';
  workbook.created = new Date();

  // 每份问卷各生成「明细」+「汇总」两个 sheet
  for (const key of ['leader', 'manager']) {
    const label = GROUPS[key].label;
    const managers = db
      .prepare('SELECT id, name FROM managers WHERE group_key = ? ORDER BY sort ASC, id ASC')
      .all(key);
    const subs = db
      .prepare('SELECT * FROM submissions WHERE group_key = ? ORDER BY id ASC')
      .all(key);

    // --- 明细 ---
    // 每位测评对象展开为「总分 + 4 个维度」共 5 列
    const detail = workbook.addWorksheet(`${label}-明细`);
    const detailColumns = [
      { header: '提交ID', key: 'id', width: 10 },
      { header: '姓名', key: 'name', width: 16 },
      { header: '状态', key: 'status', width: 10 },
      { header: '提交时间', key: 'createdAt', width: 22 },
      { header: '作废时间', key: 'voidedAt', width: 22 },
    ];
    managers.forEach((m) => {
      detailColumns.push({ header: `${m.name}-总分`, key: `m_${m.id}_total`, width: 14 });
      EVAL_DIMENSIONS.forEach((d) => {
        detailColumns.push({ header: `${m.name}-${d.name}`, key: `m_${m.id}_${d.key}`, width: 14 });
      });
    });
    detail.columns = detailColumns;

    subs.forEach((sub) => {
      const scores = scoreStmt.all(sub.id);
      const scoreMap = new Map(scores.map((s) => [s.manager_id, s]));
      const row = {
        id: sub.id,
        name: sub.name,
        status: sub.voided_at ? '已作废' : '有效',
        createdAt: formatDateTime(sub.created_at),
        voidedAt: sub.voided_at ? formatDateTime(sub.voided_at) : '',
      };
      managers.forEach((m) => {
        const s = scoreMap.get(m.id);
        row[`m_${m.id}_total`] = s ? s.score : '';
        EVAL_DIMENSIONS.forEach((d) => {
          row[`m_${m.id}_${d.key}`] = s && s[d.key] != null ? s[d.key] : '';
        });
      });
      detail.addRow(row);
    });
    detail.getRow(1).font = { bold: true };

    // --- 汇总 ---
    const summarySheet = workbook.addWorksheet(`${label}-汇总`);
    summarySheet.columns = [
      { header: '排名', key: 'rank', width: 8 },
      { header: '测评对象', key: 'manager', width: 24 },
      { header: '平均总分', key: 'avg', width: 12 },
      ...EVAL_DIMENSIONS.map((d) => ({ header: `${d.name}均分`, key: d.key, width: 14 })),
      { header: '最高分', key: 'max', width: 12 },
      { header: '最低分', key: 'min', width: 12 },
      { header: '有效人数', key: 'count', width: 12 },
    ];
    computeSummary(key).forEach((r) => {
      summarySheet.addRow({
        rank: r.rank,
        manager: r.manager,
        avg: r.avg,
        d1: r.d1,
        d2: r.d2,
        d3: r.d3,
        d4: r.d4,
        max: r.max,
        min: r.min,
        count: r.count,
      });
    });
    summarySheet.getRow(1).font = { bold: true };
  }

  const filename = `民主测评导出_${formatFileStamp(new Date())}.xlsx`;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  await workbook.xlsx.write(res);
  res.end();
});

// ---------------------------------------------------------------------------
// 日期格式化
// ---------------------------------------------------------------------------
function pad(n) {
  return String(n).padStart(2, '0');
}
function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function formatFileStamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// 页面路由
// ---------------------------------------------------------------------------
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
// 两份问卷入口，均由 index.html 承载，前端按路径识别 group
app.get('/leader', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/manager', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n项目民主测评系统已启动`);
  console.log(`  领导班子问卷： http://localhost:${PORT}/leader`);
  console.log(`  管理人员问卷： http://localhost:${PORT}/manager`);
  console.log(`  管理后台：     http://localhost:${PORT}/admin`);
  console.log(`  管理密码由环境变量 ADMIN_PASSWORD 配置${
    process.env.ADMIN_PASSWORD ? '' : '（当前为默认 admin123，请尽快修改）'
  }\n`);
});
