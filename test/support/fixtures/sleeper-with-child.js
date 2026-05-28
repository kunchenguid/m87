// Test fixture: a process that spawns a grandchild (in the same process group)
// and then sleeps forever. Used to verify that the e2e runner group-kills the
// whole tree - parent AND grandchildren - on timeout / cleanup.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const grandchildPidFile = process.argv[2];

// No `detached`, so the grandchild stays in our process group. The runner
// spawns us detached as the group leader, so killing -pid reaps this too.
const grandchild = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1e9)"],
  { stdio: "ignore" },
);

writeFileSync(grandchildPidFile, String(grandchild.pid));

setInterval(() => {}, 1e9);
