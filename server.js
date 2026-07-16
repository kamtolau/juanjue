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

/** 查询某姓名当前是否存在有效（未作废）提交 */
const findValidSubmissionStmt = db.prepare(
  'SELECT * FROM submissions WHERE name = ? AND voided_at IS NULL LIMIT 1'
);
function findValidSubmission(name) {
  return findValidSubmissionStmt.get(name);
}

/** 获取全部启用的测评对象（按 sort、id 排序） */
const activeManagersStmt = db.prepare(
  'SELECT id, name, title FROM managers WHERE active = 1 ORDER BY sort ASC, id ASC'
);
function getActiveManagers() {
  return activeManagersStmt.all();
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

app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    title: '项目领导班子民主测评',
    references: EVAL_REFERENCES,
    surveyOpen: getSetting('survey_open', '1') === '1',
  });
});

/**
 * 姓名核验：判断该姓名能否进入测评
 * 返回 canEnter=true 表示未提交过（可进入）
 */
app.post('/api/check-name', (req, res) => {
  if (getSetting('survey_open', '1') !== '1') {
    return res.json({ ok: false, canEnter: false, error: '测评已关闭' });
  }
  const name = normalizeName(req.body && req.body.name);
  if (!name) {
    return res.json({ ok: false, canEnter: false, error: '请输入姓名' });
  }
  if (findValidSubmission(name)) {
    return res.json({ ok: false, canEnter: false, error: '该姓名已提交过测评，不可重复填写' });
  }
  res.json({
    ok: true,
    canEnter: true,
    name,
    managers: getActiveManagers(),
    references: EVAL_REFERENCES,
  });
});

/**
 * 提交测评
 * body: { name, scores: [{ managerId, score }] }
 */
app.post('/api/submit', (req, res) => {
  if (getSetting('survey_open', '1') !== '1') {
    return res.status(400).json({ ok: false, error: '测评已关闭' });
  }

  const name = normalizeName(req.body && req.body.name);
  if (!name) {
    return res.status(400).json({ ok: false, error: '请输入姓名' });
  }

  // 姓名唯一性再次校验
  if (findValidSubmission(name)) {
    return res.status(400).json({ ok: false, error: '该姓名已提交过测评，不可重复填写' });
  }

  const managers = getActiveManagers();
  const managerIds = new Set(managers.map((m) => m.id));

  const rawScores = Array.isArray(req.body && req.body.scores) ? req.body.scores : [];

  // 归一化并做完整性 / 范围 / 唯一性校验
  const scoreByManager = new Map();
  for (const item of rawScores) {
    const mid = Number(item && item.managerId);
    const score = Number(item && item.score);
    if (!managerIds.has(mid)) {
      return res.status(400).json({ ok: false, error: '存在无效的测评对象' });
    }
    if (!Number.isInteger(score) || score < 0 || score > 100) {
      return res.status(400).json({ ok: false, error: '分数必须为 0-100 的整数' });
    }
    scoreByManager.set(mid, score);
  }

  // 完整性：每个启用对象都必须打分
  for (const m of managers) {
    if (!scoreByManager.has(m.id)) {
      return res.status(400).json({ ok: false, error: '存在未评分的测评对象' });
    }
  }

  // 唯一性：分数不可重复
  const usedScores = new Set();
  for (const score of scoreByManager.values()) {
    if (usedScores.has(score)) {
      return res.status(400).json({ ok: false, error: '每个分数只能使用一次，存在重复分数' });
    }
    usedScores.add(score);
  }

  // 写入（事务）
  const insertSubmission = db.prepare(
    'INSERT INTO submissions (name, created_at, voided_at) VALUES (?, ?, NULL)'
  );
  const insertScore = db.prepare(
    'INSERT INTO scores (submission_id, manager_id, score) VALUES (?, ?, ?)'
  );

  try {
    transaction(() => {
      // 事务内二次确认唯一（防并发）
      if (findValidSubmission(name)) {
        throw new Error('DUPLICATE');
      }
      const info = insertSubmission.run(name, nowIso());
      const submissionId = info.lastInsertRowid;
      for (const [mid, score] of scoreByManager.entries()) {
        insertScore.run(submissionId, mid, score);
      }
    });
  } catch (err) {
    if (err.message === 'DUPLICATE') {
      return res.status(400).json({ ok: false, error: '该姓名已提交过测评，不可重复填写' });
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
  const validCount = db
    .prepare('SELECT COUNT(*) AS n FROM submissions WHERE voided_at IS NULL')
    .get().n;
  const voidedCount = db
    .prepare('SELECT COUNT(*) AS n FROM submissions WHERE voided_at IS NOT NULL')
    .get().n;
  const managerCount = db.prepare('SELECT COUNT(*) AS n FROM managers WHERE active = 1').get().n;
  res.json({
    ok: true,
    surveyOpen: getSetting('survey_open', '1') === '1',
    publicUrl: getSetting('public_url', ''),
    validCount,
    voidedCount,
    managerCount,
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
    .prepare('SELECT id, name, title, sort, active FROM managers ORDER BY sort ASC, id ASC')
    .all();
  res.json({ ok: true, managers: rows });
});

/** 新增测评对象 */
app.post('/api/admin/managers', requireAdmin, (req, res) => {
  const name = normalizeName(req.body && req.body.name);
  if (!name) {
    return res.status(400).json({ ok: false, error: '请输入测评对象名称' });
  }
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM managers').get().m;
  const info = db
    .prepare('INSERT INTO managers (name, title, sort, active, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(name, '', maxSort + 1, nowIso());
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
    `SELECT s.manager_id, s.score, m.name AS manager_name
       FROM scores s JOIN managers m ON m.id = s.manager_id
      WHERE s.submission_id = ?`
  );
  const result = subs.map((sub) => {
    const scores = scoreStmt.all(sub.id);
    return {
      id: sub.id,
      name: sub.name,
      createdAt: sub.created_at,
      voidedAt: sub.voided_at,
      status: sub.voided_at ? '已作废' : '有效',
      scores,
    };
  });
  res.json({ ok: true, submissions: result });
});

/** 汇总排名（仅统计有效提交） */
function computeSummary() {
  const managers = db
    .prepare('SELECT id, name FROM managers ORDER BY sort ASC, id ASC')
    .all();
  const rows = managers.map((m) => {
    const agg = db
      .prepare(
        `SELECT COUNT(*) AS n, AVG(s.score) AS avg, MAX(s.score) AS max, MIN(s.score) AS min
           FROM scores s
           JOIN submissions sub ON sub.id = s.submission_id
          WHERE s.manager_id = ? AND sub.voided_at IS NULL`
      )
      .get(m.id);
    return {
      managerId: m.id,
      manager: m.name,
      count: agg.n || 0,
      avg: agg.n ? Number(agg.avg.toFixed(2)) : 0,
      max: agg.n ? agg.max : 0,
      min: agg.n ? agg.min : 0,
    };
  });
  // 按平均分降序排名
  rows.sort((a, b) => b.avg - a.avg);
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

app.get('/api/admin/summary', requireAdmin, (req, res) => {
  res.json({ ok: true, summary: computeSummary() });
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
  const managers = db
    .prepare('SELECT id, name FROM managers ORDER BY sort ASC, id ASC')
    .all();

  const subs = db.prepare('SELECT * FROM submissions ORDER BY id ASC').all();
  const scoreStmt = db.prepare('SELECT manager_id, score FROM scores WHERE submission_id = ?');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = '项目领导班子民主测评系统';
  workbook.created = new Date();

  // --- Sheet 1：原始明细 ---
  const detail = workbook.addWorksheet('原始明细');
  const detailColumns = [
    { header: '提交ID', key: 'id', width: 10 },
    { header: '姓名', key: 'name', width: 16 },
    { header: '状态', key: 'status', width: 10 },
    { header: '提交时间', key: 'createdAt', width: 22 },
    { header: '作废时间', key: 'voidedAt', width: 22 },
  ];
  managers.forEach((m) => detailColumns.push({ header: m.name, key: `m_${m.id}`, width: 18 }));
  detail.columns = detailColumns;

  subs.forEach((sub) => {
    const scores = scoreStmt.all(sub.id);
    const scoreMap = new Map(scores.map((s) => [s.manager_id, s.score]));
    const row = {
      id: sub.id,
      name: sub.name,
      status: sub.voided_at ? '已作废' : '有效',
      createdAt: formatDateTime(sub.created_at),
      voidedAt: sub.voided_at ? formatDateTime(sub.voided_at) : '',
    };
    managers.forEach((m) => {
      row[`m_${m.id}`] = scoreMap.has(m.id) ? scoreMap.get(m.id) : '';
    });
    detail.addRow(row);
  });
  detail.getRow(1).font = { bold: true };

  // --- Sheet 2：汇总统计 ---
  const summarySheet = workbook.addWorksheet('汇总统计');
  summarySheet.columns = [
    { header: '排名', key: 'rank', width: 8 },
    { header: '测评对象', key: 'manager', width: 24 },
    { header: '平均分', key: 'avg', width: 12 },
    { header: '最高分', key: 'max', width: 12 },
    { header: '最低分', key: 'min', width: 12 },
    { header: '有效人数', key: 'count', width: 12 },
  ];
  computeSummary().forEach((r) => {
    summarySheet.addRow({
      rank: r.rank,
      manager: r.manager,
      avg: r.avg,
      max: r.max,
      min: r.min,
      count: r.count,
    });
  });
  summarySheet.getRow(1).font = { bold: true };

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
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n项目领导班子民主测评系统已启动`);
  console.log(`  测评页：   http://localhost:${PORT}/`);
  console.log(`  管理后台： http://localhost:${PORT}/admin`);
  console.log(`  管理密码由环境变量 ADMIN_PASSWORD 配置${
    process.env.ADMIN_PASSWORD ? '' : '（当前为默认 admin123，请尽快修改）'
  }\n`);
});
