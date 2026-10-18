// Canonical JSON: the one serialiser used both when writing and when verifying the audit chain.
// Keys sorted recursively, no whitespace, numbers in JavaScript's shortest round-trip form (5.0 -> 5, -0 -> 0),
// undefined members dropped. Non-finite numbers and non-plain values are refused, never silently coerced.

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value))
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null)
        throw new TypeError('canonicalJson: only plain objects');
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}
