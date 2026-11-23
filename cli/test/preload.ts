/**
 * Loaded before every test file (`bunfig.toml`). Vault writes set the dirty
 * flag in the llmOS state folder (`src/dirty.ts`), so the test run gets its
 * own state folder: a test never writes the machine's state.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "llmos-test-state-"));
