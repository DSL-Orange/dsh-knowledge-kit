#!/usr/bin/env node
/**
 * records-check.mjs —— 记录机制的三检 + 台账生成
 *
 * 规矩来源：30-协作/40-记录机制.md
 * 用法（在库根下执行）：
 *   node _tools/records-check.mjs            # 只检查
 *   node _tools/records-check.mjs --write    # 检查 + 重写 00-索引-台账.md
 *   node _tools/records-check.mjs --stale=14 # 水位过期阈值改 14 天
 *   库根不在脚本上级时：KB_DIR=<库根> node _tools/records-check.mjs
 *
 * 退出码：有 error（孤儿/断链/NUL）→ 1；只有 warn（水位过期）→ 0
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 库根 = 本脚本所在目录（_tools/）的上一级；可用环境变量 KB_DIR 覆盖
const KB = process.env.KB_DIR
  ? path.resolve(process.env.KB_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.dirname(KB);
const INDEX = path.join(KB, '00-索引.md');
// 台账独立成文件：按**读者**拆——入口（路由）给全体会话，家底（台账）给管理员
const LEDGER_FILE = path.join(KB, '00-索引-台账.md');
const LEDGER_BEGIN = '<!-- BEGIN RECORDS-LEDGER';
const LEDGER_END = '<!-- END RECORDS-LEDGER -->';
const SECTION_TITLE = '## 五、记录台账（自动生成）';

// 扫描范围：默认只扫库内。
// 需要扫库外目录时用环境变量：KB_EXTRA_SCAN="D:\path\a,D:\path\b"
const SCAN = [{ dir: KB, label: '知识库' }];
const extra = process.env.KB_EXTRA_SCAN;
if (extra) {
  for (const d of extra.split(',')) {
    const p = d.trim();
    if (p && fs.existsSync(p)) SCAN.push({ dir: p, label: path.basename(p) });
  }
}

// 跳过：素材/备份/归档/临时
const SKIP_RE = /[\\/](_信箱|_备份|_归档|_观测|node_modules|\.git|__pycache__|_backup[^\\/]*)([\\/]|$)/;

const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write');
const staleDays = (() => {
  for (const a of args) {
    const m = /^--stale=(\d+)$/.exec(a);
    if (m) return Number(m[1]);
  }
  return 7;
})();

const errors = [];
const warns = [];
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (SKIP_RE.test(p)) continue;
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

function readText(p) {
  const buf = fs.readFileSync(p);
  const nul = buf.indexOf(0);
  return { text: buf.toString('utf8'), hasNul: nul >= 0, nulAt: nul };
}

function firstHeading(text) {
  for (const line of text.split(/\r?\n/).slice(0, 12)) {
    const m = /^#\s+(.+)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return '';
}

function waterLine(text) {
  for (const line of text.split(/\r?\n/).slice(0, 40)) {
    // 兼容三种写法：`水位：`、`**水位**：`、`更新：`
    const m = /(?:水位\**[：:]|更新[：:])\s*\**\s*([0-9]{4}-[0-9]{2}-[0-9]{2}(?:[ T][0-9]{2}:[0-9]{2})?)/.exec(line);
    if (m) return m[1];
  }
  return '';
}

function kindOf(file) {
  const r = rel(file);
  const base = path.basename(file);
  if (base === '00-索引.md') return '索引';
  if (/变更日志/.test(base)) return '日志';
  if (r.startsWith('reports/')) return '报告';
  // 只有 40-项目 下的备忘录/交接/阶段总结才算"项目状态快照"；
  // 30-协作 里的备忘录是协作规矩的附属记录，不算快照（否则会逼着改已发布的协作文档）。
  if (r.startsWith('DSH知识库/40-项目/') && /阶段总结|备忘录|交接|进度报告/.test(base)) return '快照';
  if (r.startsWith('DSH知识库/30-协作/')) return '规矩';
  return '档案';
}

// 规矩生效日：此前的文件不追"水位行"（历史文件不返工）
const RULE_DATE = '2026-10-27';
function nameDate(file) {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(path.basename(file));
  return m ? m[1] : '';
}

// ── 收集 ────────────────────────────────────────────────────────────
// 首次 --write 时台账文件还不存在，会导致"台账漏掉自己"、需再跑一次。
// 先落一个占位文件，让它在本次扫描里就被算进去（自举一次到位）。
if (WRITE && !fs.existsSync(LEDGER_FILE)) {
  fs.writeFileSync(LEDGER_FILE, '# 记录台账（自动生成，**不是入口**）\n', 'utf8');
}

const records = [];
for (const { dir, label } of SCAN) {
  for (const file of walk(dir)) {
    const { text, hasNul, nulAt } = readText(file);
    const st = fs.statSync(file);
    const r = rel(file);
    const water = waterLine(text);
    records.push({
      kind: kindOf(file),
      path: r,
      water: water || ('~' + st.mtime.toISOString().slice(0, 10)),
      waterIsReal: Boolean(water),
      sizeKB: Math.round(st.size / 102.4) / 10,
      mtime: st.mtimeMs,
      title: firstHeading(text) || path.basename(file),
      scope: label,
    });
    if (hasNul) errors.push(`NUL 字节  ${r}  (offset ${nulAt}) → 编辑工具会判成二进制`);
  }
}
records.sort((a, b) => a.kind.localeCompare(b.kind, 'zh') || a.path.localeCompare(b.path));

// ── 断链检查（索引内的 md 链接） ────────────────────────────────────
const indexText = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : '';
for (const m of indexText.matchAll(/\]\(([^)]+?\.md)(#[^)]*)?\)/g)) {
  const target = m[1];
  if (/^[a-z]+:\/\//i.test(target)) continue;
  const abs = path.resolve(KB, target);
  if (!fs.existsSync(abs)) errors.push(`断链  ${target}  （索引里指向的路径不存在）`);
}

// ── 孤儿检查（在台账里的必须存在；存在的必须在台账里） ──────────────
const beginIdx = indexText.indexOf(LEDGER_BEGIN);
const endIdx = indexText.indexOf(LEDGER_END);
// --write 时用"即将写入的新台账"来比对，否则刚加的记录会被误报成孤儿（2026-10-28 修）
// 2026-10-31：台账已移出索引，独立为 `00-索引-台账.md`
const ledgerText = WRITE
  ? buildLedger()
  : fs.existsSync(LEDGER_FILE)
    ? fs.readFileSync(LEDGER_FILE, 'utf8')
    : '';
const inLedger = new Set();
for (const m of ledgerText.matchAll(/^\|\s*([^|]+?)\s*\|\s*`([^`]+)`/gm)) inLedger.add(m[2]);
for (const rec of records) {
  if (inLedger.size > 0 && !inLedger.has(rec.path)) {
    errors.push(`孤儿  ${rec.path}  （记录存在，台账里没有）`);
  }
}
if (inLedger.size > 0) {
  const existing = new Set(records.map((r) => r.path));
  for (const p of inLedger) if (!existing.has(p)) errors.push(`台账里的路径已不存在  ${p}`);
}

// ── 水位过期检查（只针对"状态型"：快照/报告） ──────────────────────
const now = Date.now();
for (const rec of records) {
  if (rec.kind !== '快照' && rec.kind !== '报告') continue;
  if (!rec.waterIsReal) continue; // 没有真水位行 → 用 mtime，不判过期（另一类问题，见下）
  const t = Date.parse(rec.water.replace(' ', 'T'));
  if (Number.isNaN(t)) continue;
  const days = Math.floor((now - t) / 86400000);
  if (days > staleDays) warns.push(`水位过期  ${rec.path}  水位=${rec.water}（${days} 天前，阈值 ${staleDays}）`);
}
// 状态型却没有水位行 → 提示（规矩 2）。只对"规矩生效日之后"的文件报，历史文件不返工。
for (const rec of records) {
  if (rec.kind !== '快照' && rec.kind !== '报告') continue;
  if (rec.waterIsReal) continue;
  const d = nameDate(rec.path);
  if (d && d < RULE_DATE) continue; // 历史报告：不追水水位
  const ageDays = (now - rec.mtime) / 86400000;
  if (ageDays <= staleDays || d >= RULE_DATE) {
    warns.push(`缺水位行  ${rec.path}  （近 ${Math.floor(ageDays)} 天改过但没写"水位："，建议补一行）`);
  }
}

// ── 写台账 ──────────────────────────────────────────────────────────
function buildLedger() {
  const lines = [];
  lines.push(`${LEDGER_BEGIN}（由 _tools/records-check.mjs --write 生成，不要手改） -->`);
  lines.push('');
  lines.push(`> 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')} ｜ 共 ${records.length} 条 ｜ `);
  lines.push('> 类型：日志(只追加) / 报告(阶段发布) / 快照(可覆盖) / 档案(细节) / 规矩 / 索引。定义见 `30-协作/40-记录机制.md`。');
  lines.push('');
  lines.push('| 类型 | 路径 | 水位 | KB | 说明 |');
  lines.push('|---|---|---|---|---|');
  for (const r of records) {
    const note = r.title.replace(/\|/g, '／').slice(0, 42);
    const water = r.waterIsReal ? r.water : `~${r.water.slice(1)}`;
    lines.push(`| ${r.kind} | \`${r.path}\` | ${water} | ${r.sizeKB} | ${note} |`);
  }
  lines.push('');
  lines.push(LEDGER_END);
  return lines.join('\n');
}

if (WRITE) {
  const block = buildLedger();
  const head = [
    '# 记录台账（自动生成，**不是入口**）',
    '',
    '> 由 `_tools/records-check.mjs --write` 维护，**禁手改**。',
    '> **本文件不负责"去哪查"**——路由请看 [00-索引.md](00-索引.md)。',
    '> 读者：**知识库管理员**（盘家底、查重复、看水位与体积）；普通会话按需读。',
    '> 2026-10-31 从 `00-索引.md` 拆出：索引被读约 17 次/周，其中台账对"查路"是噪声。',
    '',
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(LEDGER_FILE, head + block + '\n', 'utf8');
  console.log(`台账已写入：${rel(LEDGER_FILE)}（${records.length} 条）`);
}

// ── 报告 ────────────────────────────────────────────────────────────
console.log('');
console.log('══ 记录检查 ══════════════════════════════════════════');
console.log(`扫描：${SCAN.map((s) => s.label + '(' + walk(s.dir).length + ')').join('  ')}`);
const byKind = records.reduce((acc, r) => ((acc[r.kind] = (acc[r.kind] || 0) + 1), acc), {});
console.log('分类：' + Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join('  '));
console.log(`孤儿/断链/NUL（error）：${errors.length} ｜ 水位（warn）：${warns.length}`);
for (const e of errors) console.log('  ✖ ' + e);
for (const w of warns) console.log('  ! ' + w);
if (errors.length === 0) console.log('  ✔ 没有孤儿、没有断链、没有 NUL 字节');
console.log('═════════════════════════════════════════════════════');
process.exit(errors.length > 0 ? 1 : 0);
