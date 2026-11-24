import type { Entry, TransferProgress } from "./api";

export const estimateDelay = 5_000;
export const estimateInterval = 2_000;
const sampleWindow = 8_000;
const stalledAfter = 4_000;

function byteSize(value: number | null) {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

export class TransferEstimate {
  private readonly jobs: { knownFile: boolean; size: number | null }[];
  private readonly samples = [{ at: 0, bytes: 0 }];
  private readonly bytesByPath = new Map<string, number>();
  private index = 0;
  private totalBytes = 0;
  private currentBytes = 0;
  private knownRemaining = 0;
  private unknownRemaining = 0;
  private lastProgress = 0;
  private pauseStarted: number | null = null;
  private pausedTime = 0;

  constructor(entries: readonly (Entry | null)[], private readonly startedAt: number) {
    this.jobs = entries.map((entry) => {
      const knownFile = !!entry && !entry.directory && !entry.link;
      const size = knownFile ? byteSize(entry.size) : null;
      if (size === null) this.unknownRemaining++;
      else this.knownRemaining += size;
      return { knownFile, size };
    });
  }

  elapsed(now: number) {
    return (this.pauseStarted ?? now) - this.startedAt - this.pausedTime;
  }

  setPaused(paused: boolean, now: number) {
    if (paused) {
      this.pauseStarted ??= now;
    } else if (this.pauseStarted !== null) {
      this.pausedTime += now - this.pauseStarted;
      this.pauseStarted = null;
    }
  }

  progress(event: TransferProgress, now: number) {
    const job = this.jobs[this.index];
    if (!job) return;
    const total = byteSize(event.total);
    if (job.knownFile && total !== null && total !== job.size) {
      if (job.size === null) this.unknownRemaining--;
      this.knownRemaining += total - (job.size ?? 0);
      job.size = total;
    }
    const path = event.path ?? event.file;
    const previous = this.bytesByPath.get(path) ?? 0;
    if (event.bytes > previous) {
      this.bytesByPath.set(path, event.bytes);
      this.currentBytes += event.bytes - previous;
      this.totalBytes += event.bytes - previous;
      this.lastProgress = this.elapsed(now);
    }
  }

  finishItem() {
    const job = this.jobs[this.index++];
    if (!job) return;
    if (job.size === null) this.unknownRemaining--;
    else this.knownRemaining -= job.size;
    this.currentBytes = 0;
    this.bytesByPath.clear();
  }

  remainingSeconds(now: number): number | null {
    const at = this.elapsed(now);
    // Keep one sample immediately before the window to cover sparse updates.
    while (this.samples.length > 1 && this.samples[1].at <= at - sampleWindow) this.samples.shift();
    const earlier = this.samples[0];
    if (at > this.samples.at(-1)!.at) this.samples.push({ at, bytes: this.totalBytes });
    const remaining = this.knownRemaining - this.currentBytes;
    const progressed = this.totalBytes - earlier.bytes;
    if (this.unknownRemaining || remaining <= 0 || !progressed || at - this.lastProgress >= stalledAfter) return null;
    return Math.ceil(remaining * (at - earlier.at) / progressed / 1_000);
  }
}
