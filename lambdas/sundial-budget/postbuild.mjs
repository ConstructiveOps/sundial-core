// postbuild.mjs — deploy-time cleanup for sundial-budget (run by deploy.ps1 after
// esbuild has bundled). Removes the transient template.generated.js so the working
// tree returns to its normal state, where `npm test` reads the source .xlsx
// directly. The bundle already inlined the embedded template, so the file is no
// longer needed on disk.

import { rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const generated = join(here, "template.generated.js");

if (existsSync(generated)) {
  rmSync(generated);
  console.log(`postbuild: removed transient ${generated}`);
}
