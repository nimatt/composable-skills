import fs from "node:fs";
import path from "node:path";

import type { Config, Diagnostic, DiscoveredSkill } from "./types.ts";
import { describe, warning } from "./types.ts";
import { OUTPUT_FILENAME, TEMPLATE_FILENAME } from "./layout.ts";

export interface Discovery {
  skills: DiscoveredSkill[];
  diagnostics: Diagnostic[];
  /**
   * True only when every configured source root resolved *and* was enumerated end to end.
   * Prune eligibility hangs on this: a root the build could not read is indistinguishable from
   * a root whose skills were all deleted upstream.
   */
  complete: boolean;
}

export function discoverSkills(config: Config): Discovery {
  const diagnostics: Diagnostic[] = [];
  const bySkill = new Map<string, DiscoveredSkill>();
  let complete = !config.sourcesIncomplete;

  for (const root of config.sources) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.path, { withFileTypes: true });
    } catch (cause) {
      diagnostics.push(
        warning(`cannot read source root ${root.path}: ${describe(cause)} — skipped`),
      );
      complete = false;
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const dir = path.join(root.path, entry.name);
      /**
       * `isDirectory()` is false for a symlink dirent, so a symlinked skill directory is
       * invisible to discovery while being perfectly readable — and its compiled output would be
       * pruned as a skill that no longer exists. Refused, because following it would read a
       * template from outside every configured source root, but never silently.
       */
      if (entry.isSymbolicLink()) {
        if (
          probeFile(path.join(dir, TEMPLATE_FILENAME)) === "file" ||
          looksLikeSkill(dir) === "yes"
        ) {
          diagnostics.push(
            warning(`skill directory is a symlink — not followed`, {
              skill: entry.name,
              file: dir,
            }),
          );
          complete = false;
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      const templatePath = path.join(dir, TEMPLATE_FILENAME);
      const template = probeFile(templatePath);
      if (template === "unreadable") {
        diagnostics.push(
          warning(`cannot read template ${templatePath}: permission or I/O error — skipped`, {
            skill: entry.name,
            file: dir,
          }),
        );
        complete = false;
        continue;
      }
      if (template !== "file") {
        const probe = looksLikeSkill(dir);
        if (probe === "yes") {
          diagnostics.push(
            warning(`no ${TEMPLATE_FILENAME} — skipped`, { skill: entry.name, file: dir }),
          );
        } else if (probe === "unreadable") {
          diagnostics.push(
            warning(`cannot read skill directory ${dir}: permission or I/O error — skipped`, {
              skill: entry.name,
            }),
          );
          complete = false;
        }
        continue;
      }
      if (bySkill.has(entry.name)) {
        diagnostics.push(
          warning(`skill name collides across sources — "${root.spec}" wins`, {
            skill: entry.name,
          }),
        );
      }
      bySkill.set(entry.name, {
        name: entry.name,
        dir,
        sourceRoot: root.path,
        templatePath,
      });
    }
  }

  return {
    skills: [...bySkill.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    diagnostics,
    complete,
  };
}

type Probe = "yes" | "no" | "unreadable";

function looksLikeSkill(dir: string): Probe {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const found = entries.some(
      (entry) => entry.isFile() && (entry.name === OUTPUT_FILENAME || entry.name.endsWith(".tmpl")),
    );
    return found ? "yes" : "no";
  } catch (cause) {
    return isMissing(cause) ? "no" : "unreadable";
  }
}

type FileProbe = "file" | "other" | "missing" | "unreadable";

/**
 * `ENOENT` is "there is no skill here" and every other errno is "this build cannot see whether
 * there is one". Collapsing the two is what let an unreadable skill directory drop out of `keep`
 * with no diagnostic and have its compiled output pruned.
 */
function probeFile(candidate: string): FileProbe {
  try {
    return fs.statSync(candidate).isFile() ? "file" : "other";
  } catch (cause) {
    return isMissing(cause) ? "missing" : "unreadable";
  }
}

export function isMissing(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
