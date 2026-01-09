// サミトモレシート見える君（トモズ/サミット） app.js 完全版
// - CSVヘッダからチェーン自動判定（PROFILES）
// - 注意書き（#reqCols）をチェーン別に切替
// - 会員ランキング（対象商品：JAN/商品名）→ クリックで会員選択→ apply()
// - 会員選択 + 絞り込み（店舗/商品情報）
// - 商品絞り込みモード：detail_only / receipt_all
// - 会員サマリー（条件内）
// - レシート一覧：クリックでジャンプ、左右キーで切替

// ---------- DOM helper ----------
const $ = (s) => document.querySelector(s);

// ---------- util ----------
function setStatus(msg) { const el = $("#status"); if (el) el.textContent = msg; }
function fmtInt(n) { return new Intl.NumberFormat("ja-JP").format(Math.round(n)); }
function fmtYen(n) { return new Intl.NumberFormat("ja-JP").format(Math.round(n)); }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[c]));
}
function toDateKey(v) {
  if (!v) return "";
  const s = String(v).trim().replaceAll("/", "-");
  return s.length >= 10 ? s.slice(0, 10) : s;
}
function normalizeTime(v) {
  if (!v) return "";
  const s0 = String(v).trim();
  if (s0.includes(":")) {
    const parts = s0.split(":").map(x => x.trim()).filter(Boolean);
    const hh = (parts[0] ?? "00").padStart(2, "0").slice(0, 2);
    const mm = (parts[1] ?? "00").padStart(2, "0").slice(0, 2);
    const ss = (parts[2] ?? "00").padStart(2, "0").slice(0, 2);
    return `${hh}:${mm}:${ss}`;
  }
  const s = s0.replace(/\D/g, "");
  if (s.length === 6) return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
  if (s.length === 4) return `${s.slice(0, 2)}:${s.slice(2, 4)}:00`;
  if (s.length === 2) return `${s.slice(0, 2)}:00:00`;
  return "";
}
function parseNum(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).replaceAll(",", "").trim();
  const x = Number(s);
  return Number.isFinite(x) ? x : 0;
}
function uniqSorted(arr) { return Array.from(new Set(arr.filter(Boolean))).sort(); }

// ---------- profiles (列名辞書) ----------
const PROFILES = {
  TOMODS: {
    key: "TOMODS",
    name: "トモズ",
    member: "会員番号/匿名会員番号",
    date: "買上日",
    time: "買上時間",
    storeName: "店舗名",
    item: "商品名",
    amount: "買上金額（会員）",
    qty: "買上点数（会員）",
    maker: "メーカー/取引先",
    catL: "大分類",
    catM: "中分類",
    catS: "小分類",
    jan: "JANコード",
    notice: [
      "トモズ形式：列名は全角カッコ（例：買上金額（会員））が多いです。",
      "レシートID列は不要（会員×店舗×買上日×買上時間で擬似生成）。",
    ],
  },
  SUMMIT: {
    key: "SUMMIT",
    name: "サミット",
    member: "匿名会員番号",
    date: "買上日",
    time: "買上時間",
    storeName: "店舗名",
    item: "商品名",
    amount: "買上金額（会員)",
    qty: "買上点数（会員)",
    maker: "",
    catL: "部門名",
    catM: "カテゴリ名",
    catS: "",
    jan: "JANコード",
    notice: [
      "サミット形式：列名は半角カッコ（例：買上金額（会員)）が混ざることがあります。",
      "レシートID列は不要（会員×店舗×買上日×買上時間で擬似生成）。",
    ],
  },
};

// 実際に使うプロファイル（CSV読み込み時に決定）
let COL = PROFILES.TOMODS;
let CHAIN_KEY = "TOMODS";

// ヘッダからどっちのチェーンか推定
function pickProfile(headers) {
  const has = (x) => headers.includes(x);

  if (has("匿名会員番号") && (has("買上金額（会員)") || has("買上点数（会員)"))) return PROFILES.SUMMIT;
  if (has("会員番号/匿名会員番号") && (has("買上金額（会員）") || has("買上点数（会員）"))) return PROFILES.TOMODS;

  if (has("会員番号/匿名会員番号")) return PROFILES.TOMODS;
  if (has("匿名会員番号")) return PROFILES.SUMMIT;

  return PROFILES.TOMODS;
}

// ---------- app state ----------
let RAW = [];
let HEADERS = [];
let MEMBER_LIST = [];
let RECEIPTS = [];
let CUR = 0;

// ---------- required columns note (チェーン別) ----------
function renderRequiredColumnsNote() {
  const el = $("#reqCols");
  if (!el) return;

  const required = [COL.member, COL.date, COL.time, COL.storeName, COL.item, COL.amount].filter(Boolean);
  const optional = [COL.qty, COL.maker, COL.catL, COL.catM, COL.catS, COL.jan].filter(Boolean);

  const chainName = COL?.name ? `【${COL.name}】` : "";
  const noticeLines = (COL.notice || []).map(x => `・${escapeHtml(x)}`).join("<br>");

  el.innerHTML =
    `${chainName} 必須: ${required.map(c => `<span>${escapeHtml(c)}</span>`).join(" / ")}`
    + `<br>${chainName} 任意: ${optional.map(c => `<span>${escapeHtml(c)}</span>`).join(" / ")}`
    + `<br><span class="muted">※ レシートID列は不要：会員×店舗×買上日×買上時間で擬似生成</span>`
    + (noticeLines ? `<br><span class="muted">${noticeLines}</span>` : "");
}

function setChainBadge() {
  const badge = $("#chainBadge");
  if (!badge) return;
  badge.textContent = `CHAIN: ${COL?.name ?? "-"}`;
}

// ---------- header presence helpers ----------
function hasCol(name) { return !!name && HEADERS.includes(name); }
function valOrEmpty(o, colName) {
  if (!colName) return "";
  if (!hasCol(colName)) return "";
  return String(o[colName] ?? "").trim();
}

// ---------- CSV parser ----------
function parseCSV(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQ = false;

  while (i < text.length) {
    const c = text[i];

    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      } else { field += c; i++; continue; }
    } else {
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\n") {
        row.push(field); field = "";
        if (!(row.length === 1 && row[0] === "")) rows.push(row);
        row = []; i++; continue;
      }
      if (c === "\r") { i++; continue; }
      field += c; i++; continue;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
  }
  return rows;
}

// ---------- pseudo receipt id ----------
function makePseudoReceiptId(r) {
  const base = `${r.__member}|${r.__store}|${r.__date} ${r.__time}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return `R${h.toString(16)}_${r.__date.replaceAll("-", "")}_${r.__time.replaceAll(":", "")}`;
}

// ---------- load & normalize ----------
function loadFromText(text) {
  const grid = parseCSV(text);
  if (grid.length < 2) throw new Error("CSVが空っぽ（ヘッダ1行＋データが必要）");

  HEADERS = grid[0].map((h, idx) => {
    const s = String(h ?? "").trim();
    if (idx === 0) return s.replace(/^\uFEFF/, "");
    return s;
  });

  COL = pickProfile(HEADERS);
  CHAIN_KEY = COL.key;

  setChainBadge();
  renderRequiredColumnsNote();

  const required = [COL.member, COL.date, COL.time, COL.storeName, COL.item, COL.amount].filter(Boolean);
  const missing = required.filter(c => !HEADERS.includes(c));
  if (missing.length) throw new Error(`必須列が足りない: ${missing.join(", ")}（CSVヘッダ or PROFILESを合わせて）`);

  RAW = grid.slice(1)
    .filter(r => r.length && r.some(x => String(x).trim() !== ""))
    .map(r => {
      const o = {};
      for (let j = 0; j < HEADERS.length; j++) o[HEADERS[j]] = r[j] ?? "";

      o.__member = String(o[COL.member]).trim();
      o.__date = toDateKey(o[COL.date]);
      o.__time = normalizeTime(o[COL.time]);
      o.__store = String(o[COL.storeName]).trim();
      o.__item = String(o[COL.item]).trim();
      o.__amt = parseNum(o[COL.amount]);
      o.__qty = hasCol(COL.qty) ? parseNum(o[COL.qty]) : 1;

      if (!o.__time) throw new Error(`買上時間が解釈できない行があります。列「${COL.time}」の形式を確認してください（例: 13:05 や 130522 など）`);

      o.__maker = valOrEmpty(o, COL.maker);
      o.__catL = valOrEmpty(o, COL.catL);
      o.__catM = valOrEmpty(o, COL.catM);
      o.__catS = valOrEmpty(o, COL.catS);
      o.__jan = valOrEmpty(o, COL.jan);

      o.__dtKey = `${o.__date} ${o.__time}`;
      o.__receipt = makePseudoReceiptId(o);
      return o;
    });

  const set = new Set();
  for (const r of RAW) if (r.__member) set.add(r.__member);
  MEMBER_LIST = Array.from(set).sort();

  refreshMemberSelect();
  setStatus(`読込OK: ${fmtInt(RAW.length)}行 / 会員数: ${fmtInt(MEMBER_LIST.length)} / CHAIN=${COL.name}`);

  // CSV読込後：ランキング初期表示
  renderMemberRanking();
}

// ---------- UI: member select ----------
function refreshMemberSelect() {
  const search = ($("#memberSearch")?.value || "").trim();
  const list = search ? MEMBER_LIST.filter(m => m.includes(search)) : MEMBER_LIST;

  const sel = $("#member");
  if (!sel) return;

  const current = sel.value;
  sel.innerHTML = `<option value="">（選択）</option>`
    + list.slice(0, 5000).map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");

  if (current && list.includes(current)) sel.value = current;
}

function fillSelect(id, values) {
  const sel = $(id);
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = [`<option value="">（全て）</option>`]
    .concat(values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`))
    .join("");
  if (cur && values.includes(cur)) sel.value = cur;
}

function refreshFilterOptionsForMember(memberId) {
  if (!memberId) {
    fillSelect("#storeFilter", []);
    fillSelect("#makerFilter", []);
    fillSelect("#catLFilter", []);
    fillSelect("#catMFilter", []);
    fillSelect("#catSFilter", []);
    return;
  }
  const lines = RAW.filter(r => r.__member === memberId);
  fillSelect("#storeFilter", uniqSorted(lines.map(x => x.__store)));
  fillSelect("#makerFilter", uniqSorted(lines.map(x => x.__maker)));
  fillSelect("#catLFilter", uniqSorted(lines.map(x => x.__catL)));
  fillSelect("#catMFilter", uniqSorted(lines.map(x => x.__catM)));
  fillSelect("#catSFilter", uniqSorted(lines.map(x => x.__catS)));
}

// ---------- receipts builder ----------
function buildReceiptsForMember(memberId, filters) {
  const {
    dateFilter, store, maker, catL, catM, catS,
    janLike, itemLike,
    productScope
  } = filters;

  const janQ = (janLike || "").trim();
  const itemQ = (itemLike || "").trim();

  const baseLines = RAW.filter(r => {
    if (r.__member !== memberId) return false;
    if (dateFilter && r.__date !== dateFilter) return false;
    if (store && r.__store !== store) return false;
    if (maker && r.__maker !== maker) return false;
    if (catL && r.__catL !== catL) return false;
    if (catM && r.__catM !== catM) return false;
    if (catS && r.__catS !== catS) return false;
    return true;
  });

  const matchProduct = (r) => {
    if (janQ && !r.__jan.includes(janQ)) return false;
    if (itemQ && !r.__item.includes(itemQ)) return false;
    return true;
  };

  let lines = baseLines;
  const hasProductCond = !!(janQ || itemQ);

  if (hasProductCond) {
    if (productScope === "receipt_all") {
      const receiptSet = new Set(baseLines.filter(matchProduct).map(x => x.__receipt));
      lines = baseLines.filter(r => receiptSet.has(r.__receipt));
    } else {
      lines = baseLines.filter(matchProduct);
    }
  }

  const map = new Map();
  for (const r of lines) {
    const key = r.__receipt;
    if (!map.has(key)) {
      map.set(key, { receiptId: key, date: r.__date, time: r.__time, dtKey: r.__dtKey, store: r.__store, lines: [] });
    }
    map.get(key).lines.push(r);
  }

  const receipts = Array.from(map.values()).map(rcpt => {
    const sales = rcpt.lines.reduce((a, x) => a + x.__amt, 0);
    const qty = rcpt.lines.reduce((a, x) => a + x.__qty, 0);

    const itemMap = new Map();
    for (const x of rcpt.lines) {
      const name = x.__item || "（不明商品）";
      if (!itemMap.has(name)) itemMap.set(name, { item: name, amt: 0, qty: 0 });
      const o = itemMap.get(name);
      o.amt += x.__amt;
      o.qty += x.__qty;
    }
    const items = Array.from(itemMap.values());
    return { ...rcpt, sales, qty, items };
  });

  return receipts;
}

// ---------- sort ----------
function sortReceipts(list, mode) {
  const a = [...list];
  const cmpStr = (x, y) => String(x).localeCompare(String(y));
  switch (mode) {
    case "dt_asc": a.sort((p, q) => cmpStr(p.dtKey, q.dtKey) || cmpStr(p.store, q.store)); break;
    case "dt_desc": a.sort((p, q) => cmpStr(q.dtKey, p.dtKey) || cmpStr(p.store, q.store)); break;
    case "sales_asc": a.sort((p, q) => (p.sales - q.sales) || cmpStr(p.dtKey, q.dtKey)); break;
    case "sales_desc": a.sort((p, q) => (q.sales - p.sales) || cmpStr(q.dtKey, p.dtKey)); break;
    case "qty_asc": a.sort((p, q) => (p.qty - q.qty) || cmpStr(p.dtKey, q.dtKey)); break;
    case "qty_desc": a.sort((p, q) => (q.qty - p.qty) || cmpStr(q.dtKey, p.dtKey)); break;
    default: a.sort((p, q) => cmpStr(q.dtKey, p.dtKey));
  }
  return a;
}
function sortItems(items, mode) {
  const a = [...items];
  switch (mode) {
    case "amt_asc": a.sort((p, q) => p.amt - q.amt); break;
    case "amt_desc": a.sort((p, q) => q.amt - p.amt); break;
    case "qty_asc": a.sort((p, q) => p.qty - q.qty); break;
    case "qty_desc": a.sort((p, q) => q.qty - p.qty); break;
    case "name_asc": a.sort((p, q) => String(p.item).localeCompare(String(q.item))); break;
    default: a.sort((p, q) => q.amt - p.amt);
  }
  return a;
}

// ---------- member summary ----------
function renderMemberSummary() {
  const n = RECEIPTS.length;
  const sales = RECEIPTS.reduce((a, r) => a + r.sales, 0);
  const qty = RECEIPTS.reduce((a, r) => a + r.qty, 0);
  const atv = n ? sales / n : 0;

  const days = new Set(RECEIPTS.map(r => r.date)).size;
  const stores = new Set(RECEIPTS.map(r => r.store)).size;

  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };

  setText("#k_rcpt", n ? fmtInt(n) : "-");
  setText("#k_sales", n ? fmtYen(sales) : "-");
  setText("#k_qty", n ? fmtInt(qty) : "-");
  setText("#k_days", n ? fmtInt(days) : "-");
  setText("#k_stores", n ? fmtInt(stores) : "-");
  setText("#k_atv", n ? fmtYen(atv) : "-");
}

// ---------- receipt list ----------
function renderReceiptList() {
  const box = $("#rcptList");
  const info = $("#listInfo");
  if (!box) return;

  if (!RECEIPTS.length) {
    if (info) info.textContent = "-";
    box.innerHTML = `<div class="muted small">レシートがありません</div>`;
    return;
  }

  if (info) info.textContent = `件数=${RECEIPTS.length}`;

  box.innerHTML = RECEIPTS.map((r, idx) => {
    const active = idx === CUR ? "active" : "";
    return `
      <button class="rcptBtn ${active}" data-idx="${idx}">
        <div class="rcptTop">
          <span class="mono">${escapeHtml(r.date)} ${escapeHtml(r.time)}</span>
          <span class="mono">¥${fmtYen(r.sales)}</span>
        </div>
        <div class="rcptMid mono">${escapeHtml(r.store)}</div>
        <div class="rcptBot">
          <span class="pill mono">点数 ${fmtInt(r.qty)}</span>
          <span class="pill mono">行 ${fmtInt(r.items.length)}</span>
        </div>
      </button>
    `;
  }).join("");

  box.querySelectorAll("button[data-idx]").forEach(btn => {
    btn.addEventListener("click", () => {
      CUR = Number(btn.dataset.idx);
      renderCurrentReceipt();
      renderReceiptList();
    });
  });
}

// ---------- receipt detail ----------
function renderCurrentReceipt() {
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const itemsTbody = $("#items");

  if (!RECEIPTS.length) {
    setText("#rcptIndex", "-");
    setText("#rcptMeta", "-");
    setText("#r_sales", "-");
    setText("#r_qty", "-");
    setText("#r_lines", "-");
    if (itemsTbody) itemsTbody.innerHTML = `<tr><td colspan="4" class="muted">レシートがありません</td></tr>`;
    return;
  }

  CUR = Math.max(0, Math.min(CUR, RECEIPTS.length - 1));
  const r = RECEIPTS[CUR];

  setText("#rcptIndex", `${CUR + 1} / ${RECEIPTS.length}`);
  setText("#rcptMeta", `${r.date} ${r.time}  |  ${r.store}`);

  setText("#r_sales", fmtYen(r.sales));
  setText("#r_qty", fmtInt(r.qty));

  const itemSort = $("#itemSort")?.value || "amt_desc";
  const items = sortItems(r.items, itemSort);
  setText("#r_lines", fmtInt(items.length));

  const maxAmt = Math.max(...items.map(x => x.amt), 1);
  if (itemsTbody) {
    itemsTbody.innerHTML = items.map(x => {
      const ratio = r.sales ? (x.amt / r.sales) : 0;
      const w = Math.round((x.amt / maxAmt) * 100);
      return `
        <tr>
          <td>${escapeHtml(x.item)}</td>
          <td class="right mono">${fmtYen(x.amt)}</td>
          <td class="right mono">${fmtInt(x.qty)}</td>
          <td>
            <div class="bar"><div style="width:${w}%"></div></div>
            <div class="small muted mono">${(ratio * 100).toFixed(1)}%</div>
          </td>
        </tr>
      `;
    }).join("");
  }
}

// ---------- filters ----------
function getFilters() {
  return {
    dateFilter: $("#dateFilter")?.value || "",
    store: $("#storeFilter")?.value || "",
    maker: $("#makerFilter")?.value || "",
    catL: $("#catLFilter")?.value || "",
    catM: $("#catMFilter")?.value || "",
    catS: $("#catSFilter")?.value || "",
    janLike: $("#janFilter")?.value || "",
    itemLike: $("#itemFilter")?.value || "",
    productScope: $("#productScope")?.value || "detail_only",
  };
}

// ---------- apply / clear ----------
function apply() {
  const memberId = $("#member")?.value || "";
  if (!memberId) { setStatus("会員を選択してください"); return; }

  const filters = getFilters();
  let receipts = buildReceiptsForMember(memberId, filters);
  receipts = sortReceipts(receipts, $("#rcptSort")?.value || "dt_desc");

  RECEIPTS = receipts;
  CUR = 0;

  renderMemberSummary();
  renderReceiptList();
  renderCurrentReceipt();

  setStatus(`会員=${memberId} / レシート=${fmtInt(RECEIPTS.length)}件（条件内サマリー表示中）`);
}

function clearAll() {
  const setVal = (id, v) => { const el = $(id); if (el) el.value = v; };

  setVal("#member", "");
  setVal("#dateFilter", "");
  setVal("#storeFilter", "");
  setVal("#makerFilter", "");
  setVal("#catLFilter", "");
  setVal("#catMFilter", "");
  setVal("#catSFilter", "");
  setVal("#janFilter", "");
  setVal("#itemFilter", "");
  setVal("#memberSearch", "");
  setVal("#productScope", "detail_only");
  setVal("#rcptSort", "dt_desc");

  RECEIPTS = [];
  CUR = 0;

  renderMemberSummary();
  renderReceiptList();
  renderCurrentReceipt();
  refreshMemberSelect();

  setStatus("クリア");
}

// ---------- keyboard: left/right ----------
function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}
document.addEventListener("keydown", (e) => {
  if (!RECEIPTS.length) return;
  if (isTypingTarget(document.activeElement)) return;

  if (e.key === "ArrowLeft") {
    e.preventDefault();
    CUR = Math.max(0, CUR - 1);
    renderCurrentReceipt(); renderReceiptList();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    CUR = Math.min(RECEIPTS.length - 1, CUR + 1);
    renderCurrentReceipt(); renderReceiptList();
  }
});

// ============================================================
// 0) 会員探索（ランキング）
//   - 一致した明細だけで集計（同時購買は入れない）
// ============================================================
function getRankQuery() {
  return {
    janQ: ($("#rankJan")?.value || "").trim(),
    itemQ: ($("#rankItem")?.value || "").trim(),
    metric: $("#rankMetric")?.value || "sales_desc",
    limit: Number($("#rankLimit")?.value || 100),
  };
}
function computeMemberRanking({ janQ, itemQ, metric, limit }) {
  if (!RAW.length) return [];

  const hasCond = !!(janQ || itemQ);

  const match = (r) => {
    // 条件がないときは全件対象（＝全体ランキング）
    if (!hasCond) return true;
    if (janQ && !r.__jan.includes(janQ)) return false;
    if (itemQ && !r.__item.includes(itemQ)) return false;
    return true;
  };

  const m = new Map();
  for (const r of RAW) {
    if (!match(r)) continue;

    const id = r.__member;
    if (!id) continue;

    if (!m.has(id)) {
      m.set(id, {
        member: id,
        sales: 0,
        qty: 0,
        rcptSet: new Set(),
        storeSet: new Set(),
        lastDt: "",
      });
    }
    const o = m.get(id);
    o.sales += r.__amt;
    o.qty += r.__qty;
    o.rcptSet.add(r.__receipt);
    o.storeSet.add(r.__store);
    if (!o.lastDt || String(r.__dtKey).localeCompare(o.lastDt) > 0) o.lastDt = r.__dtKey;
  }

  let arr = Array.from(m.values()).map(o => ({
    member: o.member,
    sales: o.sales,
    qty: o.qty,
    rcpt: o.rcptSet.size,
    stores: o.storeSet.size,
    lastDt: o.lastDt || "",
  }));

  const cmpStrDesc = (a, b) => String(b).localeCompare(String(a));
  switch (metric) {
    case "qty_desc":
      arr.sort((a, b) => (b.qty - a.qty) || (b.sales - a.sales) || cmpStrDesc(a.lastDt, b.lastDt));
      break;
    case "rcpt_desc":
      arr.sort((a, b) => (b.rcpt - a.rcpt) || (b.sales - a.sales) || cmpStrDesc(a.lastDt, b.lastDt));
      break;
    case "last_desc":
      arr.sort((a, b) => cmpStrDesc(a.lastDt, b.lastDt) || (b.sales - a.sales) || (b.rcpt - a.rcpt));
      break;
    case "sales_desc":
    default:
      arr.sort((a, b) => (b.sales - a.sales) || cmpStrDesc(a.lastDt, b.lastDt) || (b.rcpt - a.rcpt));
      break;
  }

  if (Number.isFinite(limit) && limit > 0) arr = arr.slice(0, limit);
  return arr;
}

function renderMemberRanking() {
  const tbody = $("#rankTable");   // tbody要素（id=rankTable）
  const info = $("#rankInfo");
  if (!tbody) return;

  if (!RAW.length) {
    if (info) info.textContent = "CSV読込後に有効";
    tbody.innerHTML = `<tr><td colspan="7" class="muted">CSV未読込</td></tr>`;
    return;
  }

  const q = getRankQuery();
  const isAll = (!q.janQ && !q.itemQ);

  if (info) {
    info.textContent = isAll
      ? `全体ランキング表示中（会員クリックで選択→反映）`
      : `条件あり：該当会員を表示中（クリックで会員選択→反映）`;
  }

  const arr = computeMemberRanking(q);

  if (!arr.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">該当なし</td></tr>`;
    return;
  }

  tbody.innerHTML = arr.map((r, i) => `
    <tr class="rankClickable" data-member="${escapeHtml(r.member)}">
      <td class="mono">${i + 1}</td>
      <td class="mono">${escapeHtml(r.member)}</td>
      <td class="right mono">${fmtYen(r.sales)}</td>
      <td class="right mono">${fmtInt(r.qty)}</td>
      <td class="right mono">${fmtInt(r.rcpt)}</td>
      <td class="mono">${escapeHtml(r.lastDt)}</td>
      <td class="right mono">${fmtInt(r.stores)}</td>
    </tr>
  `).join("");

  tbody.querySelectorAll("tr[data-member]").forEach(tr => {
    tr.addEventListener("click", () => {
      const memberId = tr.dataset.member || "";
      if (!memberId) return;

      const sel = $("#member");
      if (sel) sel.value = memberId;

      const rJan = ($("#rankJan")?.value || "").trim();
      const rItem = ($("#rankItem")?.value || "").trim();
      const janEl = $("#janFilter");
      const itemEl = $("#itemFilter");
      if (janEl) janEl.value = rJan;
      if (itemEl) itemEl.value = rItem;

      refreshFilterOptionsForMember(memberId);
      apply();
      sel?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

// ---------- file load ----------
async function loadFile(file) {
  try {
    setStatus(`読込中... ${file.name}`);
    const text = await file.text();
    loadFromText(text);

    // 初期状態
    RECEIPTS = [];
    CUR = 0;
    renderMemberSummary();
    renderReceiptList();
    renderCurrentReceipt();

  } catch (err) {
    setStatus("読込失敗: " + (err?.message ?? String(err)));
  }
}

// ---------- UI wiring ----------
function wire() {
  renderRequiredColumnsNote();
  setChainBadge();

  $("#apply")?.addEventListener("click", apply);
  $("#clear")?.addEventListener("click", clearAll);

  $("#prev")?.addEventListener("click", () => {
    if (!RECEIPTS.length) return;
    CUR = Math.max(0, CUR - 1);
    renderCurrentReceipt(); renderReceiptList();
  });
  $("#next")?.addEventListener("click", () => {
    if (!RECEIPTS.length) return;
    CUR = Math.min(RECEIPTS.length - 1, CUR + 1);
    renderCurrentReceipt(); renderReceiptList();
  });

  $("#memberSearch")?.addEventListener("input", refreshMemberSelect);
  $("#member")?.addEventListener("change", () => {
    const memberId = $("#member")?.value || "";
    refreshFilterOptionsForMember(memberId);
  });

  $("#rcptSort")?.addEventListener("change", () => { if (RECEIPTS.length) apply(); });
  $("#itemSort")?.addEventListener("change", () => { if (RECEIPTS.length) renderCurrentReceipt(); });
  $("#productScope")?.addEventListener("change", () => { if (RECEIPTS.length) apply(); });

  // ranking
  $("#rankRefresh")?.addEventListener("click", renderMemberRanking);
  $("#rankMetric")?.addEventListener("change", () => { if (RAW.length) renderMemberRanking(); });
  $("#rankLimit")?.addEventListener("change", () => { if (RAW.length) renderMemberRanking(); });
  $("#rankJan")?.addEventListener("input", () => { if (RAW.length) renderMemberRanking(); });
  $("#rankItem")?.addEventListener("input", () => { if (RAW.length) renderMemberRanking(); });

  // drag & drop
  const drop = $("#drop");
  if (drop) {
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.style.borderColor = "rgba(37,99,235,.65)"; });
    drop.addEventListener("dragleave", () => { drop.style.borderColor = "rgba(37,99,235,.35)"; });
    drop.addEventListener("drop", async (e) => {
      e.preventDefault(); drop.style.borderColor = "rgba(37,99,235,.35)";
      const file = e.dataTransfer.files?.[0];
      if (file) await loadFile(file);
    });
  }

  $("#file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (file) await loadFile(file);
  });

  // 初期表示
  console.log("rank ready", {
  hasGetRankQuery: typeof getRankQuery,
  rankJan: $("#rankJan")?.value,
  rankItem: $("#rankItem")?.value,
  RAW: RAW.length
});

  renderMemberRanking();
  renderMemberSummary();
  renderReceiptList();
  renderCurrentReceipt();
  setStatus("CSV未読込");
}

// DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire);
} else {
  wire();
}



