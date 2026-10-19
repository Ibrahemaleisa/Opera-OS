export const TEST_ENV: Record<string, string> = {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://operra_app:operra_app_dev@localhost:5432/operra_test?connection_limit=10",
  MIGRATION_DATABASE_URL: process.env.TEST_MIGRATION_DATABASE_URL ?? "postgresql://operra:operra_dev@localhost:5432/operra_test",
  DATABASE_APP_ROLE: "operra_app",
  JOBS_MODE: "inline",
  REDIS_URL: "",
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR: "./storage-test",
  APP_SECRET: "test-secret-test-secret-test-secret-0123456789",
  NODE_ENV: "test",
};
