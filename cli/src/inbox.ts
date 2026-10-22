/**
 * llmOS-profile inbox filing, compute side: the `categories` or `project`
 * properties a destination path implies. Moving and stamping the note come
 * with the CLI's write verbs. The stamp is a default: a note that already
 * names its categories, such as `[[Papers]]` in `knowledge/`, keeps them.
 */

import { normalize } from "node:path";
import { projectAlias } from "./schema.ts";

export const RECOGNIZED_AREAS = new Set(["knowledge", "projects", "sources", "archive"]);
// Each value names a hub in `categories/`. Archiving does not change what a
// note is, so `archive` implies no category.
const AREA_CATEGORIES: Record<string, string> = {
  knowledge: "[[Knowledge]]",
  sources: "[[Sources]]",
};

/**
 * Derive the properties a destination path implies: the area's default
 * category, or none for `archive`. A project's landing page
 * (`projects/<slug>/<slug>.md`) gets `[[Projects]]` and no self-link; any
 * other project note gets the project link alone. The path is normalized
 * first (`./`, `//`, `..`). Throws for a destination outside the recognized
 * filing areas.
 */
export function destinationProperties(root: string, destination: string): Record<string, string[]> {
  const target = destination.endsWith(".md") ? destination : `${destination}.md`;
  const parts = normalize(target).split("/");
  const area = parts[0] ?? "";
  if (!RECOGNIZED_AREAS.has(area)) {
    throw new Error(
      `destination '${destination}' is outside the recognized vault filing ` +
        `areas (${[...RECOGNIZED_AREAS].sort().join(", ")})`,
    );
  }
  if (area !== "projects") {
    const category = AREA_CATEGORIES[area];
    return category === undefined ? {} : { categories: [category] };
  }

  if (parts.length < 2) throw new Error(`destination '${destination}' names no project slug`);
  const slug = parts[1] as string;
  if (parts.length === 3 && parts[2] === `${slug}.md`) return { categories: ["[[Projects]]"] };
  return { project: [`[[projects/${slug}/${slug}|${projectAlias(root, slug)}]]`] };
}
