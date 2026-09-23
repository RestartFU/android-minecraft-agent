import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./mc.ts";
import { Mc, loadCfg, shellQuote } from "./lib.ts";

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
