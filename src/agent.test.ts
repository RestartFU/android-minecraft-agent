import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./mc.ts";
import { Mc, loadCfg, resourceIssues, shellQuote } from "./lib.ts";

test("click rejects flag coordinates before contacting Android", async () => {
  await expect(main(["click", "--x", "10", "--y", "20"])).rejects.toThrow("positional X Y");
  await expect(main(["click", "10"])).rejects.toThrow("Y must be a number");
});

test("shell arguments preserve punctuation without executing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-quote-"));
  try {
    const input = `a'b; touch ${dir}/injected; #`;
    const p = Bun.spawn(["sh", "-c", `printf '%s' ${shellQuote(input)}`], { stdout: "pipe" });
    expect(await new Response(p.stdout).text()).toBe(input);
    expect(await p.exited).toBe(0);
    expect((await Bun.file(`${dir}/injected`).exists())).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launch reports when an existing container has a different resolution", async () => {
  const mc = new Mc(loadCfg({ HOME: "/tmp" }));
  mc.containers = async () => [{ id: "main", name: "mc-main", port: 5555, status: "Up", size: { w: 854, h: 480 } }];
  await expect(mc.launch({ width: 1280, height: 720 })).rejects.toThrow("mc stop --id main --remove");
});

test("cleanup gives existing clients grace, then pauses and removes idle containers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-cleanup-"));
  try {
    const mc = new Mc(loadCfg({ HOME: dir }));
    const c = { id: "old", name: "mc-old", port: 5555, status: "Up", size: { w: 854, h: 480 } };
    const commands: string[] = [];
    mc.containers = async () => [c];
    Object.defineProperty(mc, "dm", { value: async (cmd: string) => {
      commands.push(cmd);
      if (cmd.startsWith("pause ")) c.status = "Up (Paused)";
      return "";
    } });
    const start = 1_800_000_000_000;
    expect((await mc.cleanup(start)).actions).toEqual([{ id: "old", action: "grace" }]);
    expect((await mc.cleanup(start + 59 * 60_000)).actions).toEqual([]);
    expect((await mc.cleanup(start + 60 * 60_000)).actions).toEqual([{ id: "old", action: "pause" }]);
    expect((await mc.cleanup(start + 3 * 60 * 60_000 - 1)).actions).toEqual([]);
    expect((await mc.cleanup(start + 3 * 60 * 60_000)).actions).toEqual([{ id: "old", action: "remove" }]);
    expect(commands).toEqual(["pause 'mc-old'", "rm -f 'mc-old'"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("using a client resets its cleanup clock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-active-"));
  try {
    const mc = new Mc(loadCfg({ HOME: dir }));
    mc.containers = async () => [{ id: "active", name: "mc-active", port: 5555, status: "Up", size: { w: 854, h: 480 } }];
    Object.defineProperty(mc, "adb", { value: async () => ({ code: 0, out: "", err: "" }) });
    Object.defineProperty(mc, "dm", { value: async () => { throw new Error("active client was paused"); } });
    const now = Date.now();
    await mc.cleanup(now - 60 * 60_000);
    await mc.resolve("active");
    expect((await mc.cleanup(Date.now() + 1000)).actions).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop can remove a paused client without resuming it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-remove-"));
  try {
    const mc = new Mc(loadCfg({ HOME: dir }));
    const commands: string[] = [];
    mc.containers = async () => [{ id: "main", name: "mc-main", port: 5555, status: "Up (Paused)", size: { w: 854, h: 480 } }];
    Object.defineProperty(mc, "adb", { value: async () => ({ code: 0, out: "", err: "" }) });
    Object.defineProperty(mc, "dm", { value: async (cmd: string) => { commands.push(cmd); return ""; } });
    expect(await mc.stop(undefined, false)).toEqual({ id: "main", removed: true });
    expect(commands).toEqual(["rm -f 'mc-main'"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight requires host and guest headroom for new and resumed clients", () => {
  const snapshot = {
    host: { availableMiB: 4000, load1: 7, cpus: 8 },
    guest: { availableMiB: 2500, load1: 2, cpus: 8 },
  };
  expect(resourceIssues(snapshot, "new")).toHaveLength(3);
  expect(resourceIssues(snapshot, "resume")).toHaveLength(1);
  expect(resourceIssues({ ...snapshot, host: { ...snapshot.host, load1: 4 } }, "resume")).toEqual([]);
});

test("launch checks resources before starting a client", async () => {
  const mc = new Mc(loadCfg({ HOME: "/tmp" }));
  const snapshot = {
    host: { availableMiB: 8192, load1: 4, cpus: 8 },
    guest: { availableMiB: 1024, load1: 1, cpus: 8 },
  };
  mc.containers = async () => [];
  Object.defineProperty(mc, "resources", { value: async () => snapshot });
  Object.defineProperty(mc, "dm", { value: async () => { throw new Error("started without headroom"); } });
  await expect(mc.launch({ id: "new" })).rejects.toThrow("Android guest RAM");

  mc.containers = async () => [{ id: "existing", name: "mc-existing", port: 5555, status: "Up", size: { w: 854, h: 480 } }];
  Object.defineProperty(mc, "startGame", { value: async () => { throw new Error("started without headroom"); } });
  await expect(mc.launch({ id: "existing" })).rejects.toThrow("Android guest RAM");
});
