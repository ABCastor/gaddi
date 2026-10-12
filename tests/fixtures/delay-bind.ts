// Force the real bind-before-listen race at the second broker startup, in an isolated fixture.
import fs from 'node:fs';
import path from 'node:path';
if (process.argv[1]?.endsWith('/daemon/daemon.ts')) {
  const binding = Reflect.get(process, 'binding') as (name: string) => {
    Pipe: { prototype: { bind: (address: string, ...args: unknown[]) => number } };
  };
  const { Pipe } = binding('pipe_wrap');
  const bind = Pipe.prototype.bind;
  Pipe.prototype.bind = function(address, ...args) {
    const result = bind.call(this, address, ...args);
    if (result === 0 && address === process.env.GADDI_SOCKET) {
      if (!process.env.GADDI_HOME?.includes('/tests/.state/')) throw new Error('Bind delay requires an isolated broker home');
      const marker = path.join(process.env.GADDI_HOME, 'bind-probe');
      if (fs.existsSync(marker)) {
        console.error('PROBE socket bound; listen delayed');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      } else fs.writeFileSync(marker, 'first bind');
    }
    return result;
  };
}
