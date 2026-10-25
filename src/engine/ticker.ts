/**
 * Frame clock that keeps running when the Take1 tab is in the background.
 *
 * While you record, you are looking at another window, so the Take1 tab is hidden.
 * Chrome throttles requestAnimationFrame (stops) and setInterval (1/s, later 1/min)
 * in hidden tabs. Dedicated-worker timers are not throttled, so the worker posts a
 * tick 30 times a second and the main thread draws + encodes on each tick.
 */
export function createTicker(fps: number, onTick: () => void) {
  const src = `let id=null;onmessage=e=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const worker = new Worker(url);
  worker.onmessage = () => onTick();
  worker.postMessage(1000 / fps);
  return {
    stop() {
      worker.postMessage(0);
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}
