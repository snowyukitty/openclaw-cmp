import { runCmpTool } from "../extensions/cmp/index.js";

const questions = [
  "2026迄今為止，目前最大的新聞有哪些",
  "請用三點比較 Python 和 Rust 在系統編程上的核心差異",
  "分析並告訴我，人工智能在未來5年內對程序員就業市場的影響",
  "What are the strongest arguments for and against replacing REST APIs with GraphQL for a mid-sized product team?",
  "請比較日本、台灣、韓國在 2026 年半導體產業策略上的重點差異"
];

const context = {
  channel: "discord",
  accountId: "default",
  senderId: "676210679899881484"
};

for (const question of questions) {
  await runSample(question);
}

async function runSample(question) {
  const retries = 2;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const startedAt = Date.now();
    console.log(`\n=== CMP SAMPLE START ===`);
    console.log(`attempt=${attempt} question=${question}`);
    try {
      const result = await runCmpTool({ command: question, context });
      const text = result?.content?.[0]?.text || "";
      const details = result?.details || {};
      const elapsedMs = Date.now() - startedAt;
      console.log(`ok=${Boolean(details.ok)} elapsed_ms=${elapsedMs}`);
      console.log(`successful_platforms=${(details.successfulPlatforms || []).join(",")}`);
      console.log(`text_length=${text.length}`);
      console.log(text.slice(0, 1200));
      if (text.length > 1200) {
        console.log("\n[truncated]");
      }
      if (details.ok || !shouldRetry(text, details.error)) return;
    } catch (error) {
      console.error(`CMP sample failed for question: ${question}`);
      console.error(error);
      if (attempt >= retries || !shouldRetry(String(error?.message || error), "")) return;
    }
    await sleep(2000);
  }
}

function shouldRetry(text, errorMessage) {
  const combined = `${text}\n${errorMessage}`.toLowerCase();
  return combined.includes("browser control is not reachable")
    || combined.includes("timed out")
    || combined.includes("econnrefused");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
