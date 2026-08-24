# 腾讯云 SCF → 飞书多维表格 · 快速开始

把「网页表单/问卷/活动页」的提交实时写入「飞书多维表格」，服务器成本≈0（SCF 免费额度内），密钥只在服务端。

## 一、准备飞书（一次性，约 10 分钟）

1. 打开 [open.feishu.cn](https://open.feishu.cn) → 创建**企业自建应用**（独立应用，权限最小化）。
2. 「凭证与基础信息」复制 **App ID** + **App Secret**。
3. 「权限管理」搜"多维表格" → 勾 `bitable:app` + `bitable:record` 读写。
4. 「版本管理与发布」→ 创建版本 → 申请发布 → **管理员审核通过**（不发布权限不生效）。
5. 飞书客户端「多维表格」→ 新建空表 → 改名 → 复制链接。
   - ⚠️ API 创建的表不在"云文档"，在独立"多维表格"应用里；最稳是你**手动建空表**。
   - 从链接解析：`app_token` = `base/xxx` 的 `xxx`；`table_id` = `?table=yyy` 的 `yyy`。

记下 4 个值：**APP_ID / APP_SECRET / APP_TOKEN / TABLE_ID**。

## 二、三分钟跑通（本地联调）

```bash
cd <skill目录>/scripts
cp feishu_config.example.json feishu_config.json
# 编辑 feishu_config.json，填入上面 4 个值
node index.js          # 启动本地服务，端口 8080
```

用浏览器打开 `survey-template.html`，把脚本里的 `API_BASE` 改成 `http://localhost:8080`，填表提交 → 飞书表应出现一条记录。

## 三、配置你的字段

只改 `scripts/index.js` 里两处：

- **FIELD_MAP**：每题一行 `{ key, feishu, type }`，`key` 对应前端 `data-field`，`feishu` 是飞书列名，`type` ∈ `single`(单值)/`multi`(多选)/`number`(数字)/`json`(原始JSON)/`lines`(多行文本)。
- **REQUIRED_KEYS**：必填项的 `key` 列表。

飞书表需有对应列（手动建或调 API 建），列名 = FIELD_MAP 里的 `feishu`，再加固定运营列「提交时间」「跟进状态」。

## 四、部署到腾讯云 SCF（Web 函数）

> 详见 SKILL.md 的「SCF Web 函数 5 大坑」，必须全对。

1. 腾讯云 SCF 控制台 → 新建 → **Web 函数**（非事件函数）→ Node.js 18。
2. 把 `scripts/` 下三个文件打 zip：`index.js` + `feishu_config.json` + `scf_bootstrap`。
3. 上传 zip → 端口填 **9000** → 部署。
4. 复制函数**公网 HTTPS 地址**。
5. 前端 `survey-template.html` 的 `API_BASE` 换成该地址，部署前端到 CloudStudio/COS 即可。

## 五、常见变体

- **换一套问卷**：只改前端 HTML 内容 + FIELD_MAP + 飞书表列，管道层全复用。
- **验证手机号送优惠券**：在 `handleSubmit` 写主表成功后加发券逻辑（查重 + 落发券记录表 / 调你的券系统 API / 飞书通知），前端加手机号框 + 正则 `/^1[3-9]\d{9}$/`，主表加「手机号/是否已发券/发券时间」列。详见 SKILL.md 扩展 B。

## 六、分享给同事（复刻）

本 skill 是「装完即跑」的完整骨架。分享方式任选其一：

- **直发 zip**：把整个 `tencent-scf-fly-bitable/` 目录打包发给对方，对方解压到自己的 `~/.workbuddy/skills/` 即可。
- **GitHub 安装**：推到 GitHub 仓库，对方用 WorkBuddy 的「从 GitHub 安装技能」一键装。
- 对方只需按上面「一~四」用自己的飞书应用 + SCF 部署即可，**流程与代码零改写**。
