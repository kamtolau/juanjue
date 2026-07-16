# 项目领导班子民主测评系统

用于项目内部人员通过手机微信，对项目领导班子成员进行民主测评。支持姓名查重、滑块打分、分数唯一校验、后台汇总统计、提交作废、Excel 导出与二维码发布。

## 技术栈

- Node.js 24+
- Express
- SQLite（Node 24 内置 `node:sqlite`，免原生编译）
- 原生 HTML / CSS / JavaScript
- exceljs（Excel 导出）
- qrcode（二维码生成）

## 目录结构

```
├── server.js          后端服务（API、鉴权、Excel、二维码）
├── db.js              数据库初始化与内置名单
├── package.json
├── .env.example       环境变量样例
├── survey.db          运行后自动生成（勿提交）
└── public/
    ├── index.html     测评页
    ├── app.js         测评页逻辑
    ├── admin.html     管理后台
    ├── admin.js       后台逻辑
    ├── admin.css      后台样式
    └── style.css      公共样式
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

> 数据库使用 Node 24 内置的 `node:sqlite`，**无需 C++ 编译环境**，`npm install`
> 只安装 express / exceljs / qrcode 三个纯 JS 依赖。

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并修改：

```
PORT=3000
ADMIN_PASSWORD=你的后台密码
```

`ADMIN_PASSWORD` 未设置时默认为 `admin123`，**生产环境务必修改**。

### 3. 启动

```bash
npm start
```

启动后：

- 测评页：<http://localhost:3000/>
- 管理后台：<http://localhost:3000/admin>

首次运行会自动生成 `survey.db` 并写入内置 20 位测评对象名单。

## 核心页面

### 测评页（两份独立问卷）

- 领导班子问卷：`/leader`（陈振成、解泓立、储志坚、吴珩、商圣帅、孔杨、孙博 共 7 人）
- 管理人员问卷：`/manager`（程玉鹏等 13 人）
- 根路径 `/` 为入口选择页，可点击进入任一问卷。

两份问卷相互独立：**同一姓名在 `/leader` 和 `/manager` 各能提交一次**，各自独立作废、独立统计，相当于填两份问卷。

流程：

1. 填写人先输入姓名，系统核验该姓名在**本问卷**下是否已有有效提交。
2. 未提交过才可进入；已提交过不可重复进入。
3. 姓名输入页底部提示：姓名仅用于校验是否公司员工，不泄露个人评分。
4. 进入后顶部显示「测评参考」（团结协作、专业素养、执行落实力、担当作为）。
5. 每位测评对象通过横向滑块打 0-100 分，**每个分数在同一份测评中只能使用一次**。
6. 有未评分对象时提交会自动滚动定位并高亮；有重复分数时前端提示并阻止提交。
7. 后端再次校验分数完整性、范围与唯一性。
8. 提交成功后只显示成功提示。

### 管理后台 `/admin`

- 使用 `ADMIN_PASSWORD` 登录。
- 测评控制：开放/关闭测评、设置站点根地址、**分别生成两份问卷的二维码**、导出 Excel、清空数据。
- 汇总排名：两份问卷分别按平均分组内排名，仅统计有效提交。
- 提交明细：查看每条提交（含问卷类别标签）与各对象分数，可**作废**某条提交。
- 对象管理：按问卷分组展示，新增对象时选择所属问卷、修改名称、停用/启用。

## 重复提交规则

- 按**姓名**判断是否重复。
- `submissions.voided_at` 为空表示有效提交。
- 同一姓名只允许存在一条有效提交。
- 后台作废后写入 `voided_at`，该姓名可重新提交；作废记录不参与汇总统计。

## Excel 导出

导出文件含两个 sheet：

- **原始明细**：提交 ID、姓名、状态（有效/已作废）、提交时间、作废时间、各测评对象分数。
- **汇总统计**：排名、测评对象、平均分、最高分、最低分、有效人数。

## 数据库

SQLite，运行后自动生成 `survey.db`，主要数据表：

| 表 | 说明 |
| --- | --- |
| `settings` | 测评开放状态、公网地址等 |
| `managers` | 测评对象名单 |
| `submissions` | 提交记录（含作废时间） |
| `scores` | 评分明细 |

## 生产部署（可选）

### PM2 后台常驻

```bash
npm install -g pm2
pm2 start server.js --name juanjie --env production
pm2 save
pm2 startup
```

设置环境变量（示例）：

```bash
pm2 start server.js --name juanjie --update-env
# 或在启动前 export ADMIN_PASSWORD=xxx PORT=3000
```

### Nginx 反向代理 + HTTPS（示例）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

配置 HTTPS 后，在后台「公网地址」填写 `https://your-domain.com/` 并生成二维码，
供参评人微信扫码填写。

## 注意事项

- 微信内打开需保证公网地址可访问、建议启用 HTTPS。
- 管理员登录令牌保存在服务端内存，服务重启后需重新登录。
- `survey.db` 为数据文件，注意备份，勿提交至版本库。
