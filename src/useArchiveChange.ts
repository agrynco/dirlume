import { Channel } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { api, type ArchiveChange } from "./api";
import { nextTransferId } from "./TransferDialog";

export function useArchiveChange() {
  const job = useRef<{ id: number; started: boolean; cancel: boolean } | null>(null);
  const [progress, setProgress] = useState<number>();
  const [canceling, setCanceling] = useState(false);

  async function run(archive: number, change: ArchiveChange) {
    const current = { id: nextTransferId(), started: false, cancel: false };
    job.current = current;
    setProgress(undefined);
    const output = new Channel<number>((percent) => {
      if (job.current === current) setProgress(percent || undefined);
    });
    try {
      await api.beginTransfer(current.id);
      current.started = true;
      if (current.cancel) await api.cancelTransfer(current.id);
      await api.changeArchive(current.id, archive, change, output);
    } finally {
      output.onmessage = () => {};
      if (current.started) await api.finishTransfer(current.id).catch(() => {});
      job.current = null;
      setCanceling(false);
    }
  }

  function cancel() {
    const current = job.current;
    if (!current || current.cancel) return;
    current.cancel = true;
    setCanceling(true);
    if (current.started) void api.cancelTransfer(current.id).catch(() => {});
  }

  return { run, cancel, canceling, progress };
}
