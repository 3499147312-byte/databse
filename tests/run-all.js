const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const files = [
  "tests/core.test.js",
  "tests/core-extended.test.js",
  "tests/csv.test.js",
  "tests/client-utils.test.js",
  "tests/page-flows.test.js",
  "tests/context-permissions.test.js",
  "tests/context-security.test.js",
  "tests/domain.test.js",
  "tests/handler-auth.test.js",
  "tests/handler-sales-inventory.test.js",
  "tests/handler-expenses-receivables.test.js",
  "tests/handler-reports-dashboard.test.js",
  "tests/handler-admin.test.js",
  "tests/workflow-journeys.test.js",
  "tests/api-routing-ui.test.js",
  "tests/feature-flow-consistency.test.js",
  "scripts/validate-project.js"
];

for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(root, file)], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`全套自动化测试通过：${files.length - 1}组测试 + 1组项目静态检查`);
