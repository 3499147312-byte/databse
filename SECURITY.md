# 安全说明

以下内容禁止提交到 Git：

- `project.private.config.json`
- `cloudfunctions/api/seed/accounts.json`
- `cloudfunctions/api/seed/accounts.private.json`
- 含初始密码的人员 CSV、Excel 或数据库备份
- 真实的一次性初始化码、AppSecret、访问令牌

现有正式环境已经完成初始化，后续升级不得再次执行初始化。

如需部署全新的独立环境，请从线下安全备份恢复账号种子文件，并在部署前设置新的随机初始化码。账号文件只能由老板离线保管。

