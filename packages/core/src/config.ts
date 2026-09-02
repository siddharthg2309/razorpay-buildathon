import { join } from "node:path";
import { loadActionLibrary, type ActionLibrary } from "./actions.js";
import { loadPlaybooks, type PlaybookTable } from "./playbooks.js";
import { loadTaxonomy, type DeclineTaxonomy } from "./taxonomy.js";

export interface EngineConfig {
  library: ActionLibrary;
  taxonomy: DeclineTaxonomy;
  playbooks: PlaybookTable;
}

/**
 * Loads all three config artefacts together, so a playbook referencing an
 * action the library forbids fails at startup rather than mid-batch.
 */
export function loadConfig(root: string = process.cwd()): EngineConfig {
  const library = loadActionLibrary(join(root, "actions/library.yaml"));
  return {
    library,
    taxonomy: loadTaxonomy(join(root, "taxonomy/decline-codes.yaml")),
    playbooks: loadPlaybooks(join(root, "playbooks/default.yaml"), library),
  };
}
