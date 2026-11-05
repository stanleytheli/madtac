/**
 * The level folder registry. Every `src/world/levels/*.json` (as saved by the editor:
 * open ?edit=true, build, hit Save) is bundled automatically and available here
 * by filename — drop a file in the folder, no code changes needed.
 *
 * Booting a level: `?level=<name>` loads levels/<name>.json. With no param, a
 * file named `default.json` (if the folder has one) replaces the hand-coded
 * demo map in world.ts.
 */
import { registry } from "../engine/registry.ts";

const files = import.meta.glob("./levels/*.json", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

export const LEVELS: Record<string, string> = registry();
for (const [path, text] of Object.entries(files)) {
  const m = /([^/\\]+)\.json$/.exec(path);
  if (m) LEVELS[m[1]] = text;
}
