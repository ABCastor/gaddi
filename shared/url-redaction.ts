// Public display/storage only. Never apply this to navigation, policy inputs or signed actions.
const sensitive = new Set([
  'code', 'state', 'token', 'idtoken', 'accesstoken', 'refreshtoken', 'sig', 'signature',
  'key', 'apikey', 'password', 'passwd', 'session', 'sessionid', 'sessionstate',
  'secret', 'clientsecret', 'credential', 'authorization', 'auth', 'jwt', 'ticket',
  'nonce', 'assertion', 'samlrequest', 'samlresponse', 'oauthverifier', 'codeverifier',
  'oauthcode', 'oauthstate', 'authcode', 'authorizationcode', 'idtokenhint',
  'phpsessid', 'jsessionid', 'awsaccesskeyid',
]);
function decode(value: string) {
  try { return decodeURIComponent(value); }
  // Malformed escapes elsewhere must not hide an ASCII parameter name or nested URL.
  catch { return value.replace(/%([0-9a-f]{2})/gi, (_, byte: string) => String.fromCharCode(parseInt(byte, 16))); }
}
function sensitiveKey(value: string) {
  let name = value;
  for (let n = 0; n < 3; n++) { const next = decode(name); if (next === name) break; name = next; }
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return sensitive.has(key) || /(?:token|password|secret|signature|credential|assertion|apikey|sessionid)$/.test(key);
}
function text(value: string, depth: number): string {
  // Bound nested redirect decoding. Deeper URL-bearing values are withheld, not returned raw.
  if (depth >= 4) return '[redacted]';
  return value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#"'<>]*@/gi, '$1[redacted]@')
    .replace(/(&amp;|&#0*38;|&#x0*26;|[?&#])([^?&#=\s"'<>]+)(=|&#0*61;|&#x0*3d;)([^&#\s"'<>]*)/gi,
      (_match, separator: string, key: string, equals: string, raw: string) => {
        if (sensitiveKey(key)) {
          // Keep an already-redacted URL's surrounding wrapper punctuation on later passes.
          const safe = /^\[redacted\][\])}.,:]*$/.test(raw) ? raw : '[redacted]';
          return `${separator}${key}${equals}${safe}`;
        }
        // A redirect/return URL may itself carry credentials, including percent-encoded ones.
        let decoded = raw;
        for (let n = depth; n < 4; n++) {
          const next = decode(decoded);
          if (next === decoded) break;
          decoded = next;
        }
        if (/%(?:25)*(?:3f|23|26|3d)/i.test(decoded)) return `${separator}${key}${equals}[redacted]`;
        if (!/[?&#]/.test(decoded)) return `${separator}${key}${equals}${raw}`;
        const safe = text(decoded, depth + 1);
        return `${separator}${key}${equals}${safe === decoded ? raw : decoded === raw ? safe : encodeURIComponent(safe)}`;
      });
}

// Invariant: credentials in URL queries/fragments/userinfo cannot cross any public text boundary.
// Relative URLs, SPA fragments, repeated/encoded/case-varied names and HTML ampersands are included.
export function redactURLText(value: string): string { return text(value, 0); }

// Traverse keys as well as values: arbitrary evaluation objects can use a URL as a property name.
// Clone rather than mutate, leaving the original Chrome URL and authority-bearing objects intact.
export function redactURLs<T>(value: T): T {
  if (typeof value === 'string') return redactURLText(value) as T;
  if (Array.isArray(value)) return value.map(entry => redactURLs(entry)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redactURLText(key), redactURLs(entry)])) as T;
  }
  return value;
}
