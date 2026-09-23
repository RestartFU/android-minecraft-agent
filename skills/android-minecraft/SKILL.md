---
name: android-minecraft
description: Use when driving a real Minecraft Bedrock client on Android (redroid in a KVM guest) for screenshots, input, chat, joining servers, or validating features — the replacement for the unstable Linux mcpelauncher client. Triggers on the `mc` CLI, android-minecraft-agent, redroid, or when the Linux Minecraft client is broken or slow.
---

# Minecraft on Android (redroid) via `mc`

A real Bedrock client runs on Android 13 (redroid) inside an Ubuntu 22.04 KVM guest, driven
over `adb`. Prefer the `mc` CLI; an MCP (`android-minecraft-agent`) exposes the same tools
under the `mcpelauncher-agent` names if that's what the environment provides.

## Setup (once per shell)

```bash
export MC_ADB=adb
export MC_SSH_KEY=~/.ssh/mc-android
export MC_SSH_TARGET=root@127.0.0.1
export MC_SSH_PORT=2222
export MC_IMAGE=lunar/redroid13-gapps
export MC_GPU_MODE=host
export MC_PORT_BASE=5555
```

If the guest is down, start it (`guest/start-vm.sh`); it forwards one adb port per client.

## Core loop

```bash
mc launch --id main            # ~1s if the container is warm, ~20s cold; starts Minecraft
mc screenshot --width 426 --out /tmp/s.png   # then read /tmp/s.png
mc click 426 240               # coordinates are in the last screenshot's pixels
mc chat "hello"                # open chat, type, send
mc stop                        # pause (fast relaunch); --remove frees memory
```

## Rules of thumb

- **Screenshot, then act on it.** Coordinates are in the pixels of the last screenshot; the
  in-game HUD is game-rendered, so `uiautomator` cannot see it — tap by coordinate.
- **Game UI needs a longer press.** Use `mc click X Y --action press --hold-ms 150` for menu
  buttons that ignore a quick tap.
- **Joining a server needs an Xbox sign-in** on the client (Play sign-in is not enough). Once
  signed in it persists in `/data`. Then `mc connect <host> [port]`, or add it with
  `mc add-server NAME host:port`.
- **`stop` pauses by default** (~1.3s relaunch). Use `mc stop --remove` only when you want to
  free the ~3GB the container holds.
- **Don't kill other tasks' clients.** `mc list` shows running instances; only touch your own.
- The ~20s cold boot is Android `init`; the fast path is resuming a paused container.

## MCP equivalent

If the environment exposes the MCP instead of the CLI, the tools are: `launch`, `stop`,
`list`, `state`, `screenshot`, `key`, `hold_key`, `type`, `chat`, `look`, `click`,
`mouse_move_to`, `scroll`, `add_server`, `open_uri`, `connect`, `set_fps`, `wait`, `log`.
