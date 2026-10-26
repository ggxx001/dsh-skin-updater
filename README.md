# 皮肤更新 / Skin Updates

在 DSH 的 **设置 → 皮肤管理** 页面底部追加一张「更新」卡片（不改动第三方皮肤管理器包）：

- 每款已安装皮肤显示「已装版本 · 最新版本」，有新版时可点击「更新」。
- 「自动更新」勾选：开启后 DSH 启动约 90 秒检查一次，此后每 6 小时检查并更新。
- 下载固定优先使用国内镜像 `https://registry.npmmirror.com`，失败自动回退官方源，不依赖 GitHub。
- 更新复用 DSH 自带的 `pluginManager.installBundle`，包清单、锁文件与启用状态由 DSH 维护。

实现方式：客户端用 MutationObserver 监听 `[data-dsh-skin-manager]` 页面，把卡片插到页面内容之后；
宿主端提供 `/api/dsh/skin-updates` 接口。设置保存在 `<DSH_HOME>/skin-updater/settings.json`。
