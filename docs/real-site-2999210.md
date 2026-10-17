# 2026-10-16 最新验证：内存阻碍，未完成上线验收

运行代码 `9e8bb02`，Worker `deca889d-d769-4666-99a5-34d79756b23c`；[PR #4](https://github.com/plane11875/quickjsbrowser/pull/4) 为草稿，main 未合并本轮变更。

| 项目 | 最新真实结果 |
|---|---|
| URL | https://linux.do/t/topic/2999210 |
| 页面 JS | 启用 |
| 视口 | 1024×768 |
| 导航 | 进入分批加载，continue 后超时 |
| 累计 DO CPU | 10.709972 秒，失败尝试的全过程累计 |
| 平台 CPU 超限 | 0 |
| 平台内存超限 | 2 |
| 平台采样 isolate 峰值 | 242,134,549 字节 |
| 同 DO A → B → A / 点击 / 返回 | 尚未通过；冷启动中断 |
| 合并状态 | 不满足真实测试成功条件，保留草稿 |

CPU 来自按独立 objectId 过滤的 durableObjectsPeriodicGroups，cpuTime 微秒换算为秒。两条周期记录为 10,709,972 与 0 微秒；内存指标为同 isolate 的采样峰值，不是单个 VM 的逻辑使用量。原始会话标识和日志不提交 Git。CPU、墙钟和内存分别报告；不能把失败前的 CPU 当成完整成功运行成本。

另一个新会话的真实 Worker 路由定向探针通过：Linux.do 文档走 SNI 返回 200；Stripe v3、pricing-table 与 Google GSI 均返回 200，非适用中继自动改直连。最终 relay=3、direct=4、fallback=2，重复 Stripe 请求未再尝试 SNI。该探针只验证网络路径，不执行整个 Discourse 应用，也不替代下述完整流程验收。公开复现：`test/route-fallback-remote.mjs`（私有环境提供 KEY/RELAY_IP）。

已完成 14 个本地套件及六个渲染 case；首轮部署的五组局部线上回归通过。真实资源在 Node/WASM 重放时已生成 Discourse 页头、标题与 cooked 正文，并消除启动错误；这仍不构成 Worker 线上通过。

排查定位了 minified source 行列计算的重复扫描、WASI 分配大小桩导致的 GC/上限计量错误、编译源码副本、跨导航新建大线性内存以及几何查询的 DOM/大 JSON 复制。对应修复已部署，内存峰值下降，但完整页面仍越过 Worker 的实际承载边界。[Cloudflare 文档](https://developers.cloudflare.com/workers/platform/limits/#memory)规定每 isolate 128 MB，包含 JS 堆和 WASM。

下一阶段需要大幅降低 VM 中 DOM/对象/函数元数据的驻留量，或将渲染与 JS 执行隔离到不同内存边界。跨服务几何查询还必须保持页面脚本的同步语义，不能直接把同步桥接改成未等待的 fetch，也不能关闭 JS/样式/观察器来代替完整流程。资源缓存继续保持会话内存语义，不增加 KV。

-O3 与共享函数源码原型都进行了评估。-O3 未显示可靠的整页收益；共享源码原型仅小幅降低内存，未证明能解决线上限制，未纳入最终运行代码。相关实验保留在 Codespace 的私有 .cache 下。

---

## 以下为此前解除源码限制时的历史报告

# 真实网站：linux.do 帖子 2999210

地址：https://linux.do/t/topic/2999210

标题：浅试 pi codemode，可能确实省一点 tokens？

## 解除源码限制后的 Worker 实测

2026-10-16 16:21 UTC 开始，独立新 CDP 会话、指定 SNI 中继，视口 1024×768，显式启用 JavaScript。运行代码 `7bb44b5`，Worker 版本 `7e0c06bf-85fc-499a-9dae-43e17fef3048`。

![实际输出：仍停在应用加载画面](images/worker-linux-topic-2999210-unrestricted.png)

| 指标 | 本次实测 |
| --- | ---: |
| 全程累计 Durable Object CPU | **23.161496 秒** |
| 目标 | ≤10 秒 CPU，**未达到** |
| 已准备脚本源码 | 14,947,279 字节 |
| 已进入执行的脚本 | 27 段 |
| 脚本/依赖请求 | 73 |
| 已缓存渲染资源 | 89 |
| 初次导航响应（墙钟） | 5851 ms |
| 最后截图（墙钟） | 591 ms |
| 平台 CPU / 内存超限错误 | 0 / 0 |
| 测试退出码 | **2：应用未完成** |

### CPU 统计口径

使用 Cloudflare GraphQL 的 `durableObjectsPeriodicGroups`，按本次新会话的 `objectId` 精确过滤，累计 `sum.cpuTime`。通过 GraphQL schema introspection 确认单位为微秒，两条记录分别为 8,052,519 与 15,108,977 微秒，合计 23,161,496 微秒。

该累计值包含本次导航、分批加载、QuickJS 和渲染/截图在 Durable Object 内消耗的 CPU；不把网络等待等墙钟时间算作 CPU，也不将其说成单条 CDP 消息的 CPU。没有以 Node 本地 `process.cpuUsage` 或 Worker 内的普通计时冒充平台 CPU。

应用仍未完成启动，因此这个数字也不能证明完整运行后的最终 CPU。资料：[Cloudflare Durable Object metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)。原始会话数据与对象 ID 保存在私有测试输出，不提交会话日志。

### 实际阻塞点

- 浏览器检测脚本：`ReferenceError: 'CSS' is not defined`。这指缺少浏览器 `CSS` 命名空间，并不是没有 CSS 布局引擎。
- Discourse 主模块：`document.referrer` 为 undefined，页面代码调用 `.includes('android-app://')` 时抛错。堆栈位于 `chunk-kcspcnt3.digested.js:30:72641`，已核对源码。
- Google Identity、Stripe 的三个外部脚本通过指定中继握手失败，`TLS Alert: 0228`；没有自动改成直连。
- 长期 interval 尚不支持；Cloudflare beacon 还读取了尚未实现的 `performance.timing.navigationStart`。

这次移除了旧的 512 KiB/2 MiB 门槛、放宽导入/解释执行保护、取消 linux.do 默认禁用 JS。普通脚本失败不再阻断独立脚本或丢弃 DOM，只有失控任务会重建 VM；启用 JS 时排除 noscript 内容和资源，呈现实际启动状态。

所有十组本地测试与六项渲染回归通过；另外五个线上局部行为回归通过。**这些回归通过不等于该真实网站兼容通过。** 本页真实网站仍明确失败。

## 历史对照：解除限制前

2026-10-16 15:56 UTC 的版本 `1bad7eb5-3c64-4a02-80e2-6979992ee056`，运行代码 `9ecba45`：93 个渲染资源下载完毕，但中文语言包超过 512 KiB，脚本执行数 0，输出为静态回退。

![旧版静态回退](images/worker-linux-topic-2999210.png)

## 复现

通过私有环境提供 `QJSB_KEY` 和 `QJSB_RELAY_IP`，然后执行：

```bash
node test/real-site-remote.mjs
```

默认测试上述地址，可用 `QJSB_REAL_URL` 指定另一个真实网址。截图、DOM 与诊断保存在 `.cache/real-site/`。脚本保留本次 Durable Object ID，供平台 CPU 精确过滤；应用未完成时返回退出码 2，网络或截图失败时返回 1，不把生成 PNG 算作网站兼容通过。
