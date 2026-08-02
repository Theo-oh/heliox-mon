// 通知设置：主机名胶囊 + Telegram 弹层

import { $ } from "../core/dom.js";
import { getJSON, logFetchError, postJSON } from "../core/http.js";

export function initNotify() {
  fetchNotifyStatus();
  setupNotifyPill();
}

// 拉取通知配置：未配置 Telegram 时主机名胶囊保持纯展示，顶栏干净；
// 已配置则亮出铃铛并允许点开弹层，推送时刻放在弹层里而非顶栏
async function fetchNotifyStatus() {
  const pill = /** @type {HTMLButtonElement} */ ($("server-name"));
  const tgStatus = $("tg-pop-status");
  const drStatus = $("dr-pop-status");
  if (!pill) return;

  // disabled 同时挡住点击与 hover 态，弹层入口和视觉提示保持一致
  const setInteractive = (on, hint) => {
    pill.classList.toggle("is-notify", on);
    pill.disabled = !on;
    if (on) {
      pill.setAttribute("aria-haspopup", "dialog");
      pill.setAttribute("aria-expanded", "false");
      pill.title = hint;
    } else {
      pill.removeAttribute("aria-haspopup");
      pill.removeAttribute("aria-expanded");
      pill.removeAttribute("title");
    }
  };

  try {
    const cfg = await getJSON("/api/config");

    if (!cfg.telegram_enabled) {
      setInteractive(false);
      return;
    }

    const dr = cfg.daily_report || {};
    const hourLabel =
      dr.enabled && dr.hour != null
        ? `${String(dr.hour).padStart(2, "0")}:00`
        : null;

    setInteractive(true, hourLabel ? `每日报告 ${hourLabel}` : "Telegram 通知");
    if (tgStatus) {
      tgStatus.textContent = "已配置";
      tgStatus.className = "notify-badge is-on";
    }
    if (drStatus) {
      drStatus.textContent = hourLabel ? `每天 ${hourLabel}` : "已关闭";
      drStatus.className = "notify-badge " + (dr.enabled ? "is-on" : "is-off");
    }
  } catch (e) {
    logFetchError("获取通知配置失败", e);
    setInteractive(false); // 拿不到状态时不给入口，避免误导
  }
}

// 主机名胶囊：点击开合通知弹层（点击外部 / Esc 关闭），弹层内「发送测试消息」即时验证
function setupNotifyPill() {
  const pill = $("server-name");
  const pop = $("notify-popover");
  if (!pill || !pop) return;

  const result = $("notify-test-result");
  const setOpen = (open) => {
    pop.hidden = !open;
    pill.setAttribute("aria-expanded", String(open));
    // 每次重新打开清掉上次的测试结果，避免残留旧的成功/失败提示
    if (open && result) {
      result.textContent = "";
      result.className = "notify-result";
    }
  };

  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(pop.hidden);
  });
  pop.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => {
    if (!pop.hidden) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) setOpen(false);
  });

  wireNotifyButton("notify-test-btn", "/api/notify/test", result);
  wireNotifyButton("notify-daily-btn", "/api/notify/daily-report", result);
}

// wireNotifyButton 给弹层内按钮绑定「点击 -> POST 触发发送 -> 回显结果」逻辑，
// 发送期间禁用按钮避免重复点击；成功/失败都把后端 message 回显到共享结果区。
function wireNotifyButton(btnId, url, result) {
  const btn = /** @type {HTMLButtonElement} */ ($(btnId));
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "发送中…";
    if (result) {
      result.textContent = "";
      result.className = "notify-result";
    }
    try {
      const { ok, data } = await postJSON(url);
      if (result) {
        result.textContent = data.message || (ok ? "已发送" : "发送失败");
        result.className = "notify-result " + (ok ? "is-ok" : "is-err");
      }
    } catch (e) {
      if (result) {
        result.textContent = "请求失败：" + e.message;
        result.className = "notify-result is-err";
      }
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
  });
}
