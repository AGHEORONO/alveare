// Repo-relative path patterns: literal paths, directories ("dir/" = "dir/**") and simple globs
// (*, **, ?). Patterns keep their original case for display; all comparisons are
// case-insensitive because Windows and macOS file systems are.

const GLOB_CHARS = /[*?[\]{}]/;

export function normalizePattern(p: string): string {
  let s = p.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/^\/+/, '');
  if (s.endsWith('/')) s += '**';
  if (s === '' || s === '.') s = '**';
  return s;
}

export function isGlob(p: string): boolean {
  return GLOB_CHARS.test(p);
}

function literalPrefix(p: string): string {
  const i = p.search(GLOB_CHARS);
  return i === -1 ? p : p.slice(0, i);
}

const regexCache = new Map<string, RegExp>();

export function globToRegex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (re) return re;
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // "**/" matches zero or more directories; "**" at the end matches everything below
        if (pattern[i + 2] === '/') { src += '(?:.*/)?'; i += 2; }
        else { src += '.*'; i += 1; }
      } else src += '[^/]*';
    } else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp(`^${src}$`, 'i');
  regexCache.set(pattern, re);
  return re;
}

/** Does pattern `pattern` cover the concrete path `path`? Both must be normalized. */
export function matches(pattern: string, path: string): boolean {
  if (!isGlob(pattern)) return pattern.toLowerCase() === path.toLowerCase();
  return globToRegex(pattern).test(path);
}

/**
 * Could two patterns refer to a common file? Exact for literal/literal and glob/literal.
 * Glob/glob is conservative: overlap if one literal prefix is a prefix of the other
 * (may report a false conflict, never misses a real one).
 */
export function overlaps(a: string, b: string): boolean {
  const ga = isGlob(a), gb = isGlob(b);
  if (!ga && !gb) return a.toLowerCase() === b.toLowerCase();
  if (ga && !gb) return matches(a, b);
  if (!ga && gb) return matches(b, a);
  const pa = literalPrefix(a).toLowerCase(), pb = literalPrefix(b).toLowerCase();
  return pa.startsWith(pb) || pb.startsWith(pa);
}
