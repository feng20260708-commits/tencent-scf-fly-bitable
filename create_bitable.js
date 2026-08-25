#!/usr/bin/env node
/**
 * create_bitable.js — 自动建多维表格 + 自动授权「组织内可编辑」
 *
 * 解决的痛点：
 *   用应用身份(tenant_access_token)建表，表归【应用】所有，创建者个人默认只有阅读权。
 *   点「申请编辑」会发给机器人且无审批入口 → 永远收不到通知。本脚本建表后立刻把表设为
 *   「组织内获得链接的人可编辑」，你刷新飞书即可编辑，彻底避免所有权错位。
 *
 * 前置权限（开放平台→权限管理，开通后必须「版本管理与发布」才生效）：
 *   - bitable:app                      （建多维表格）
 *   - bitable:record                   （写记录，原 skill 已要求）
 *   - docs:permission.setting:write_only （设置文档权限，本脚本新增，最小权限即可）
 *
 * 用法：
 *   cp feishu_config.example.json feishu_config.json   # 填 APP_ID / APP_SECRET
 *   node create_bitable.js --name "2026汽车潜客问卷"
 *   node create_bitable.js --name "教培回访表" --fields "姓名:text,手机号:phone,意向:single,提交时间:date"
 *
 * 说明：--fields 仅快速建列；复杂字段（带选项的单选/多选、公式等）建议在飞书手动补。
 *       建列失败不致命，主流程（建 base + 设可编辑）必须成功。
 */
const fs = require('fs');
const path = require('path');

const FEISHU = 'https://open.feishu.cn';

// ---------- 配置加载（配置文件优先，环境变量兜底） ----------
function loadConfig() {
  const p = path.join(__dirname, 'feishu_config.json');
  let file = {};
  if (fs.existsSync(p)) {
    try { file = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.warn('feishu_config.json 解析失败:', e.message); }
  }
  const cfg = {
    app_id: file.app_id || process.env.FEISHU_APP_ID,
    app_secret: file.app_secret || process.env.FEISHU_APP_SECRET,
  };
  if (!cfg.app_id || !cfg.app_secret) {
    console.error('❌ 缺少 App ID / App Secret。请复制 feishu_config.example.json 为 feishu_config.json 并填写，或设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET。');
    process.exit(1);
  }
  return cfg;
}

// ---------- tenant_access_token（2h 缓存，提前 1min 刷新） ----------
let _tok = null, _exp = 0;
async function getToken() {
  const now = Date.now();
  if (_tok && now < _exp) return _tok;
  const r = await fetch(`${FEISHU}/open-apis/auth/v3/app_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: CFG.app_id, app_secret: CFG.app_secret }),
  }).then((x) => x.json());
  if (r.code !== 0) throw new Error('获取 tenant_access_token 失败: ' + JSON.stringify(r));
  _tok = r.tenant_access_token;
  _exp = now + (r.expire - 60) * 1000;
  return _tok;
}

async function api(method, urlPath, body) {
  const tok = await getToken();
  const r = await fetch(FEISHU + urlPath, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((x) => x.json());
  return r;
}

// ---------- 建多维表格（整个 base） ----------
async function createApp(name) {
  const r = await api('POST', '/open-apis/bitable/v1/apps', { name });
  if (r.code !== 0) throw new Error('创建多维表格失败: ' + JSON.stringify(r));
  return r.data.app; // { app_token, default_table_id, folder_token, name, url }
}

// ---------- 字段类型映射 ----------
const TYPE = { text: 1, number: 2, single: 3, multi: 4, date: 5, checkbox: 6, phone: 13, url: 15, user: 11 };

function parseFields(arg) {
  if (!arg) return [];
  return arg.split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [name, type] = pair.split(':').map((x) => x.trim());
    if (!name) return null;
    return { name, type: TYPE[type] ? type : 'text' };
  }).filter(Boolean);
}

async function addFields(appToken, tableId, fields) {
  for (const f of fields) {
    const body = { field_name: f.name, type: TYPE[f.type] || 1 };
    if (f.type === 'single' || f.type === 'multi') {
      // 单选/多选给一组默认选项占位，后续可在飞书调整
      body.property = { options: [{ name: '选项一' }, { name: '选项二' }] };
    }
    const r = await api('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, body);
    if (r.code !== 0) console.warn(`  ⚠️ 字段「${f.name}」创建失败（可忽略，去飞书手动加）: ${JSON.stringify(r).slice(0, 160)}`);
    else console.log(`  ✅ 字段「${f.name}」(${f.type})`);
  }
}

// ---------- 关键：建表后立即授权「组织内可编辑」 ----------
async function setOrgEditable(appToken) {
  const r = await api('PATCH', `/open-apis/drive/v1/permissions/${appToken}/public?type=bitable`, {
    link_share_entity: 'tenant_editable',
  });
  if (r.code !== 0) {
    throw new Error('设置「组织内可编辑」失败。多为缺少权限或未发布：请在开放平台开通 docs:permission.setting:write_only 并重新发布。详情: ' + JSON.stringify(r).slice(0, 200));
  }
  return r;
}

// ---------- 参数解析 ----------
function getArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}

// ---------- 主流程 ----------
const CFG = loadConfig();
(async () => {
  const name = getArg('--name') || '问卷数据表';
  const fields = parseFields(getArg('--fields'));
  console.log(`\n🚀 创建多维表格「${name}」...`);
  const app = await createApp(name);
  console.log(`   app_token  = ${app.app_token}`);
  console.log(`   table_id   = ${app.default_table_id}`);
  console.log(`   链接       = ${app.url}`);

  if (fields.length) {
    console.log('\n📋 建字段...');
    await addFields(app.app_token, app.default_table_id, fields);
  }

  console.log('\n🔓 授权「组织内获得链接的人可编辑」（解决表归应用、个人不能编辑的问题）...');
  await setOrgEditable(app.app_token);

  console.log('\n✅ 完成！刷新飞书即可编辑该表。');
  console.log('   下一步：把下面两行填进 feishu_config.json 的 APP_TOKEN / TABLE_ID，再跑 index.js 接收问卷：');
  console.log(`   APP_TOKEN="${app.app_token}"`);
  console.log(`   TABLE_ID="${app.default_table_id}"`);
  console.log(`   链接: ${app.url}\n`);
})().catch((e) => { console.error('\n❌', e.message); process.exit(1); });
