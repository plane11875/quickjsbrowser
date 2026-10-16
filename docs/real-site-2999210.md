# 真实网站：linux.do 帖子 2999210

地址：https://linux.do/t/topic/2999210

标题：浅试 pi codemode，可能确实省一点 tokens？

2026-10-16 15:56 UTC，使用真实线上 Worker、新 CDP 会话、指定的 SNI 中继，视口 1024×768，显式启用 JavaScript。未修改网站 HTML/CSS；截图使用当前浏览器实现的真实输出。

![当前实际截图](images/worker-linux-topic-2999210.png)

## 实际结果：应用未完成

- 顶层文档导航约 2857ms，截图约 676ms。
- 渲染资源分批缓存为 32 → 64 → 93，最终未下载资源为 0，失败资源为 0。
- JavaScript 预取失败：`https://cdn.ldstatic.com/extra-locales/2bd76d36ad74b4e6bad0260d58e82fb51193d954/zh_CN/main.js`，错误 `response size budget exceeded`。
- 当前代码的单脚本体积上限为 524288 字节，总源码上限 2097152 字节。首先触发的是本项目的脚本体积限制，不能据此判断 Worker 的 CPU 或内存上限。
- 页面脚本执行数为 0，状态 `degraded`，输出模式 `fallback`。正文和帖子图片能显示，但完整 Discourse 应用和真实交互未跑通。
- PNG 为 206457 字节，SHA-256：`a0ba788259142f8997566fb6547caa720f336afb7f07e59eb3684b2cf3f2c483`。

当前 Worker 版本 `1bad7eb5-3c64-4a02-80e2-6979992ee056`，运行代码 `9ecba45`。此前简化测试页通过只证明局部行为，不能替代此站点的兼容性结果。

## 复现

通过私有环境提供 `QJSB_KEY` 和 `QJSB_RELAY_IP`，然后执行：

```bash
node test/real-site-remote.mjs
```

默认测试上述地址，可用 `QJSB_REAL_URL` 指定另一个真实网址。截图、DOM 与诊断保存在 `.cache/real-site/`，不提交会话日志。脚本在应用未完成时返回退出码 2，网络或截图失败时返回 1，不会把「生成了 PNG」记作网站兼容通过。
