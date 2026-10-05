import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
export class Bridge {
  constructor() {
    this.pending = new Map();
    this.counter = 0;
    this.stopped = false;
  }
  start() {
    if (this.stopped) throw Error('Gateway companion is stopping');
    if (this.child) return;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./rpc-bridge.js', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    // The end of the companion's error output explains a companion that will not start.
    this.stderr = '';
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-300);
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(r.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(r.id);
      r.error ? pending.reject(Error(r.error)) : pending.resolve(r.result);
    });
    child.on('error', (error) => {
      if (this.child === child) this.fail(error.message);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.fail(`exit ${code}`);
    });
  }
  fail(reason = 'stopped') {
    this.child = null;
    const detail = [reason, this.stderr?.trim().split('\n').at(-1)].filter(Boolean).join(': ');
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error(`Gateway companion interrupted (${detail}); reconcile before retry`));
    }
    this.pending.clear();
  }
  request(method, params) {
    this.start();
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('Gateway companion timeout; reconcile before retry'));
      }, 25000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  stop() {
    this.stopped = true;
    this.child?.kill();
    this.fail();
  }
}
