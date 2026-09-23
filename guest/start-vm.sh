#!/bin/bash
# Start the Ubuntu 22.04 KVM guest that hosts the redroid (Android) containers.
# Host GPU is exposed via virtio-gpu-gl + egl-headless (virgl -> radeonsi).
# Each client needs its adb port forwarded here; the CLI only sees host-forwarded ports.
set -euo pipefail

VM_DIR="${VM_DIR:-$HOME/lunar-vm}"        # holds disk.qcow2 and the cloud-init seed.iso
DISK="${DISK:-$VM_DIR/disk.qcow2}"
SEED="${SEED:-$VM_DIR/seed.iso}"
SSH_PORT="${SSH_PORT:-2222}"
PORTS="${PORTS:-5555 5556 5557 5558 5559 5560}"   # one adb port per client
SMP="${SMP:-8}"
MEM="${MEM:-8192}"
RENDER_NODE="${RENDER_NODE:-/dev/dri/renderD128}"

FW=""
for p in "$SSH_PORT" $PORTS; do
  tgt=$p; [ "$p" = "$SSH_PORT" ] && tgt=22
  FW="$FW,hostfwd=tcp:127.0.0.1:$p-:$tgt"
done

PID_FILE="$VM_DIR/qemu.pid"
if [ -f "$PID_FILE" ]; then
  old_pid=$(cat "$PID_FILE")
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
    if tr '\0' ' ' < "/proc/$old_pid/cmdline" | grep -Fq -- "-drive file=$DISK,"; then
      echo "guest already running (pid $old_pid)"
      exit 0
    fi
    echo "pid file points to another process ($old_pid); refusing to start" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

setsid qemu-system-x86_64 -name android-mc-guest \
  -enable-kvm -cpu host -smp "$SMP" -m "$MEM" \
  -drive file="$DISK",if=virtio,cache=writeback \
  -drive file="$SEED",if=virtio,format=raw,readonly=on \
  -netdev "user,id=n0$FW" -device virtio-net-pci,netdev=n0 \
  -vga none -device virtio-gpu-gl-pci,hostmem=1024M \
  -display "egl-headless,rendernode=$RENDER_NODE" \
  -serial file:"$VM_DIR/serial.log" -pidfile "$PID_FILE" -daemonize

echo "qemu pid=$(cat "$PID_FILE")  forwards=$FW"
