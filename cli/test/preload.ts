/**
 * Loaded before every test file (`bunfig.toml`). Vault writes set the dirty
 * flag under the temp folder (`src/dirty.ts`), so the test run gets its own
 * temp folder: a test never leaves a flag that makes the machine's next Stop
 * hook reindex.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TMPDIR = mkdtempSync(join(tmpdir(), "llmos-test-"));
