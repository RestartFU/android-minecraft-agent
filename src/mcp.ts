#!/usr/bin/env bun
// MCP wrapper over the same core as the `mc` CLI. Tools keep the mcpelauncher-agent names.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Mc } from "./lib.ts";

const mc = new Mc();
const text = (s: unknown) => ({ content: [{ type: "text" as const, text: typeof s === "string" ? s : JSON.stringify(s) }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const instanceArg = { instance: z.string().optional().describe("Instance id; defaults to the most recently launched") };
const keySchema = z.string().describe("Key name: a-z, 0-9, enter, escape, space, tab, up/down/left/right, shift, ctrl, alt, ...");

const server = new McpServer({ name: "android-minecraft-agent", version: "0.1.0" });

server.tool(
  "launch",
  "Start (or resume) a real Minecraft Bedrock client in a redroid (Android 13) container inside the KVM guest",
  {
    id: z.string().default("main").describe("Instance id, unique per running client"),
    data_dir: z.string().optional().describe("Guest path for this instance's /data (own login, worlds, settings)"),
    width: z.number().int().min(320).default(854),
    height: z.number().int().min(180).default(480),
    fps_cap: z.number().int().min(0).default(30),
    wait_for_menu: z.boolean().default(false).describe("Return only after the launcher is up; false returns once boot_completed"),
  },
  async ({ id, data_dir, width, height, fps_cap, wait_for_menu }) =>
    text(await mc.launch({ id, dataDir: data_dir, width, height, fpsCap: fps_cap, waitForMenu: wait_for_menu })),
);

server.tool(
  "stop",
  "Stop a client. Defaults to pausing the container (fast ~1s relaunch); keep_warm=false removes it",
  { ...instanceArg, keep_warm: z.boolean().default(true) },
  async ({ instance, keep_warm }) => text(await mc.stop(instance, keep_warm)),
);

server.tool("list", "List running client containers", {}, async () => text(await mc.list()));

server.tool("state", "Display size, focus, and boot state", instanceArg, async ({ instance }) => text(await mc.state(instance)));

server.tool(
  "screenshot",
  "Capture the current frame as PNG",
  { ...instanceArg, width: z.number().int().min(64).optional().describe("Downscale to this width (aspect kept)") },
  async ({ instance, width }) => {
    const png = await mc.screenshot(instance, width);
    const c = await mc.resolve(instance);
    return {
      content: [
        { type: "image" as const, data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
        { type: "text" as const, text: `${c.size.w}x${c.size.h} device space (click coordinates are in the last screenshot's pixels)` },
      ],
    };
  },
);

server.tool(
  "key",
  "Press a key (Android keyevent; tap only)",
  { ...instanceArg, key: keySchema, action: z.enum(["tap", "press", "release"]).default("tap"), hold_ms: z.number().int().min(1).default(60), mods: z.array(z.string()).optional() },
  async ({ instance, key }) => text(await mc.key(instance, key)),
);

server.tool("hold_key", "Hold a key (best-effort long press; movement on Android is touch-based)", { ...instanceArg, key: keySchema, ms: z.number().int().min(1).max(60_000) }, async ({ instance, key }) =>
  text(await mc.holdKey(instance, key)),
);

server.tool("type", "Type text into the focused text field", { ...instanceArg, text: z.string() }, async ({ instance, text: t }) => text(await mc.type(instance, t)));

server.tool("chat", "Open chat, type a message and send it", { ...instanceArg, message: z.string() }, async ({ instance, message }) => text(await mc.chat(instance, message)));

server.tool("look", "Turn the camera by a relative delta (pixels)", { ...instanceArg, dx: z.number(), dy: z.number() }, async ({ instance, dx, dy }) => text(await mc.look(instance, dx, dy)));

server.tool(
  "click",
  "Tap at coordinates in the last screenshot's pixels (left = attack/break, right = use/place)",
  { ...instanceArg, button: z.enum(["left", "right", "middle"]).default("left"), x: z.number().optional(), y: z.number().optional(), action: z.enum(["tap", "press", "release"]).default("tap"), hold_ms: z.number().int().min(1).default(60) },
  async ({ instance, x, y, action, hold_ms }) => {
    if (x === undefined || y === undefined) throw new Error("x and y are required on the Android backend");
    return text(await mc.click(x, y, { id: instance, action, holdMs: hold_ms }));
  },
);

server.tool("mouse_move_to", "No-op on the Android backend (touch has no hover cursor)", { ...instanceArg, x: z.number(), y: z.number() }, async () => text({ ok: true, note: "no hover cursor on touch; use click" }));

server.tool("scroll", "Scroll a list by a wheel delta", { ...instanceArg, dy: z.number() }, async ({ instance, dy }) => text(await mc.scroll(instance, dy)));

server.tool("add_server", "Add a server via a minecraft: deep link", { ...instanceArg, name: z.string(), address: z.string() }, async ({ instance, name, address }) => text(await mc.addServer(instance, name, address)));

server.tool("open_uri", "Send a raw minecraft: URI to the game", { ...instanceArg, uri: z.string() }, async ({ instance, uri }) => text(await mc.openUri(instance, uri)));

server.tool("connect", "Join a server directly via a minecraft://connect deep link", { ...instanceArg, host: z.string(), port: z.number().int().default(19132) }, async ({ instance, host, port }) => text(await mc.connect(instance, host, port)));

server.tool("set_fps", "No-op on the Android backend (fps is fixed at container launch)", { ...instanceArg, cap: z.number().int().min(0) }, async () => text({ ok: true, note: "fps is set via androidboot.redroid_fps at launch" }));

server.tool("wait", "Wait for the game to catch up", { ms: z.number().int().min(1).max(60_000) }, async ({ ms }) => { await sleep(ms); return text({ ok: true }); });

server.tool("log", "Recent client log lines from logcat", { ...instanceArg, lines: z.number().int().min(1).max(500).default(50) }, async ({ instance, lines }) => text(await mc.log(instance, lines)));

const transport = new StdioServerTransport();
await server.connect(transport);
process.on("SIGINT", () => process.exit(0));
