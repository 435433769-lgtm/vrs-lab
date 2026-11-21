# VRS Lab

一个非官方的 Counter-Strike 2 **Valve 区域排名（VRS）** 交互浏览器。

它把 Valve 公布的 Markdown 快照转换成易读的分数拆解：四个种子因子、交手调整、每一场计入的比赛、赛事奖金以及排名历史。本站**不会**重新计算排名。

## 项目状态

静态原型，无需构建步骤，也不依赖前端框架。可选的本地 Python 服务会在 Valve 发布新的月度快照时自动更新数据。界面支持**中英文切换**，默认按浏览器语言选择；本文档以中文为主。

- `index.html` — 页面外壳
- `styles.css` — 设计系统
- `app.js` — 路由、渲染、图表（Hash 路由：`#/`、`#/team/:id`、`#/compare`、`#/methodology`）
- `data.js` — 生成的数据包（约 6.5 MB）
- `data/meta.json` — 构建元数据（`latestDate`、`builtAt`、队伍数等），供更新服务和页面读取
- `scripts/build_data.py` — 数据管线
- `scripts/validate_data.py` — 数值不变量校验
- `scripts/dev_server.py` — 本地服务：静态文件白名单、实时更新 API、自动重建
- `deploy/` — 一键部署、更新、安全检查脚本，systemd 服务，Nginx 配置

## 功能

- 排名页：区域标签、快照选择、排序、战队/选手搜索、排名变动、迷你走势图，以及四因子概览。
- 战队页：分数瀑布图、因子卡片、阵容历史与同名战队历史、官方详情文件中的全部比赛。
- **2–4 个阵容**的多队对比：因子雷达图、逐因子条形图、分数公式、共同对手、交手矩阵和多线排名图。对比结果可通过 `#/compare?t=id1,id2,…` 分享。
- 区域排名表上的 Major 晋级线，使用最近一次公布的名额分配（Winter 2025）。
- 方法说明页，明确区分官方数据与本站自己的可视化。
- **中英文切换**：右上角 `EN` / `中文` 按钮即时切换，选择会保存在浏览器；也可以用 `?lang=zh` 或 `?lang=en` 直接打开指定语言。

## 运行

```powershell
python scripts/dev_server.py --port 5173
# 然后打开 http://127.0.0.1:5173/
```

`dev_server.py` 只为公开页面文件提供访问，并给 HTML 和 `data/meta.json` 设置 `no-cache`，静态资源则按文件修改时间追加 `?v=`，因此修改后刷新即可生效。直接用 `python -m http.server 5173 --bind 127.0.0.1` 也能打开页面，但浏览器可能缓存旧的 `data.js` / `app.js`，而且不会自动更新。

## 部署上线（腾讯云轻量 · 香港）

推荐配置：**腾讯云轻量应用服务器，中国香港，Ubuntu 22.04，1 核 1G / 20GB SSD / 30Mbps**。香港节点不需要 ICP 备案，买完即可用公网 IP 访问；30Mbps 带宽能让约 6.5MB 的 `data.js` 在几秒内完成首次加载。活动价大约 24–35 元/月，年付约 300–400 元。

### 1. 购买与放行端口

1. 注册腾讯云并完成实名认证，进入“轻量应用服务器” → 新建。
2. 地域选“中国香港”，镜像选 **Ubuntu Server 22.04 LTS 64bit**，套餐选 1 核 1G。
3. 设置 root 密码，记下公网 IP。
4. 在轻量控制台 → 服务器 → 防火墙，放行 **TCP 22、80、443**。

### 2. 准备域名（可选，但推荐）

在域名服务商处添加一条 **A 记录**，例如：

| 主机记录 | 记录类型 | 记录值 |
| --- | --- | --- |
| `vrs` | A | 你的服务器公网 IP |

如果使用 Cloudflare，申请证书期间必须把代理状态设为 **仅 DNS（灰云）**，否则 Let's Encrypt 验证会失败。证书签发成功后再决定是否开启代理。

### 3. 一键安装

在腾讯云控制台点“登录”，打开网页终端（OrcaTerm），或用 PowerShell：

```powershell
ssh root@你的公网IP
```

然后执行：

```bash
# 安装 git 并拉取代码（推荐）
sudo apt-get update
sudo apt-get install -y git
sudo git clone --depth 1 https://gitee.com/little-tiger-tooth12/vrs-lab.git /opt/vrs

# 有域名：自动申请 Let's Encrypt 证书并开启 HTTPS
sudo bash /opt/vrs/deploy/setup.sh --domain vrs.example.com --email you@example.com

# 没有域名：只启用 HTTP，用公网 IP 访问
sudo bash /opt/vrs/deploy/setup.sh
```

如果 `/opt/vrs` 已经存在，`setup.sh` 会自动拉取最新代码并保留服务器上已经构建好的新快照，不需要手动删除目录。

脚本会自动完成：

- 安装 `git`、`python3`、`nginx`、`certbot`；
- 创建专用运行用户 `vrs`，把仓库拉取到 `/opt/vrs`；
- 写入并启动 `vrs.service`（开机自启、崩溃自动重启）；
- 写入 Nginx 站点（gzip、静态资源长缓存、API 反向代理、`/api/check` 限流）；
- 有域名时运行 `certbot --nginx` 申请证书并强制跳转 HTTPS；
- 做一次本地健康检查，失败时打印服务日志。

### 4. 验证

```bash
systemctl status vrs --no-pager
curl http://127.0.0.1:5173/api/meta
```

浏览器打开 `https://你的域名/` 或 `http://你的公网IP/`，侧边栏应显示绿色的“已同步 · 11月2日”。点击状态按钮可手动检查更新（有 60 秒冷却）。如果证书申请失败，先确认 DNS 已生效、Cloudflare 代理已关闭、80/443 已放行，然后重试：

```bash
sudo certbot --nginx -d vrs.example.com --redirect
```

### 4.1 安全检查

部署完成后可以跑一次基础安全检查：

```bash
sudo bash /opt/vrs/deploy/security-check.sh

# 已经启用 HTTPS 时，检查线上域名
BASE=https://vrs.example.com sudo bash /opt/vrs/deploy/security-check.sh
```

脚本会检查：

- `vrs`、Nginx 是否运行，`5173` 是否只监听本机；
- 首页、`data.js`、`data/meta.json`、`/api/meta` 是否正常；
- `.git`、`scripts/`、`data/raw/`、`deploy/`、`README.md` 是否返回 404；
- `/api/check` 限流、缓存头、gzip、数据包大小一致性；
- Git remote 是否含明文令牌、`.git/config` 权限、磁盘使用率。

它不会修改配置，但会触发一次正常的更新检查。最后会给出 `[OK]`、`[WARN]`、`[FAIL]` 汇总；有 `[FAIL]` 时按提示处理即可。

### 5. 自动更新怎么工作

服务器上的 `dev_server.py` 由 systemd 常驻，每小时检查一次 Valve 官方仓库。只有发现比本地更新的快照日期时才重新构建；`data.js` 和 `data/meta.json` 使用临时文件 + 原子替换，访问者不会下载到半个文件。已打开的页面每 60 秒查询一次 `/api/meta`，发现新的 `builtAt` 后热切换到新数据包，不需要手动操作。

如果 `/api/meta` 不可用，前端会退回到静态 `data/meta.json`（每 5 分钟检查一次）。因此以后即使改成“Nginx 静态托管 + 定时构建”，页面仍然能自动发现新快照。

### 6. 日常维护

```bash
# 更新代码并重启
sudo bash /opt/vrs/deploy/update.sh

# 如果本次更新修改了 deploy/nginx.conf，再运行一次部署脚本让 Nginx 配置生效
sudo bash /opt/vrs/deploy/setup.sh --domain vrs.example.com --email you@example.com

# 重启 / 查看状态
sudo systemctl restart vrs
systemctl status vrs --no-pager

# 查看运行日志与最近一次构建日志
journalctl -u vrs -n 100 --no-pager
tail -n 50 /opt/vrs/data/update.log

# Nginx 日志
tail -n 50 /var/log/nginx/access.log
tail -n 50 /var/log/nginx/error.log
```

腾讯云控制台还支持给服务器做快照备份，建议在修改配置前手动打一个快照。当前数据包和历史快照都保存在 `/opt/vrs`，`data/raw/` 是可重新下载的缓存。

### 7. 安全与成本

- Python 服务只监听 `127.0.0.1:5173`，公网只能通过 Nginx 访问；
- 只公开 `index.html`、`app.js`、`styles.css`、`data.js`、`data/meta.json`、`favicon.ico`，`.git`、`scripts/`、`data/raw/` 不会被下载；
- `POST /api/check` 同时受 Nginx 限流和应用内 60 秒冷却保护；
- 服务器约 300–400 元/年，域名约 10–30 元/年，HTTPS 免费。

## 实时更新

本地或服务器上的服务默认每 1 小时检查一次 Valve 官方仓库（可用 `--interval` 调整，最低 60 秒）。发现更新的快照日期时，它会运行 `scripts/build_data.py` 并原子写入 `data.js` 与 `data/meta.json`；已打开的页面会检测到新的 `builtAt`，并在不整页刷新的情况下热切换到新的 `data.js`。

- `GET /api/meta` — 构建元数据与更新状态（`checking`、`building`、`lastCheck`、`remoteLatest`、`lastError`）
- `POST /api/check` — 立即触发一次检查（同一 IP 60 秒内只接受一次）
- 侧边栏状态按钮 — 点击可手动检查；绿色表示已同步，橙色表示正在检查或重建，灰色表示没有找到更新信息
- `data/update.log` — 最近一次自动重建的输出日志
- `--no-watch` — 只提供静态文件，不检查、不重建

检查失败后会在 5 分钟后重试；正常检查则等待配置的间隔。如果页面以纯静态方式托管（Gitee Pages、`python -m http.server`），前端会尝试读取静态 `data/meta.json`，侧边栏显示“静态托管”，并继续使用上一次生成的 `data.js`；要发布新月份，需要重新构建并重新部署，或者用定时任务更新 `data.js` 和 `data/meta.json`。

## 重建数据

```powershell
python scripts/build_data.py
python scripts/validate_data.py
```

数据管线通过 jsDelivr CDN 读取官方仓库（部分网络无法访问 raw.githubusercontent）。所有下载的文件都会缓存在 `data/raw/` 下，因此重复运行很快，也能离线工作。删除 `data/raw/` 可强制重新下载。

快照覆盖范围为 2024-08-06 → 2026-11-02（共 48 个快照）。只有最新快照会解析完整的比赛详情；更早的快照用于排名历史。

## 数据模型

| 概念 | 定义 |
| --- | --- |
| 阵容 ID | `sha1(排序后的小写选手昵称)`，前缀为 `r`。阵容变动会产生新的实体。 |
| 战队趋势 | 按规范化队名聚合的排名序列，仅用于可视化，不代表身份。 |
| 积分 | 排名表中显示的整数。 |
| 最终排名分 | 详情文件中的小数；`积分 ≈ round(最终排名分)`。 |

阵容由选手集合而非俱乐部名称识别，因为 VRS 本身以阵容为基础。因此出现同名战队（`OG`、`Sashi`、`BRUTE` 等）是正常现象，它们会被区分对待。

## 校验

`scripts/validate_data.py` 会对最新快照检查：

- `final == starting + h2h`（容差 0.15）
- `因子平均值 == 四个因子的均值`（容差 0.002）
- `积分 ≈ final`（容差 0.5，因为详情页只保留一位小数）
- 区域总数、重复阵容键、阵容人数、历史覆盖情况

当前结果：376/376 支战队通过全部三项数值不变量；欧洲 244 / 美洲 87 / 亚洲 45。

## 晋级线

`data/qualification.json` 保存了唯一一次官方公布的 Major 名额分配（CS Major 补充规则手册中的 Winter 2025 表）。它会作为 `payload.qualification` 嵌入数据包，并渲染为：

- 区域排名表中的虚线 **第三阶段 / 第二阶段 / 第一阶段** 晋级线（仅当区域标签处于激活状态、按排名排序且没有搜索条件时显示）；
- 排名页侧栏的 **Major 晋级线** 卡片；
- 战队页与对比摘要中的徽章；
- 方法说明页的名额分配表。

Valve 会在每个 Major 周期根据上一届 Major 的各区域成绩重新计算名额，因此这些线始终标注 `asOf` 日期，并且**不是**实时晋级资格或预测。

## 已知限制

- 官方详情表**不包含赛事名称**，比赛行只能按日期、对手和赛事权重分组。
- 只有最新快照包含完整的比赛/因子详情。
- 数据包是单个约 6.5 MB 的脚本。对原型来说足够；正式部署应改为 API 并分页。
- Valve 可能随时调整模型或文件格式。

## 数据来源与免责声明

排名与详情文件：
<https://github.com/ValveSoftware/counter-strike_regional_standings>

详情文件注明，区域排名的赛事数据由 **HLTV.org** 提供。

这是一个非官方的粉丝原型，与 Valve、HLTV 或任何赛事主办方均无隶属关系，也未获得其认可。请勿将其用于官方邀请、参赛资格或种子排位决策。

官方仓库**没有 LICENSE 文件**。其代码属于“源码可见”，并非开源。本项目不复制该仓库代码，只读取其公布的数据文件。
