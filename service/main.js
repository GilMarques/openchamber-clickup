// Local service for the ClickUp Tasks extension: opens note files in Obsidian.
//
// Spawned by the OpenChamber host on the panel's first serviceRequest. Runs
// with the user's full access (like every guest service) but only answers two
// routes on 127.0.0.1 and only launches files inside the user's home folder.
// The host owns auth (bearer token), spawn, and the loopback proxy; the panel
// never sees the port or the token.
//
// Routes (all require `Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN`):
//   GET  /health          -> 200 { ok: true }
//   POST /open { dir, taskId } -> 200 { ok: true, uri } and launches Obsidian
//     on obsidian://open?path=<absolute file>. `dir` may use ~/ ; the resolved
//     file must stay inside the home folder, and the task id is strictly
//     validated, so this endpoint cannot become a generic launcher.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const expandHome = (value) => {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65536) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

const launch = (uri) =>
  new Promise((resolve) => {
    // The host starts services with a sanitized environment (PATH, HOME, temp,
    // locale only), which cannot reach the graphical session on its own.
    // Rebuild the missing session pieces from their well-known per-user paths
    // so xdg-open can find its handlers and talk to the desktop. In particular
    // xdg-open needs XDG_DATA_DIRS to include the flatpak export dirs, or it
    // never finds the obsidian:// handler. Never overrides what is set.
    const withSession = () => {
      const env = { ...process.env };
      const home = os.homedir();
      if (!env.XDG_DATA_HOME) env.XDG_DATA_HOME = `${home}/.local/share`;
      if (!env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = `${home}/.config`;
      if (!env.XDG_DATA_DIRS) {
        env.XDG_DATA_DIRS = [
          `${home}/.local/share/flatpak/exports/share`,
          "/var/lib/flatpak/exports/share",
          "/usr/local/share",
          "/usr/share",
        ].join(":");
      }
      let uid = null;
      try {
        uid = os.userInfo().uid;
      } catch {
        uid = null;
      }
      if (typeof uid === "number") {
        const runtimeDir = `/run/user/${uid}`;
        if (!env.XDG_RUNTIME_DIR && fs.existsSync(runtimeDir)) env.XDG_RUNTIME_DIR = runtimeDir;
        const bus = `${runtimeDir}/bus`;
        if (!env.DBUS_SESSION_BUS_ADDRESS && fs.existsSync(bus)) {
          env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
        }
        if (!env.WAYLAND_DISPLAY && fs.existsSync(`${runtimeDir}/wayland-0`)) {
          env.WAYLAND_DISPLAY = "wayland-0";
        }
      }
      if (!env.DISPLAY && fs.existsSync("/tmp/.X11-unix/X0")) env.DISPLAY = ":0";
      return env;
    };
    const child = spawn("xdg-open", [uri], { stdio: "ignore", env: withSession() });
    const timer = setTimeout(() => {
      child.kill();
      console.error(`xdg-open timed out for ${uri}`);
      resolve({ ok: false, error: "xdg-open timed out" });
    }, 10000);
    child.on("error", (error) => {
      clearTimeout(timer);
      console.error(`could not launch ${uri}: ${error.message}`);
      resolve({ ok: false, error: `could not launch Obsidian: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      console.error(`xdg-open exited with status ${code} for ${uri}`);
      resolve({ ok: false, error: `xdg-open exited with status ${code}` });
    });
  });

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/open") {
    readBody(req).then(
      async (raw) => {
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          json(res, 400, { ok: false, error: "body must be JSON" });
          return;
        }
        const taskId = String(payload.taskId ?? "");
        if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
          json(res, 400, { ok: false, error: "bad task id" });
          return;
        }
        const dir = path.resolve(expandHome(String(payload.dir ?? "")));
        if (dir !== os.homedir() && !dir.startsWith(os.homedir() + path.sep)) {
          json(res, 400, { ok: false, error: "directory must be inside the home folder" });
          return;
        }
        const file = path.join(dir, `${taskId}.md`);
        const uri = `obsidian://open?path=${encodeURIComponent(file)}`;
        const result = await launch(uri);
        if (!result.ok) {
          json(res, 500, { ok: false, error: result.error });
          return;
        }
        json(res, 200, { ok: true, uri });
      },
      () => json(res, 400, { ok: false, error: "unreadable body" }),
    );
    return;
  }
  json(res, 404, { ok: false, error: "not-found" });
});

server.listen(port, "127.0.0.1");
