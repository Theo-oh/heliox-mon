// SSE 事件总线：整页只持有一条 /api/traffic/realtime 长连接，
// 默认消息是每秒网速，具名事件 system 是系统资源快照。
// 各模块通过 onStreamEvent 订阅，彼此不需要知道对方存在。

/** @type {Map<string, Set<(data: any) => void>>} */
const handlers = new Map();
/** 已在当前连接上挂过监听的事件名 */
const attached = new Set();

/** @type {EventSource|null} */
let es = null;
let retryMs = 1000;
/** @type {ReturnType<typeof setTimeout>|null} */
let retryTimer = null;

/**
 * 订阅一类 SSE 事件。type 为 "message" 时是默认消息。
 * @param {string} type
 * @param {(data: any) => void} handler
 * @returns {() => void} 取消订阅
 */
export function onStreamEvent(type, handler) {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler);
  attach(type); // 允许连上之后再订阅
  return () => {
    handlers.get(type)?.delete(handler);
  };
}

/**
 * 分发到订阅者。每个订阅者独立 try/catch：网速渲染出错不能连带
 * 让同一帧的系统状态渲染被跳过。
 * @param {string} type
 * @param {string} raw
 */
function dispatch(type, raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`解析 SSE ${type} 数据失败:`, e);
    return;
  }
  const set = handlers.get(type);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(data);
    } catch (e) {
      console.error(`处理 SSE ${type} 事件失败:`, e);
    }
  }
}

/** @param {string} type */
function attach(type) {
  if (!es || attached.has(type)) return;
  attached.add(type);
  es.addEventListener(type, (event) => dispatch(type, event.data));
}

export function startStream() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (es) es.close();

  es = new EventSource("/api/traffic/realtime");
  attached.clear();
  for (const type of handlers.keys()) attach(type);

  es.onopen = () => {
    retryMs = 1000;
  };
  es.onerror = () => {
    // CONNECTING 说明浏览器正在自愈，抢着 close() 反而更慢；只接管它已放弃的连接
    if (!es || es.readyState !== EventSource.CLOSED) return;
    console.error(`SSE 连接断开，${retryMs / 1000} 秒后重连...`);
    retryTimer = setTimeout(startStream, retryMs);
    retryMs = Math.min(retryMs * 2, 10000);
  };
}

export function stopStream() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (es) {
    es.close();
    es = null;
  }
  attached.clear();
}
