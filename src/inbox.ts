/**
 * llmOS-profile inbox filing, compute side: the `categories` or `project`
 * properties a destination path implies. Moving and stamping the note come
 * with the CLI's write verbs.
 */

import { pathParts, sortedStrings } from "./compat.ts";
import { projectAlias } from "./schema.ts";

export const RECOGNIZED_AREAS = new Set(["knowledge", "projects", "sources", "archive"]);
const AREA_CATEGORIES: Record<string, string> = {
  knowledge: "[[Knowledge]]",
  sources: "[[Sources]]",
  archive: "[[Archive]]",
};

/**
 * Derive the properties a destination path implies. A project's landing page
 * (`projects/<slug>/<slug>.md`) gets `[[Projects]]` and no self-link; any
 * other project note gets the project link alone. Throws for a destination
 * outside the recognized filing areas.
 */
export function destinationProperties(root: string, destination: string): Record<string, string[]> {
  const target = destination.endsWith(".md") ? destination : `${destination}.md`;
  const parts = pathParts(target);
  const area = parts[0] ?? "";
  if (!RECOGNIZED_AREAS.has(area)) {
    throw new Error(
      `destination '${destination}' is outside the recognized vault filing ` +
        `areas (${sortedStrings(RECOGNIZED_AREAS).join(", ")})`,
    );
  }
  if (area !== "projects") return { categories: [AREA_CATEGORIES[area] as string] };

  if (parts.length < 2) throw new Error(`destination '${destination}' names no project slug`);
  const slug = parts[1] as string;
  if (parts.length === 3 && parts[2] === `${slug}.md`) return { categories: ["[[Projects]]"] };
  return { project: [`[[projects/${slug}/${slug}|${projectAlias(root, slug)}]]`] };
}
