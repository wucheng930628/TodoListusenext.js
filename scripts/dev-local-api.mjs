import { spawn } from "node:child_process";
// Bind the server itself to loopback; Host/Origin checks are additional guards.
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3000"], {
  stdio: "inherit",
  env: { ...process.env, SLOWLY_LOCAL_API: "1", SLOWLY_LOCAL_API_ORIGIN: "http://127.0.0.1:3000", DYNAMODB_ENDPOINT: "http://127.0.0.1:9000" },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
