import assert from "node:assert/strict";
import plugin, { __cmpTestHooks } from "../extensions/cmp/index.js";

const { stripGeminiPreferenceScaffold, buildPlatformPrompt, isCurrentNewsQuestion } = __cmpTestHooks;

assert.equal(plugin.id, "cmp");

const newsQuestion = "2026迄今為止，目前最大的新聞有哪些";
assert.equal(isCurrentNewsQuestion(newsQuestion), true);
const newsPrompt = buildPlatformPrompt("gemini", newsQuestion, "zh");
assert.match(newsPrompt, /最新可用資訊/);
assert.match(newsPrompt, /2026迄今為止，目前最大的新聞有哪些/);

const compareQuestion = "請用三點比較 Python 和 JavaScript";
assert.equal(isCurrentNewsQuestion(compareQuestion), false);
const comparePrompt = buildPlatformPrompt("chatgpt", compareQuestion, "zh");
assert.doesNotMatch(comparePrompt, /最新可用資訊/);
assert.match(comparePrompt, /具體差異與理由/);

const geminiScaffold = `
Which response is more helpful?
Choice A
短答案。
This response is more helpful
Choice B
這段不該被選到。
`;
assert.equal(stripGeminiPreferenceScaffold(geminiScaffold), "短答案。");

const geminiTwoChoice = `
Which response is more helpful?
Choice A
第一段很短。
Choice B
第二段比較長，而且才是真正應該保留的回答內容。
This response is more helpful
`;
assert.equal(
  stripGeminiPreferenceScaffold(geminiTwoChoice),
  "第二段比較長，而且才是真正應該保留的回答內容。"
);

console.log("cmp smoke tests passed");
