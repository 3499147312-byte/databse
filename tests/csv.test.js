const assert = require("assert");
const { parse, toObjects } = require("../miniprogram/utils/csv");

const source = "\uFEFF人员编号,姓名,备注\r\nR001,测试甲,\"含,逗号\"\r\nR002,测试乙,\"含\"\"引号\"\"\"\r\nR003,测试丙,\"两行\n内容\"\r\n";
const rows = parse(source);
assert.deepStrictEqual(rows, [
  ["人员编号", "姓名", "备注"],
  ["R001", "测试甲", "含,逗号"],
  ["R002", "测试乙", "含\"引号\""],
  ["R003", "测试丙", "两行\n内容"]
]);

assert.deepStrictEqual(toObjects(rows), [
  { rowNumber: 2, values: { 人员编号: "R001", 姓名: "测试甲", 备注: "含,逗号" } },
  { rowNumber: 3, values: { 人员编号: "R002", 姓名: "测试乙", 备注: "含\"引号\"" } },
  { rowNumber: 4, values: { 人员编号: "R003", 姓名: "测试丙", 备注: "两行\n内容" } }
]);

assert.deepStrictEqual(parse("A,B\n,\n1,2\n\n"), [["A", "B"], ["1", "2"]], "全空行应被忽略");
assert.throws(() => parse("A,B\n1,\"未闭合"), /CSV/, "未闭合引号必须报错");
assert.deepStrictEqual(toObjects([["A", "B"]]), []);

console.log("CSV解析测试通过");
