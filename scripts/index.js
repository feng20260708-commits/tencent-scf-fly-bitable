/**
 * 通用问卷后端 · Node.js 零依赖 · 兼容腾讯云 SCF Web 函数
 * 来自 skill：腾讯云SCF飞书多维表格部署
 *
 * 快速开始（详见 skill 内 README.md）：
 *  1. 复制 feishu_config.example.json → feishu_config.json，填入你的 4 个值
 *  2. 在下方 FIELD_MAP 按「问卷字段映射表」配置你的字段
 *  3. 本地联调：node index.js  （端口 8080，前端填 http://localhost:8080）
 *  4. 部署：连同 scf_bootstrap.sh 一起打包 zip 上传到 SCF Web 函数（端口 9000）；注意部署包里要把 scf_bootstrap.sh 改名成 scf_bootstrap（去扩展名）
 *
 * 前端把整份表单 POST 到 /api/submit，body 是 JSON（字段名 = payload key）
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============ 配置读取（同级 feishu_config.json 优先，环境变量兜底） ============
// 注意：必须用配置文件优先。本机若残留 FEISHU_APP_ID 等旧环境变量会污染部署，
// 打包到 SCF 时务必带 feishu_config.json，而不是靠环境变量。
const CONFIG_PATH = path.join(__dirname, 'feishu_config.json');
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch (e) { /* 无配置文件则用环境变量 */ }

const config = (fileCfg.app_id && fileCfg.app_secret && fileCfg.app_token && fileCfg.table_id)
  ? fileCfg
  : {
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
      app_token: process.env.FEISHU_APP_TOKEN,
      table_id: process.env.FEISHU_TABLE_ID,
    };

// ============ CORS 头（跨域调用，控制台无需另配 CORS） ============
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ============ HTTPS 请求（零依赖，兼容 Node 12+） ============
function httpsRequest(method, url, data, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {}),
    };
    if (data !== undefined) options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(data));
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
        catch (e) { reject(new Error('响应解析失败: ' + raw.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(JSON.stringify(data));
    req.end();
  });
}

// ============ 飞书 tenant_access_token 缓存（2h，提前1min刷新） ============
let tokenCache = { token: null, expireAt: 0 };
async function getTenantToken() {
  if (tokenCache.token && Date.now() < tokenCache.expireAt - 60000) return tokenCache.token;
  const res = await httpsRequest('POST', 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: config.app_id, app_secret: config.app_secret,
  });
  if (res.json.code !== 0) throw new Error('获取飞书 token 失败: ' + res.json.msg);
  tokenCache.token = res.json.tenant_access_token;
  tokenCache.expireAt = Date.now() + res.json.expire * 1000;
  return tokenCache.token;
}

// ============ 写入多维表格 ============
async function writeRecordToBitable(fields) {
  const token = await getTenantToken();
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.app_token}/tables/${config.table_id}/records`;
  const res = await httpsRequest('POST', url, { fields }, { Authorization: 'Bearer ' + token });
  if (res.json.code !== 0) throw new Error('写入多维表格失败: ' + res.json.msg + ' | ' + JSON.stringify(res.json.error || ''));
  return res.json.data.record;
}

// ============ ↓↓↓ 你只需改这里：字段映射 + 必填项 ↓↓↓ ============

// 按你的《问卷字段映射表》配置。type 取值：
//   'single' -> 单值（文本/单选/数字字符串，统一存文本）
//   'multi'  -> 多选（数组）
//   'number' -> 数字（解析失败存 0）
//   'json'   -> 原始 JSON 原文（建议每条问卷都存一份，便于回溯）
//   'lines'  -> 多行易读文本（见下方 formatLines，适合流程表/评分矩阵等动态结构）
const FIELD_MAP = [
  { key: 'company_name',  feishu: '企业名称', type: 'single' },
  { key: 'contact_phone', feishu: '联系电话', type: 'single' },
  { key: 'tags',          feishu: '需求标签', type: 'multi'  },
  // 按需增删，例如：
  // { key: 'budget',    feishu: '预算区间', type: 'single' },
  // { key: 'headcount', feishu: '团队人数', type: 'number' },
  // { key: 'raw',       feishu: '原始数据(JSON)', type: 'json' },
];

// 必填校验：填 payload 的 key，缺了返回错误
const REQUIRED_KEYS = ['company_name', 'contact_phone'];

// 固定运营字段（每次提交自动带，飞书表需有对应列）
const OP_FIELDS = {
  '提交时间': () => Date.now(),
  '跟进状态': () => '待联系',
};

// ============ ↑↑↑ 字段配置结束 ↑↑↑ ============

function pickSingle(payload, key) {
  const v = payload[key];
  if (Array.isArray(v)) return v.length ? v[0] : '';
  return v || '';
}
function pickMulti(payload, key) {
  const v = payload[key];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) return [v];
  return [];
}

// 把对象数组拼成易读多行文本，labels=[{key,label}]
function formatLines(arr, labels) {
  if (!Array.isArray(arr) || !arr.length) return '未填写';
  return arr.map((o) => labels.map((l) => `${l.label}: ${o[l.key] ?? '-'}`).join('｜')).join('\n');
}

function buildFields(payload) {
  const fields = {};
  for (const [name, fn] of Object.entries(OP_FIELDS)) fields[name] = fn();
  for (const m of FIELD_MAP) {
    if (m.type === 'multi') {
      fields[m.feishu] = pickMulti(payload, m.key);
    } else if (m.type === 'number') {
      const n = Number(payload[m.key]);
      fields[m.feishu] = isNaN(n) ? 0 : n;
    } else if (m.type === 'json') {
      fields[m.feishu] = JSON.stringify(payload[m.key] ?? payload);
    } else if (m.type === 'lines') {
      fields[m.feishu] = formatLines(payload[m.key], m.labels || []);
    } else {
      fields[m.feishu] = pickSingle(payload, m.key); // single 及其它默认单值文本
    }
  }
  return fields;
}

function validate(payload) {
  return REQUIRED_KEYS.filter((k) => !payload[k] || (Array.isArray(payload[k]) && payload[k].length === 0));
}

// ============ 统一处理入口 ============
async function handleSubmit(payload) {
  const missing = validate(payload);
  if (missing.length) return { ok: false, error: '缺少必填项: ' + missing.join(', ') };
  try {
    const fields = buildFields(payload);
    const record = await writeRecordToBitable(fields);
    return { ok: true, recordId: record.record_id, message: '提交成功，已写入多维表格' };
  } catch (e) {
    console.error('[submit] 写入失败:', e.message);
    return { ok: false, error: e.message };
  }
}

// ============ 本地 HTTP 服务（联调 + Web 函数容器模式） ============
function startLocalServer(port = 8080) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'POST' && req.url === '/api/submit') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const result = await handleSubmit(payload);
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '请求解析失败: ' + e.message }));
        }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Not Found' }));
  });
  // Web 函数规范：0.0.0.0 监听，PORT 由平台注入（默认 9000）
  server.listen(port, '0.0.0.0', () => console.log(`[server] 已启动: 0.0.0.0:${port}`));
}

// ============ 腾讯云 SCF 入口（入口名必须 main_handler） ============
async function main_handler(event, context) {
  const method = event.httpMethod || (event.requestContext && event.requestContext.http && event.requestContext.http.method);
  if (method === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  try {
    let payload;
    if (typeof event === 'string') payload = JSON.parse(event);
    else if (event.body) payload = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    else payload = event;
    const result = await handleSubmit(payload);
    return {
      statusCode: result.ok ? 200 : 400,
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS),
      body: JSON.stringify(result),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS),
      body: JSON.stringify({ ok: false, error: e.message }),
    };
  }
}

exports.main_handler = main_handler;
exports.main = main_handler; // 兼容别名

if (require.main === module) startLocalServer(parseInt(process.env.PORT || '8080', 10));
