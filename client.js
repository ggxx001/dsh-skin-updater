window.__ModuleLoader__.load({
	id: "@ggxx/dsh-skin-updater",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const ROUTE = "/api/dsh/skin-updates";
		const ANCHOR = "[data-dsh-skin-manager]";
		const MARK = "data-dsh-skin-updates";
		const STYLE_ID = "dsh-skin-updates-style";

		const CARD = "display:grid;gap:10px;margin:16px 0 28px;padding:14px 16px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);";

		let panel = null;
		let snapshot = null;
		let busy = null;
		let status = null;
		let observer = null;
		let timer = null;

		function isZh() {
			const lang = document.documentElement.lang || navigator.language || "en";
			return String(lang).toLowerCase().startsWith("zh");
		}

		function t(zh, en) {
			return isZh() ? zh : en;
		}

		async function request(method, body, query) {
			const init = { method, headers: { accept: "application/json" } };
			if (body !== undefined) {
				init.headers["content-type"] = "application/json";
				init.body = JSON.stringify(body);
			}
			const response = await fetch(ROUTE + (query === undefined ? "" : query), init);
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data.error === undefined ? "HTTP " + response.status : data.error);
			return data;
		}

		function node(tag, style, children) {
			const element = document.createElement(tag);
			if (style !== undefined) element.style.cssText = style;
			if (children !== undefined) {
				const list = Array.isArray(children) ? children : [children];
				for (const child of list) {
					if (child === null || child === undefined) continue;
					element.append(typeof child === "string" ? document.createTextNode(child) : child);
				}
			}
			return element;
		}

		function ensureStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = [
				"[" + MARK + "] button{font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}",
				"[" + MARK + "] button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}",
				"[" + MARK + "] button:disabled{opacity:.45;cursor:default}",
				"[" + MARK + "] input[type=checkbox]{width:14px;height:14px;margin:0;cursor:pointer}"
			].join("\n");
			(document.head === null ? document.documentElement : document.head).append(style);
		}

		function errorText(error) {
			return error instanceof Error ? error.message : String(error);
		}

		function render() {
			if (panel === null) return;
			const settings = snapshot === null || snapshot.settings === undefined ? { autoUpdate: false } : snapshot.settings;
			const skins = snapshot === null || snapshot.skins === undefined ? [] : snapshot.skins;
			panel.replaceChildren();

			panel.append(node("div", "display:flex;align-items:center;justify-content:space-between;gap:10px;", [
				node("h3", "margin:0;font-size:14px;font-weight:600;", t("更新", "Updates")),
				(() => {
					const button = node("button", undefined, busy === "check" ? t("检查中…", "Checking…") : t("检查更新", "Check updates"));
					button.type = "button";
					button.disabled = busy !== null;
					button.addEventListener("click", () => refresh("?force=1"));
					return button;
				})()
			]));

			const box = document.createElement("input");
			box.type = "checkbox";
			box.checked = settings.autoUpdate === true;
			box.disabled = busy !== null;
			box.addEventListener("change", () => toggleAuto(box.checked));

			panel.append(node("label", "display:flex;align-items:center;gap:10px;cursor:pointer;", [
				box,
				node("span", "display:grid;gap:2px;", [
					node("span", "font-size:13px;font-weight:600;", t("自动更新", "Auto update")),
					node("span", "font-size:12px;color:var(--dsw-alias-label-tertiary);", settings.lastRun === undefined
						? t("尚未自动检查", "No automatic check yet")
						: t("上次自动检查：", "Last automatic check: ") + settings.lastRun)
				])
			]));

			if (skins.length === 0) {
				panel.append(node("p", "margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);", t("未发现皮肤包。", "No skin packages found.")));
			}

			for (const skin of skins) {
				const title = skin.title === skin.name && skin.name.endsWith("-manager") ? t("皮肤管理器", "Skin manager") : skin.title;
				const meta = t("已装 ", "installed ") + skin.version + (skin.latest === null || skin.latest === undefined ? "" : " · " + t("最新 ", "latest ") + skin.latest);
				const button = node("button", undefined, busy === skin.name ? t("更新中…", "Updating…") : skin.hasUpdate === true ? t("更新", "Update") : t("已是最新", "Up to date"));
				button.type = "button";
				button.disabled = busy !== null || skin.hasUpdate !== true;
				button.addEventListener("click", () => update(skin.name));
				panel.append(node("div", "display:flex;align-items:center;justify-content:space-between;gap:10px;", [
					node("span", "display:grid;gap:2px;min-width:0;", [
						node("span", "font-size:13px;font-weight:600;", title),
						node("span", "font-size:12px;color:var(--dsw-alias-label-tertiary);", skin.name),
						node("span", "font-size:12px;color:var(--dsw-alias-label-secondary);", meta)
					]),
					button
				]));
			}

			if (status !== null) {
				panel.append(node("p", "margin:0;font-size:12px;color:" + (status.kind === "error" ? "var(--dsw-alias-state-danger)" : "var(--dsw-alias-label-secondary)") + ";", status.text));
			}
		}

		async function refresh(query) {
			busy = "check";
			render();
			try {
				snapshot = await request("GET", undefined, query);
				status = null;
			} catch (error) {
				status = { kind: "error", text: t("检查失败：", "Check failed: ") + errorText(error) };
			} finally {
				busy = null;
				render();
			}
		}

		async function update(name) {
			busy = name;
			status = null;
			render();
			try {
				const data = await request("POST", { action: "update", package: name });
				status = {
					kind: "ok",
					text: data.status === "up-to-date" ? t("已是最新版本。", "Already up to date.") : t("更新完成，重启 DSH 后生效。", "Updated. Restart DSH to apply.")
				};
				snapshot = await request("GET", undefined, "?force=1");
			} catch (error) {
				status = { kind: "error", text: t("更新失败：", "Update failed: ") + errorText(error) };
			} finally {
				busy = null;
				render();
			}
		}

		async function toggleAuto(enabled) {
			try {
				const data = await request("POST", { action: "settings", autoUpdate: enabled });
				if (snapshot !== null) snapshot.settings = data.settings;
				status = { kind: "ok", text: enabled ? t("已开启自动更新。", "Auto update is on.") : t("已关闭自动更新。", "Auto update is off.") };
			} catch (error) {
				status = { kind: "error", text: t("保存失败：", "Save failed: ") + errorText(error) };
			}
			render();
		}

		function detach() {
			if (panel !== null && panel.isConnected) panel.remove();
		}

		function mount() {
			const anchor = document.querySelector(ANCHOR);
			if (anchor === null || anchor.parentElement === null) {
				detach();
				return;
			}
			if (panel === null) {
				ensureStyle();
				panel = node("section", CARD);
				panel.setAttribute(MARK, "");
			}
			const container = anchor.parentElement;
			if (panel.parentElement !== container || panel.previousElementSibling !== anchor) {
				container.insertBefore(panel, anchor.nextSibling);
			}
			if (snapshot === null) refresh();
		}

		function schedule() {
			if (timer !== null) return;
			timer = window.setTimeout(() => {
				timer = null;
				mount();
			}, 120);
		}

		function start() {
			if (observer !== null) return;
			observer = new MutationObserver(() => {
				if (document.hidden !== true) schedule();
			});
			observer.observe(document.documentElement, { childList: true, subtree: true });
			schedule();
		}

		function stop() {
			if (observer !== null) {
				observer.disconnect();
				observer = null;
			}
			if (timer !== null) {
				window.clearTimeout(timer);
				timer = null;
			}
			detach();
			if (panel !== null) {
				panel = null;
				snapshot = null;
			}
		}

		const inject = [];

		function apply(ctx) {
			if (ctx !== undefined && typeof ctx.effect === "function") {
				ctx.effect(() => {
					start();
					return () => stop();
				}, "dsh-skin-updater: skin manager update panel");
				return;
			}
			start();
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
