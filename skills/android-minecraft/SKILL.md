---
name: android-minecraft
description: Use when driving a Minecraft Bedrock Android client through the android-minecraft-agent mc CLI for screenshots, input, chat, server joins, or feature checks.
---

# Minecraft on Android (redroid) via `mc`

A real Bedrock client runs on Android 13 (redroid) inside an Ubuntu 22.04 KVM guest, driven
over `adb` by the `mc` CLI.

## Setup (once per shell)

If `mc` is already installed as a host wrapper, use it directly; it supplies the guest
connection settings. Otherwise, set these variables for your host and run the repo CLI:

```bash
export MC_ADB=adb
export MC_SSH_KEY=~/.ssh/mc-android
export MC_SSH_TARGET=lunar@127.0.0.1
export MC_SSH_PORT=2222
export MC_IMAGE=lunar/redroid13-gapps
export MC_GPU_MODE=host
export MC_PORT_BASE=5555
export MC_DOCKER=docker
```

If the guest is down, start it (`guest/start-vm.sh`); it forwards one adb port per client.
Run `mc` from this repo's `bin` directory on `PATH`, or use `bun run src/mc.ts` from the repo.

## Core loop

```bash
mc preflight --id main         # check host and guest CPU/RAM before launch
mc launch --id main            # 20 FPS by default; ~1s warm, ~20s cold
mc screenshot --out /tmp/s.png               # full resolution for visual checks
mc click 426 240               # coordinates are in the last screenshot's pixels
mc chat "hello"                # open chat, type, send
mc stop                        # pause (fast relaunch); --remove frees memory
```

## Rules of thumb

- **Check headroom before a new session.** `mc preflight --id ID` reports host and Android
  guest CPU/RAM; `mc launch` repeats the check and refuses to start or resume when either
  machine lacks headroom. Retry after the reported pressure clears. An already running
  client remains usable.
- **Keep FPS low for routine work.** New clients default to 20 FPS to reduce CPU use.
  Raise `--fps` only when the task needs smoother motion or a frame-rate measurement, and
  use the lowest cap that serves that task. An existing container keeps its launch cap;
  do not remove and recreate another task's client to change it.
- **Screenshot, then act on it.** `mc click` takes positional `X Y`, in the pixels of the last
  screenshot for that instance, including when the screenshot was downscaled. The in-game HUD
  is rendered by the game, so `uiautomator` cannot see it.
- **Game UI needs a longer press.** Use `mc click X Y --action press --hold-ms 150` for menu
  buttons that ignore a quick tap. After opening a text field, wait for the keyboard and take
  another screenshot: the layout may move. For visual checks, launch at 1280×720 and use
  full-size screenshots; 854×480 is faster but can hide small alignment defects.
- **Resolution is fixed per container.** To change it, `mc stop --id ID --remove` then
  `mc launch --id ID --width 1280 --height 720`. The instance's `/data` persists.
- **Joining a server needs an Xbox sign-in** on the client (Play sign-in is not enough). Once
  signed in it persists in `/data`. Then `mc connect <host> [port]`, or add it with
  `mc add-server NAME host:port`. A local proxy on the QEMU host is reachable from Android
  at `10.0.2.2:<port>` with the default user-mode QEMU network.
- **Google Play owns the license check.** Install or update Minecraft through Play with an
  account that owns it. A sideloaded APK may show “Buy game to continue” even after Play
  sign-in. If Play downloads remain Pending, see [SETUP.md](../../SETUP.md#troubleshooting).
- **Protect sign-in secrets.** Do not put passwords in chat, logs, screenshots, or CLI args
  retained by shell history. Complete sign-in in the Android UI using an appropriate private
  input method. The CLI does not automate purchases or account recovery.
- **`stop` pauses by default** (~1.3s relaunch). Use `mc stop --remove` only when you want to
  free the ~3GB the container holds. The installed cleanup timer pauses running clients
  after 60 minutes without CLI activity and removes paused clients after two more hours.
  It preserves `/data` and gives clients from before activity tracking a full grace period.
- **Don't kill other tasks' clients.** `mc list` shows running instances; only touch your own.
- The ~20s cold boot is Android `init`; the fast path is resuming a paused container.

## Improve this agent when use reveals a problem

If the CLI or this skill is slow, or you find an edge case while doing a Minecraft task,
make a focused improvement in the `RestartFU/android-minecraft-agent` checkout. Verify the
affected behavior and update the skill when the workflow changes. Do not keep a separate
local-only skill fix: the installed skill should point at this checkout.

If you have push permission, commit the improvement and push **directly to this repo's
`main` branch**. First fast-forward your local `main`; if the remote advances while you
work, integrate it and rerun relevant checks before pushing. The same local checkout must
end on the pushed commit, so the installed CLI and skill update at the same time. If you
cannot push, leave the verified change in the checkout and report what remains to publish.
