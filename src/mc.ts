#!/usr/bin/env bun
// `mc` - CLI for android-minecraft-agent.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mc } from "./lib.ts";

type Flags = { _: string[] } & Record<string, string | boolean | string[]>;

function parse(argv: string[]): Flags {
  const f: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) f[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) f[a.slice(2)] = argv[++i];
      else f[a.slice(2)] = true;
    } else f._.push(a);
  }
  return f;
}
const str = (f: Flags, k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
const num = (f: Flags, k: string) => (f[k] !== undefined ? Number(f[k]) : undefined);
const bool = (f: Flags, k: string) => f[k] === true || f[k] === "true";
function requiredNumber(value: string | undefined, name: string): number {
  if (value === undefined || value.trim() === "" || !Number.isFinite(Number(value))) {
    throw new Error(`${name} must be a number`);
  }
  return Number(value);
}
const out = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

const HELP = `mc - drive a Minecraft Bedrock client on Android (redroid in a KVM guest)

Usage: mc <command> [flags]

  launch [--id main] [--data-dir DIR] [--width 854] [--height 480] [--fps 20] [--wait-for-menu]
  stop   [--id main] [--remove]        # pause by default (fast relaunch); --remove frees memory
  cleanup                              # pause idle clients, remove old paused clients
  preflight [--id main]                # check CPU and RAM before launch
  list
  state  [--id main]
  screenshot [--id main] [--width N] [--out FILE] [--stdout]
  click X Y [--id main] [--action tap|press] [--hold-ms N]
  type  "text" [--id main]
  chat  "message" [--id main]
  key   KEY [--id main]
  look  DX DY [--id main]
  scroll DY [--id main]
  uri   "minecraft:..." [--id main]
  add-server NAME ADDRESS [--id main]
  connect HOST [PORT] [--id main]      # minecraft://connect deep link
  log   [--lines N] [--id main]
  wait  MS
  version

Env: MC_ADB, MC_SSH_KEY, MC_SSH_TARGET, MC_SSH_PORT, MC_IMAGE, MC_GPU_MODE, MC_PORT_BASE, MC_CACHE
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const f = parse(rest);
  const mc = new Mc();
  const id = str(f, "id");
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return 0;
    case "version":
      out({ name: "android-minecraft-agent", version: "0.1.0" });
      return 0;
    case "launch":
      out(await mc.launch({ id, dataDir: str(f, "data-dir"), width: num(f, "width"), height: num(f, "height"), fpsCap: num(f, "fps"), waitForMenu: bool(f, "wait-for-menu") }));
      return 0;
    case "stop":
      out(await mc.stop(id, !bool(f, "remove")));
      return 0;
    case "cleanup":
      out(await mc.cleanup());
      return 0;
    case "preflight": {
      const check = await mc.preflight(id);
      out(check);
      return check.ok ? 0 : 1;
    }
    case "list":
      out(await mc.list());
      return 0;
    case "state":
      out(await mc.state(id));
      return 0;
    case "screenshot": {
      const png = await mc.screenshot(id, num(f, "width"));
      if (bool(f, "stdout")) {
        await Bun.write(Bun.stdout, png);
      } else {
        const file = str(f, "out") ?? join(mkdtempSync(join(tmpdir(), "mc-")), "shot.png");
        writeFileSync(file, png);
        console.log(file);
      }
      return 0;
    }
    case "click":
      if (f["x"] !== undefined || f["y"] !== undefined) throw new Error("click takes positional X Y: mc click 426 240");
      out(await mc.click(requiredNumber(f._[0], "X"), requiredNumber(f._[1], "Y"), { id, action: str(f, "action"), holdMs: num(f, "hold-ms") }));
      return 0;
    case "type":
      out(await mc.type(id, f._.join(" ")));
      return 0;
    case "chat":
      out(await mc.chat(id, f._.join(" ")));
      return 0;
    case "key":
      out(await mc.key(id, f._[0]));
      return 0;
    case "look":
      out(await mc.look(id, Number(f._[0]), Number(f._[1])));
      return 0;
    case "scroll":
      out(await mc.scroll(id, Number(f._[0])));
      return 0;
    case "uri":
      out(await mc.openUri(id, f._[0]));
      return 0;
    case "add-server":
      out(await mc.addServer(id, f._[0], f._[1]));
      return 0;
    case "connect":
      out(await mc.connect(id, f._[0], f._[1] ? Number(f._[1]) : 19132));
      return 0;
    case "log":
      out(await mc.log(id, num(f, "lines") ?? 50));
      return 0;
    case "wait":
      await mc.wait(Number(f._[0]));
      out({ ok: true });
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.error(HELP);
      return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
