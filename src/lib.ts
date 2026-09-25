// Core of android-minecraft-agent: talks to redroid (Android 13) containers running
// inside a KVM guest, over SSH (docker) and adb.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Size = { w: number; h: number };
export type Container = { id: string; name: string; port: number; status: string; size: Size };

const RUNNING_IDLE_MS = 60 * 60 * 1000;
const PAUSED_IDLE_MS = 2 * 60 * 60 * 1000;

// adb shell and ssh execute strings through a shell, even when Bun receives an argv array.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export type Cfg = {
  adb: string;
  sshKey: string;
  sshTarget: string;
  sshPort: string;
  image: string;
  gpuMode: string;
  docker: string;
  portBase: number;
  cacheFile: string;
  cacheMs: number;
};

export function loadCfg(env: Record<string, string | undefined> = process.env): Cfg {
  const home = env.HOME ?? ".";
  const cacheHome = env.XDG_CACHE_HOME ?? `${home}/.cache`;
  return {
    adb: env.MC_ADB ?? "adb",
    sshKey: env.MC_SSH_KEY ?? `${home}/.ssh/mc-android`,
    sshTarget: env.MC_SSH_TARGET ?? "root@127.0.0.1",
    sshPort: env.MC_SSH_PORT ?? "2222",
    image: env.MC_IMAGE ?? "redroid/redroid:13.0.0-latest",
    gpuMode: env.MC_GPU_MODE ?? "host",
    // Guest docker command. Default assumes the SSH user is in the docker group (no sudo).
    docker: env.MC_DOCKER ?? "docker",
    portBase: Number(env.MC_PORT_BASE ?? 5555),
    cacheFile: env.MC_CACHE ?? `${cacheHome}/mc-android/instances.json`,
    cacheMs: Number(env.MC_CACHE_MS ?? 3000),
  };
}

export class Mc {
  readonly cfg: Cfg;
  private sizes = new Map<number, Size>();

  constructor(cfg: Cfg = loadCfg()) {
    this.cfg = cfg;
  }

  private async run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out, err };
  }
  private async runBin(cmd: string[]): Promise<{ code: number; buf: Uint8Array; err: string }> {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [buf, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
    return { code: await p.exited, buf: new Uint8Array(buf), err };
  }
  private async runBinIn(cmd: string[], input: Uint8Array): Promise<{ code: number; buf: Uint8Array; err: string }> {
    const p = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write(input);
    await p.stdin.end();
    const [buf, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
    return { code: await p.exited, buf: new Uint8Array(buf), err };
  }

  private ssh(cmd: string) {
    return this.run([
      "ssh", "-i", this.cfg.sshKey, "-p", this.cfg.sshPort,
      "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR",
      this.cfg.sshTarget, cmd,
    ]);
  }
  private dev(port: number) { return `127.0.0.1:${port}`; }
  private adb(port: number, args: string[]) { return this.run([this.cfg.adb, "-s", this.dev(port), ...args]); }
  private sh(port: number, cmd: string) { return this.adb(port, ["shell", cmd]); }
  private sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

  private async dm(cmd: string): Promise<string> {
    const r = await this.ssh(`${this.cfg.docker} ${cmd}`);
    if (r.code !== 0) throw new Error(r.err.trim() || `docker ${cmd} failed`);
    if (/^(run|start|unpause|pause|rm)\b/.test(cmd)) await this.clearCache();
    return r.out;
  }

  // Resolving an instance costs an SSH `docker ps` round-trip (~165ms), so cache the list
  // briefly (on disk, so short-lived CLI invocations benefit too).
  private async readCache(): Promise<Container[] | null> {
    try {
      const j = JSON.parse(await readFile(this.cfg.cacheFile, "utf8"));
      if (Date.now() - j.at < this.cfg.cacheMs) return j.data as Container[];
    } catch {}
    return null;
  }
  private async writeCache(data: Container[]) {
    try {
      await mkdir(dirname(this.cfg.cacheFile), { recursive: true });
      await writeFile(this.cfg.cacheFile, JSON.stringify({ at: Date.now(), data }));
    } catch {}
  }
  async clearCache() { try { await rm(this.cfg.cacheFile, { force: true }); } catch {} }

  private activityFile(id: string) { return `${this.cfg.cacheFile}.activity-${encodeURIComponent(id)}`; }
  private async lastActivity(id: string): Promise<number | null> {
    try {
      const at = Number(await readFile(this.activityFile(id), "utf8"));
      return Number.isFinite(at) && at > 0 ? at : null;
    } catch { return null; }
  }
  private async markActivity(id: string, at = Date.now()) {
    await mkdir(dirname(this.cfg.cacheFile), { recursive: true });
    await writeFile(this.activityFile(id), String(at));
  }

  async containers(force = false): Promise<Container[]> {
    if (!force) {
      const c = await this.readCache();
      if (c) return c;
    }
    const out = await this.dm(`ps -a --filter label=mc.role=client --format '{{.Names}}\\t{{.Label "mc.port"}}\\t{{.Label "mc.size"}}\\t{{.Status}}'`);
    const data: Container[] = out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [name, port, size, status] = l.split("\t");
        const [w, h] = (size || "854x480").split("x").map(Number);
        if (Number(port)) this.sizes.set(Number(port), { w, h });
        return { id: name.replace(/^mc-/, ""), name, port: Number(port), status: status || "", size: { w, h } };
      });
    await this.writeCache(data);
    return data;
  }
  async resolve(id?: string): Promise<Container> {
    const cs = await this.containers();
    const c = id
      ? cs.find((x) => x.id === id && isRunning(x)) ?? cs.find((x) => x.id === id)
      : cs.find((x) => isRunning(x));
    if (!c) throw new Error(id ? `instance ${id} not found` : "no running instance; run `mc launch` first");
    if (!isRunning(c)) throw new Error(`instance ${c.id} is not running (${isPaused(c) ? "paused - run `mc launch` to resume in ~1s" : c.status})`);
    // Idempotent; recovers the adb connection after a VM restart.
    await this.adb(c.port, ["connect", this.dev(c.port)]);
    await this.markActivity(c.id);
    return c;
  }
  private async nextPort(): Promise<number> {
    const used = new Set((await this.containers(true)).map((c) => c.port));
    let p = this.cfg.portBase;
    while (used.has(p)) p++;
    return p;
  }
  sizeOf(port: number): Size { return this.sizes.get(port) ?? { w: 854, h: 480 }; }

  private async waitBoot(port: number, timeoutMs = 150_000, intervalMs = 2000): Promise<boolean> {
    await this.adb(port, ["connect", this.dev(port)]);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if ((await this.sh(port, "getprop sys.boot_completed")).out.trim() === "1") return true;
      await this.sleep(intervalMs);
    }
    return false;
  }
  private async startGame(c: Container): Promise<boolean> {
    // A fresh redroid image may boot with setup incomplete, leaving Play downloads Pending.
    await this.sh(c.port, "settings put global device_provisioned 1; settings put secure user_setup_complete 1; settings put system screen_off_timeout 2147483647; svc power stayon true; input keyevent 224");
    const installed = (await this.sh(c.port, "pm path com.mojang.minecraftpe")).out.includes("package:");
    if (installed && !(await this.sh(c.port, "pidof com.mojang.minecraftpe")).out.trim()) {
      await this.sh(c.port, "am start -n com.mojang.minecraftpe/.MainActivity");
    }
    return installed;
  }

  // ---- operations ----
  async launch(opts: { id?: string; dataDir?: string; width?: number; height?: number; fpsCap?: number; waitForMenu?: boolean } = {}) {
    const id = opts.id ?? "main";
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("id may contain only letters, numbers, hyphens, and underscores");
    const name = `mc-${id}`;
    const width = opts.width ?? 854;
    const height = opts.height ?? 480;
    const fps = opts.fpsCap ?? 20;
    if (![width, height, fps].every((n) => Number.isInteger(n) && n > 0)) throw new Error("width, height, and fps must be positive integers");
    const existing = (await this.containers(true)).find((c) => c.id === id);
    if (existing && ((opts.width !== undefined && opts.width !== existing.size.w) || (opts.height !== undefined && opts.height !== existing.size.h))) {
      throw new Error(`instance ${id} is ${existing.size.w}x${existing.size.h}; run mc stop --id ${id} --remove before changing resolution (its /data is preserved)`);
    }
    if (existing && isRunning(existing)) {
      // Container is up; make sure the game is running too.
      this.sizes.set(existing.port, existing.size);
      const installed = await this.startGame(existing);
      if (opts.waitForMenu) await this.sleep(6000);
      await this.markActivity(id);
      return { id, port: existing.port, device: this.dev(existing.port), size: `${existing.size.w}x${existing.size.h}`, warm: true, minecraftInstalled: installed, note: "already running" };
    }

    // Warm path: resume an existing Android system instead of rebooting it (~1s vs ~20s).
    if (existing) {
      this.sizes.set(existing.port, existing.size);
      if (isPaused(existing)) await this.dm(`unpause ${existing.name}`);
      else await this.dm(`start ${existing.name}`);
      const booted = await this.waitBoot(existing.port, isPaused(existing) ? 30_000 : 150_000, isPaused(existing) ? 300 : 2000);
      if (!booted) throw new Error(`instance ${id} did not resume`);
      const installed = await this.startGame(existing);
      if (opts.waitForMenu) await this.sleep(6000);
      await this.markActivity(id);
      return { id, port: existing.port, device: this.dev(existing.port), size: `${existing.size.w}x${existing.size.h}`, warm: true, minecraftInstalled: installed };
    }

    const port = await this.nextPort();
    const dir = opts.dataDir ?? `/data/mc/${id}`;
    await this.dm(`rm -f ${shellQuote(name)} 2>/dev/null || true`);
    await this.dm(
      `run -itd --name ${shellQuote(name)} --privileged --label mc.role=client --label mc.port=${port} --label mc.size=${width}x${height} ` +
        `--device /dev/dri -v ${shellQuote(`${dir}:/data`)} -p ${port}:5555 ${shellQuote(this.cfg.image)} ` +
        `androidboot.redroid_gpu_mode=${shellQuote(this.cfg.gpuMode)} androidboot.use_memfd=true ` +
        `androidboot.redroid_width=${width} androidboot.redroid_height=${height} androidboot.redroid_dpi=160 androidboot.redroid_fps=${fps}`,
    );
    this.sizes.set(port, { w: width, h: height });
    if (!(await this.waitBoot(port))) throw new Error(`instance ${id} did not finish booting`);
    const installed = await this.startGame({ id, name, port, status: "Up", size: { w: width, h: height } });
    if (opts.waitForMenu) await this.sleep(8000);
    await this.markActivity(id);
    return { id, port, device: this.dev(port), size: `${width}x${height}`, warm: false, minecraftInstalled: installed };
  }

  async stop(id?: string, keepWarm = true) {
    const cs = keepWarm ? [] : await this.containers(true);
    const c = keepWarm ? await this.resolve(id) : id
      ? cs.find((x) => x.id === id)
      : cs.find(isRunning) ?? cs.find(isPaused);
    if (!c) throw new Error(id ? `instance ${id} not found` : "no instance found");
    if (keepWarm) {
      await this.dm(`pause ${shellQuote(c.name)}`);
      await this.markActivity(c.id);
      return { id: c.id, paused: true, note: "run `mc launch` to resume in ~1s" };
    }
    await this.adb(c.port, ["disconnect", this.dev(c.port)]);
    await this.dm(`rm -f ${shellQuote(c.name)}`);
    await rm(this.activityFile(c.id), { force: true });
    return { id: c.id, removed: true };
  }

  async cleanup(now = Date.now()) {
    const actions: { id: string; action: "grace" | "pause" | "remove" }[] = [];
    for (const c of await this.containers(true)) {
      let at = await this.lastActivity(c.id);
      if (at === null || at > now) {
        // Existing containers predate activity tracking. Give them a full grace period.
        await this.markActivity(c.id, now);
        actions.push({ id: c.id, action: "grace" });
        continue;
      }
      const age = now - at;
      if (isRunning(c) && age >= RUNNING_IDLE_MS) {
        await this.dm(`pause ${shellQuote(c.name)}`);
        await this.markActivity(c.id, now);
        actions.push({ id: c.id, action: "pause" });
      } else if (!isRunning(c) && age >= PAUSED_IDLE_MS) {
        await this.dm(`rm -f ${shellQuote(c.name)}`);
        await rm(this.activityFile(c.id), { force: true });
        actions.push({ id: c.id, action: "remove" });
      }
    }
    return { actions };
  }

  async list() {
    return (await this.containers(true)).map((c) => ({ id: c.id, device: this.dev(c.port), size: `${c.size.w}x${c.size.h}`, status: c.status }));
  }

  async state(id?: string) {
    const c = await this.resolve(id);
    const r = await this.sh(c.port, "wm size; echo '--'; dumpsys window | grep -m1 mCurrentFocus; echo '--'; getprop sys.boot_completed");
    const [size, focus, boot] = r.out.split("--").map((s) => s.trim());
    return { port: c.port, size, focus, boot, note: "fps/cursor-lock are not available on the Android backend" };
  }

  async screenshot(id?: string, width?: number): Promise<Uint8Array> {
    const c = await this.resolve(id);
    const { buf } = await this.runBin([this.cfg.adb, "-s", this.dev(c.port), "exec-out", "screencap", "-p"]);
    if (!width || width === c.size.w) {
      await this.saveShotScale(c.port, c.size.w, 1);
      return buf;
    }
    const out = await downscalePng(buf, width);
    await this.saveShotScale(c.port, c.size.w, out ? c.size.w / width : 1);
    return out ?? buf;
  }

  private async saveShotScale(port: number, deviceWidth: number, scale: number) {
    const path = `${this.cfg.cacheFile}.shot-${port}`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ deviceWidth, scale }));
  }

  private async shotScale(port: number, deviceWidth: number): Promise<number> {
    try {
      const saved = JSON.parse(await readFile(`${this.cfg.cacheFile}.shot-${port}`, "utf8"));
      if (saved.deviceWidth === deviceWidth && Number.isFinite(saved.scale) && saved.scale > 0) return saved.scale;
    } catch {}
    return 1;
  }

  async click(x: number, y: number, opts: { id?: string; button?: string; action?: string; holdMs?: number } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click needs numeric X Y coordinates");
    if (opts.action && !["tap", "press"].includes(opts.action)) throw new Error("click action must be tap or press");
    if (opts.holdMs !== undefined && (!Number.isInteger(opts.holdMs) || opts.holdMs < 1)) throw new Error("hold-ms must be a positive integer");
    const c = await this.resolve(opts.id);
    const sc = await this.shotScale(c.port, c.size.w);
    const px = Math.round(x * sc), py = Math.round(y * sc);
    const action = opts.action ?? "tap";
    const cmd = action === "tap" ? `input tap ${px} ${py}` : `input swipe ${px} ${py} ${px} ${py} ${opts.holdMs ?? 60}`;
    await this.sh(c.port, cmd);
    return { x: px, y: py, action };
  }

  async type(id: string | undefined, text: string) {
    const c = await this.resolve(id);
    await this.sh(c.port, `input text ${shellQuote(text.replace(/ /g, "%s"))}`);
    return { ok: true };
  }

  async key(id: string | undefined, key: string) {
    const c = await this.resolve(id);
    const code = KEYMAP[key.toLowerCase()];
    if (!code) throw new Error(`unsupported key: ${key}`);
    await this.sh(c.port, `input keyevent KEYCODE_${code}`);
    return { key, android: `KEYCODE_${code}` };
  }

  async holdKey(id: string | undefined, key: string) {
    const c = await this.resolve(id);
    const code = KEYMAP[key.toLowerCase()];
    if (!code) throw new Error(`unsupported key: ${key}`);
    await this.sh(c.port, `input keyevent --longpress KEYCODE_${code}`);
    return { key, note: "longpress; exact duration is not controllable via adb on this backend" };
  }

  async chat(id: string | undefined, message: string) {
    const c = await this.resolve(id);
    const s = this.sizeOf(c.port);
    await this.sh(c.port, `input tap ${Math.round(s.w * 0.5)} ${Math.round(s.h * 0.044)}`);
    await this.sleep(600);
    await this.sh(c.port, `input text ${shellQuote(message.replace(/ /g, "%s"))}`);
    await this.sleep(200);
    await this.sh(c.port, `input tap ${Math.round(s.w * 0.946)} ${Math.round(s.h * 0.385)}`);
    return { ok: true };
  }

  async look(id: string | undefined, dx: number, dy: number) {
    const c = await this.resolve(id);
    const s = this.sizeOf(c.port);
    const x0 = Math.round(s.w / 2), y0 = Math.round(s.h / 2), f = 1.5;
    await this.sh(c.port, `input swipe ${x0} ${y0} ${Math.round(x0 + dx * f)} ${Math.round(y0 + dy * f)} 250`);
    return { ok: true };
  }

  async scroll(id: string | undefined, dy: number) {
    const c = await this.resolve(id);
    const s = this.sizeOf(c.port);
    const x = Math.round(s.w / 2), y = Math.round(s.h * 0.6);
    await this.sh(c.port, `input swipe ${x} ${y} ${x} ${Math.round(y - dy)} 200`);
    return { ok: true };
  }

  async openUri(id: string | undefined, uri: string) {
    if (!uri.startsWith("minecraft:")) throw new Error("uri must start with minecraft:");
    const c = await this.resolve(id);
    await this.sh(c.port, `am start -a android.intent.action.VIEW -d ${shellQuote(uri)}`);
    return { ok: true, uri };
  }
  addServer(id: string | undefined, name: string, address: string) {
    return this.openUri(id, `minecraft://?addExternalServer=${encodeURIComponent(name)}|${encodeURIComponent(address)}`);
  }
  connect(id: string | undefined, host: string, port = 19132) {
    return this.openUri(id, `minecraft://connect?serverUrl=${host}&serverPort=${port}`);
  }

  async log(id: string | undefined, lines = 50) {
    const c = await this.resolve(id);
    const r = await this.sh(c.port, `logcat -d -t ${lines} | grep -iE 'minecraft|mojang|AndroidRuntime|FATAL' | tail -${lines}`);
    return r.out.trim() || "(no matching log lines)";
  }

  wait(ms: number) { return this.sleep(ms); }
}

export function isPaused(c: Container) { return c.status.includes("Paused"); }
export function isRunning(c: Container) { return c.status.startsWith("Up") && !isPaused(c); }

const KEYMAP: Record<string, string> = {
  enter: "ENTER", escape: "ESCAPE", back: "BACK", space: "SPACE", tab: "TAB", delete: "DEL", backspace: "DEL",
  up: "DPAD_UP", down: "DPAD_DOWN", left: "DPAD_LEFT", right: "DPAD_RIGHT",
  shift: "SHIFT_LEFT", ctrl: "CTRL_LEFT", alt: "ALT_LEFT", super: "META_LEFT",
  home: "HOME", menu: "MENU", pageup: "PAGE_UP", pagedown: "PAGE_DOWN",
};
for (let i = 0; i < 26; i++) KEYMAP[String.fromCharCode(97 + i)] = String.fromCharCode(65 + i);
for (let i = 0; i <= 9; i++) KEYMAP[String(i)] = String(i);

// Downscale a PNG via a pipe. ImageMagick starts in ~6ms; ffmpeg ~130ms, so prefer it.
export async function downscalePng(buf: Uint8Array, width: number): Promise<Uint8Array | null> {
  const cmds = [
    ["magick", "-", "-resize", `${width}x`, "png:-"],
    ["convert", "-", "-resize", `${width}x`, "png:-"],
    ["ffmpeg", "-y", "-loglevel", "error", "-i", "pipe:0", "-vf", `scale=${width}:-1`, "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
  ];
  for (const cmd of cmds) {
    try {
      const p = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      p.stdin.write(buf);
      await p.stdin.end();
      const out = new Uint8Array(await new Response(p.stdout).arrayBuffer());
      await new Response(p.stderr).text();
      if ((await p.exited) === 0 && out.length > 0) return out;
    } catch {}
  }
  return null;
}
