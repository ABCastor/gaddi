// Secret values are retained as zeroable buffers, never as persistent strings.
export function createSigninSecrets({ ttlMs = 10 * 60 * 1000 }: { ttlMs?: number } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Invalid secret retention period');
  const entries: { tab: number; expires: number; values: Buffer[] }[] = [];
  let timer: NodeJS.Timeout | undefined;
  function clear(tab?: number) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (tab === undefined || entries[i].tab === tab) {
        for (const value of entries[i].values) value.fill(0);
        entries.splice(i, 1);
      }
    }
    schedule();
  }
  function expire() {
    const now = Date.now();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].expires <= now) {
        for (const value of entries[i].values) value.fill(0);
        entries.splice(i, 1);
      }
    }
    schedule();
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (entries.length) {
      timer = setTimeout(expire, Math.max(1, Math.min(...entries.map(entry => entry.expires)) - Date.now()));
      timer.unref();
    }
  }
  function remember(tab: number, values: string[]) {
    expire();
    entries.push({ tab, expires: Date.now() + ttlMs, values: values.filter(value => value.length > 0).map(value => Buffer.from(value)) });
    schedule();
  }
  function redact(value: unknown, tab?: number, redactKeys = true): unknown {
    expire();
    const values = entries.filter(entry => tab === undefined || entry.tab === tab).flatMap(entry => entry.values)
      .sort((a, b) => b.length - a.length);
    const string = (text: string) => {
      for (const value of values) text = text.split(value.toString()).join('[redacted]');
      return text;
    };
    const seen = new WeakMap<object, unknown>();
    // In fixed schemas these are generated identifiers/enums, not credential data.
    // Arbitrary eval values use the default mode before entering that schema.
    const metadata = new Set(['id', 'tab', 'tabId', 'windowId', 'groupId', 'version', 'outcome', 'step', 'code', 'kind', 'status']);
    function visit(input: unknown): unknown {
      if (typeof input === 'string') return string(input);
      if (typeof input === 'number' || typeof input === 'bigint') {
        const text = String(input), safe = string(text);
        const numericMatch = values.some(value => /^[0-9]+$/.test(value.toString()) && Number(value.toString()) === Number(input));
        return numericMatch ? '[redacted]' : safe === text ? input : safe;
      }
      if (input === null || typeof input !== 'object') return input;
      if (Buffer.isBuffer(input)) return string(input.toString());
      if (seen.has(input)) return seen.get(input);
      if (input instanceof Error) return { name: string(input.name), message: string(input.message), stack: string(input.stack || '') };
      const output: unknown[] | Record<string, unknown> = Array.isArray(input) ? [] : {};
      seen.set(input, output);
      for (const [key, entry] of Object.entries(input)) {
        Object.defineProperty(output, redactKeys ? string(key) : key, { value: !redactKeys && metadata.has(key) ? entry : visit(entry), enumerable: true, configurable: true, writable: true });
      }
      return output;
    }
    return visit(value);
  }
  return { remember, redact, clear, stop: () => clear() };
}
