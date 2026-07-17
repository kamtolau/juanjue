'use strict';

/**
 * 数据库模块
 * 使用 Node.js 24 内置的 node:sqlite（免原生编译），首次运行自动创建
 * survey.db 与所需数据表，并把内置的 20 位测评对象名单写入 managers 表。
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = path.join(__dirname, 'survey.db');
const db = new DatabaseSync(DB_FILE);

// 提升并发写入稳定性 / 开启外键
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/**
 * 简单事务封装（node:sqlite 无 better-sqlite3 的 db.transaction）。
 * fn 抛错时回滚。
 */
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 建表
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS managers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT    NOT NULL,
  title     TEXT    DEFAULT '',
  sort      INTEGER NOT NULL DEFAULT 0,
  active    INTEGER NOT NULL DEFAULT 1,      -- 1 启用 / 0 停用
  group_key TEXT    NOT NULL DEFAULT 'leader', -- 问卷类别 leader / manager
  created_at TEXT   NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  group_key  TEXT    NOT NULL DEFAULT 'leader', -- 问卷类别 leader / manager
  created_at TEXT    NOT NULL,
  voided_at  TEXT                             -- 为空表示有效提交
);

CREATE TABLE IF NOT EXISTS scores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  manager_id    INTEGER NOT NULL,
  score         INTEGER NOT NULL,              -- 四个维度分之和（总分）
  d1            INTEGER,                        -- 团结协作
  d2            INTEGER,                        -- 专业素养
  d3            INTEGER,                        -- 执行落实力
  d4            INTEGER,                        -- 担当作为
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (manager_id)    REFERENCES managers(id)
);

CREATE INDEX IF NOT EXISTS idx_submissions_name   ON submissions(name);
CREATE INDEX IF NOT EXISTS idx_submissions_voided ON submissions(voided_at);
CREATE INDEX IF NOT EXISTS idx_scores_submission  ON scores(submission_id);
CREATE INDEX IF NOT EXISTS idx_scores_manager     ON scores(manager_id);
`);

// ---------------------------------------------------------------------------
// 迁移：为旧库补充 group_key 列（新库 CREATE 已含该列，此处兼容已有 survey.db）
// ---------------------------------------------------------------------------
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('managers', 'group_key', "group_key TEXT NOT NULL DEFAULT 'leader'");
ensureColumn('submissions', 'group_key', "group_key TEXT NOT NULL DEFAULT 'leader'");
// 四个维度分（团结协作 / 专业素养 / 执行落实力 / 担当作为），旧库补列
ensureColumn('scores', 'd1', 'd1 INTEGER');
ensureColumn('scores', 'd2', 'd2 INTEGER');
ensureColumn('scores', 'd3', 'd3 INTEGER');
ensureColumn('scores', 'd4', 'd4 INTEGER');

// group_key 列就绪后再建其索引
db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_group ON submissions(group_key);');

// ---------------------------------------------------------------------------
// 默认设置
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function getSetting(key, fallback = null) {
  const row = getSettingStmt.get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}

// 初始化默认值（仅当不存在时写入）
function initSetting(key, value) {
  if (getSettingStmt.get(key) === undefined) {
    setSettingStmt.run(key, String(value));
  }
}
initSetting('survey_open', '1');   // 1 开放 / 0 关闭
initSetting('public_url', '');     // 公网测评地址

// ---------------------------------------------------------------------------
// 内置测评对象名单（分两份问卷）
//   leader  —— 领导班子，7 人
//   manager —— 管理人员，13 人
// ---------------------------------------------------------------------------
const LEADER_NAMES = [
  '陈振成（项目经理）',
  '解泓立（党支部书记兼总工程师）',
  '储志坚（盾构副经理）',
  '吴珩（副经理）',
  '商圣帅（安全总监）',
  '孔杨（总会计师）',
  '孙博（总经济师）',
];

const MANAGER_NAMES = [
  '程玉鹏（物资部部长）',
  '卢娟（综合办主任）',
  '吕海鹏（实验室主任）',
  '翟建勇（掘进队长）',
  '侯平乾（盾构工区长）',
  '农成敏（安监部部长）',
  '赵振宇（工程部部长）',
  '郑原野（测量队队长）',
  '梁成（工区长）',
  '史超（工区长）',
  '马艺斐（财务部副部长）',
  '黄孝炜（盾构司机）',
  '秦珂（安监部）',
];

const managerCount = db.prepare('SELECT COUNT(*) AS n FROM managers').get().n;
if (managerCount === 0) {
  // 首次运行：写入内置名单
  const insert = db.prepare(
    'INSERT INTO managers (name, title, sort, active, group_key, created_at) VALUES (?, ?, ?, 1, ?, ?)'
  );
  transaction(() => {
    let sort = 0;
    LEADER_NAMES.forEach((name) => insert.run(name, '', ++sort, 'leader', nowIso()));
    MANAGER_NAMES.forEach((name) => insert.run(name, '', ++sort, 'manager', nowIso()));
  });
} else {
  // 已有库：按姓名把内置名单归位到对应问卷（幂等，兼容旧的 20 人单表）
  const setGroupByName = db.prepare('UPDATE managers SET group_key = ? WHERE name = ?');
  transaction(() => {
    LEADER_NAMES.forEach((name) => setGroupByName.run('leader', name));
    MANAGER_NAMES.forEach((name) => setGroupByName.run('manager', name));
  });
}

module.exports = {
  db,
  nowIso,
  getSetting,
  setSetting,
  transaction,
};
