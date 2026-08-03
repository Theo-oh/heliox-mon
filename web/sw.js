// 缓存名带版本号：升级前端资源时必须同步 bump，否则旧缓存不会被清理
const CACHE_NAME = 'heliox-v9';

// 预缓存首屏渲染必需的资源。图表库缺一个页面就会因 Chart/echarts 未定义而报错，
// 所以 vendor 三件套必须在列表里，否则离线打开只剩空壳。
// ES module 图是「全或无」的：任何一个 js/ 下的模块拿不到，整个入口都不会执行，
// 页面停在骨架且没有任何提示——新增模块文件时务必同步补进这份清单。
const ASSETS_TO_CACHE = [
  '/',
  '/style.css',
  '/favicon.svg',
  '/manifest.json',
  '/js/main.js',
  '/js/core/dom.js',
  '/js/core/format.js',
  '/js/core/http.js',
  '/js/core/stream.js',
  '/js/core/theme.js',
  '/js/core/vendor.js',
  '/js/modules/latency/index.js',
  '/js/modules/latency/chart.js',
  '/js/modules/latency/palette.js',
  '/js/modules/latency/stats.js',
  '/js/modules/notify.js',
  '/js/modules/realtime.js',
  '/js/modules/system.js',
  '/js/modules/traffic.js',
  '/js/modules/trend.js',
  '/vendor/chart.umd.min.js',
  '/vendor/chartjs-plugin-annotation.min.js',
  '/vendor/echarts.min.js'
];

// 安装阶段：预缓存核心静态文件
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // 逐个 add 而非 addAll：addAll 是原子的，单个资源失败会导致整个 SW 安装失败
      return Promise.all(
        ASSETS_TO_CACHE.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('预缓存失败:', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// 激活阶段：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 请求拦截：网络优先策略（保证监控数据实时性，断网时回退缓存）
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 只接管同源 GET；API/SSE 必须直连，跨域资源（如 Turnstile）也不拦截
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // 成功响应回写缓存：二进制升级后离线副本才不会一直停在首次安装的版本。
        // 排除 redirected：会话过期时 / 会 302 到登录页，否则会把登录页缓存成首页
        if (res.ok && res.type === 'basic' && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(async () => {
        // caches.match 未命中返回 undefined，直接交给 respondWith 会抛 TypeError
        return (await caches.match(event.request)) || Response.error();
      })
  );
});
