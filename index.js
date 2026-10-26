import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const name = "dsh-skin-updater";
export const inject = ["webServer"];

const ROUTE = "/api/dsh/skin-updates";
const MIRROR = "https://registry.npmmirror.com";
const FALLBACK_REGISTRY = "https://registry.npmjs.org";
const SKIN_PATTERN = /^@smalltailqwq\/dsh-client-ui-skin-/;
const REGISTRY_CACHE_MS = 10 * 60 * 1000;
const AUTO_FIRST_DELAY_MS = 90 * 1000;
const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;

function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
  return join(homedir(), ".dsh");
}

function resolveProfileDir(ctx) {
  try {
    const raw = ctx.baseUrl;
    if (typeof raw === "string" && raw.startsWith("file:")) {
      const target = fileURLToPath(raw);
      const dir = existsSync(target) && statSync(target).isDirectory() ? target : dirname(target);
      if (basename(dirname(dir)) === "profiles") return dir;
    }
  } catch {}
  const explicit = process.env.DSH_SKIN_PROFILE || process.env.DSH_PROFILE;
  const profile = typeof explicit === "string" && explicit.trim() !== "" ? explicit.trim() : "web";
  return join(dshHome(), "profiles", profile);
}

function readSkins(profileDir) {
  const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
  const dependencies = manifest.dependencies === undefined ? {} : manifest.dependencies;
  const skins = [];
  for (const packageName of Object.keys(dependencies)) {
    if (!SKIN_PATTERN.test(packageName)) continue;
    const packageDir = join(profileDir, "node_modules", packageName);
    let version;
    let title;
    let id;
    try {
      version = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
    } catch {}
    try {
      const skin = JSON.parse(readFileSync(join(packageDir, "skin.json"), "utf8"));
      if (typeof skin.name === "string" && skin.name.trim() !== "") title = skin.name;
      if (typeof skin.id === "string") id = skin.id;
    } catch {}
    if (typeof version !== "string") continue;
    skins.push({ name: packageName, version, title: title === undefined ? packageName : title, id });
  }
  skins.sort((a, b) => a.name.localeCompare(b.name));
  return skins;
}

const registryCache = new Map();

async function fetchLatest(packageName, force) {
  const hit = registryCache.get(packageName);
  if (force !== true && hit !== undefined && Date.now() - hit.at < REGISTRY_CACHE_MS) return hit.value;
  let lastError;
  for (const base of [MIRROR, FALLBACK_REGISTRY]) {
    try {
      const url = base + "/" + packageName.replace("/", "%2F");
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("registry " + response.status);
      const meta = await response.json();
      const latest = meta["dist-tags"] === undefined ? undefined : meta["dist-tags"].latest;
      if (typeof latest !== "string") throw new Error("registry has no latest tag");
      registryCache.set(packageName, { at: Date.now(), value: latest });
      return latest;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError === undefined ? new Error("registry-unreachable") : lastError;
}

function versionParts(value) {
  const core = String(value).split("-")[0];
  return core.split(".").map((part) => {
    const number = Number.parseInt(part, 10);
    return Number.isFinite(number) ? number : 0;
  });
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] === undefined ? 0 : a[index]) - (b[index] === undefined ? 0 : b[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isNewer(latest, installed) {
  return compareVersions(latest, installed) > 0;
}

function settingsFile() {
  return join(dshHome(), "skin-updater", "settings.json");
}

async function readSettings() {
  try {
    const raw = JSON.parse(await readFile(settingsFile(), "utf8"));
    return {
      autoUpdate: raw.autoUpdate === true,
      lastRun: typeof raw.lastRun === "string" ? raw.lastRun : undefined,
      lastResult: typeof raw.lastResult === "string" ? raw.lastResult : undefined
    };
  } catch {
    return { autoUpdate: false };
  }
}

async function writeSettings(next) {
  const file = settingsFile();
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(next, undefined, 2), "utf8");
  await rename(temporary, file);
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body-too-large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.trim() === "" ? {} : JSON.parse(text));
      } catch {
        reject(new Error("invalid-json"));
      }
    });
    request.on("error", reject);
  });
}

function summarizeInstall(result) {
  if (typeof result !== "object" || result === null) return undefined;
  const summary = {};
  for (const key of ["bundle", "version", "stage", "restartRequired", "failedAt"]) {
    if (result[key] !== undefined) summary[key] = result[key];
  }
  return summary;
}

async function updateOne(ctx, profileDir, packageName) {
  if (typeof packageName !== "string" || !SKIN_PATTERN.test(packageName)) throw new Error("not-a-skin-package");
  const skin = readSkins(profileDir).find((item) => item.name === packageName);
  if (skin === undefined) throw new Error("skin-not-installed");
  const latest = await fetchLatest(packageName, true);
  if (!isNewer(latest, skin.version)) return { package: packageName, status: "up-to-date", version: skin.version };
  const manager = ctx.get("pluginManager");
  if (manager === undefined || typeof manager.installBundle !== "function") throw new Error("plugin-manager-unavailable");
  const result = await manager.installBundle(packageName + "@" + latest, { registry: MIRROR });
  return {
    package: packageName,
    status: "updated",
    from: skin.version,
    to: latest,
    detail: summarizeInstall(result)
  };
}

async function handle(ctx, profileDir, request, response) {
  if (!sameOrigin(request)) {
    sendJson(response, 403, { ok: false, error: "cross-site-request-rejected" });
    return;
  }
  let url;
  try {
    url = new URL(request.url, "http://localhost");
  } catch {
    sendJson(response, 400, { ok: false, error: "invalid-url" });
    return;
  }
  try {
    if (request.method === "GET") {
      const force = url.searchParams.get("force") === "1";
      const settings = await readSettings();
      const rows = [];
      for (const skin of readSkins(profileDir)) {
        let latest;
        let error;
        try {
          latest = await fetchLatest(skin.name, force);
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure);
        }
        rows.push({
          ...skin,
          latest: latest === undefined ? null : latest,
          hasUpdate: latest !== undefined && isNewer(latest, skin.version),
          ...(error === undefined ? {} : { error })
        });
      }
      sendJson(response, 200, { ok: true, registry: MIRROR, settings, skins: rows });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method-not-allowed" });
      return;
    }
    const body = await readBody(request);
    if (body.action === "settings") {
      const current = await readSettings();
      const next = { ...current, autoUpdate: body.autoUpdate === true };
      await writeSettings(next);
      sendJson(response, 200, { ok: true, settings: next });
      return;
    }
    if (body.action === "update") {
      const result = await updateOne(ctx, profileDir, body.package);
      sendJson(response, 200, { ok: true, ...result });
      return;
    }
    sendJson(response, 400, { ok: false, error: "unknown-action" });
  } catch (failure) {
    sendJson(response, 500, { ok: false, error: failure instanceof Error ? failure.message : String(failure) });
  }
}

function startAutoUpdate(ctx, profileDir) {
  let stopped = false;
  let timer;
  const run = async () => {
    const settings = await readSettings();
    if (settings.autoUpdate !== true) return;
    const notes = [];
    for (const skin of readSkins(profileDir)) {
      try {
        const latest = await fetchLatest(skin.name, true);
        if (!isNewer(latest, skin.version)) continue;
        const manager = ctx.get("pluginManager");
        if (manager === undefined || typeof manager.installBundle !== "function") {
          notes.push("plugin-manager-unavailable");
          break;
        }
        await manager.installBundle(skin.name + "@" + latest, { registry: MIRROR });
        notes.push(skin.name + ": " + skin.version + " -> " + latest);
      } catch (failure) {
        notes.push(skin.name + ": " + (failure instanceof Error ? failure.message : String(failure)));
      }
    }
    const current = await readSettings();
    await writeSettings({
      ...current,
      autoUpdate: current.autoUpdate,
      lastRun: new Date().toISOString(),
      lastResult: notes.length === 0 ? "up-to-date" : notes.join("; ")
    });
  };
  const schedule = (delay) => {
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await run();
      } catch {}
      if (!stopped) schedule(AUTO_INTERVAL_MS);
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
  };
  schedule(AUTO_FIRST_DELAY_MS);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

export function apply(ctx) {
  const profileDir = resolveProfileDir(ctx);
  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: "exact",
      path: ROUTE,
      handler: (request, response) => handle(ctx, profileDir, request, response)
    });
    const stopAutoUpdate = startAutoUpdate(ctx, profileDir);
    return () => {
      if (typeof unregister === "function") unregister();
      stopAutoUpdate();
    };
  }, "dsh-skin-updater: update route and automatic updater");
}
