const assert = require("assert");
const Module = require("module");
const { createHarness, expectCode } = require("./helpers/handler-harness");

(async () => {
  const data = {
    users: [
      { _id: "acct_active", personId: "R001", name: "正常用户", role: "rep", openid: "openid_active", disabled: false, mustChangePassword: false },
      { _id: "acct_disabled", personId: "R002", name: "停用用户", role: "rep", openid: "openid_disabled", disabled: true, mustChangePassword: false },
      { _id: "acct_password", personId: "R003", name: "待改密用户", role: "rep", openid: "openid_password", disabled: false, mustChangePassword: true }
    ],
    idempotency: [],
    audit_logs: [],
    bulk: Array.from({ length: 150 }, (_, index) => ({ _id: `ROW${index}`, order: index }))
  };
  const harness = createHarness(data);
  let openid = "openid_active";
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database: () => harness.db,
    getWXContext: () => ({ OPENID: openid })
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloudMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  const contextPath = require.resolve("../cloudfunctions/api/lib/context");
  delete require.cache[contextPath];
  const context = require(contextPath);
  Module._load = originalLoad;

  // CONTEXT-AUTH-01：未绑定、停用和待改密账号分别返回明确错误。
  openid = "openid_missing";
  await expectCode(context.requireUser(), "AUTH_REQUIRED");
  openid = "openid_disabled";
  await expectCode(context.requireUser(), "ACCOUNT_DISABLED");
  openid = "openid_password";
  await expectCode(context.requireUser(), "PASSWORD_CHANGE_REQUIRED");
  assert.strictEqual((await context.requireUser({ allowPasswordChange: true })).personId, "R003");
  openid = "openid_active";
  assert.strictEqual((await context.requireUser()).personId, "R001");

  // CONTEXT-FETCH-01：分页读取能够跨过100条云数据库单页限制。
  const allRows = await context.fetchAll("bulk", {}, { max: 150 });
  assert.strictEqual(allRows.length, 150);

  // CONTEXT-IDEMPOTENCY-01：相同成功请求只执行一次并复用结果。
  const user = data.users[0];
  let executions = 0;
  const first = await context.withIdempotency(user, "request-key-001", "testAction", async () => {
    executions += 1;
    return { value: 42 };
  });
  const second = await context.withIdempotency(user, "request-key-001", "testAction", async () => {
    executions += 1;
    return { value: 99 };
  });
  assert.deepStrictEqual(first, { value: 42 });
  assert.deepStrictEqual(second, { value: 42 });
  assert.strictEqual(executions, 1);

  // CONTEXT-IDEMPOTENCY-02：非法请求号、处理中请求和失败状态正确处理。
  await expectCode(context.withIdempotency(user, "short", "testAction", async () => ({})), "INVALID_IDEMPOTENCY_KEY");
  const crypto = require("crypto");
  const digest = crypto.createHash("sha256").update("R001|busyAction|request-key-002").digest("hex");
  await context.setDoc("idempotency", digest, {
    userId: "R001",
    action: "busyAction",
    status: "processing",
    startedAtMs: Date.now()
  });
  await expectCode(context.withIdempotency(user, "request-key-002", "busyAction", async () => ({})), "REQUEST_PROCESSING");
  const failedDigest = crypto.createHash("sha256").update("R001|failAction|request-key-003").digest("hex");
  await assert.rejects(context.withIdempotency(user, "request-key-003", "failAction", async () => {
    const error = new Error("expected failure");
    error.code = "EXPECTED";
    throw error;
  }), /expected failure/);
  assert.strictEqual(harness.get("idempotency", failedDigest).status, "failed");
  assert.strictEqual(harness.get("idempotency", failedDigest).errorCode, "EXPECTED");

  // CONTEXT-AUDIT-01：审计日志记录操作者、动作、目标并限制详情长度。
  await context.writeAudit(user, "测试审计", "TARGET-01", "x".repeat(1500));
  const audit = harness.rows("audit_logs")[0];
  assert.strictEqual(audit.actorId, "R001");
  assert.strictEqual(audit.action, "测试审计");
  assert.strictEqual(audit.detail.length, 1000);

  console.log("认证、幂等与审计上下文测试通过");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
