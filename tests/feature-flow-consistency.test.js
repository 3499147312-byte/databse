const assert = require("assert");
const fs = require("fs");
const path = require("path");
const catalog = require("./fixtures/feature-flow-catalog");

const root = path.resolve(__dirname, "..");
const manual = [
  fs.readFileSync(path.join(root, "docs", "用户使用手册_V1.1.md"), "utf8"),
  fs.readFileSync(path.join(root, "docs", "用户使用手册_V1.2.md"), "utf8")
].join("\n");
const report = fs.readFileSync(path.join(root, "docs", "自动化测试报告_2026-07-24.md"), "utf8");
const testSource = fs.readdirSync(path.join(root, "tests"))
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => fs.readFileSync(path.join(root, "tests", name), "utf8"))
  .join("\n");

// TRACE-01：手册每个操作功能都能追溯到报告条目、自动化用例和真实界面入口。
const ids = new Set();
for (const feature of catalog) {
  assert(!ids.has(feature.id), `重复功能编号：${feature.id}`);
  ids.add(feature.id);
  assert(manual.includes(feature.manualHeading), `手册缺少：${feature.id} ${feature.manualHeading}`);
  assert(report.includes(`| ${feature.id} |`), `测试报告缺少：${feature.id}`);
  for (const testCase of feature.testCases) {
    assert(testSource.includes(`// ${testCase}`), `自动化测试缺少：${feature.id} -> ${testCase}`);
  }
  const [uiFile, uiText] = feature.ui;
  const uiSource = fs.readFileSync(path.join(root, uiFile), "utf8");
  assert(uiSource.includes(uiText), `界面入口缺少：${feature.id} -> ${uiFile} / ${uiText}`);
}

// TRACE-02：手册第二至第十三章的三级操作标题必须全部纳入可追溯目录。
const operationArea = manual.slice(manual.indexOf("## 二、"), manual.indexOf("## 十四、"));
const operationHeadings = operationArea.split(/\r?\n/).filter((line) => line.startsWith("### "));
const catalogHeadings = new Set(catalog.map((item) => item.manualHeading));
const untrackedHeadings = operationHeadings.filter((heading) => !catalogHeadings.has(heading));
assert.deepStrictEqual(untrackedHeadings, [], `手册存在未纳入测试追溯的功能：${untrackedHeadings.join("、")}`);
assert(catalog.some((item) => item.manualHeading === "## 十一、省区月度业绩"));

console.log(`功能流程一致性检查通过：${catalog.length}项手册功能均有界面、用例和结果证据`);
