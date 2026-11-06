import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PACKAGER_PORT || 3920);

const FILES = {
  packageJson: path.join(ROOT, "package.json"),
  tauriConf: path.join(ROOT, "src-tauri", "tauri.conf.json"),
  cargoToml: path.join(ROOT, "src-tauri", "Cargo.toml"),
};

let buildProc = null;
let cleanProc = null;
const sseClients = new Set();

const TARGET_DIR = path.join(ROOT, "src-tauri", "target");
const DIST_DIR = path.join(ROOT, "dist");

function dirSizeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      try {
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      } catch {
        /* locked / deleted mid-scan */
      }
    }
  }
  return total;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function diskUsage() {
  const target = dirSizeBytes(TARGET_DIR);
  const dist = dirSizeBytes(DIST_DIR);
  return {
    target,
    dist,
    total: target + dist,
    targetLabel: formatBytes(target),
    distLabel: formatBytes(dist),
    totalLabel: formatBytes(target + dist),
  };
}

function busy() {
  return Boolean(buildProc || cleanProc);
}

function readVersions() {
  const pkg = JSON.parse(fs.readFileSync(FILES.packageJson, "utf8"));
  const tauri = JSON.parse(fs.readFileSync(FILES.tauriConf, "utf8"));
  const cargo = fs.readFileSync(FILES.cargoToml, "utf8");
  const cargoMatch = cargo.match(/^version\s*=\s*"([^"]+)"/m);
  return {
    packageJson: pkg.version,
    tauriConf: tauri.version,
    cargoToml: cargoMatch?.[1] ?? "",
    productName: tauri.productName ?? "",
  };
}

function currentVersion() {
  const v = readVersions();
  return v.packageJson || v.tauriConf || v.cargoToml || "0.0.0";
}

function parseSemver(v) {
  const m = String(v)
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function bump(v, kind) {
  const p = parseSemver(v);
  if (!p) return v;
  if (kind === "major") return `${p.major + 1}.0.0`;
  if (kind === "minor") return `${p.major}.${p.minor + 1}.0`;
  return `${p.major}.${p.minor}.${p.patch + 1}`;
}

function proposeNext(v) {
  return {
    patch: bump(v, "patch"),
    minor: bump(v, "minor"),
    major: bump(v, "major"),
  };
}

function writeVersions(next) {
  if (!/^\d+\.\d+\.\d+$/.test(next)) {
    throw new Error(`版本号格式无效：${next}`);
  }

  const pkg = JSON.parse(fs.readFileSync(FILES.packageJson, "utf8"));
  pkg.version = next;
  fs.writeFileSync(FILES.packageJson, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  const tauri = JSON.parse(fs.readFileSync(FILES.tauriConf, "utf8"));
  tauri.version = next;
  fs.writeFileSync(FILES.tauriConf, `${JSON.stringify(tauri, null, 2)}\n`, "utf8");

  let cargo = fs.readFileSync(FILES.cargoToml, "utf8");
  cargo = cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${next}"`);
  fs.writeFileSync(FILES.cargoToml, cargo, "utf8");
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function estimateProgress(line, prev) {
  let next = prev;
  const text = line.replace(/\u001b\[[0-9;]*m/g, "");

  if (/Running beforeBuildCommand|npm run build|vite build/i.test(text)) {
    next = Math.max(next, 8);
  }
  if (/✓ built|built in/i.test(text)) {
    next = Math.max(next, 22);
  }
  if (/Compiling|Building/i.test(text)) {
    next = Math.max(next, 28);
  }
  const cargoPct = text.match(/\[([=>\- ]+)\]\s*(\d+)\/(\d+)/);
  if (cargoPct) {
    const cur = Number(cargoPct[2]);
    const total = Number(cargoPct[3]) || 1;
    next = Math.max(next, 28 + Math.floor((cur / total) * 45));
  }
  if (/Finished .*release|Finished `release`/i.test(text)) {
    next = Math.max(next, 78);
  }
  if (/Built application|Patching|Target: x64/i.test(text)) {
    next = Math.max(next, 84);
  }
  if (/Running makensis|produce .*setup\.exe/i.test(text)) {
    next = Math.max(next, 90);
  }
  if (/Finished \d+ bundle/i.test(text)) {
    next = Math.max(next, 100);
  }
  return Math.min(100, next);
}

function findInstaller(version) {
  const nsisDir = path.join(
    ROOT,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "nsis",
  );
  if (!fs.existsSync(nsisDir)) return null;
  const files = fs
    .readdirSync(nsisDir)
    .filter((f) => f.toLowerCase().endsWith("-setup.exe"))
    .map((f) => ({
      name: f,
      path: path.join(nsisDir, f),
      mtime: fs.statSync(path.join(nsisDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  const preferred = files.find((f) => f.name.includes(version));
  return preferred ?? files[0] ?? null;
}

function startClean() {
  if (busy()) {
    throw new Error("已有任务在进行中，请稍后再清理");
  }

  const before = diskUsage();
  broadcast("status", {
    running: true,
    kind: "clean",
    progress: 5,
    message: `正在清理构建缓存（当前 ${before.totalLabel}）…`,
  });
  broadcast("log", {
    text: `$ cargo clean\n# 并删除 dist/\n# 清理前：target ${before.targetLabel} · dist ${before.distLabel}\n`,
  });

  cleanProc = spawn("cargo clean", {
    cwd: path.join(ROOT, "src-tauri"),
    env: { ...process.env, FORCE_COLOR: "0" },
    shell: true,
    windowsHide: true,
  });

  const onChunk = (buf) => {
    const text = buf.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      broadcast("log", { text: `${line}\n` });
      broadcast("status", {
        running: true,
        kind: "clean",
        progress: 45,
        message: line.slice(0, 160),
      });
    }
  };

  cleanProc.stdout.on("data", onChunk);
  cleanProc.stderr.on("data", onChunk);

  cleanProc.on("error", (err) => {
    cleanProc = null;
    broadcast("log", { text: `${err.message}\n` });
    broadcast("status", {
      running: false,
      kind: "clean",
      progress: 0,
      ok: false,
      message: `清理失败：${err.message}`,
      disk: diskUsage(),
    });
  });

  cleanProc.on("close", (code) => {
    cleanProc = null;
    broadcast("status", {
      running: true,
      kind: "clean",
      progress: 80,
      message: "正在删除前端 dist…",
    });

    try {
      if (fs.existsSync(DIST_DIR)) {
        fs.rmSync(DIST_DIR, { recursive: true, force: true });
        broadcast("log", { text: "已删除 dist/\n" });
      } else {
        broadcast("log", { text: "dist/ 不存在，跳过\n" });
      }
    } catch (e) {
      broadcast("log", { text: `删除 dist 失败：${e.message}\n` });
    }

    const after = diskUsage();
    const freed = Math.max(0, before.total - after.total);
    if (code === 0) {
      broadcast("log", {
        text: `# 清理完成：释放约 ${formatBytes(freed)}，当前 ${after.totalLabel}\n`,
      });
      broadcast("status", {
        running: false,
        kind: "clean",
        progress: 100,
        ok: true,
        message: `清理完成，约释放 ${formatBytes(freed)}（当前 ${after.totalLabel}）`,
        disk: after,
      });
    } else {
      broadcast("status", {
        running: false,
        kind: "clean",
        progress: after.total ? 60 : 100,
        ok: false,
        message: `cargo clean 退出码 ${code}（当前 ${after.totalLabel}）`,
        disk: after,
      });
    }
  });
}

function startBuild() {
  if (busy()) {
    throw new Error("已有任务在进行中");
  }

  let progress = 2;
  broadcast("status", {
    running: true,
    kind: "build",
    progress,
    message: "开始打包…",
  });
  broadcast("log", { text: `$ npm run build:installer\n` });

  // Windows 下直接 spawn npm.cmd 常会报 spawn EINVAL，需走 shell。
  buildProc = spawn("npm run build:installer", {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: "0" },
    shell: true,
    windowsHide: true,
  });

  const onChunk = (buf) => {
    const text = buf.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      progress = estimateProgress(line, progress);
      broadcast("log", { text: `${line}\n` });
      broadcast("status", {
        running: true,
        kind: "build",
        progress,
        message: line.slice(0, 160),
      });
    }
  };

  buildProc.stdout.on("data", onChunk);
  buildProc.stderr.on("data", onChunk);

  buildProc.on("error", (err) => {
    buildProc = null;
    broadcast("log", { text: `${err.message}\n` });
    broadcast("status", {
      running: false,
      kind: "build",
      progress,
      ok: false,
      message: `启动打包失败：${err.message}`,
    });
  });

  buildProc.on("close", (code) => {
    buildProc = null;
    const version = currentVersion();
    const installer = findInstaller(version);
    if (code === 0) {
      broadcast("status", {
        running: false,
        kind: "build",
        progress: 100,
        ok: true,
        message: "打包完成",
        installer: installer
          ? { name: installer.name, path: installer.path }
          : null,
        disk: diskUsage(),
      });
    } else {
      broadcast("status", {
        running: false,
        kind: "build",
        progress,
        ok: false,
        message: `打包失败（退出码 ${code}）`,
      });
    }
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const htmlPath = path.join(__dirname, "index.html");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(htmlPath));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/version") {
    const current = currentVersion();
    sendJson(res, 200, {
      current,
      files: readVersions(),
      propose: proposeNext(current),
      building: busy(),
      disk: diskUsage(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/build") {
    try {
      const body = await readBody(req);
      if (body.version) {
        writeVersions(String(body.version).trim());
      }
      startBuild();
      sendJson(res, 200, { ok: true, current: currentVersion() });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/clean") {
    try {
      startClean();
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/open-folder") {
    try {
      const body = await readBody(req);
      const target = body.path
        ? path.dirname(String(body.path))
        : path.join(ROOT, "src-tauri", "target", "release", "bundle", "nsis");
      if (process.platform === "win32") {
        spawn("explorer", [target], { detached: true, stdio: "ignore" }).unref();
      }
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`青枝打包工具已启动：${url}`);
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
});
