---
name: 腾讯云SCF飞书多维表格部署
slug: tencent-scf-fly-bitable
displayName: 腾讯云SCF飞书多维表格部署
version: 1.0.0
description: 把网页问卷/活动页的提交数据写入飞书多维表格的标准部署工作流。当用户要做"表单/问卷/活动页 → 服务器接收 → 飞书多维表格实时落库 → 团队在飞书跟进"这类需求时使用，尤其适用于换问卷形式、验证手机号送优惠券等变体。涵盖飞书应用申请、SCF Web函数部署（含5大坑）、零依赖Node后端、前端fetch提交、联调验证全链路。
agent_created: true
---

# 腾讯云 SCF → 飞书多维表格 部署工作流

把「网页提交」接通到「飞书多维表格」，服务器成本≈0（SCF 免费额度内），密钥只存服务端。

## 何时用
- 网页问卷/活动页收集数据，要实时进飞书表
- 换一套问卷（只改内容层）
- 活动页加「验证手机号送优惠券」
- 任何「前端表单 → 结构化落表 → 团队跟进」场景

## 架构
```
客户浏览器 → 问卷页 → POST /api/submit → 腾讯云 SCF 云函数 → 飞书 API → 飞书多维表格
```
密钥只在服务端，网页看不到。

## 阶段 0-1：问卷设计 + 字段映射表
- 每题动手前定好「对应飞书哪个字段、什么类型」
- 映射表决定后端 buildFields 和飞书建表
- 题型→飞书字段：填空/单选/数字→文本/单选/数字；多选→多选（带选项）；表格/矩阵→多行文本(易读)+原始JSON(两列)；另加 提交时间/跟进状态/跟进备注 运营字段
- 动态结构（流程表、评分矩阵）**不要逐列建字段**，存「易读文本 + JSON 原文」两列

## 阶段 2：飞书准备（一次性）
1. `open.feishu.cn` → 创建企业自建应用（独立应用，别复用个人CLI，权限最小化）
2. 凭证与基础信息 → 复制 App ID + App Secret
3. 权限管理 → 搜"多维表格" → 勾 `bitable:app` + `bitable:record` 读写
4. 版本管理与发布 → 创建版本 → 申请发布 → **管理员审核通过（不发布权限不生效）**
5. 建多维表格：飞书客户端「多维表格」→ 新建空表 → 改名 → 复制链接（**API创建的表不显示在"云文档"，在独立"多维表格"应用里**，最稳是你手动建空表）
6. 从链接解析 `app_token`（base/后）+ `table_id`（?table=后）
- 交付 4 个值：APP_ID / APP_SECRET / APP_TOKEN / TABLE_ID

## 阶段 3：后端（Node.js 零依赖，兼容 SCF）
核心 4 块：`config`（凭证，配置文件优先）、`getTenantToken()`（2h缓存提前1min刷新）、`buildFields()`（JSON→飞书字段）、`main_handler`（SCF入口）+ `writeRecordToBitable()`。

**⚠️ SCF Web 函数部署 5 大坑（踩过，必须全对）：**
1. 缺 `scf_bootstrap` 启动文件 → `exec format error`
2. 启动命令必须用**绝对路径**：Node18=`/var/lang/node18/bin/node`
3. 监听端口必须 **9000** 且地址 **0.0.0.0**（非8080）
4. 入口函数名必须 `main_handler`（控制台执行方法 index.main_handler）
5. 凭证用**配置文件优先、环境变量兜底**（本机残留的旧 FEISHU_APP_ID 会污染环境变量，必须用 zip 内 feishu_config.json）

`scf_bootstrap` 内容（zip内，权限755，LF换行）：
```bash
#!/bin/bash
export PORT=9000
/var/lang/node18/bin/node index.js
```

`index.js` 关键：
```js
const config = (fileCfg.app_id && fileCfg.app_secret && fileCfg.app_token && fileCfg.table_id)
  ? fileCfg : { app_id: process.env.FEISHU_APP_ID, ... };  // 配置文件优先
server.listen(port, '0.0.0.0', ...);  // PORT 由平台注入，默认9000
exports.main_handler = async (event, context) => { /* OPTIONS预检 + POST处理 */ };
```

CORS 在代码里返回即可（`Access-Control-Allow-Origin: *`），**控制台不用配 CORS**（配了反而易报错）。

## 阶段 4：前端改造（3件事）
1. `var API_BASE = 'https://云函数公网HTTPS地址'`（联调填 http://localhost:8080）
2. 每题用 `name`/`data-field` 标识，写 `collectData()` 序列化成 JSON
3. `fetch(API_BASE + '/api/submit', {method:'POST', body: JSON.stringify(data)})` → 成功/失败页
样式交互不动，只加采集+fetch+反馈三段。

## 阶段 5：打包部署
- zip 含 `index.js` + `feishu_config.json`（密钥）+ `scf_bootstrap`（755）
- 腾讯云 SCF 控制台 → 新建 → **Web 函数**（不是事件函数，事件函数的API网关触发常灰着）→ Node.js 16/18 → 上传zip → 端口9000 → 部署
- 函数URL → 复制**公网HTTPS**地址
- 问卷静态页部署到 CloudStudio/COS → 前端 API_BASE 换成云函数地址

## 阶段 6：联调验证
- OPTIONS 返回 204 + CORS头（跨域OK）
- POST 返回 `{"ok":true,"recordId":"rec..."}`（写飞书成功）
- 飞书表查记录字段完整（多选数组/数字/JSON都在）
- 清理测试数据

## 扩展 A：换问卷
只改内容层：① 问卷HTML（保持name/data-field+collectData）② 重画字段映射表 ③ 改 buildFields 字段名（飞书表增删列用API或手动）。管道层全复用。

## 扩展 B：验证手机号送优惠券
后端加 3 块（管道不动）：
```js
async function hasReceived(phone){ /* 查飞书发券记录表是否已发 */ }
async function grantCoupon(phone, payload){
  // 方案A：落「发券记录表」+飞书通知（零依赖立即可用）
  // 方案B：调用你的优惠券系统API（替换此行）
  // 方案C：发短信/飞书消息给客户
}
// handleSubmit 写主表成功后：
if (payload.phone && !await hasReceived(payload.phone)) await grantCoupon(payload.phone, payload);
```
前端加手机号框 + 正则 `/^1[3-9]\d{9}$/` 校验。主表加字段：手机号/是否已发券/发券时间。防刷：格式校验 + 手机号去重 + 可选限流。

## 代码骨架（skill 自带，装完即用）

本 skill 已内置可直接部署的骨架，无需外部文件：

- `scripts/index.js` —— 通用后端（数据驱动 **FIELD_MAP**，改字段映射即适配新问卷，零依赖兼容 SCF）
- `scripts/scf_bootstrap` —— Web 函数启动文件（PORT=9000 + 绝对 node 路径）
- `scripts/feishu_config.example.json` —— 脱敏配置样例（复制成 `feishu_config.json` 填 4 个值）
- `scripts/survey-template.html` —— 前端采集模板（`collectData()` + `fetch` 提交 + 手机号正则示例）
- `README.md` —— 5 分钟快速开始 + 字段配置 + 部署 + 分享

**复刻路径**：同事装上本 skill → 按 README「一~四」用自己的飞书应用 + SCF 部署 → 流程与代码零改写即可运行。
分享方式：① 打包整个目录发对方解压到 `~/.workbuddy/skills/`；② 推 GitHub 让对方用「从 GitHub 安装技能」一键装。
