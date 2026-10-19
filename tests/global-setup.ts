import { execSync } from "node:child_process";
import { TEST_ENV } from "./test-env";

export default function setup() {
  const env = { ...process.env, ...TEST_ENV } as NodeJS.ProcessEnv;
  execSync("npx prisma migrate deploy", { env, stdio: "pipe" });
  execSync("npx tsx scripts/apply-rls.ts", { env, stdio: "pipe" });
}
