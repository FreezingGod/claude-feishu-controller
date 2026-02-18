/**
 * Discord 代理引导模块
 * 通过 --import 在 discord.js 加载前运行，代理 REST API 和 WebSocket 连接
 *
 * 用法: node --import ./src/discord-proxy-bootstrap.mjs src/index-discord.js
 *
 * 原理:
 * - REST API: discord.js 使用 undici，通过 setGlobalDispatcher 设置代理
 * - WebSocket: ws 库内部 initAsClient 会设置 createConnection: tlsConnect，
 *   这会绕过 agent 的连接创建。解决方案是拦截 https.request，
 *   对 WebSocket upgrade 请求删除 createConnection 并注入代理 agent
 */

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;

if (proxyUrl) {
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  const { ProxyAgent, setGlobalDispatcher } = await import('undici');
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);

  // 使用 CJS require 获取可变的 https 模块
  const https = require('https');

  // 1. 代理 REST API 请求（discord.js 使用 undici）
  setGlobalDispatcher(new ProxyAgent(proxyUrl));

  // 2. 代理 WebSocket 连接（拦截 https.request）
  const wsAgent = new HttpsProxyAgent(proxyUrl);
  const origHttpsRequest = https.request;

  https.request = function(options, ...args) {
    // 检测 WebSocket upgrade 请求（ws 库发起的连接）
    if (options && options.headers) {
      const upgradeHeader = options.headers.Upgrade || options.headers.upgrade;
      if (upgradeHeader === 'websocket') {
        // 删除 ws 设置的 createConnection，让 agent 接管连接创建
        delete options.createConnection;
        options.agent = wsAgent;
      }
    }
    return origHttpsRequest.call(this, options, ...args);
  };

  console.log(`[Proxy] 已配置代理: ${proxyUrl} (REST + WebSocket)`);
}
