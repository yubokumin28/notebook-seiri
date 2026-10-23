// content.js と sources.js が共通で使う小道具(同じ拡張の content script 同士は関数を共有できる)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// このサイトは Trusted Types で innerHTML を禁止しているので、部品は必ずこれで組み立てる
function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "dataset") Object.assign(e.dataset, v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== "") e.append(c);
  return e;
}

async function waitFor(fn, timeout = 8000, step = 150) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

// 色付きアイコン+短い文字のボタン。詳しい説明は指を乗せると出る(title)
function iconBtn(icon, label, tip, extraClass = "") {
  return el("button", { type: "button", className: ("nbd-ic " + extraClass).trim(), title: tip, ariaLabel: tip }, [
    el("span", { className: "nbd-ic-i", textContent: icon }),
    el("span", { className: "nbd-ic-t", textContent: label }),
  ]);
}

// 使い方のページを開くボタン(開くのは background.js)
function manualBtn() {
  const b = iconBtn("❔", "使い方", "使い方のページを開く");
  b.addEventListener("click", () => {
    try {
      chrome.runtime.sendMessage({ type: "open-manual" });
    } catch (e) {
      /* 拡張を入れ直した直後は届かない。ページを読み込み直せば直る */
    }
  });
  return b;
}

// ボタンや確認窓は日本語の文字で探しているので、日本語表示の画面でしか動かない。
// 画面の言葉が日本語でなければ、下のバーに一言出す
const PAGE_JA = /^ja/i.test(document.documentElement.lang || "ja");
function langNote() {
  if (PAGE_JA) return null;
  return el("span", {
    className: "nbd-langnote",
    textContent: "⚠ 日本語表示で使ってください",
    title: "この拡張は、Gemini Notebook を日本語で表示している時だけ動きます。Google アカウントの言語を日本語にしてからお使いください。",
  });
}

// ---- 拡張のオン・オフ ----
// 右下の小さな丸ボタンで、拡張が足したもの(チェック欄・概要・下のバー)をまとめて隠す/出す。状態は保存する。
(() => {
  const root = document.documentElement;
  const fab = el("button", { type: "button", id: "nbd-fab" });
  const paint = () => {
    const off = root.classList.contains("nbd-off");
    fab.textContent = off ? "📒" : "🙈";
    fab.title = off ? "拡張の表示をオンにする" : "拡張の表示をオフにする(チェック欄・概要・バーを隠す)";
  };
  const set = (off) => {
    root.classList.toggle("nbd-off", off);
    paint();
    try {
      chrome.storage.local.set({ nbdOff: off });
    } catch (e) {
      /* 保存できなくても切り替えはできる */
    }
  };
  fab.addEventListener("click", () => set(!root.classList.contains("nbd-off")));
  try {
    chrome.storage.local.get("nbdOff").then((d) => {
      root.classList.toggle("nbd-off", !!d.nbdOff);
      paint();
    });
  } catch (e) {
    /* 読めない時はオンのまま */
  }
  paint();
  document.body.append(fab);
})();

function closeMenus() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const bd = document.querySelector(".cdk-overlay-backdrop");
  if (bd) bd.click();
}

// 確認画面の枠。body に見出し・説明・一覧などを入れ、cancel / go ボタンを返す
function openModal(title, bodyNodes, goLabel) {
  const prog = el("div", { className: "nbd-progress", hidden: true });
  const cancel = el("button", { type: "button", textContent: "やめる" });
  const go = el("button", { type: "button", className: "nbd-danger", textContent: goLabel });
  const actions = el("div", { className: "nbd-actions" }, [cancel, go]);
  const box = el("div", { className: "nbd-modal" }, [el("h2", { textContent: title }), ...bodyNodes, prog, actions]);
  const ov = el("div", { id: "nbd-overlay" }, [box]);
  // 入力中のキーをページ側のショートカットに渡さない(ノートの画面ではチャット欄が入力を奪う: error-patterns 10/02)
  for (const type of ["keydown", "keyup", "keypress"]) box.addEventListener(type, (e) => e.stopPropagation());
  document.body.append(ov);
  cancel.addEventListener("click", () => {
    if (!cancel.dataset.running) ov.remove();
  });
  return { ov, box, prog, cancel, go, actions };
}
