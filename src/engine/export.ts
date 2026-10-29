import type { ExportJob } from './export.worker';

/** Page-side client for export.worker.ts: one worker, jobs matched by id. */

let worker: Worker | null = null;
let seq = 0;
const jobs = new Map<number, { resolve: (b: Blob) => void; reject: (e: Error) => void; progress?: (p: number) => void }>();

function ensure() {
  if (worker) return worker;
  worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const d = e.data;
    const j = jobs.get(d.id);
    if (!j) return;
    if (d.type === 'progress') j.progress?.(d.p);
    else {
      jobs.delete(d.id);
      if (d.type === 'done') j.resolve(d.blob);
      else j.reject(new Error(d.message));
    }
  };
  worker.onerror = (e) => {
    jobs.forEach((j) => j.reject(new Error(e.message || 'Export worker crashed')));
    jobs.clear();
    worker = null;
  };
  return worker;
}

/** Build an MP4 in the export worker. The PCM buffer is transferred (pass a copy). */
export function buildVideo(job: Omit<ExportJob, 'id'>, onProgress?: (p: number) => void): Promise<Blob> {
  const id = ++seq;
  const w = ensure();
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, progress: onProgress });
    w.postMessage({ ...job, id }, [job.pcm.buffer]);
  });
}
