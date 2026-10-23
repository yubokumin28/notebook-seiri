// 使い方のページを開くだけの裏方。
// ・Chrome 右上の拡張アイコンを押した時
// ・画面の下のバーの「❔ 使い方」を押した時(content script からの合図)
// ・初めて入れた時
const MANUAL = "manual/index.html";

function openManual() {
  chrome.tabs.create({ url: chrome.runtime.getURL(MANUAL) });
}

chrome.action.onClicked.addListener(openManual);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "open-manual") openManual();
});

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === "install") openManual();
});
