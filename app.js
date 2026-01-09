// レシート見える君（トモズ/サミット） app.js 完全版
// - CSVヘッダからチェーン（トモズ/サミット）を自動判定
// - バッジ表示（#chainBadge）
// - 注意書き（#reqCols）をチェーン別に切替
// - 会員選択 + 絞り込み（店舗/商品情報）
// - 商品絞り込みモード：
//    A) detail_only ＝ 一致した明細だけ表示（軽い）
//    B) receipt_all ＝ 一致するレシートを抽出し、明細は全表示（同時購入が見える）
// - 会員サマリー（条件内）
// - レシート一覧：クリックでジャンプ、左右キーで切替
//
// ※ CSVの列名は PROFILES に定義。列名が違う場合はそこだけ直せばOK。

// ---------- DOM helper ----------
const $ = (s) => document.querySelector(s);

// ---------- util ----------
function setStatus(msg) {
  const el = $("#status");
  if (el) el.textContent = msg;
}
function fmtInt(n) {
  return new Intl.NumberFormat("ja-JP").format(Math.round(n));
}
function fmtYen(n) {
  return new Intl.NumberFormat("ja-JP").format(Math.round(n));
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
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
function uniqSorted(arr) {
  return Array.from(new Set(arr.filter(Boolean))).sort();
}

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
    maker: "",        // 無ければ空でOK
    catL: "部門名",   // 使いたい粒度に調整OK（例：部門名）
    catM: "カテゴリ名",
    catS: "",         // 無ければ空でOK
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

  // サミットの強いシグナル
  if (has("匿名会員番号") && (has("買上金額（会員)") || has("買上点数（会員)"))) {
    return PROFILES.SUMMIT;
  }

  // トモズの強いシグナル
  if (has("会員番号/匿名会員番号") && (has("買上金額（会員）") || has("買上点数（会員）"))) {
    return PROFILES.TOMODS;
  }

  // 曖昧時の倒し方（運用で増やす）
  if (has("会員番号/匿名会員番号")) return PROFILES.TOMODS;
  if (has("匿名会員番号")) return PROFILES.SUMMIT;

  // 最後の保険（ここは好みでSUMMITにしてもOK）
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
  const el = document.getElementById("reqCols");
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

// ---------- header presence helpers ----------
function hasCol(name) {
  return !!name && HEADERS.includes(name);
}
function valOrEmpty(o, colName) {
  if (!colName) return "";
  if (!hasCol(colName)) return "";
  return String(o[colName] ?? "").trim();
}

// ---------- CSV parser (minimal) ----------
function parseCSV(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQ = false;

  while (i < text.length) {
    const c = text[i];

    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      } else {
        field += c; i++; continue;
      }
    } else {
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\n") {
        row.push(field); field = "";
        if (!(row.length === 1 && row[0] === "")) rows.push(row);
        row = []; i++; continue;
      }
      if (c === "\r")
