// 统一的 JSON 请求封装。只负责「把坏响应变成异常」，不吞异常、不重试、不去重——
// 各调用点保留自己的中文报错文案，出问题时仍能一眼定位到模块。

export class HttpError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   * @param {boolean} [redirected] 是否因未授权已跳转登录页
   */
  constructor(message, status = 0, redirected = false) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.redirected = redirected;
  }
}

/**
 * @param {string} url
 * @param {{noStore?: boolean}} [opts]
 * @returns {Promise<any>}
 */
export async function getJSON(url, opts = {}) {
  const res = await fetch(url, opts.noStore ? { cache: "no-store" } : undefined);

  // 会话过期统一跳登录页；抛出的错误带 redirected 标记，调用方不必再报错
  if (res.status === 401) {
    window.location.href = "/login";
    throw new HttpError("未授权", 401, true);
  }
  if (!res.ok) {
    throw new HttpError(`API 请求失败: ${res.status} ${res.statusText}`, res.status);
  }
  // 校验 Content-Type：反代异常或服务未起来时会返回 HTML，直接喂给 JSON.parse
  // 只会得到一句无从下手的语法错误
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new HttpError("服务端返回非 JSON 数据", res.status);
  }
  return res.json();
}

/**
 * POST 后无论成败都要把后端 message 回显给用户，所以不抛异常而是原样返回。
 * @param {string} url
 * @returns {Promise<{ok: boolean, data: any}>}
 */
export async function postJSON(url) {
  const res = await fetch(url, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

/**
 * 打印请求失败日志。已跳转登录页的情况不再刷屏——页面马上就要离开了。
 * @param {string} prefix
 * @param {any} err
 */
export function logFetchError(prefix, err) {
  if (err instanceof HttpError && err.redirected) return;
  console.error(prefix, err);
}
