/** Minimal robots.txt parser following RFC 9309 (groups, Allow/Disallow, `*` and `$`, longest match wins). */

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

export interface Robots {
  groups: Group[];
  comments: string[];
}

export function parseRobots(text: string): Robots {
  const groups: Group[] = [];
  const comments: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const hash = raw.indexOf("#");
    if (hash >= 0) {
      const comment = raw.slice(hash + 1).trim();
      if (comment) comments.push(comment);
    }
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, comments };
}

function rulesFor(robots: Robots, userAgent: string): Rule[] {
  const token = userAgent.toLowerCase().split("/")[0] ?? "";
  const named = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = named.length > 0 ? named : robots.groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

/** True if `userAgent` may fetch `url` under these rules. */
export function isAllowed(robots: Robots, userAgent: string, url: string): boolean {
  const { pathname, search } = new URL(url);
  const path = pathname + search;
  let best: Rule | null = null;
  for (const rule of rulesFor(robots, userAgent)) {
    if (!matches(rule.pattern, path)) continue;
    const longer = !best || rule.pattern.length > best.pattern.length;
    const tieAllow = best && rule.pattern.length === best.pattern.length && rule.allow;
    if (longer || tieAllow) best = rule;
  }
  return best ? best.allow : true;
}
