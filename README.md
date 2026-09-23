# android-minecraft-agent

Drive a **real Minecraft Bedrock** client running on **Android (redroid)** inside a KVM
guest — from a single `mc` CLI.

This is a replacement for the `mcpelauncher` Linux client, which is a shim (reimplemented
Android runtime) that is unstable, has broken chat/IME, and misses features that depend on
real Android/Xbox services. Here the client is the real Android app, installed from Google
Play, driven over `adb`.

## Why a guest

`redroid` and the Google Android emulator do **not** boot on some very new hosts (e.g.
Fedora 44 / kernel 6.19: Android `init` aborts at `PropertyInit`, and the emulator segfaults
in its bundled QEMU). An **Ubuntu 22.04 guest (kernel 5.15 LTS)** runs redroid reliably, and
one guest hosts several containers (one client each) with hardware GPU via `virtio-gpu`.

```
Fedora 44 host (kernel 6.19)                     <- runs QEMU + adb only
└─ Ubuntu 22.04 KVM guest, kernel 5.15           <- ssh :2222
   └─ Docker -> redroid 13 (Android 13) + GApps  <- one container per client
      └─ Minecraft Bedrock (from Google Play)    <- adb :5555, 5556, ...
```

## Layout

| Path | What |
|---|---|
| `src/lib.ts` | Core: containers, launch/stop, screenshot, input, chat (the one source of truth) |
| `src/mc.ts` | `mc` CLI |
| `skills/android-minecraft/` | Agent skill for using the CLI |
| `guest/` | QEMU start script + GApps Dockerfile for the guest |
| `SETUP.md` | Step-by-step setup (host → guest → Android → Minecraft) |
| `AGENTS.md` | Agent entry point |

## Requirements

Full walkthrough: [SETUP.md](./SETUP.md).

- A KVM guest (Ubuntu 22.04, kernel 5.15) reachable over SSH, with Docker and the
  `lunar/redroid13-gapps` image (see `guest/`), plus `binder_linux` and `/dev/dri`.
- `adb` on the host, and per-instance UDP/TCP ports forwarded from the host into the guest
  (the CLI only sees host-forwarded ports).
- [Bun](https://bun.sh). ImageMagick (`magick`) optional but recommended for fast screenshot
  downscaling.

## CLI

```bash
export MC_ADB=adb
export MC_SSH_KEY=~/.ssh/mc-android
export MC_SSH_TARGET=root@127.0.0.1
export MC_SSH_PORT=2222
export MC_IMAGE=lunar/redroid13-gapps
export MC_GPU_MODE=host          # host (virtio-gpu/virgl) | guest (SwiftShader)
export MC_PORT_BASE=5555

mc launch --id main --data-dir /data/mc/main      # ~1s resume, ~20s cold boot
mc state
mc screenshot --width 426 --out /tmp/shot.png     # or --stdout for a pipe
mc click 426 240
mc chat "hello from adb"
mc connect zeqa.net 19132                          # join a server (client must be signed into Xbox)
mc stop                                            # pause (fast); mc stop --remove to free memory
```

`mc screenshot` prints a file path by default (the agent then reads the PNG), or writes the
raw PNG to stdout with `--stdout`.

## Performance

Measured on an AMD Ryzen 9 7900X host (guest 8 vCPU / 8 GB, hardware virgl), client in a
server world:

| Metric | Value |
|---|---|
| Warm relaunch (`stop` then `launch`) | **~1.3 s** |
| Cold launch (new container) | ~20 s |
| `screenshot` 854×480 | ~155 ms |
| `screenshot` 426 px | ~175 ms |
| `state` / `click` | ~20 ms |
| Host CPU per client | ~0.4–0.5 core |

Instance lookups are cached on disk because an SSH `docker ps` costs ~165 ms per call;
`stop` pauses the container so a relaunch skips Android init.

## Notes

- The client must be **signed into Xbox Live** to join online servers (Play sign-in alone is
  not enough). Sign-in is a one-time UI flow; after that it persists in `/data`.
- The in-game HUD is game-rendered, so `uiautomator` can't see it; `chat`/menu taps use fixed
  coordinates scaled from the configured width/height.
- Paused containers hold ~3 GB each; use `mc stop --remove` when you don't need the fast path.

MIT.
