const assert = require("assert");
const path = require("path");
const { createHarness, expectCode } = require("./helpers/handler-harness");
const {
  newPasswordRecord,
  verifyPassword
} = require("../cloudfunctions/api/lib/core");

const configPath = path.resolve(__dirname, "..", "cloudfunctions", "api", "config.js");
const testConfig = {
  setupCode: "TEST-SETUP-2026",
  passwordIterations: 1000,
  maxRowsPerImport: 1000
};

function account(id, username, name, role, password) {
  return {
    id,
    personId: id.toUpperCase(),
    username,
    name,
    role,
    department: "测试区域",
    ...newPasswordRecord(password, testConfig.passwordIterations)
  };
}

(async () => {
  const initialPassword = "Aa!TestPass123";

  // AUTH-BOOTSTRAP-01：正确一次性初始化码创建匿名账号、产品和完成标记。
  {
    const harness = createHarness({
      users: [],
      settings: [],
      products: [],
      audit_logs: []
    });
    const auth = harness.loadHandler("auth", { modules: { [configPath]: testConfig } });
    const accounts = [
      account("acct_test_boss", "testboss", "测试老板", "boss", initialPassword),
      account("acct_test_rep", "testrep", "测试代表", "rep", initialPassword)
    ];
    await expectCode(auth.bootstrap({ setupCode: "wrong" }, accounts), "INVALID_SETUP_CODE");
    const result = await auth.bootstrap({ setupCode: testConfig.setupCode }, accounts);
    assert.deepStrictEqual(result, { usersCreated: 2, productsCreated: 3 });
    assert.strictEqual(harness.rows("users").length, 2);
    assert.strictEqual(harness.rows("products").length, 3);
    assert.strictEqual(harness.get("settings", "bootstrap").completed, true);
    await expectCode(auth.bootstrap({ setupCode: testConfig.setupCode }, accounts), "ALREADY_INITIALIZED");
  }

  // AUTH-BOOTSTRAP-02：没有私有账号种子时禁止初始化。
  {
    const harness = createHarness({ users: [], settings: [] });
    const auth = harness.loadHandler("auth", { modules: { [configPath]: testConfig } });
    await expectCode(auth.bootstrap({ setupCode: testConfig.setupCode }, []), "ACCOUNT_SEED_MISSING");
  }

  // AUTH-LOGIN-01：正确账号密码绑定当前微信，返回值不泄露密码字段。
  {
    const user = {
      _id: "acct_login",
      personId: "R900",
      username: "login900",
      usernameLower: "login900",
      name: "登录测试",
      role: "rep",
      disabled: false,
      openid: "",
      failedAttempts: 0,
      lockedUntil: 0,
      mustChangePassword: true,
      ...newPasswordRecord(initialPassword, testConfig.passwordIterations)
    };
    const harness = createHarness({ users: [user], audit_logs: [] });
    harness.state.openid = "openid_login_test";
    const auth = harness.loadHandler("auth", { modules: { [configPath]: testConfig } });
    const result = await auth.login({ username: "LOGIN900", password: initialPassword });
    assert.strictEqual(result.user.openid, "openid_login_test");
    assert.strictEqual(harness.get("users", "acct_login").openid, "openid_login_test");
    assert.strictEqual(result.user.passwordHash, undefined);
    assert.strictEqual(result.user.passwordSalt, undefined);
  }

  // AUTH-LOGIN-02：错误密码累计失败，连续五次后锁定账号。
  {
    const user = {
      _id: "acct_login",
      personId: "R900",
      username: "login900",
      usernameLower: "login900",
      name: "登录测试",
      role: "rep",
      disabled: false,
      openid: "",
      failedAttempts: 0,
      lockedUntil: 0,
      ...newPasswordRecord(initialPassword, testConfig.passwordIterations)
    };
    const harness = createHarness({ users: [user] });
    const auth = harness.loadHandler("auth", { modules: { [configPath]: testConfig } });
    for (let index = 0; index < 5; index += 1) {
      await expectCode(auth.login({ username: "login900", password: "Wrong!Pass123" }), "INVALID_CREDENTIALS");
    }
    assert(harness.get("users", "acct_login").lockedUntil > Date.now());
    await expectCode(auth.login({ username: "login900", password: initialPassword }), "ACCOUNT_LOCKED");
  }

  // AUTH-LOGIN-03：一个微信或员工账号不能重复绑定其他对象。
  {
    const first = {
      _id: "acct_first",
      personId: "R901",
      username: "first901",
      usernameLower: "first901",
      name: "账号甲",
      role: "rep",
      disabled: false,
      openid: "openid_same",
      ...newPasswordRecord(initialPassword, testConfig.passwordIterations)
    };
    const second = {
      _id: "acct_second",
      personId: "R902",
      username: "second902",
      usernameLower: "second902",
      name: "账号乙",
      role: "rep",
      disabled: false,
      openid: "",
      ...newPasswordRecord(initialPassword, testConfig.passwordIterations)
    };
    const harness = createHarness({ users: [first, second] });
    harness.state.openid = "openid_same";
    const auth = harness.loadHandler("auth", { modules: { [configPath]: testConfig } });
    await expectCode(auth.login({ username: "second902", password: initialPassword }), "WECHAT_ALREADY_BOUND");
    harness.state.openid = "openid_other";
    await expectCode(auth.login({ username: "first901", password: initialPassword }), "ACCOUNT_ALREADY_BOUND");
  }

  // AUTH-ME-01：已登录用户可以查询自身安全信息。
  {
    const user = {
      _id: "acct_me",
      personId: "R903",
      username: "me903",
      name: "本人测试",
      role: "rep",
      ...newPasswordRecord(initialPassword, testConfig.passwordIterations)
    };
    const harness = createHarness({ users: [user] }, user);
    const auth = harness.loadHandler("auth", { modules: { [configPath]: testConfig } });
    const result = await auth.me();
    assert.strictEqual(result.user.personId, "R903");
    assert.strictEqual(result.user.passwordHash, undefined);
  }

  // AUTH-PASSWORD-01：校验旧密码、确认密码和强度，成功后强制改密标记关闭。
  {
    const user = {
      _id: "acct_password",
      personId: "R904",
      username: "pass904",
      name: "改密测试",
      role: "rep",
      mustChangePassword: true,
      ...newPasswordRecord(initialPassword, testConfig.passwordIterations)
    };
    const harness = createHarness({ users: [user], audit_logs: [] }, user);
    const auth = harness.loadHandler("auth", { modules: { [configPath]: testConfig } });
    await expectCode(auth.changePassword({ oldPassword: "wrong", newPassword: "Bb!NewPass456", confirmPassword: "Bb!NewPass456" }), "WRONG_PASSWORD");
    await expectCode(auth.changePassword({ oldPassword: initialPassword, newPassword: "Bb!NewPass456", confirmPassword: "different" }), "PASSWORD_MISMATCH");
    await expectCode(auth.changePassword({ oldPassword: initialPassword, newPassword: "123", confirmPassword: "123" }), "WEAK_PASSWORD");
    await expectCode(auth.changePassword({ oldPassword: initialPassword, newPassword: initialPassword, confirmPassword: initialPassword }), "SAME_PASSWORD");
    const nextPassword = "Bb!NewPass456";
    const result = await auth.changePassword({
      oldPassword: initialPassword,
      newPassword: nextPassword,
      confirmPassword: nextPassword
    });
    assert.strictEqual(result.user.mustChangePassword, false);
    assert.strictEqual(harness.get("users", "acct_password").mustChangePassword, false);
    assert.strictEqual(verifyPassword(harness.get("users", "acct_password"), nextPassword), true);
  }

  console.log("初始化、登录与密码云函数测试通过");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
