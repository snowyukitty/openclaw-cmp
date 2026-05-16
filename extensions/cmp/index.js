import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { managedBrowserHelpText } from "../../skills/_shared/compat.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OPENCLAW_DIR = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
const SKILL_DIR = resolveCmpSkillDir();
const CONFIG_PATH = path.join(SKILL_DIR, "config", "platforms.json");
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_DIR, "openclaw.json");
const AUTH_PROFILES_PATH = path.join(OPENCLAW_DIR, "agents", "main", "agent", "auth-profiles.json");
const STATE_SCRIPT = path.join(SKILL_DIR, "scripts", "state.py");
const DETECT_SCRIPT = path.join(SKILL_DIR, "scripts", "detect-complete.js");
const EXTRACT_SCRIPT = path.join(SKILL_DIR, "scripts", "extract-response.js");
const LOG_DIR = path.join(SKILL_DIR, "logs");
const LAST_RUN_LOG = path.join(LOG_DIR, "last-run.json");
const RUN_LOG = path.join(LOG_DIR, "cmp.log");
const PLATFORM_ORDER = ["chatgpt", "claude", "gemini", "grok"];
const PLATFORM_SET = new Set(PLATFORM_ORDER);
// CMP is explicitly quality-first. We would rather wait longer than synthesize on
// half-finished browser output, so the runtime uses a generous 5-minute ceiling.
const RESPONSE_WAIT_DEADLINE_MS = 300000;
const COMPLETION_STABLE_POLLS = 4;
const RESPONSE_WAIT_MINUTES = Math.round(RESPONSE_WAIT_DEADLINE_MS / 60000);
const FORBIDDEN_SYNTHESIS_PATTERNS = [
  /主要整理了.+這幾個面向/,
  /的分析明顯偏向/,
  /單獨補進了.+這條線索/,
  /共同的評估角度包括/,
  /提供的可保留重點/,
  /直接回答你的問題：沒有單一答案/,
  /退化輸出|保底資訊|差異分析未完成/
];
const COMMON_QUESTION_WORDS = new Set([
  "what", "which", "tell", "about", "best", "good", "great", "now", "please", "with",
  "from", "your", "this", "that", "these", "those", "should", "would", "could", "them",
  "they", "then", "than", "into", "three", "five", "points"
]);
let cmpLogger = console;
let browserCurrentTargetId = null;
let browserControlServerBootPromise = null;
let cmpAgentRuntime = null;
let cmpCoreConfig = null;
let copilotTokenResolverPromise = null;

function resolveCmpSkillDir() {
  const override = process.env.CMP_SKILL_DIR;
  if (override) return override;
  const adjacent = path.resolve(MODULE_DIR, "../../skills/cmp");
  if (fsSync.existsSync(adjacent)) return adjacent;
  return path.join(OPENCLAW_DIR, "skills", "cmp");
}

const plugin = {
  id: "cmp",
  name: "CMP",
  description: "Deterministic command handler for cmp slash commands.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {}
  },
  register(api) {
    cmpLogger = api.logger || console;
    cmpAgentRuntime = api.runtime?.agent || null;
    cmpCoreConfig = api.config || null;
    api.logger.info(
      "[cmp] registering plugin commands: cmp-status (telegram: cmpstatus), cmp-on (telegram: cmpon), cmp-off (telegram: cmpoff), tool: cmp"
    );
    api.registerCommand({
      name: "cmp",
      description: "Run a multi-AI browser comparison. Usage: /cmp <question>",
      acceptsArgs: true,
      async handler(ctx) {
        const result = await handleCmpRequest({
          commandName: "cmp",
          command: String(ctx?.args || ""),
          context: summarizeContext(ctx)
        });
        return { text: result.text };
      }
    });
    api.registerCommand({
      name: "cmp-status",
      nativeNames: {
        telegram: "cmpstatus"
      },
      description: "Show current cmp platform state.",
      acceptsArgs: false,
      async handler(ctx) {
        const result = await handleCmpRequest({
          commandName: "cmp-status",
          command: "",
          context: summarizeContext(ctx)
        });
        return { text: result.text };
      }
    });
    api.registerCommand({
      name: "cmp-on",
      nativeNames: {
        telegram: "cmpon"
      },
      description: "Enable one cmp platform or all platforms. Usage: /cmp-on <platform|all>",
      acceptsArgs: true,
      async handler(ctx) {
        const result = await handleCmpRequest({
          commandName: "cmp-on",
          command: String(ctx?.args || ""),
          context: summarizeContext(ctx)
        });
        return { text: result.text };
      }
    });
    api.registerCommand({
      name: "cmp-off",
      nativeNames: {
        telegram: "cmpoff"
      },
      description: "Disable one cmp platform or all platforms. Usage: /cmp-off <platform|all>",
      acceptsArgs: true,
      async handler(ctx) {
        const result = await handleCmpRequest({
          commandName: "cmp-off",
          command: String(ctx?.args || ""),
          context: summarizeContext(ctx)
        });
        return { text: result.text };
      }
    });
    api.registerTool({
      name: "cmp",
      label: "CMP",
      description:
        "Runs the cmp multi-AI browser workflow and handles cmp status/on/off commands deterministically.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Raw user text after the slash command."
          },
          commandName: {
            type: "string"
          },
          skillName: {
            type: "string"
          }
        },
        required: ["command"]
      },
      async execute(_id, params) {
        return executeCmp(params);
      }
    });
  }
};

export default plugin;
export async function runCmpTool(params) {
  return executeCmp(params);
}
export const __cmpTestHooks = {
  stripGeminiPreferenceScaffold,
  buildPlatformPrompt,
  isCurrentNewsQuestion,
  findOpenClawDistFile
};

function textResult(text, details) {
  return {
    content: [{ type: "text", text }],
    details
  };
}

async function executeCmp(params) {
  const result = await handleCmpRequest(params);
  return textResult(result.text, result.details);
}

async function handleCmpRequest(params) {
  const commandName = typeof params?.commandName === "string" ? params.commandName : "cmp";
  const rawCommand = typeof params?.command === "string" ? params.command : "";
  const context = summarizeContext(params?.context);

  logTrace("handler_entry", {
    commandName,
    commandLength: rawCommand.length,
    context
  });

  if (commandName === "cmp-status") {
    const payload = await buildStatusPayload();
    return finalizeReply(context, renderStatus(payload), payload);
  }

  if (commandName === "cmp-on" || commandName === "cmp-off") {
    const mode = commandName === "cmp-on" ? "on" : "off";
    const target = rawCommand.trim().toLowerCase();
    const payload = await applyToggle(target, mode);
    return finalizeReply(context, renderToggle(payload), payload);
  }

  if (commandName === "cmp") {
    const parsed = parseCmpInput(rawCommand);
    logTrace("parsed_command", { kind: parsed.kind, commandName });

    if (parsed.kind === "help") {
      return finalizeReply(context, buildUsageText(), { ok: true, kind: "help" });
    }
    if (parsed.kind === "status") {
      const payload = await buildStatusPayload();
      return finalizeReply(context, renderStatus(payload), payload);
    }
    if (parsed.kind === "toggle") {
      const payload = await applyToggle(parsed.target, parsed.mode);
      return finalizeReply(context, renderToggle(payload), payload);
    }
    return await runComparison(parsed.question, context);
  }

  return finalizeReply(context, buildUsageText(), { ok: true, kind: "help" });
}

function parseCmpInput(rawCommand) {
  const trimmed = rawCommand.trim();
  if (!trimmed) return { kind: "help" };
  if (/^status$/i.test(trimmed)) return { kind: "status" };
  const toggleMatch = trimmed.match(/^(chatgpt|claude|gemini|grok|all)\s+(on|off)$/i);
  if (toggleMatch) {
    return {
      kind: "toggle",
      target: toggleMatch[1].toLowerCase(),
      mode: toggleMatch[2].toLowerCase()
    };
  }
  return { kind: "question", question: trimmed };
}

async function buildStatusPayload() {
  const status = await loadStatus();
  return {
    ok: true,
    kind: "status",
    status
  };
}

async function applyToggle(target, mode) {
  if (!target) {
    throw new Error(`No platform provided. ${buildUsageText()}`);
  }
  if (target !== "all" && !PLATFORM_SET.has(target)) {
    throw new Error(`Unknown platform: ${target}. Valid values: chatgpt, claude, gemini, grok, all.`);
  }
  if (mode !== "on" && mode !== "off") {
    throw new Error(`Unknown mode: ${mode}. Use on or off.`);
  }

  if (target === "all") {
    await runCommand("python3", [STATE_SCRIPT, "set-all", mode], { timeoutMs: 30000 });
  } else {
    await runCommand("python3", [STATE_SCRIPT, "set", target, mode], { timeoutMs: 30000 });
  }

  const status = await loadStatus();
  return {
    ok: true,
    kind: "toggle",
    target,
    mode,
    status
  };
}

async function loadStatus() {
  const status = await runCommand("python3", [STATE_SCRIPT, "status", "--json"], {
    json: true,
    timeoutMs: 30000
  });
  return status;
}

async function loadEnabledPlatforms() {
  return await runCommand("python3", [STATE_SCRIPT, "enabled", "--json"], {
    json: true,
    timeoutMs: 30000
  });
}

async function runComparison(question, invocation = {}) {
  const startedAt = new Date().toISOString();
  const locale = detectLocale(question);
  const runLog = {
    startedAt,
    question,
    locale,
    invocation,
    traces: [],
    platforms: []
  };
  traceRun(runLog, "cmp_handler_entry", {
    questionLength: question.length,
    locale,
    invocation
  });
  try {
    const platforms = await readJson(CONFIG_PATH);
    const enabledPlatforms = await loadEnabledPlatforms();
    runLog.enabledPlatforms = enabledPlatforms;
    traceRun(runLog, "platform_selection", { enabledPlatforms });

    const browserStatus = await ensureBrowserReady(runLog);
    runLog.browserStatus = browserStatus;
    const evaluateEnabled = await readEvaluateEnabled();
    runLog.evaluateEnabled = evaluateEnabled;
    traceRun(runLog, "browser_ready", {
      running: browserStatus?.running,
      cdpReady: browserStatus?.cdpReady,
      evaluateEnabled
    });

    if (!enabledPlatforms.length) {
      const text = localize(locale, {
        zh: "沒有啟用的平台。請使用 /cmp-on <platform> 或輸入 /cmp <platform> on。",
        ja: "有効なプラットフォームがありません。/cmp-on <platform> か /cmp <platform> on を使ってください。",
        en: "No platforms enabled. Use /cmp-on <platform> or /cmp <platform> on."
      });
      runLog.error = text;
      await persistRunLog(runLog);
      return finalizeReply(invocation, text, { ok: false, reason: "no_enabled_platforms", log: LAST_RUN_LOG });
    }

    const active = [];

    for (const platformKey of enabledPlatforms) {
      const cfg = platforms[platformKey];
      if (!cfg) {
        runLog.platforms.push({
          platform: platformKey,
          status: "failed",
          error: "Missing platform config"
        });
        continue;
      }
      const result = await sendPromptToPlatform(platformKey, cfg, question, locale, runLog);
      runLog.platforms.push(result.log);
      if (result.active) {
        active.push(result.active);
      }
    }

    if (!active.length) {
      runLog.error = "No platforms were queried successfully.";
      await persistRunLog(runLog);
      return finalizeReply(
        invocation,
        renderFailureOnlyReport(question, locale, runLog.platforms),
        { ok: false, reason: "no_platforms_queried", log: LAST_RUN_LOG }
      );
    }

    if (evaluateEnabled) {
      traceRun(runLog, "response_wait_start", { mode: "evaluate", activePlatforms: active.map((entry) => entry.platform) });
      await installCompletionDetectors(active, runLog);
      await waitForCompletion(active, runLog);
    } else {
      traceRun(runLog, "response_wait_start", { mode: "snapshot_fallback", activePlatforms: active.map((entry) => entry.platform) });
      await waitForCompletionFallback(active, runLog);
    }

    await collectResponses(active, evaluateEnabled, question, runLog);
    await closeActiveTabs(active, runLog);

    const aggregation = await aggregatePlatformResponses(question, locale, active, runLog.platforms, runLog);
    traceRun(runLog, "synthesis_start", {
      usablePlatforms: aggregation.usable.map((entry) => entry.platform),
      unusablePlatforms: aggregation.unusable.map((entry) => ({
        platform: entry.platform,
        reason: entry.reason
      }))
    });
    const synthesis = await buildComparisonSynthesis(question, locale, aggregation, runLog);
    const text = aggregation.usable.length
      ? renderComparisonReport(question, locale, aggregation, synthesis)
      : renderFailureOnlyReport(question, locale, aggregation.unusable);
    runLog.synthesis = synthesis;
    runLog.aggregation = aggregation;
    runLog.finalText = text;
    traceRun(runLog, "final_reply_ready", {
      usablePlatforms: aggregation.usable.map((entry) => entry.platform),
      failures: aggregation.unusable.map((entry) => ({
        platform: entry.platform,
        failure: entry.reason
      }))
    });
    await persistRunLog(runLog);

    return finalizeReply(invocation, text, {
      ok: aggregation.usable.length > 0,
      successfulPlatforms: aggregation.usable.map((entry) => entry.platform),
      log: LAST_RUN_LOG,
      transportData: {
        question,
        locale,
        aggregation,
        synthesis
      }
    });
  } catch (error) {
    const message = toErrorMessage(error);
    runLog.error = message;
    traceRun(runLog, "cmp_run_failed", { error: message });
    try {
      await persistRunLog(runLog);
    } catch (persistError) {
      logTrace("cmp_run_failed_persist_error", {
        error: toErrorMessage(persistError),
        originalError: message
      });
    }
    return finalizeReply(
      invocation,
      renderImmediateFailureReport(question, locale, message),
      { ok: false, reason: "cmp_runtime_error", error: message, log: LAST_RUN_LOG }
    );
  }
}

function finalizeReply(context, text, details) {
  return {
    text: fitForTransport(text, context, details),
    details
  };
}

function fitForTransport(text, context, details) {
  const cleaned = compactWhitespacePreservingLines(text || "");
  const limit = detectTransportTextLimit(context);
  if (cleaned.length <= limit) return cleaned;
  const transport = details?.transportData;
  if (!transport) {
    return summarizePlainTextForTransport(cleaned, limit);
  }
  const compact = compactWhitespacePreservingLines(renderComparisonReport(
    transport.question,
    transport.locale,
    transport.aggregation,
    transport.synthesis,
    { compact: true }
  ));
  if (compact.length <= limit) return compact;

  const tighter = compactWhitespacePreservingLines(renderComparisonReport(
    transport.question,
    transport.locale,
    transport.aggregation,
    transport.synthesis,
    { compact: true, tighter: true }
  ));
  if (tighter.length <= limit) return tighter;

  return compactWhitespacePreservingLines(renderUltraCompactComparisonReport(
    transport.question,
    transport.locale,
    transport.aggregation,
    transport.synthesis,
    limit
  ));
}

function detectTransportTextLimit(context) {
  const channel = String(context?.channel || context?.transport || "").toLowerCase();
  if (channel === "discord") return 1900;
  if (channel === "telegram") return 3500;
  return 3500;
}

async function ensureBrowserReady(runLog) {
  let status = await runCommand("openclaw", ["browser", "status", "--json"], {
    json: true,
    timeoutMs: 30000
  });
  traceRun(runLog, "browser_status", status || {});
  if (status?.enabled && !status?.running) {
    traceRun(runLog, "browser_start_requested", {});
    await runCommand("openclaw", ["browser", "start", "--json"], {
      json: true,
      timeoutMs: 60000
    });
    status = await runCommand("openclaw", ["browser", "status", "--json"], {
      json: true,
      timeoutMs: 30000
    });
    traceRun(runLog, "browser_status_after_start", status || {});
  }
  if (!status?.enabled) {
    throw new Error("Managed browser is disabled in openclaw.json.");
  }
  if (!status?.running) {
    throw new Error(`Managed browser is not running. ${managedBrowserHelpText()}`);
  }
  if (!status?.cdpReady) {
    throw new Error("Managed browser is running but CDP is not ready.");
  }
  return status;
}

async function readEvaluateEnabled() {
  const cfg = await readJson(OPENCLAW_CONFIG_PATH);
  return Boolean(cfg?.browser?.evaluateEnabled);
}

async function sendPromptToPlatform(platformKey, cfg, question, locale, runLog) {
  const promptText = buildPlatformPrompt(platformKey, question, locale);
  const log = {
    platform: platformKey,
    name: cfg.name,
    url: cfg.new_chat_url,
    status: "starting",
    steps: []
  };
  traceRun(runLog, "platform_begin", {
    platform: platformKey,
    url: cfg.new_chat_url
  });

  try {
    const openResult = await runCommand("openclaw", ["browser", "open", cfg.new_chat_url, "--json"], {
      json: true,
      timeoutMs: 45000
    });
    const targetId = await resolveOpenedTargetId(openResult.targetId, cfg.new_chat_url, runLog, platformKey);
    log.targetId = targetId;
    log.steps.push({ step: "open", ok: true, targetId, url: cfg.new_chat_url });
    traceRun(runLog, "platform_opened", { platform: platformKey, targetId, url: cfg.new_chat_url });

    await delay(500);
    await focusTab(targetId);
    traceRun(runLog, "platform_focus", { platform: platformKey, targetId });

    try {
      await runCommand("openclaw", ["browser", "wait", "--load", "networkidle", "--timeout", "15000", "--json"], {
        json: true,
        timeoutMs: 20000
      });
      log.steps.push({ step: "wait_load", ok: true });
      traceRun(runLog, "platform_loaded", { platform: platformKey, targetId });
    } catch (error) {
      log.steps.push({ step: "wait_load", ok: false, error: toErrorMessage(error) });
      traceRun(runLog, "platform_load_warning", { platform: platformKey, error: toErrorMessage(error) });
    }

    const loginState = await detectLoginScreen();
    log.steps.push({ step: "detect_login", ok: !loginState.loginLikely, details: loginState });
    traceRun(runLog, "platform_login_check", {
      platform: platformKey,
      loginLikely: Boolean(loginState.loginLikely),
      url: loginState.url
    });
    if (loginState.loginLikely) {
      log.status = "session_expired";
      log.failure = localize(locale, {
        zh: `${cfg.name}: 🔒 會話已過期，請重新登入。`,
        ja: `${cfg.name}: 🔒 セッション切れです。再ログインしてください。`,
        en: `${cfg.name}: 🔒 Session expired. Please sign in again.`
      });
      return { log };
    }

    const firstSnapshot = await snapshotPage();
    log.steps.push({
      step: "snapshot_input",
      ok: true,
      refs: Object.keys(firstSnapshot.refs || {})
    });

    const inputRef = findInputRef(firstSnapshot.refs || {});
    log.inputRef = inputRef || null;
    log.steps.push({ step: "find_input", ok: Boolean(inputRef), inputRef });
    traceRun(runLog, "platform_input_discovery", { platform: platformKey, inputRef });

    let fillMethod = "type";
    let inputFilled = false;

    if (inputRef) {
      try {
        await runCommand("openclaw", ["browser", "click", inputRef, "--json"], {
          json: true,
          timeoutMs: 10000
        });
        await runCommand("openclaw", ["browser", "type", inputRef, promptText, "--json"], {
          json: true,
          timeoutMs: 45000
        });
        const typedValue = await readElementText(inputRef);
        inputFilled = typedValue.includes(promptText);
        log.steps.push({
          step: "fill_input",
          ok: inputFilled,
          method: "type_ref",
          observedLength: typedValue.length
        });
        traceRun(runLog, "platform_fill_attempt", {
          platform: platformKey,
          method: "type_ref",
          ok: inputFilled,
          observedLength: typedValue.length
        });
      } catch (error) {
        log.steps.push({
          step: "fill_input",
          ok: false,
          method: "type_ref",
          error: toErrorMessage(error)
        });
        traceRun(runLog, "platform_fill_attempt", {
          platform: platformKey,
          method: "type_ref",
          ok: false,
          error: toErrorMessage(error)
        });
      }
    }

    if (!inputFilled && platformKey === "claude") {
      const claudeFill = await fillClaudeComposer(promptText);
      fillMethod = "claude_dom";
      inputFilled = Boolean(claudeFill?.ok);
      log.steps.push({ step: "fill_input_fallback", ok: inputFilled, method: "claude_dom", details: claudeFill });
      traceRun(runLog, "platform_fill_attempt", {
        platform: platformKey,
        method: "claude_dom",
        ok: inputFilled,
        details: claudeFill
      });
    }

    if (!inputFilled) {
      const domFill = await fillInputViaDom(promptText);
      fillMethod = "dom";
      inputFilled = Boolean(domFill?.ok);
      log.steps.push({ step: "fill_input_fallback", ok: inputFilled, method: "dom", details: domFill });
      traceRun(runLog, "platform_fill_attempt", {
        platform: platformKey,
        method: "dom",
        ok: inputFilled,
        details: domFill
      });
    }

    if (!inputFilled) {
      log.status = "failed";
      log.failure = `${cfg.name}: ❌ Could not interact with chat input`;
      return { log };
    }

    await delay(2000);

    const secondSnapshot = await snapshotPage();
    log.steps.push({
      step: "snapshot_send",
      ok: true,
      refs: Object.keys(secondSnapshot.refs || {})
    });

    const sendRef = findSendRef(secondSnapshot.refs || {});
    log.sendRef = sendRef || null;
    log.steps.push({ step: "find_send", ok: Boolean(sendRef), sendRef });
    traceRun(runLog, "platform_send_discovery", { platform: platformKey, sendRef });

    const submission = await submitPrompt(platformKey, promptText, inputRef, sendRef, runLog, log);
    const sendMethod = submission.method;
    const sendOk = submission.ok;

    if (!sendOk) {
      log.status = "failed";
      log.failure = `${cfg.name}: ❌ ${submission.reason || "Could not find an enabled send action"}`;
      return { log };
    }

    log.status = "sent";
    log.fillMethod = fillMethod;
    log.sendMethod = sendMethod;
    traceRun(runLog, "platform_sent", {
      platform: platformKey,
      targetId,
      fillMethod,
      sendMethod
    });

    return {
      log,
      active: {
        platform: platformKey,
        name: cfg.name,
        targetId,
        url: cfg.new_chat_url,
        status: "sent",
        completion: "pending",
        responseText: "",
        failure: null,
        question,
        promptText
      }
    };
  } catch (error) {
    log.status = "failed";
    log.failure = `${cfg.name}: ❌ ${toErrorMessage(error)}`;
    log.steps.push({ step: "fatal", ok: false, error: toErrorMessage(error) });
    traceRun(runLog, "platform_failed", { platform: platformKey, error: toErrorMessage(error) });
    return { log };
  }
}

async function installCompletionDetectors(active, runLog) {
  const detector = await fs.readFile(DETECT_SCRIPT, "utf8");
  for (const entry of active) {
    if (entry.platform === "claude") {
      // Claude uses a dedicated per-poll DOM probe (checkClaudeCompletion) that does not
      // depend on injected JS state. Injection would fail anyway because Claude navigates
      // from /new to /chat/<id> on submission, invalidating the tab targetId.
      addRunStep(runLog, entry.platform, { step: "inject_detector", ok: true, skipped: true, reason: "claude_uses_dedicated_probe" });
      continue;
    }
    try {
      await focusActiveEntry(entry, runLog);
      await runCommand("openclaw", ["browser", "evaluate", "--fn", detector, "--json"], {
        json: true,
        timeoutMs: 20000
      });
      addRunStep(runLog, entry.platform, { step: "inject_detector", ok: true });
      traceRun(runLog, "detector_injected", { platform: entry.platform });
    } catch (error) {
      addRunStep(runLog, entry.platform, { step: "inject_detector", ok: false, error: toErrorMessage(error) });
      traceRun(runLog, "detector_injected", { platform: entry.platform, ok: false, error: toErrorMessage(error) });
    }
  }
}

async function waitForCompletion(active, runLog) {
  const history = new Map();
  const deadline = Date.now() + RESPONSE_WAIT_DEADLINE_MS;
  const waitStartedAt = Date.now();
  while (Date.now() < deadline && active.some((entry) => entry.completion === "pending")) {
    for (const entry of active) {
      if (entry.completion !== "pending") continue;
      try {
        await focusActiveEntry(entry, runLog);
        if (entry.platform === "chatgpt") {
          const completion = await checkChatGPTCompletion(entry.promptText || entry.question, history.get(entry.platform));
          history.set(entry.platform, completion);
          addRunStep(runLog, entry.platform, {
            step: "wait_complete",
            ok: completion.done,
            platformCheck: true,
            details: completion
          });
          traceRun(runLog, "platform_completion_probe", {
            platform: entry.platform,
            elapsedMs: Date.now() - waitStartedAt,
            ...completion
          });
          if (completion.done) {
            entry.completion = "done";
            traceRun(runLog, "response_complete", {
              platform: entry.platform,
              method: "chatgpt_probe",
              elapsedMs: Date.now() - waitStartedAt
            });
          }
          continue;
        }
        if (entry.platform === "gemini") {
          const completion = await checkGeminiCompletion(entry.promptText || entry.question, history.get(entry.platform));
          history.set(entry.platform, completion);
          addRunStep(runLog, entry.platform, {
            step: "wait_complete",
            ok: completion.done,
            platformCheck: true,
            details: completion
          });
          traceRun(runLog, "platform_completion_probe", {
            platform: entry.platform,
            elapsedMs: Date.now() - waitStartedAt,
            ...completion
          });
          if (completion.done) {
            entry.completion = "done";
            traceRun(runLog, "response_complete", {
              platform: entry.platform,
              method: "gemini_probe",
              elapsedMs: Date.now() - waitStartedAt
            });
          }
          continue;
        }
        if (entry.platform === "grok") {
          const completion = await checkGrokCompletion(history.get(entry.platform));
          history.set(entry.platform, completion);
          addRunStep(runLog, entry.platform, {
            step: "wait_complete",
            ok: completion.done,
            platformCheck: true,
            details: completion
          });
          traceRun(runLog, "platform_completion_probe", {
            platform: entry.platform,
            elapsedMs: Date.now() - waitStartedAt,
            ...completion
          });
          if (completion.done) {
            entry.completion = "done";
            traceRun(runLog, "response_complete", {
              platform: entry.platform,
              method: "grok_probe",
              elapsedMs: Date.now() - waitStartedAt
            });
          }
          continue;
        }
        if (entry.platform === "claude") {
          const completion = await checkClaudeCompletion(entry.promptText || entry.question, history.get(entry.platform));
          history.set(entry.platform, completion);
          addRunStep(runLog, entry.platform, {
            step: "wait_complete",
            ok: completion.done,
            platformCheck: true,
            details: completion
          });
          traceRun(runLog, "platform_completion_probe", {
            platform: entry.platform,
            elapsedMs: Date.now() - waitStartedAt,
            ...completion
          });
          if (completion.done) {
            entry.completion = "done";
            traceRun(runLog, "response_complete", {
              platform: entry.platform,
              method: "claude_probe",
              elapsedMs: Date.now() - waitStartedAt
            });
          }
          continue;
        }
        await runCommand("openclaw", ["browser", "wait", "--fn", "window.__cmpDone===true", "--timeout", "8000", "--json"], {
          json: true,
          timeoutMs: 12000
        });
        entry.completion = "done";
        addRunStep(runLog, entry.platform, { step: "wait_complete", ok: true });
        traceRun(runLog, "response_complete", {
          platform: entry.platform,
          elapsedMs: Date.now() - waitStartedAt
        });
      } catch (_error) {
        addRunStep(runLog, entry.platform, { step: "wait_complete", ok: false, transient: true });
      }
    }
    await delay(2000);
  }

  for (const entry of active) {
    if (entry.completion === "pending") {
      entry.completion = "timeout";
      entry.failure = `⏱ Response timed out after ${RESPONSE_WAIT_MINUTES} minutes`;
      addRunStep(runLog, entry.platform, { step: "timeout", ok: false });
      traceRun(runLog, "response_timeout", {
        platform: entry.platform,
        elapsedMs: Date.now() - waitStartedAt
      });
    }
  }
}

async function waitForCompletionFallback(active, runLog) {
  const history = new Map();
  const deadline = Date.now() + RESPONSE_WAIT_DEADLINE_MS;
  const waitStartedAt = Date.now();
  while (Date.now() < deadline && active.some((entry) => entry.completion === "pending")) {
    for (const entry of active) {
      if (entry.completion !== "pending") continue;
      await focusActiveEntry(entry, runLog);
      const snapshot = await snapshotPage();
      const textLength = snapshot.snapshot.length;
      const prev = history.get(entry.platform) || { last: -1, stable: 0 };
      const stable = prev.last === textLength ? prev.stable + 1 : 0;
      history.set(entry.platform, { last: textLength, stable });
      addRunStep(runLog, entry.platform, {
        step: "wait_fallback",
        ok: true,
        textLength,
        stable
      });
      if (textLength > 160 && stable >= COMPLETION_STABLE_POLLS) {
        entry.completion = "done";
        traceRun(runLog, "response_complete_fallback", {
          platform: entry.platform,
          textLength,
          stable,
          elapsedMs: Date.now() - waitStartedAt
        });
      }
    }
    await delay(2000);
  }

  for (const entry of active) {
    if (entry.completion === "pending") {
      entry.completion = "timeout";
      entry.failure = `⏱ Response timed out after ${RESPONSE_WAIT_MINUTES} minutes`;
      traceRun(runLog, "response_timeout", {
        platform: entry.platform,
        elapsedMs: Date.now() - waitStartedAt
      });
    }
  }
}

async function collectResponses(active, evaluateEnabled, question, runLog) {
  const extractor = evaluateEnabled ? await fs.readFile(EXTRACT_SCRIPT, "utf8") : null;
  for (const entry of active) {
    try {
      await focusActiveEntry(entry, runLog);
      await delay(1500);
      let extracted = await extractPlatformResponse(entry.platform, question, evaluateEnabled, extractor, runLog);
      if (extracted.text && (needsMoreResponseDepth(entry.platform, extracted.text, question) || looksLikeTruncatedExtraction(extracted.text))) {
        traceRun(runLog, "response_retry_wait", {
          platform: entry.platform,
          source: extracted.source,
          reason: looksLikeTruncatedExtraction(extracted.text) ? "post_collection_truncated_response" : "post_collection_thin_response"
        });
        await delay(2500);
        const retried = await extractPlatformResponse(entry.platform, question, evaluateEnabled, extractor, runLog);
        if ((retried.text || "").length > (extracted.text || "").length) {
          extracted = retried;
        }
      }
      entry.responseText = extracted.text;
      entry.responseSource = extracted.source;
      addRunStep(runLog, entry.platform, {
        step: "extract_response",
        ok: Boolean(entry.responseText),
        length: entry.responseText.length,
        source: extracted.source
      });
      traceRun(runLog, "response_extracted", {
        platform: entry.platform,
        ok: Boolean(entry.responseText),
        length: entry.responseText.length,
        source: extracted.source
      });
      if (!entry.responseText) {
        entry.failure = entry.failure || extracted.reason || "❌ Could not extract response";
      }
    } catch (error) {
      entry.failure = entry.failure || `❌ ${toErrorMessage(error)}`;
      addRunStep(runLog, entry.platform, { step: "extract_response", ok: false, error: toErrorMessage(error) });
      traceRun(runLog, "response_extracted", { platform: entry.platform, ok: false, error: toErrorMessage(error) });
    }
  }
}

async function aggregatePlatformResponses(question, locale, active, platformLogs, runLog) {
  const candidates = active.map((entry) => ({
    platform: entry.platform,
    name: entry.name,
    responseText: compactWhitespace(entry.responseText || ""),
    responseSource: entry.responseSource || "",
    completion: entry.completion,
    failure: entry.failure || ""
  }));
  traceRun(runLog, "aggregation_start", {
    candidatePlatforms: candidates.map((entry) => ({
      platform: entry.platform,
      length: entry.responseText.length,
      failure: entry.failure || null
    }))
  });

  const screened = await screenPlatformAnswers(question, locale, candidates, runLog);
  const usable = [];
  const unusable = [];

  for (const entry of candidates) {
    const platformLog = platformLogs.find((item) => item.platform === entry.platform);
    const screen = screened[entry.platform] || buildHeuristicScreenResult(entry, question);
    const reason = entry.failure || screen.reason || "unusable_response";
    const item = {
      platform: entry.platform,
      name: entry.name,
      responseText: entry.responseText,
      responseSource: entry.responseSource,
      completion: entry.completion,
      usability: screen,
      log: platformLog || null,
      reason
    };
    if (entry.responseText && !entry.failure && screen.usable) {
      usable.push(item);
    } else {
      unusable.push({
        ...item,
        responseText: screen.keepExtract ? entry.responseText : ""
      });
    }
  }

  for (const log of platformLogs) {
    if (candidates.some((entry) => entry.platform === log.platform)) continue;
    const reason = stripPlatformPrefix(log.failure || log.status || "platform_unavailable", log.name || log.platform);
    unusable.push({
      platform: log.platform,
      name: log.name || log.platform,
      responseText: "",
      responseSource: "",
      completion: "failed",
      usability: { usable: false, reason, issues: [] },
      log,
      reason
    });
  }

  traceRun(runLog, "aggregation_complete", {
    usablePlatforms: usable.map((entry) => entry.platform),
    unusablePlatforms: unusable.map((entry) => ({
      platform: entry.platform,
      reason: entry.reason
    }))
  });

  return { usable, unusable };
}

async function closeActiveTabs(active, runLog) {
  for (const entry of active) {
    try {
      entry.targetId = await recoverTargetId(entry, runLog);
      await runCommand("openclaw", ["browser", "close", entry.targetId, "--json"], {
        json: true,
        timeoutMs: 10000
      });
      addRunStep(runLog, entry.platform, { step: "close_tab", ok: true });
      traceRun(runLog, "tab_closed", { platform: entry.platform, targetId: entry.targetId });
    } catch (error) {
      addRunStep(runLog, entry.platform, { step: "close_tab", ok: false, error: toErrorMessage(error) });
      traceRun(runLog, "tab_closed", { platform: entry.platform, ok: false, error: toErrorMessage(error) });
    }
  }
}

async function focusTab(targetId) {
  browserCurrentTargetId = targetId;
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await runCommand("openclaw", ["browser", "focus", targetId, "--json"], {
        json: true,
        timeoutMs: 10000
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(250 * attempt);
    }
  }
  throw lastError;
}

async function focusActiveEntry(entry, runLog) {
  try {
    await focusTab(entry.targetId);
  } catch (error) {
    const recoveredTargetId = await recoverTargetId(entry, runLog);
    if (!recoveredTargetId || recoveredTargetId === entry.targetId) {
      throw error;
    }
    entry.targetId = recoveredTargetId;
    await focusTab(entry.targetId);
  }
}

async function recoverTargetId(entry, runLog) {
  if (!entry?.targetId) return entry?.targetId || null;
  const recovered = await resolveOpenedTargetId(entry.targetId, entry.url || "", runLog, entry.platform).catch(() => entry.targetId);
  if (recovered && recovered !== entry.targetId) {
    traceRun(runLog, "platform_target_refresh", {
      platform: entry.platform,
      previousTargetId: entry.targetId,
      nextTargetId: recovered
    });
  }
  return recovered || entry.targetId;
}

async function resolveOpenedTargetId(targetId, expectedUrl, runLog, platformKey) {
  if (!targetId) return targetId;
  const tabs = await listTabs().catch(() => null);
  if (!tabs?.length) return targetId;
  const direct = tabs.find((tab) => tab.targetId === targetId);
  if (direct) return targetId;

  const resolved = findBestTabForUrl(tabs, expectedUrl);
  if (resolved?.targetId) {
    traceRun(runLog, "platform_target_recovered", {
      platform: platformKey,
      originalTargetId: targetId,
      recoveredTargetId: resolved.targetId,
      recoveredUrl: resolved.url
    });
    return resolved.targetId;
  }
  return targetId;
}

async function listTabs() {
  const result = await runCommand("openclaw", ["browser", "tabs", "--json"], {
    json: true,
    timeoutMs: 15000
  });
  return Array.isArray(result?.tabs) ? result.tabs : [];
}

function findBestTabForUrl(tabs, expectedUrl) {
  const expected = safeUrl(expectedUrl);
  const host = expected?.host || "";
  const origin = expected?.origin || "";
  const candidates = tabs.filter((tab) => tab?.type === "page");
  const exact = [...candidates].reverse().find((tab) => tab.targetId && tab.url === expectedUrl);
  if (exact) return exact;
  const sameOrigin = [...candidates].reverse().find((tab) => tab.targetId && tab.url && safeUrl(tab.url)?.origin === origin);
  if (sameOrigin) return sameOrigin;
  const sameHost = [...candidates].reverse().find((tab) => tab.targetId && tab.url && safeUrl(tab.url)?.host === host);
  if (sameHost) return sameHost;
  const looseGrok = host.includes("grok.com")
    ? [...candidates].reverse().find((tab) => tab.targetId && /grok\.com/.test(tab.url || ""))
    : null;
  return looseGrok || null;
}

function safeUrl(value) {
  try {
    return new URL(String(value || ""));
  } catch (_error) {
    return null;
  }
}

async function snapshotPage() {
  return await runCommand("openclaw", ["browser", "snapshot", "--efficient", "--json"], {
    json: true,
    timeoutMs: 20000
  });
}

function findInputRef(refs) {
  const entries = Object.entries(refs);
  const candidates = entries
    .map(([ref, meta]) => ({
      ref,
      role: String(meta?.role || "").toLowerCase(),
      name: String(meta?.name || "")
    }))
    .filter((entry) => /textbox|searchbox|combobox/.test(entry.role));

  if (!candidates.length) return null;

  candidates.sort((left, right) => scoreInput(right) - scoreInput(left));
  return candidates[0].ref;
}

function scoreInput(entry) {
  const name = entry.name.toLowerCase();
  let score = 0;
  if (entry.role === "textbox") score += 10;
  if (/message|ask|question|reply|prompt|chat|claude|gemini|grok|chatgpt/.test(name)) score += 20;
  if (/search/.test(name)) score -= 10;
  return score;
}

function findSendRef(refs) {
  const entries = Object.entries(refs)
    .map(([ref, meta]) => ({
      ref,
      role: String(meta?.role || "").toLowerCase(),
      name: String(meta?.name || "")
    }))
    .filter((entry) => entry.role === "button");

  const named = entries
    .map((entry) => ({ ...entry, score: scoreSend(entry.name) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (named.length) return named[0].ref;
  return null;
}

function scoreSend(name) {
  const lower = String(name || "").toLowerCase();
  if (!lower) return 0;
  let score = 0;
  if (/send|submit|up|arrow|paper|plane/.test(lower)) score += 20;
  if (/stop|voice|microphone|attach|upload/.test(lower)) score -= 30;
  return score;
}

async function readElementText(ref) {
  try {
    const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", "(el) => String(el.value || el.innerText || el.textContent || '')", "--ref", ref, "--json"], {
      json: true,
      timeoutMs: 10000
    });
    return typeof result?.result === "string" ? result.result : "";
  } catch (_error) {
    return "";
  }
}

async function detectLoginScreen() {
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", LOGIN_CHECK_FN, "--json"], {
    json: true,
    timeoutMs: 10000
  });
  return result.result || { loginLikely: false };
}

async function fillInputViaDom(question) {
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", buildFillFunction(question), "--json"], {
    json: true,
    timeoutMs: 20000
  });
  return result.result;
}

async function fillClaudeComposer(question) {
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", buildClaudeFillFunction(question), "--json"], {
    json: true,
    timeoutMs: 20000
  });
  return result.result;
}

async function clickSendViaDom() {
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", SEND_CLICK_FN, "--json"], {
    json: true,
    timeoutMs: 15000
  });
  return result.result;
}

async function checkChatGPTCompletion(question, previous = null) {
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", buildChatGPTCompletionCheckFn(question), "--json"], {
    json: true,
    timeoutMs: 12000
  });
  const probe = result?.result || { hasStop: false, hasResponse: false, length: 0, composerHasPrompt: false };
  const stable = previous && previous.length === probe.length ? (previous.stable || 0) + 1 : 0;
  return {
    ...probe,
    stable,
    done: Boolean(probe.hasResponse && !probe.hasStop && !probe.composerHasPrompt) && stable >= COMPLETION_STABLE_POLLS
  };
}

async function checkGeminiCompletion(question, previous = null) {
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", buildGeminiCompletionCheckFn(question), "--json"], {
    json: true,
    timeoutMs: 12000
  });
  const probe = result?.result || { hasStop: false, hasResponse: false, length: 0, composerHasPrompt: false };
  const stable = previous && previous.length === probe.length ? (previous.stable || 0) + 1 : 0;
  return {
    ...probe,
    stable,
    done: Boolean(probe.hasResponse && !probe.hasStop && !probe.composerHasPrompt) && stable >= COMPLETION_STABLE_POLLS
  };
}

async function checkGrokCompletion(previous = null) {
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", GROK_COMPLETION_CHECK_FN, "--json"], {
    json: true,
    timeoutMs: 12000
  });
  const probe = result?.result || { hasResponse: false, hasSubmit: false, length: 0 };
  const stable = previous && previous.length === probe.length ? (previous.stable || 0) + 1 : 0;
  return {
    ...probe,
    stable,
    done: Boolean(probe.hasResponse && !probe.hasStop) && stable >= COMPLETION_STABLE_POLLS
  };
}

async function checkClaudeCompletion(question, previous = null) {
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", buildClaudeCompletionCheckFn(question), "--json"], {
    json: true,
    timeoutMs: 12000
  });
  const probe = result?.result || { hasStop: false, hasResponse: false, length: 0, composerHasPrompt: false };
  const stable = previous && previous.length === probe.length ? (previous.stable || 0) + 1 : 0;
  return {
    ...probe,
    stable,
    done: Boolean(probe.hasResponse && !probe.hasStop && !probe.composerHasPrompt) && stable >= COMPLETION_STABLE_POLLS
  };
}

async function confirmPromptSubmitted(question, inputRef) {
  await delay(800);
  if (!inputRef) return true;
  const currentValue = compactWhitespace(await readElementText(inputRef));
  return currentValue !== compactWhitespace(question);
}

async function submitPrompt(platformKey, question, inputRef, sendRef, runLog, log) {
  const attempts = [];
  const record = (method, ok, extra = {}) => {
    attempts.push({ method, ok, ...extra });
    log.steps.push({ step: "submit_attempt", method, ok, ...extra });
    traceRun(runLog, "platform_submit", { platform: platformKey, method, ok, ...extra });
  };

  const verify = async (method) => {
    const verification = await verifySubmissionWithRetries(platformKey, question, inputRef);
    traceRun(runLog, "platform_submit_verify", { platform: platformKey, method, ...verification });
    log.steps.push({ step: "submit_verify", method, ...verification });
    return verification;
  };

  if (inputRef) {
    try {
      await runCommand("openclaw", ["browser", "press", "Enter", "--json"], {
        json: true,
        timeoutMs: 10000
      });
      const verification = await verify("enter");
      record("enter", verification.ok, { verification });
      if (verification.ok) return { ok: true, method: "enter" };
    } catch (error) {
      record("enter", false, { error: toErrorMessage(error) });
    }
  }

  if (!attempts.some((entry) => entry.ok) && sendRef) {
    try {
      await runCommand("openclaw", ["browser", "click", sendRef, "--json"], {
        json: true,
        timeoutMs: 10000
      });
      const verification = await verify("ref_click");
      record("ref_click", verification.ok, { verification, sendRef });
      if (verification.ok) return { ok: true, method: "ref_click" };
    } catch (error) {
      record("ref_click", false, { error: toErrorMessage(error), sendRef });
    }
  }

  if (!attempts.some((entry) => entry.ok) && platformKey === "claude") {
    try {
      const claudeSend = await clickClaudeSendViaDom();
      const verification = claudeSend?.ok ? await verify("claude_dom") : { ok: false, reason: claudeSend?.reason || "claude_send_not_found" };
      record("claude_dom", Boolean(claudeSend?.ok) && verification.ok, { details: claudeSend, verification });
      if (claudeSend?.ok && verification.ok) return { ok: true, method: "claude_dom" };
    } catch (error) {
      record("claude_dom", false, { error: toErrorMessage(error) });
    }
  }

  if (!attempts.some((entry) => entry.ok) && platformKey === "gemini") {
    try {
      const geminiSend = await clickGeminiSendViaDom();
      const verification = geminiSend?.ok ? await verify("gemini_dom") : { ok: false, reason: geminiSend?.reason || "gemini_send_not_found" };
      record("gemini_dom", Boolean(geminiSend?.ok) && verification.ok, { details: geminiSend, verification });
      if (geminiSend?.ok && verification.ok) return { ok: true, method: "gemini_dom" };
    } catch (error) {
      record("gemini_dom", false, { error: toErrorMessage(error) });
    }
  }

  try {
    const domSend = await clickSendViaDom(platformKey);
    const verification = domSend?.ok ? await verify("dom") : { ok: false, reason: domSend?.reason || "send_not_found" };
    record("dom", Boolean(domSend?.ok) && verification.ok, { details: domSend, verification });
    if (domSend?.ok && verification.ok) return { ok: true, method: "dom" };
  } catch (error) {
    record("dom", false, { error: toErrorMessage(error) });
  }

  const lastFailure = [...attempts].reverse().find((entry) => !entry.ok);
  return {
    ok: false,
    method: lastFailure?.method || "unknown",
    reason: lastFailure?.verification?.reason || lastFailure?.details?.reason || lastFailure?.error || "Could not verify prompt submission"
  };
}

async function verifySubmission(platformKey, question, inputRef) {
  switch (platformKey) {
    case "claude":
      return await verifyClaudeSubmission(question);
    case "gemini":
      return await verifyGeminiSubmission(question);
    case "grok":
      return await verifyGrokSubmission(question);
    case "chatgpt":
      return await verifyChatGPTSubmission(question, inputRef);
    default: {
      const changed = await confirmPromptSubmitted(question, inputRef);
      return { ok: changed, reason: changed ? "input_changed" : "composer_did_not_change" };
    }
  }
}

async function verifySubmissionWithRetries(platformKey, question, inputRef) {
  const delays = platformKey === "chatgpt" || platformKey === "gemini"
    ? [1200, 2500, 4500]
    : [1200, 2400];
  let last = { ok: false, reason: "verify_failed" };
  for (let index = 0; index < delays.length; index += 1) {
    if (index > 0) await delay(delays[index]);
    last = await verifySubmission(platformKey, question, inputRef);
    if (last?.ok) return last;
  }
  return last;
}

async function verifyClaudeSubmission(question) {
  await delay(1200);
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", buildClaudeSubmissionVerifyFn(question), "--json"], {
    json: true,
    timeoutMs: 15000
  });
  return result?.result || { ok: false, reason: "verify_failed" };
}

async function verifyGeminiSubmission(question) {
  await delay(1200);
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", buildGeminiSubmissionVerifyFn(question), "--json"], {
    json: true,
    timeoutMs: 15000
  });
  return result?.result || { ok: false, reason: "verify_failed" };
}

async function verifyGrokSubmission(question) {
  await delay(1200);
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", buildGrokSubmissionVerifyFn(question), "--json"], {
    json: true,
    timeoutMs: 15000
  });
  return result?.result || { ok: false, reason: "verify_failed" };
}

async function verifyChatGPTSubmission(question, inputRef) {
  const changed = await confirmPromptSubmitted(question, inputRef);
  if (!changed) return { ok: false, reason: "composer_did_not_change" };
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", buildChatGPTSubmissionVerifyFn(question), "--json"], {
    json: true,
    timeoutMs: 12000
  });
  return result?.result || { ok: changed, reason: changed ? "input_changed" : "verify_failed" };
}

async function clickClaudeSendViaDom() {
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", CLAUDE_SEND_CLICK_FN, "--json"], {
    json: true,
    timeoutMs: 15000
  });
  return result.result;
}

async function clickGeminiSendViaDom() {
  const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", GEMINI_SEND_CLICK_FN, "--json"], {
    json: true,
    timeoutMs: 15000
  });
  return result.result;
}

async function extractPlatformResponse(platformKey, question, evaluateEnabled, extractor, runLog) {
  const attempts = [];
  const tryCandidate = async (source, fn) => {
    const result = await runCommand("openclaw", ["browser", "evaluate", "--fn", fn, "--json"], {
      json: true,
      timeoutMs: 20000
    });
    const raw = typeof result?.result === "string" ? result.result : result?.result?.text || "";
    const validation = validateExtractedResponse(platformKey, raw, question);
    attempts.push({ source, validation });
    traceRun(runLog, "response_validation", {
      platform: platformKey,
      source,
      ok: validation.ok,
      reason: validation.reason,
      length: validation.text.length
    });
    return { source, validation };
  };

  if (platformKey === "chatgpt") {
    const chatgptPrimary = await tryCandidate("chatgpt_primary", buildChatGPTExtractFn(question));
    if (chatgptPrimary.validation.ok && !needsMoreResponseDepth(platformKey, chatgptPrimary.validation.text, question)) {
      return { text: chatgptPrimary.validation.text, source: chatgptPrimary.source };
    }
    if (chatgptPrimary.validation.ok) {
      traceRun(runLog, "response_retry_wait", { platform: platformKey, source: "chatgpt_primary", reason: "thin_response" });
      await delay(3000);
      const chatgptRetry = await tryCandidate("chatgpt_retry", buildChatGPTExtractFn(question));
      if (chatgptRetry.validation.ok) return { text: chatgptRetry.validation.text, source: chatgptRetry.source };
    }
  }

  if (platformKey === "gemini") {
    const geminiPrimary = await tryCandidate("gemini_primary", buildGeminiExtractFn(question, false));
    if (geminiPrimary.validation.ok && !needsMoreResponseDepth(platformKey, geminiPrimary.validation.text, question)) {
      return { text: geminiPrimary.validation.text, source: geminiPrimary.source };
    }
    traceRun(runLog, "response_retry_wait", {
      platform: platformKey,
      source: "gemini_primary",
      reason: geminiPrimary.validation.ok ? "thin_response" : geminiPrimary.validation.reason || "retry_after_invalid_primary"
    });
    await delay(5000);
    const geminiRetry = await tryCandidate("gemini_retry", buildGeminiExtractFn(question, true));
    if (geminiRetry.validation.ok) return { text: geminiRetry.validation.text, source: geminiRetry.source };
    if (/response_too_short|weak_question_relevance|question_echo_only/.test(geminiRetry.validation.reason || "")) {
      traceRun(runLog, "response_retry_wait", {
        platform: platformKey,
        source: "gemini_retry",
        reason: geminiRetry.validation.reason || "retry_after_invalid_retry"
      });
      await delay(7000);
      const geminiLateRetry = await tryCandidate("gemini_late_retry", buildGeminiExtractFn(question, true));
      if (geminiLateRetry.validation.ok) return { text: geminiLateRetry.validation.text, source: geminiLateRetry.source };
    }
  }

  if (platformKey === "grok") {
    const grokPrimary = await tryCandidate("grok_primary", GROK_EXTRACT_FN);
    if (grokPrimary.validation.ok && !needsMoreResponseDepth(platformKey, grokPrimary.validation.text, question)) {
      return { text: grokPrimary.validation.text, source: grokPrimary.source };
    }
    if (grokPrimary.validation.ok) {
      traceRun(runLog, "response_retry_wait", { platform: platformKey, source: "grok_primary", reason: "thin_response" });
      await delay(3000);
      const grokRetry = await tryCandidate("grok_retry", GROK_EXTRACT_FN);
      if (grokRetry.validation.ok) return { text: grokRetry.validation.text, source: grokRetry.source };
    }
  }

  if (platformKey === "claude") {
    const claudePrimary = await tryCandidate("claude_primary", CLAUDE_EXTRACT_FN);
    if (claudePrimary.validation.ok && !needsMoreResponseDepth(platformKey, claudePrimary.validation.text, question)) {
      return { text: claudePrimary.validation.text, source: claudePrimary.source };
    }
    if (claudePrimary.validation.ok) {
      traceRun(runLog, "response_retry_wait", { platform: platformKey, source: "claude_primary", reason: "thin_response" });
      await delay(4000);
      const claudeRetry = await tryCandidate("claude_retry", CLAUDE_EXTRACT_FN);
      if (claudeRetry.validation.ok) return { text: claudeRetry.validation.text, source: claudeRetry.source };
    }
  }

  if (evaluateEnabled && extractor) {
    await runCommand("openclaw", ["browser", "evaluate", "--fn", extractor, "--json"], {
      json: true,
      timeoutMs: 20000
    });
    await runCommand("openclaw", ["browser", "wait", "--fn", "window.__cmpExtracted && window.__cmpExtracted.length > 0", "--timeout", "5000", "--json"], {
      json: true,
      timeoutMs: 7000
    });
    const extracted = await runCommand("openclaw", ["browser", "evaluate", "--fn", "() => window.__cmpExtracted || ''", "--json"], {
      json: true,
      timeoutMs: 10000
    });
    const raw = typeof extracted?.result === "string" ? extracted.result.trim() : "";
    const validation = validateExtractedResponse(platformKey, raw, question);
    traceRun(runLog, "response_validation", {
      platform: platformKey,
      source: "generic_evaluate",
      ok: validation.ok,
      reason: validation.reason,
      length: validation.text.length
    });
    if (validation.ok) return { text: validation.text, source: "generic_evaluate" };
  }

  const snapshot = await runCommand("openclaw", ["browser", "snapshot", "--format", "aria", "--limit", "300", "--json"], {
    json: true,
    timeoutMs: 20000
  });
  const snapshotText = String(snapshot?.snapshot || "").trim();
  const snapshotValidation = validateExtractedResponse(platformKey, snapshotText, question);
  traceRun(runLog, "response_validation", {
    platform: platformKey,
    source: "snapshot_fallback",
    ok: snapshotValidation.ok,
    reason: snapshotValidation.reason,
    length: snapshotValidation.text.length
  });
  if (snapshotValidation.ok) return { text: snapshotValidation.text, source: "snapshot_fallback" };

  return {
    text: "",
    source: attempts.at(-1)?.source || "snapshot_fallback",
    reason: snapshotValidation.reason || attempts.at(-1)?.validation?.reason || "❌ Could not extract a valid response"
  };
}

function validateExtractedResponse(platformKey, rawText, question) {
  let text = cleanExtractedResponse(platformKey, rawText, question);
  if (text.length < 24) {
    return { ok: false, reason: "response_too_short", text };
  }
  if (looksLikeUiHistoryDump(text)) {
    return { ok: false, reason: "ui_or_history_dump", text };
  }
  if (!hasQuestionRelevanceSignal(question, text)) {
    return { ok: false, reason: "weak_question_relevance", text };
  }

  const lower = text.toLowerCase();
  if (platformKey === "gemini") {
    if (/(deep research browses the open web|where should we start|create image|create music|boost my day|help me learn|upgrade to google ai ultra|try deep research today|show thinking|refining .* answer now|prioritizing .* answer now|defining response logic answer now|analyzing the inquiry answer now|ranking .* answer now|drafting response)/i.test(text)) {
      return { ok: false, reason: "gemini_promo_content", text };
    }
    if (!/gemini|ai|人工智慧|助手|助理|python|javascript|model|模型|比較|difference|介紹/i.test(text) && text.length < 40) {
      return { ok: false, reason: "gemini_not_answer_like", text };
    }
  }

  if (platformKey === "claude") {
    if (/learn\s+code\s+write\s+life stuff/i.test(lower)) {
      return { ok: false, reason: "claude_landing_content", text };
    }
  }

  if (platformKey === "grok") {
    if (/(unlock extended capabilities|upgrade to supergrok|try free|toggle sidebar|voice imagine projects|think harder|searching the web \d+ results?)/i.test(text)) {
      return { ok: false, reason: "grok_ui_content", text };
    }
    if (!/grok|xai|ai|人工智慧|助手|助理|python|javascript|model|模型|比較|difference|介紹/i.test(text) && text.length < 40) {
      return { ok: false, reason: "grok_not_answer_like", text };
    }
  }

  if (compactWhitespace(text) === compactWhitespace(question)) {
    return { ok: false, reason: "question_echo_only", text };
  }

  return { ok: true, reason: "ok", text };
}

function looksLikeUiHistoryDump(text) {
  const cleaned = compactWhitespace(text);
  if (!cleaned) return false;
  const patterns = [
    /new chat.*search.*customize.*chats.*projects.*artifacts/i,
    /recents?.*hide.*settings?.*history/i,
    /toggle sidebar|voice imagine projects|see all|library|menu/i,
    /learn code write life stuff/i
  ];
  return patterns.some((pattern) => pattern.test(cleaned));
}

function hasQuestionRelevanceSignal(question, answer) {
  const q = compactWhitespace(question);
  const a = compactWhitespace(answer).toLowerCase();
  if (!q || !a) return false;
  const latinSignals = q
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 3 && !COMMON_QUESTION_WORDS.has(token));
  if (latinSignals.some((token) => a.includes(token))) return true;

  const cjkGroups = (q.match(/[\u3040-\u30ff\u3400-\u9fff]{2,}/gu) || [])
    .flatMap((chunk) => chunk.length <= 4 ? [chunk] : [chunk, chunk.slice(0, 2), chunk.slice(-2)])
    .filter(Boolean);
  if (cjkGroups.some((token) => answer.includes(token))) return true;

  if (isRankingQuestion(q) && /(model|models|模型|ai|python|javascript|比較|difference|ranking|top|best)/i.test(answer)) {
    return true;
  }
  if (/compare|比較|difference|不同|差異/i.test(q) && /(compare|比較|difference|不同|差異|優缺點|pros|cons)/i.test(answer)) {
    return true;
  }
  return false;
}

function cleanExtractedResponse(platformKey, rawText, question) {
  let text = String(rawText || "").replace(/\u00a0/g, " ");
  if (platformKey === "chatgpt") {
    text = text.replace(/^ChatGPT said:\s*/i, "");
  } else if (platformKey === "gemini") {
    text = text
      .replace(/^Show thinking\s*/i, "")
      .replace(/^Refining .*? Answer now\s*/i, "")
      .replace(/^Prioritizing .*? Answer now\s*/i, "")
      .replace(/^Defining Response Logic Answer now\s*/i, "")
      .replace(/^Analyzing the Inquiry Answer now\s*/i, "")
      .replace(/^Ranking .*? Answer now\s*/i, "")
      .replace(/^Conversation with Gemini\s*/i, "")
      .replace(new RegExp(`^You said\\s*${escapeRegExp(question)}\\s*Gemini said\\s*`, "i"), "")
      .replace(/^You said\s*/i, "")
      .replace(/^Gemini said\s*/i, "")
      .replace(/^(?:[A-Za-z]+(?: [A-Za-z]+){0,5}) Answer now\s*/i, "")
      .replace(/\bGemini is AI and can make mistakes\.?\s*$/i, "")
      .replace(/\bGoogle may display inaccurate info.*$/i, "");
    text = stripGeminiPreferenceScaffold(text);
  } else if (platformKey === "claude") {
    text = text
      .replace(/^Claude\s*/i, "")
      .replace(/^(Searched the web\s*)+/i, "")
      // Strip trailing UI chrome only at the very end of the extracted text.
      // The previous dotAll /\bRetry\b.*$/s was dangerously broad: any response
      // containing "retry" mid-sentence (e.g. "you can retry this...") would be
      // silently truncated to that point.
      .replace(/\s*\b(Retry|Copy|Continue|Regenerate)\s*$/i, "");
  } else if (platformKey === "grok") {
    text = text
      .replace(new RegExp(`^${escapeRegExp(question)}\\s*`, "i"), "")
      .replace(/^\d+(?:\.\d+)?s\s+Fast\s*/i, "")
      .replace(/^Searching the web \d+ results\s*/i, "")
      .replace(/\s+\d+(?:\.\d+)?s\s+Fast\b.*$/i, "")
      .replace(/\s+(?:Share .*|介紹xAI的使命.*|分享.*|More sarcastic.*)$/i, "")
      .replace(/\bThink Harder\b.*$/s, "")
      .replace(/\bUnlock extended capabilities.*$/s, "")
      .replace(/\bUpgrade to SuperGrok.*$/s, "");
  }
  return compactWhitespace(text);
}

function stripGeminiPreferenceScaffold(text) {
  const raw = String(text || "");
  if (!/Which response is more helpful\?/i.test(raw) || !/\bChoice A\b/i.test(raw)) {
    return raw;
  }
  const normalized = raw.replace(/\s+/g, " ").trim();
  const body = normalized
    .replace(/^Which response is more helpful\?[\s\S]*?\bChoice A\b\s*/i, "")
    .replace(/\bThis response is more helpful\b[\s\S]*$/i, "")
    .trim();
  const choices = body.split(/\bChoice B\b/i).map((item) => compactWhitespace(item)).filter(Boolean);
  if (!choices.length) return body;
  return choices.sort((left, right) => right.length - left.length)[0];
}

function buildPlatformPrompt(platformKey, question, locale) {
  const base = String(question || "").trim();
  if (!base) return base;
  const needsCurrent = isCurrentNewsQuestion(base);
  const currentHint = needsCurrent ? localize(locale, {
    zh: "如果你具備網頁搜尋、最新資訊或即時工具能力，請優先使用截至今天的最新可用資訊；若資訊未確認，請明確標示不確定性。",
    ja: "もし検索や最新情報ツールを使えるなら、今日時点の最新情報を優先してください。未確認情報は不確実として明示してください。",
    en: "If you have web search or up-to-date information tools, use the latest information available as of today, and mark uncertainty explicitly."
  }) : localize(locale, {
    zh: "請直接回答問題本身，避免空泛開場；若需要比較，請給出具體差異與理由。",
    ja: "一般論ではなく質問そのものに直接答え、比較が必要なら具体的な差分と理由を示してください。",
    en: "Answer the question directly rather than with generic framing; if comparison is needed, include concrete differences and reasons."
  });
  const structureHint = localize(locale, {
    zh: "請盡量提供具體事實、判斷依據與必要的保留條件，不要只給抽象總結。",
    ja: "抽象的な総論だけでなく、具体的な事実、判断根拠、必要な留保条件を含めてください。",
    en: "Please include concrete facts, reasoning, and necessary caveats rather than only a high-level summary."
  });
  return `${base}\n\n補充要求：${currentHint}\n${structureHint}`;
}

function isCurrentNewsQuestion(question) {
  return /(最新|目前|現在|今日|今天|本週|本月|今年|迄今|recent|latest|current|today|this week|this month|this year|breaking|news|headline|headlines)/i.test(String(question || ""));
}

function buildChatGPTSubmissionVerifyFn(question) {
  return `() => {
    const text = ${JSON.stringify(question)};
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const body = normalize(document.body?.innerText || "");
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 40 && rect.height > 18;
    };
    const composerNodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')).filter((el) => visible(el));
    const composerText = normalize(composerNodes.map((el) => el.value || el.innerText || el.textContent || "").join(" "));
    const composerHasPrompt = composerText.includes(text);
    const questionObserved = Array.from(document.querySelectorAll("article, main div, section div"))
      .some((el) => {
        if (!visible(el)) return false;
        const value = normalize(el.innerText || el.textContent || "");
        return value === text || value.includes(text);
      }) || (body.includes(text) && !composerHasPrompt);
    const hasStop = Array.from(document.querySelectorAll("button")).some((el) => ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).toLowerCase().includes("stop"));
    const hasAssistant = document.querySelectorAll('[data-message-author-role="assistant"]').length > 0;
    const conversationStarted = hasStop || hasAssistant || !composerHasPrompt;
    return {
      ok: conversationStarted && (questionObserved || !composerHasPrompt),
      hasStop,
      hasAssistant,
      composerHasPrompt,
      questionObserved,
      conversationStarted,
      reason: conversationStarted ? "conversation_started" : "chatgpt_submission_not_observed"
    };
  }`;
}

function buildClaudeSubmissionVerifyFn(question) {
  return `() => {
    const text = ${JSON.stringify(question)};
    const body = document.body?.innerText || "";
    const urlChanged = /\\/chat\\//.test(location.pathname);
    const hasCopy = Array.from(document.querySelectorAll("button")).some((el) => ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).toLowerCase().includes("copy"));
    const hasRetry = Array.from(document.querySelectorAll("button")).some((el) => ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).toLowerCase().includes("retry"));
    const hasPrompt = body.includes(text);
    const hasAssistantBlock = Array.from(document.querySelectorAll("article, div, section")).some((el) => {
      const t = (el.innerText || "").trim();
      const r = el.getBoundingClientRect();
      return r.width > 300 && r.height > 60 && t.length > 40 && !t.includes("Write your prompt to Claude");
    });
    return {
      ok: (urlChanged || hasPrompt) && (hasCopy || hasRetry || hasAssistantBlock),
      urlChanged,
      hasCopy,
      hasRetry,
      hasPrompt,
      hasAssistantBlock,
      reason: (urlChanged || hasPrompt) ? "conversation_started" : "claude_submission_not_observed"
    };
  }`;
}

function buildGeminiSubmissionVerifyFn(question) {
  return `() => {
    const text = ${JSON.stringify(question)};
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const body = normalize(document.body?.innerText || "");
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 40 && rect.height > 18;
    };
    const composerNodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')).filter((el) => visible(el));
    const composerText = normalize(composerNodes.map((el) => el.value || el.innerText || el.textContent || "").join(" "));
    const composerHasPrompt = composerText.includes(text);
    const questionObserved = Array.from(document.querySelectorAll('user-query, .query-text, .user-query-bubble-with-background, [data-message-author-role="user"], [data-test-id*="user"], div, span'))
      .some((el) => {
        if (!visible(el)) return false;
        const value = normalize(el.innerText || el.textContent || "");
        return value === text || value.includes(text);
      }) || (body.includes(text) && !composerHasPrompt);
    const pathStarted = /^\\/app\\/[a-z0-9]+/i.test(location.pathname);
    const hasPrompt = body.includes(text);
    const hasGeminiSaid = /gemini said/i.test(body);
    const hasResponse = Array.from(document.querySelectorAll(".response-container, .response-content, .conversation-container, .presented-response-container")).some((el) => {
      const t = (el.innerText || "").trim();
      const r = el.getBoundingClientRect();
      return r.width > 500 && r.height > 60 && t.length > 30 && !/where should we start|deep research/i.test(t);
    });
    const conversationStarted = pathStarted || hasGeminiSaid || hasResponse || !composerHasPrompt;
    return {
      ok: conversationStarted && (questionObserved || hasResponse || !composerHasPrompt),
      pathStarted,
      hasPrompt,
      composerHasPrompt,
      questionObserved,
      hasGeminiSaid,
      hasResponse,
      conversationStarted,
      reason: conversationStarted ? "conversation_started" : "gemini_submission_not_observed"
    };
  }`;
}

function buildGrokSubmissionVerifyFn(question) {
  return `() => {
    const text = ${JSON.stringify(question)};
    const body = document.body?.innerText || "";
    const pathStarted = /\\/c\\//.test(location.pathname);
    const hasPrompt = body.includes(text);
    const hasCopy = Array.from(document.querySelectorAll("button")).some((el) => ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).toLowerCase().includes("copy"));
    const hasRegenerate = Array.from(document.querySelectorAll("button")).some((el) => ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).toLowerCase().includes("regenerate"));
    const hasAnswer = Array.from(document.querySelectorAll("p, div")).some((el) => {
      const t = (el.innerText || "").trim();
      const r = el.getBoundingClientRect();
      return r.width > 320 && r.height > 20 && t.length > 24 && !t.includes(text) && !/unlock extended capabilities|upgrade to supergrok|try free/i.test(t);
    });
    return {
      ok: (pathStarted || hasPrompt) && (hasCopy || hasRegenerate || hasAnswer),
      pathStarted,
      hasPrompt,
      hasCopy,
      hasRegenerate,
      hasAnswer,
      reason: (pathStarted || hasPrompt) ? "conversation_started" : "grok_submission_not_observed"
    };
  }`;
}

function buildGeminiExtractFn(question, retry) {
  return `() => {
    const text = ${JSON.stringify(question)};
    const retry = ${retry ? "true" : "false"};
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 200 && rect.height > 24;
    };
    const clean = (value) => String(value || "")
      .replace(/\\u00a0/g, " ")
      .replace(/^Conversation with Gemini\\s*/i, "")
      .replace(/^You said\\s*/i, "")
      .replace(/^Gemini said\\s*/i, "")
      .replace(/Gemini is AI and can make mistakes\\.?\\s*$/i, "")
      .trim();
    const composerNodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')).filter((el) => visible(el));
    const composerText = normalize(composerNodes.map((el) => el.value || el.innerText || el.textContent || "").join(" "));
    const composerHasPrompt = composerText.includes(text);
    const questionObserved = Array.from(document.querySelectorAll('user-query, .query-text, .user-query-bubble-with-background, [data-message-author-role="user"], [data-test-id*="user"], div, span'))
      .some((el) => {
        if (!visible(el)) return false;
        const value = normalize(el.innerText || el.textContent || "");
        return value === text || value.includes(text);
      }) || ((document.body?.innerText || "").includes(text) && !composerHasPrompt);
    if (!questionObserved && composerHasPrompt) return { text: "" };
    const bad = (value) => /deep research browses the open web|where should we start|create image|create music|boost my day|help me learn|upgrade to google ai ultra|try deep research today|show thinking|refining .* answer now|prioritizing .* answer now|defining response logic answer now|analyzing the inquiry answer now|ranking .* answer now|drafting response/i.test(value);
    const selectors = retry
      ? [".response-content .markdown", ".response-content", ".response-container-content", ".markdown-main-panel", ".presented-response-container"]
      : [".response-container-content", ".response-content", ".response-container", ".conversation-container"];
    const candidates = [];
    for (const selector of selectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (!visible(el)) continue;
        const rect = el.getBoundingClientRect();
        const raw = (el.innerText || "").trim();
        const escaped = text.replace(/[.*+?^()|[\]\\]/g, "\\$&");
        const cleaned = clean(raw).replace(new RegExp("^" + escaped + "\\\\s*", "i"), "");
        if (!cleaned || bad(cleaned)) continue;
        let score = cleaned.length;
        if (/response-container|response-content|markdown-main-panel/.test(selector)) score += 120;
        if (rect.left > window.innerWidth * 0.18) score += 30;
        if (rect.width > window.innerWidth * 0.45) score += 20;
        if (/Gemini said/i.test(raw)) score += 20;
        candidates.push({ text: cleaned, selector, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length) return { text: "" };
    return { text: candidates[0].text, selector: candidates[0].selector, score: candidates[0].score };
  }`;
}

function buildChatGPTExtractFn(question) {
  return `() => {
    const text = ${JSON.stringify(question)};
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 240 && rect.height > 24;
    };
    const clean = (value) => String(value || "")
      .replace(/\\u00a0/g, " ")
      .replace(/^ChatGPT said:\\s*/i, "")
      .replace(/\\bChatGPT can make mistakes\\.?[\\s\\S]*$/i, "")
      .trim();
    const composerNodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')).filter((el) => visible(el));
    const composerText = normalize(composerNodes.map((el) => el.value || el.innerText || el.textContent || "").join(" "));
    const composerHasPrompt = composerText.includes(text);
    const questionObserved = Array.from(document.querySelectorAll('[data-message-author-role="user"], article, main div, section div'))
      .some((el) => {
        if (!visible(el)) return false;
        const value = normalize(el.innerText || el.textContent || "");
        return value === text || value.includes(text);
      }) || ((document.body?.innerText || "").includes(text) && !composerHasPrompt);
    if (!questionObserved && composerHasPrompt) return { text: "" };
    const selectors = ['[data-message-author-role="assistant"]', 'article .markdown', 'main article', 'article'];
    const candidates = [];
    for (const selector of selectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (!visible(el)) continue;
        const rect = el.getBoundingClientRect();
        const raw = String(el.innerText || "").trim();
        const cleaned = clean(raw);
        if (!cleaned || cleaned === text) continue;
        if (/new chat|search chats|library|sora|gpts|voice/i.test(cleaned) && cleaned.length < 250) continue;
        let score = cleaned.length;
        if (selector.includes('data-message-author-role="assistant"')) score += 220;
        if (selector.includes(".markdown")) score += 80;
        if (rect.left > window.innerWidth * 0.15) score += 25;
        if (rect.width > window.innerWidth * 0.45) score += 20;
        if (!cleaned.includes(text)) score += 30;
        candidates.push({ text: cleaned, selector, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length) return { text: "" };
    return { text: candidates[0].text, selector: candidates[0].selector, score: candidates[0].score };
  }`;
}

function buildGeminiCompletionCheckFn(question) {
  return `() => {
    const text = ${JSON.stringify(question)};
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 40 && rect.height > 18;
    };
    const buttons = Array.from(document.querySelectorAll("button"));
    const hasStop = buttons.some((el) => ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).toLowerCase().includes("stop"));
    const composerNodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')).filter((el) => visible(el));
    const composerText = normalize(composerNodes.map((el) => el.value || el.innerText || el.textContent || "").join(" "));
    const composerHasPrompt = composerText.includes(text);
    const questionObserved = Array.from(document.querySelectorAll('user-query, .query-text, .user-query-bubble-with-background, [data-message-author-role="user"], [data-test-id*="user"], div, span'))
      .some((el) => {
        if (!visible(el)) return false;
        const value = normalize(el.innerText || el.textContent || "");
        return value === text || value.includes(text);
      }) || ((document.body?.innerText || "").includes(text) && !composerHasPrompt);
    const texts = Array.from(document.querySelectorAll(".response-container-content, .response-content, .response-container, .presented-response-container, .markdown-main-panel"))
      .map((el) => normalize(el.innerText || ""))
      .filter((value) => value.length > 24 && !/deep research browses the open web|where should we start|create image|create music|boost my day|help me learn|upgrade to google ai ultra|show thinking|refining .* answer now|prioritizing .* answer now|defining response logic answer now|analyzing the inquiry answer now|ranking .* answer now|drafting response/i.test(value));
    const best = texts.sort((a, b) => b.length - a.length)[0] || "";
    return {
      hasStop,
      composerHasPrompt,
      questionObserved,
      hasResponse: best.length > 24,
      length: best.length
    };
  }`;
}

function buildClaudeCompletionCheckFn(question) {
  return `() => {
    const text = ${JSON.stringify(question)};
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 40 && rect.height > 18;
    };
    // Stop button: aria-label or text containing "stop" or "cancel", must be visible
    const buttons = Array.from(document.querySelectorAll("button"));
    const hasStopBtn = buttons.some((el) => {
      const label = ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).toLowerCase();
      return (label.includes("stop") || label.includes("cancel")) && el.offsetParent !== null;
    });
    // Streaming DOM indicators: data-is-streaming attribute or streaming cursor/animation classes
    const hasStreamingAttr = Boolean(
      document.querySelector('[data-is-streaming="true"]') ||
      document.querySelector('[class*="streaming-cursor"]') ||
      document.querySelector('[class*="result-streaming"]') ||
      document.querySelector('[class*="is-streaming"]')
    );
    const isStreaming = hasStopBtn || hasStreamingAttr;
    // Composer: should be empty after Claude accepts the prompt
    const composerNodes = Array.from(document.querySelectorAll('[contenteditable="true"], [role="textbox"]')).filter((el) => visible(el));
    const composerText = normalize(composerNodes.map((el) => el.innerText || el.textContent || "").join(" "));
    const composerHasPrompt = composerText.includes(text);
    // URL signal: Claude navigates from /new to /chat/<id> after accepting submission
    const urlChanged = /\\/chat\\//.test(location.pathname);
    // Response text: try dedicated selectors first, fall back to heuristic blocks
    const selectors = [
      '[data-message-author-role="assistant"]',
      '[class*="font-claude"]',
      '[class*="assistant-message"]',
      'article'
    ];
    let best = "";
    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel)).filter((el) => visible(el));
      if (els.length > 0) {
        const t = normalize(els[els.length - 1].innerText || "");
        if (t.length > best.length) best = t;
      }
    }
    return {
      hasStop: isStreaming,
      composerHasPrompt,
      urlChanged,
      hasResponse: best.length > 80,
      length: best.length
    };
  }`;
}

function buildChatGPTCompletionCheckFn(question) {
  return `() => {
    const text = ${JSON.stringify(question)};
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 40 && rect.height > 18;
    };
    const buttons = Array.from(document.querySelectorAll("button"));
    const hasStop = buttons.some((el) => ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).toLowerCase().includes("stop"));
    const composerNodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')).filter((el) => visible(el));
    const composerText = normalize(composerNodes.map((el) => el.value || el.innerText || el.textContent || "").join(" "));
    const composerHasPrompt = composerText.includes(text);
    const questionObserved = Array.from(document.querySelectorAll('[data-message-author-role="user"], article, main div, section div'))
      .some((el) => {
        if (!visible(el)) return false;
        const value = normalize(el.innerText || el.textContent || "");
        return value === text || value.includes(text);
      }) || ((document.body?.innerText || "").includes(text) && !composerHasPrompt);
    const texts = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], article .markdown, main article, article'))
      .filter((el) => visible(el))
      .map((el) => normalize(el.innerText || ""))
      .filter((value) => value.length > 40 && !/new chat|search chats|library|sora|gpts|voice/i.test(value));
    const best = texts.sort((a, b) => b.length - a.length)[0] || "";
    return {
      hasStop,
      composerHasPrompt,
      questionObserved,
      hasResponse: best.length > 80,
      length: best.length
    };
  }`;
}

const CLAUDE_SEND_CLICK_FN = `() => {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const composer = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'))
    .filter((el) => visible(el))
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").toLowerCase();
      let score = 0;
      if (label.includes("claude") || label.includes("prompt")) score += 40;
      if (rect.left > window.innerWidth * 0.25) score += 20;
      return { el, rect, score };
    })
    .sort((a, b) => b.score - a.score)[0];
  if (!composer) return { ok: false, reason: "claude_input_not_found" };
  const rowTop = composer.rect.bottom + 16;
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter((el) => visible(el) && !el.disabled)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const label = ((el.getAttribute("aria-label") || "") + " " + (el.textContent || "")).trim();
      let score = 0;
      if (/send/i.test(label)) score += 80;
      if (rect.left >= composer.rect.right - 60) score += 50;
      if (rect.top >= rowTop - 12 && rect.top <= rowTop + 40) score += 35;
      if (rect.width <= 40 && rect.height <= 40) score += 20;
      if (/toggle menu|sonnet|model/i.test(label)) score -= 60;
      return { el, label, rect, score };
    })
    .sort((a, b) => b.score - a.score);
  if (!buttons.length || buttons[0].score < 40) return { ok: false, reason: "claude_send_not_found" };
  buttons[0].el.click();
  return {
    ok: true,
    label: buttons[0].label,
    rect: { left: buttons[0].rect.left, top: buttons[0].rect.top, width: buttons[0].rect.width, height: buttons[0].rect.height },
    score: buttons[0].score
  };
}`;

const GEMINI_SEND_CLICK_FN = `() => {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const composers = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'))
    .filter((el) => visible(el))
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .sort((a, b) => b.rect.bottom - a.rect.bottom);
  const composer = composers[0];
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter((el) => visible(el) && !el.disabled)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const label = ((el.getAttribute("aria-label") || "") + " " + (el.textContent || "")).trim().toLowerCase();
      let score = 0;
      if (label.includes("send")) score += 120;
      if (label.includes("submit")) score += 80;
      if (label.includes("message")) score += 40;
      if (composer) {
        if (rect.top >= composer.rect.top - 40 && rect.top <= composer.rect.bottom + 60) score += 45;
        if (rect.left >= composer.rect.right - 120) score += 55;
      }
      if (rect.width <= 56 && rect.height <= 56) score += 15;
      if (/see all|history|conversation|prompt|deep research|create image|create music|help me learn/.test(label)) score -= 180;
      return { el, label, score };
    })
    .sort((a, b) => b.score - a.score);
  if (!buttons.length || buttons[0].score < 80) return { ok: false, reason: "gemini_send_not_found" };
  buttons[0].el.click();
  return { ok: true, label: buttons[0].label, score: buttons[0].score };
}`;

const CLAUDE_EXTRACT_FN = `() => {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 240 && rect.height > 40;
  };
  const candidates = [];
  const selectors = [
    '[data-message-author-role="assistant"]',
    'article',
    '[class*="assistant"]',
    '[class*="font-claude"]'
  ];
  for (const selector of selectors) {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (!visible(el)) continue;
      const text = (el.innerText || "").trim();
      if (!text || /write your prompt to claude|learn|code|life stuff/i.test(text)) continue;
      const rect = el.getBoundingClientRect();
      let score = text.length;
      if (/copy|retry/i.test(document.body.innerText || "")) score += 20;
      if (rect.left > window.innerWidth * 0.18) score += 20;
      candidates.push({ text, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return { text: candidates[0] ? candidates[0].text : "" };
}`;

const GEMINI_COMPLETION_CHECK_FN = `() => {
  const buttons = Array.from(document.querySelectorAll("button"));
  const hasStop = buttons.some((el) => ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).toLowerCase().includes("stop"));
  const texts = Array.from(document.querySelectorAll(".response-container-content, .response-content, .response-container, .presented-response-container, .markdown-main-panel"))
    .map((el) => (el.innerText || "").trim())
    .filter((text) => text.length > 24 && !/deep research browses the open web|where should we start|create image|create music|boost my day|help me learn|upgrade to google ai ultra|show thinking|refining .* answer now|prioritizing .* answer now|defining response logic answer now|analyzing the inquiry answer now|ranking .* answer now|drafting response/i.test(text));
  const best = texts.sort((a, b) => b.length - a.length)[0] || "";
  return {
    hasStop,
    hasResponse: best.length > 24,
    length: best.length
  };
}`;

const GROK_COMPLETION_CHECK_FN = `() => {
  const buttons = Array.from(document.querySelectorAll("button"));
  const hasSubmit = buttons.some((el) => ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).toLowerCase().includes("submit"));
  const texts = Array.from(document.querySelectorAll("p, div"))
    .map((el) => (el.innerText || "").trim())
    .filter((text) => text.length > 24 && !/unlock extended capabilities|upgrade to supergrok|try free|toggle sidebar|voice\\s+imagine\\s+projects|think harder|searching the web \d+ results?/i.test(text));
  const best = texts.sort((a, b) => b.length - a.length)[0] || "";
  return {
    hasSubmit,
    hasResponse: best.length > 24,
    length: best.length
  };
}`;

const GROK_EXTRACT_FN = `() => {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 300 && rect.height > 20;
  };
  const bad = (text) => /unlock extended capabilities|upgrade to supergrok|try free|toggle sidebar|voice\\s+imagine\\s+projects|think harder|history|see all|searching the web \d+ results?/i.test(text);
  const candidates = [];
  for (const el of Array.from(document.querySelectorAll("p, div"))) {
    if (!visible(el)) continue;
    const text = (el.innerText || "").trim();
    const rect = el.getBoundingClientRect();
    if (!text || text.length < 24 || bad(text)) continue;
    let score = text.length;
    if (rect.left > window.innerWidth * 0.2) score += 30;
    if (rect.top > 120 && rect.top < window.innerHeight * 0.7) score += 20;
    if (/grok|xai|ai|人工智慧|助手|助理|python|javascript|model|模型|比較|difference|介紹/i.test(text)) score += 20;
    candidates.push({ text, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { text: candidates[0] ? candidates[0].text : "" };
}`;

function buildFillFunction(question) {
  return `() => {
    const text = ${JSON.stringify(question)};
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('textarea, [contenteditable=\"true\"], [role=\"textbox\"], input[type=\"text\"]'))
      .filter((el) => visible(el))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').toLowerCase();
        let score = 0;
        if (el.tagName === 'TEXTAREA') score += 30;
        if (el.isContentEditable) score += 20;
        if (label.includes('message') || label.includes('ask') || label.includes('reply') || label.includes('prompt') || label.includes('chat')) score += 30;
        if (rect.top > window.innerHeight * 0.4) score += 20;
        return { el, score, label };
      })
      .sort((a, b) => b.score - a.score);
    if (!candidates.length) return { ok: false, reason: 'input_not_found' };
    const target = candidates[0].el;
    target.focus();
    if ('value' in target) {
      const proto = Object.getPrototypeOf(target);
      const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (desc && typeof desc.set === 'function') desc.set.call(target, text);
      else target.value = text;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      target.textContent = text;
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return {
      ok: true,
      tag: target.tagName,
      label: target.getAttribute('aria-label') || target.getAttribute('placeholder') || ''
    };
  }`;
}

function buildClaudeFillFunction(question) {
  return `() => {
    const text = ${JSON.stringify(question)};
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const labelText = (el) => (el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").toLowerCase();
    const editors = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'))
      .filter((el) => visible(el) && /claude|prompt|reply|write/.test(labelText(el)))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        let score = 0;
        if (el.isContentEditable) score += 60;
        if (el.tagName === "TEXTAREA") score += 30;
        if (rect.left > window.innerWidth * 0.25) score += 20;
        return { el, score };
      })
      .sort((a, b) => b.score - a.score);
    if (!editors.length) return { ok: false, reason: "claude_input_not_found" };
    for (const { el } of editors) {
      try {
        el.focus();
        if (el.isContentEditable) {
          el.textContent = "";
          el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: text, inputType: "insertText" }));
          el.textContent = text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
        } else {
          const proto = Object.getPrototypeOf(el);
          const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
          if (desc && typeof desc.set === "function") desc.set.call(el, text);
          else el.value = text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } catch (_error) {}
    }
    const primary = editors[0].el;
    primary.focus();
    return {
      ok: true,
      tag: primary.tagName,
      label: primary.getAttribute("aria-label") || primary.getAttribute("placeholder") || "",
      bodyHasText: (document.body?.innerText || "").includes(text)
    };
  }`;
}

const SEND_CLICK_FN = `() => {
  const visible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const buttons = Array.from(document.querySelectorAll('button, [role=\"button\"]'))
    .filter((el) => visible(el) && !el.disabled)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
      let score = 0;
      if (label.includes('send') || label.includes('submit')) score += 40;
      if (label.includes('arrow') || label.includes('up')) score += 10;
      if (rect.top > window.innerHeight * 0.4) score += 20;
      if (label.includes('stop') || label.includes('attach') || label.includes('upload') || label.includes('voice')) score -= 40;
      return { el, label, score };
    })
    .sort((a, b) => b.score - a.score);
  if (!buttons.length || buttons[0].score <= 0) return { ok: false, reason: 'send_not_found' };
  buttons[0].el.click();
  return { ok: true, label: buttons[0].label };
}`;

const LOGIN_CHECK_FN = `() => {
  const text = (document.body?.innerText || '').slice(0, 4000).toLowerCase();
  const loginLikely = /(log in|login|sign in|continue with google|continue with email|welcome back|create account)/.test(text);
  return {
    loginLikely,
    title: document.title,
    url: location.href,
    snippet: text.slice(0, 300)
  };
}`;

function renderStatus(payload) {
  const lines = ["CMP platforms"];
  for (const platform of PLATFORM_ORDER) {
    const enabled = Boolean(payload.status[platform]);
    lines.push(`${enabled ? "ON " : "OFF"} ${platform}`);
  }
  lines.push("");
  lines.push("Slash commands:");
  lines.push("/cmp <question>");
  lines.push("/cmp-status");
  lines.push("/cmp-on <platform|all>");
  lines.push("/cmp-off <platform|all>");
  return lines.join("\n");
}

function renderToggle(payload) {
  const target = payload.target === "all" ? "all platforms" : payload.target;
  const lines = [`CMP updated: ${target} -> ${payload.mode.toUpperCase()}`, ""];
  for (const platform of PLATFORM_ORDER) {
    const enabled = Boolean(payload.status[platform]);
    lines.push(`${enabled ? "ON " : "OFF"} ${platform}`);
  }
  return lines.join("\n");
}

function buildUsageText() {
  return [
    "CMP usage:",
    "/cmp <question>",
    "/cmp-status",
    "/cmp-on <platform|all>",
    "/cmp-off <platform|all>",
    "",
    "/cmp is question-only in Discord and Telegram.",
    "Use /cmp-status, /cmp-on, and /cmp-off for state control.",
    "Telegram native aliases: /cmpstatus, /cmpon, /cmpoff"
  ].join("\n");
}

function renderFailureOnlyReport(question, locale, unusablePlatforms) {
  const heading = localize(locale, {
    zh: "🔄 Multi-AI Answer Comparison",
    ja: "🔄 Multi-AI Answer Comparison",
    en: "🔄 Multi-AI Answer Comparison"
  });
  const lines = [heading, `**${localize(locale, { zh: "Question", ja: "Question", en: "Question" })}**`, question, ""];
  lines.push(localize(locale, {
    zh: "沒有收集到可用的平台答案，因此這次無法做出可靠的整合回答。",
    ja: "利用できるプラットフォーム回答を収集できなかったため、今回は信頼できる統合回答を作れませんでした。",
    en: "No usable platform answer was collected, so cmp could not produce a reliable combined answer this time."
  }));
  lines.push("");
  lines.push(`**${localize(locale, {
    zh: "Unavailable Inputs",
    ja: "Unavailable Inputs",
    en: "Unavailable Inputs"
  })}**`);
  for (const item of unusablePlatforms) {
    lines.push(`- ${item.name || item.platform}: ${stripPlatformPrefix(item.reason || "unusable_response", item.name || item.platform)}`);
  }
  lines.push("");
  lines.push(`Debug log: ${LAST_RUN_LOG}`);
  return lines.join("\n");
}

function renderImmediateFailureReport(question, locale, errorMessage) {
  const heading = localize(locale, {
    zh: "CMP 在初始化階段失敗",
    ja: "CMP は初期化段階で失敗しました",
    en: "CMP failed during initialization"
  });
  const whyLabel = localize(locale, {
    zh: "原因",
    ja: "原因",
    en: "Cause"
  });
  const nextLabel = localize(locale, {
    zh: "下一步",
    ja: "次のステップ",
    en: "Next Step"
  });
  const nextStep = localize(locale, {
    zh: `請查看 ${LAST_RUN_LOG} 與 ${RUN_LOG}，確認 browser / plugin 啟動鏈在哪一步失敗。`,
    ja: `${LAST_RUN_LOG} と ${RUN_LOG} を確認し、browser / plugin 起動チェーンのどこで失敗したかを特定してください。`,
    en: `Check ${LAST_RUN_LOG} and ${RUN_LOG} to see which browser/plugin startup step failed.`
  });
  return [
    heading,
    "",
    `**${localize(locale, { zh: "Question", ja: "Question", en: "Question" })}**`,
    question,
    "",
    `**${whyLabel}**`,
    errorMessage,
    "",
    `**${nextLabel}**`,
    nextStep
  ].join("\n");
}

function renderComparisonReport(question, locale, aggregation, synthesis, options = {}) {
  const compact = Boolean(options.compact);
  const tighter = Boolean(options.tighter);
  const lines = [];
  lines.push(localize(locale, {
    zh: "🔄 Multi-AI Answer Comparison",
    ja: "🔄 Multi-AI Answer Comparison",
    en: "🔄 Multi-AI Answer Comparison"
  }));
  lines.push(`**${localize(locale, { zh: "Question", ja: "Question", en: "Question" })}**`);
  lines.push(question);
  lines.push("");
  lines.push(`**${localize(locale, {
    zh: "Best Combined Answer",
    ja: "Best Combined Answer",
    en: "Best Combined Answer"
  })}**`);
  lines.push(compact ? summarizeMarkdownForTransport(synthesis.directAnswer, tighter ? 700 : 1100) : synthesis.directAnswer);
  lines.push("");
  lines.push(`**${localize(locale, {
    zh: "Consensus",
    ja: "Consensus",
    en: "Consensus"
  })}**`);
  for (const item of limitListByMode(synthesis.consensus || [], compact, tighter)) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`**${localize(locale, {
    zh: "Major Differences",
    ja: "Major Differences",
    en: "Major Differences"
  })}**`);
  for (const item of limitListByMode(synthesis.majorDifferences || [], compact, tighter)) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`**${localize(locale, {
    zh: "Unique Additions",
    ja: "Unique Additions",
    en: "Unique Additions"
  })}**`);
  for (const item of limitListByMode(synthesis.uniqueAdditions || [], compact, tighter)) lines.push(`- ${item}`);
  lines.push("");

  const visiblePlatformBlocks = [];
  const footerStatus = [];
  for (const entry of aggregation.usable) {
    const summary = synthesis?.platformViews?.[entry.platform] || buildLocalPlatformViewFallback(entry, locale);
    const partial = isPartialSummary(summary);
    footerStatus.push(`${entry.name || entry.platform} ${partial ? "⚠" : "✅"}`);
    visiblePlatformBlocks.push({ entry, summary, partial });
  }
  for (const item of aggregation.unusable) {
    const mark = /timed out/i.test(item.reason || "") ? "⏱" : "❌";
    footerStatus.push(`${item.name || item.platform} ${mark}`);
  }

  if (visiblePlatformBlocks.length) {
    lines.push(`**${localize(locale, {
      zh: "Platform Views",
      ja: "Platform Views",
      en: "Platform Views"
    })}**`);
    for (const block of visiblePlatformBlocks.slice(0, tighter ? 2 : visiblePlatformBlocks.length)) {
      const { entry, summary, partial } = block;
      lines.push(`**${entry.name || entry.platform}**${partial ? " · ⚠ Partial" : ""}`);
      lines.push(summaryLine(locale, summary, { compact, tighter }));
      const keyPoints = Array.isArray(summary?.keyPoints) ? summary.keyPoints.filter(Boolean).slice(0, tighter ? 1 : compact ? 2 : 3) : [];
      for (const point of keyPoints) lines.push(`- ${point}`);
      if (!tighter && summary?.caveats) {
        lines.push(localize(locale, {
          zh: `補充：${summary.caveats}`,
          ja: `補足：${summary.caveats}`,
          en: `Notes: ${summary.caveats}`
        }));
      }
      lines.push("");
    }
  }

  const failures = aggregation.unusable
    .map((item) => {
      const failure = stripPlatformPrefix(item.reason || "", item.name || item.platform);
      return failure ? `${item.name || item.platform}: ${failure}` : null;
    })
    .filter(Boolean);
  if (failures.length) {
    lines.push(`**${localize(locale, {
      zh: "Unavailable / Partial Inputs",
      ja: "Unavailable / Partial Inputs",
      en: "Unavailable / Partial Inputs"
    })}**`);
    for (const failure of failures.slice(0, tighter ? 2 : 4)) lines.push(`- ${failure}`);
    lines.push("");
  }

  lines.push(localize(locale, {
    zh: `狀態：${footerStatus.join(" · ")}`,
    ja: `Status: ${footerStatus.join(" · ")}`,
    en: `Status: ${footerStatus.join(" · ")}`
  }));
  return lines.join("\n");
}

function summaryLine(locale, summary, options = {}) {
  const text = compactWhitespace(summary?.summary || "");
  const compact = Boolean(options.compact);
  const tighter = Boolean(options.tighter);
  const fallback = localize(locale, {
    zh: "未取得可顯示的摘要。",
    ja: "表示できる要約を取得できませんでした。",
    en: "No displayable summary was available."
  });
  const normalized = compact ? summarizePlainTextForTransport(text, tighter ? 140 : 220) : text;
  return localize(locale, {
    zh: `摘要：${normalized || fallback}`,
    ja: `要約：${normalized || fallback}`,
    en: `Summary: ${normalized || fallback}`
  });
}

function limitListByMode(items, compact, tighter) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!compact) return values;
  return values.slice(0, tighter ? 2 : 3).map((item) => summarizePlainTextForTransport(item, tighter ? 120 : 180));
}

function renderUltraCompactComparisonReport(question, locale, aggregation, synthesis, limit) {
  const lines = [
    localize(locale, {
      zh: "🔄 Multi-AI Answer Comparison",
      ja: "🔄 Multi-AI Answer Comparison",
      en: "🔄 Multi-AI Answer Comparison"
    }),
    "",
    `**${localize(locale, { zh: "Best Combined Answer", ja: "Best Combined Answer", en: "Best Combined Answer" })}**`
  ];
  lines.push(summarizeMarkdownForTransport(synthesis.directAnswer, Math.max(450, limit - 650)));
  lines.push("");
  lines.push(`**${localize(locale, { zh: "Consensus", ja: "Consensus", en: "Consensus" })}**`);
  for (const item of limitListByMode(synthesis.consensus || [], true, true)) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`**${localize(locale, { zh: "Major Differences", ja: "Major Differences", en: "Major Differences" })}**`);
  for (const item of limitListByMode(synthesis.majorDifferences || [], true, true)) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`**${localize(locale, { zh: "Unique Additions", ja: "Unique Additions", en: "Unique Additions" })}**`);
  for (const item of limitListByMode(synthesis.uniqueAdditions || [], true, true)) lines.push(`- ${item}`);
  lines.push("");
  lines.push(localize(locale, {
    zh: `狀態：${aggregation.usable.map((entry) => entry.name || entry.platform).join(" · ")}`,
    ja: `Status: ${aggregation.usable.map((entry) => entry.name || entry.platform).join(" · ")}`,
    en: `Status: ${aggregation.usable.map((entry) => entry.name || entry.platform).join(" · ")}`
  }));
  return lines.join("\n");
}

function buildLocalPlatformViewFallback(entry, locale) {
  const cleaned = stripPlanningPreamble(compactWhitespace(entry?.responseText || ""));
  const summary = summarizeResponse(cleaned);
  const sentences = String(cleaned || "")
    .split(/(?<=[。.!?！？])\s+/)
    .map((item) => compactWhitespace(item))
    .filter(Boolean);
  const structured = extractStructuredPoints(cleaned);
  const keyPoints = (structured.length
    ? structured.slice(0, 3)
    : sentences.slice(0, 3).map((item) => summarizePlainTextForTransport(item, 100)))
    .filter(Boolean);
  const caveats = [];
  if (entry?.responseSource) {
    caveats.push(localize(locale, {
      zh: `來源：${entry.responseSource}`,
      ja: `取得元: ${entry.responseSource}`,
      en: `Source: ${entry.responseSource}`
    }));
  }
  if (entry?.usability?.issues?.length) {
    caveats.push(localize(locale, {
      zh: `檢測標記：${entry.usability.issues.join(", ")}`,
      ja: `検出フラグ: ${entry.usability.issues.join(", ")}`,
      en: `Flags: ${entry.usability.issues.join(", ")}`
    }));
  }
  return {
    summary,
    keyPoints,
    caveats: caveats.join(" · ")
  };
}

function summarizeMarkdownForTransport(text, maxChars) {
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map((part) => compactWhitespace(part))
    .filter(Boolean);
  if (!paragraphs.length) return "";
  const kept = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    const normalized = summarizePlainTextForTransport(paragraph, Math.min(260, maxChars));
    if (!normalized) continue;
    const next = used + normalized.length + (kept.length ? 2 : 0);
    if (next > maxChars && kept.length) break;
    kept.push(normalized);
    used = next;
    if (used >= maxChars) break;
  }
  return kept.join("\n\n");
}

function summarizePlainTextForTransport(text, maxChars) {
  const cleaned = compactWhitespace(text);
  if (!cleaned) return "";
  if (cleaned.length <= maxChars) return cleaned;
  const sentences = cleaned.split(/(?<=[。.!?！？])\s+/).map((item) => compactWhitespace(item)).filter(Boolean);
  const kept = [];
  let used = 0;
  for (const sentence of sentences) {
    const next = used + sentence.length + (kept.length ? 1 : 0);
    if (next > maxChars && kept.length) break;
    kept.push(sentence);
    used = next;
    if (used >= maxChars) break;
  }
  if (kept.length) return kept.join(" ");
  const fragments = cleaned.split(/[,，、;；]\s*/).map((item) => compactWhitespace(item)).filter(Boolean);
  const picked = [];
  used = 0;
  for (const fragment of fragments) {
    const next = used + fragment.length + (picked.length ? 2 : 0);
    if (next > maxChars && picked.length) break;
    picked.push(fragment);
    used = next;
  }
  if (picked.length) return picked.join("；");
  const words = cleaned.split(/\s+/).filter(Boolean);
  const keptWords = [];
  used = 0;
  for (const word of words) {
    const next = used + word.length + (keptWords.length ? 1 : 0);
    if (next > maxChars && keptWords.length) break;
    keptWords.push(word);
    used = next;
  }
  return keptWords.join(" ");
}

async function buildComparisonSynthesis(question, locale, aggregation, runLog) {
  if (!aggregation.usable.length) {
    return buildEmptySynthesis(locale);
  }
  const prepared = aggregation.usable.map((entry) => ({
    platform: entry.platform,
    name: entry.name,
    answer: stripPlanningPreamble(entry.responseText)
  }));
  traceRun(runLog, "summary_generation_start", {
    platformCount: prepared.length,
    answerLengths: prepared.map((entry) => ({ platform: entry.platform, length: entry.answer.length }))
  });
  try {
    const modelResult = await generatePreferredSynthesis(question, locale, prepared, aggregation.unusable, runLog);
    // Second-pass directAnswer using gpt-4.1 (free, flat-rate Copilot) with a dedicated 8000-token budget.
    // This produces a richer Best Combined Answer than the joint synthesis pass which shares tokens across all 5 fields.
    try {
      const richAnswer = await generateClaudeDirectAnswer(question, locale, prepared, aggregation.unusable, runLog);
      if (richAnswer && richAnswer.length > (modelResult.directAnswer || "").length) {
        modelResult.directAnswer = richAnswer;
        modelResult.mode = (modelResult.mode || "model") + "+gpt41";
      }
    } catch (richAnswerError) {
      traceRun(runLog, "claude_direct_answer_skipped", { reason: toErrorMessage(richAnswerError) });
    }
    const completedSummaries = await fillMissingPlatformSummaries(question, locale, prepared, modelResult.platformViews || {}, runLog);
    modelResult.platformViews = completedSummaries;
    traceRun(runLog, "summary_generation_complete", {
      mode: modelResult.mode || "model",
      platformCount: Object.keys(modelResult.platformViews || {}).length
    });
    return mergeSynthesisWithFallback(buildEmptySynthesis(locale), modelResult);
  } catch (error) {
    traceRun(runLog, "summary_generation_failed", {
      error: toErrorMessage(error)
    });
    return buildModelFailureSynthesis(locale, aggregation);
  }
}

async function generatePreferredSynthesis(question, locale, prepared, unusable, runLog) {
  traceRun(runLog, "agent_synthesis_skipped", {
    reason: "embedded_pi_agent_forces_anthropic_on_this_host"
  });
  const modelResult = await generateModelSynthesis(question, locale, prepared, unusable, runLog);
  return { ...modelResult, mode: modelResult.mode || "model" };
}

async function fillMissingPlatformSummaries(question, locale, prepared, existingSummaries, runLog) {
  const summaries = { ...(existingSummaries || {}) };
  for (const entry of prepared) {
    if (summaries[entry.platform]?.summary) continue;
    try {
      traceRun(runLog, "platform_summary_backfill_start", { platform: entry.platform });
      summaries[entry.platform] = await generatePlatformSummaryModel(question, locale, entry, runLog);
      traceRun(runLog, "platform_summary_backfill_complete", { platform: entry.platform });
    } catch (error) {
      traceRun(runLog, "platform_summary_backfill_failed", {
        platform: entry.platform,
        error: toErrorMessage(error)
      });
    }
  }
  return summaries;
}

function mergeSynthesisWithFallback(fallback, modelResult) {
  const platformViews = { ...(fallback.platformViews || {}) };
  for (const [platform, summary] of Object.entries(modelResult?.platformViews || {})) {
    platformViews[platform] = {
      ...platformViews[platform],
      ...summary
    };
  }
  return {
    platformViews,
    consensus: normalizeStringArray(modelResult?.consensus ?? modelResult?.sharedThemes, fallback.consensus),
    majorDifferences: normalizeStringArray(modelResult?.majorDifferences, fallback.majorDifferences),
    uniqueAdditions: normalizeStringArray(modelResult?.uniqueAdditions, fallback.uniqueAdditions),
    directAnswer: compactWhitespace(modelResult?.directAnswer || fallback.directAnswer),
    mode: modelResult?.mode || fallback.mode || "heuristic"
  };
}

function buildEmptySynthesis(locale) {
  return {
    platformViews: {},
    consensus: [localize(locale, {
      zh: "這次沒有足夠的可用答案可供整合。",
      ja: "今回は統合に使える回答が不足しています。",
      en: "There were not enough usable answers to synthesize."
    })],
    majorDifferences: [localize(locale, {
      zh: "由於可用來源不足，無法可靠比較差異。",
      ja: "利用可能な回答が足りず、差分を信頼して比較できません。",
      en: "There were not enough usable sources to compare differences reliably."
    })],
    uniqueAdditions: [localize(locale, {
      zh: "目前沒有可安全保留的獨特補充。",
      ja: "現時点で安全に残せる固有補足はありません。",
      en: "There were no safe unique additions to preserve."
    })],
    directAnswer: localize(locale, {
      zh: "請先檢查各平台登入狀態與瀏覽器執行狀況，再重新執行 /cmp。",
      ja: "各プラットフォームのログイン状態とブラウザ実行状況を確認してから、/cmp を再実行してください。",
      en: "Check the platform sessions and managed browser state, then run /cmp again."
    }),
    mode: "empty"
  };
}

function buildModelFailureSynthesis(locale, aggregation) {
  const unavailable = (aggregation?.unusable || [])
    .map((entry) => `${entry.name || entry.platform}: ${stripPlatformPrefix(entry.reason || "", entry.name || entry.platform)}`)
    .filter(Boolean)
    .slice(0, 4);
  const platformViews = Object.fromEntries(
    (aggregation?.usable || []).map((entry) => [entry.platform, buildLocalPlatformViewFallback(entry, locale)])
  );
  return {
    platformViews,
    consensus: [localize(locale, {
      zh: "本輪已收集到平台回答，但整合模型未能完成可信的跨平台綜合，因此以下不宣稱真正的共識。",
      ja: "今回は回答収集までは完了しましたが、統合モデルが信頼できる横断分析を完了できなかったため、ここでは合意点を断定しません。",
      en: "Platform answers were collected, but the synthesis model did not complete a reliable cross-platform synthesis, so no true consensus is being claimed below."
    })],
    majorDifferences: unavailable.length ? [localize(locale, {
      zh: `未納入整合的來源：${unavailable.join("；")}。請以下方各平台摘要與摘錄為準。`,
      ja: `統合に含めていない入力: ${unavailable.join("；")}。以下の各プラットフォーム要約と抜粋を確認してください。`,
      en: `Inputs excluded from synthesis: ${unavailable.join("; ")}. Use the platform summaries and excerpts below instead of treating this as a completed comparison.`
    })] : [localize(locale, {
      zh: "本輪未完成可靠的模型綜合，因此差異欄僅保留各平台摘要與摘錄，不做強行結論。",
      ja: "今回は信頼できる統合が未完了のため、差分欄で無理に結論づけず、各プラットフォーム要約と抜粋を優先します。",
      en: "Reliable synthesis did not complete this round, so this report avoids forcing a differences conclusion and instead keeps the platform summaries and excerpts below."
    })],
    uniqueAdditions: [localize(locale, {
      zh: "若需人工判讀，請優先查看下方 Platform Views 的具體內容與原始摘錄。",
      ja: "手動で判断する場合は、下の Platform Views にある具体的な内容と抜粋を優先してください。",
      en: "If you need to inspect the results manually, prioritize the concrete content and excerpts in Platform Views below."
    })],
    directAnswer: localize(locale, {
      zh: "這一輪沒有完成真正的 AI 綜合分析。CMP 已保留各平台的完整回答、抽取來源與執行痕跡，因此下方會直接展示各平台摘要與可用重點，並明確保留失敗原因。只有在瀏覽器流程或登入狀態必須修復時，才需要你重新執行 /cmp。",
      ja: "今回は本当の AI 統合分析が完了していません。CMP は各プラットフォームの回答全文、抽出元、実行痕跡を保持しているため、下で要約と有用なポイントを直接示し、失敗理由も明示します。ブラウザ手順やログイン状態の修復が必要な場合にのみ /cmp の再実行が必要です。",
      en: "A real AI synthesis did not complete this round. CMP preserved the full platform answers, extraction sources, and execution traces, so the report now falls back to direct platform summaries and useful excerpts instead of fake completion text. Re-run /cmp only if the browser flow or login state actually needs repair."
    }),
    mode: "model_failure"
  };
}

async function screenPlatformAnswers(question, locale, candidates, runLog) {
  const toReview = candidates.filter((entry) => entry.responseText && !entry.failure);
  const heuristic = Object.fromEntries(candidates.map((entry) => [entry.platform, buildHeuristicScreenResult(entry, question)]));
  if (!toReview.length) return heuristic;

  traceRun(runLog, "screening_model_request", {
    platformCount: toReview.length
  });
  try {
    const raw = await runGatewayChatCompletion({
      messages: buildScreeningMessages(locale, question, toReview),
      temperature: 0,
      max_tokens: 900
    });
    const parsed = parseStructuredJson(extractChatCompletionText(raw));
    const normalized = normalizeScreeningResult(parsed, toReview, heuristic);
    traceRun(runLog, "screening_model_response", {
      results: Object.entries(normalized).map(([platform, value]) => ({
        platform,
        usable: value.usable,
        reason: value.reason
      }))
    });
    return normalized;
  } catch (error) {
    traceRun(runLog, "screening_model_failed", { error: toErrorMessage(error) });
    return heuristic;
  }
}

function buildHeuristicScreenResult(entry, question) {
  const text = stripPlanningPreamble(compactWhitespace(entry.responseText || ""));
  const issues = [];
  if (!text) issues.push("missing_content");
  if (looksLikeUiHistoryDump(text)) issues.push("ui_or_history_dump");
  if (!hasQuestionRelevanceSignal(question, text)) issues.push("weak_question_relevance");
  if (needsMoreResponseDepth(entry.platform, text, question)) issues.push("thin_answer");
  return {
    usable: Boolean(text) && !issues.includes("ui_or_history_dump") && !issues.includes("weak_question_relevance"),
    reason: issues[0] || (text ? "ok" : "missing_content"),
    issues,
    keepExtract: !issues.includes("ui_or_history_dump")
  };
}

function buildScreeningMessages(locale, question, candidates) {
  return [
    {
      role: "system",
      content: localize(locale, {
        zh: [
          "你是 cmp 的答案篩選層。",
          "你會看到原始問題，以及各平台的已清理答案。",
          "你的工作是判斷每個答案是否適合進入最終整合。",
          "若答案離題、像歷史/選單殘留、太薄弱、像佔位文字、或明顯不是在回答該問題，就標記 unusable。",
          "只輸出 JSON，格式：{\"platforms\": {\"<platform>\": {\"usable\": boolean, \"reason\": string, \"issues\": string[], \"keepExtract\": boolean}}}",
          "issues 請使用簡短英文代碼，例如 wrong_topic, ui_dump, placeholder, too_thin, partial, weak_relevance。"
        ].join("\n"),
        ja: [
          "あなたは cmp の回答スクリーニング層です。",
          "元の質問と各プラットフォームのクリーニング済み回答を見て、最終統合に使えるか判定してください。",
          "話題ずれ、履歴/メニュー残骸、プレースホルダ、薄すぎる回答は unusable にします。",
          "JSON のみ出力: {\"platforms\": {\"<platform>\": {\"usable\": boolean, \"reason\": string, \"issues\": string[], \"keepExtract\": boolean}}}"
        ].join("\n"),
        en: [
          "You are the cmp answer screening layer.",
          "You will receive the original user question and cleaned answers from multiple platforms.",
          "Decide whether each answer is usable for final synthesis.",
          "Mark an answer unusable if it is wrong-topic, stale, a UI/history dump, placeholder-like, too thin, or clearly not answering the question.",
          "Return JSON only: {\"platforms\": {\"<platform>\": {\"usable\": boolean, \"reason\": string, \"issues\": string[], \"keepExtract\": boolean}}}",
          "Use short issue codes such as wrong_topic, ui_dump, placeholder, too_thin, partial, weak_relevance."
        ].join("\n")
      })
    },
    {
      role: "user",
      content: JSON.stringify({
        question,
        platforms: candidates.map((entry) => ({
          platform: entry.platform,
          name: entry.name,
          answer: entry.responseText
        }))
      })
    }
  ];
}

function normalizeScreeningResult(parsed, candidates, fallback) {
  const normalized = { ...(fallback || {}) };
  const values = parsed?.platforms || {};
  for (const entry of candidates) {
    const raw = values?.[entry.platform] || values?.[entry.name] || null;
    if (!raw || typeof raw !== "object") continue;
    normalized[entry.platform] = {
      usable: Boolean(raw.usable),
      reason: compactWhitespace(raw.reason || "") || (raw.usable ? "ok" : "unusable_response"),
      issues: normalizeStringArray(raw.issues, []),
      keepExtract: raw.keepExtract !== false
    };
  }
  return normalized;
}

function stripPlanningPreamble(text) {
  const cleaned = String(text || "").replace(/\u00a0/g, " ");
  const lines = cleaned
    .split(/\n+/)
    .map((line) => compactWhitespace(line))
    .filter(Boolean);
  const filtered = lines.filter((line) => !/^(識別語言偏好並籌劃專業回應策略|identify language preference|planning response strategy|show thinking|thinking|drafting response|prioritizing .* answer now|defining response logic answer now|analyzing the inquiry answer now)$/i.test(line));
  return compactWhitespace((filtered.length ? filtered : lines).join("\n"));
}

function summarizeResponse(text) {
  const cleaned = stripPlanningPreamble(compactWhitespace(text));
  return summarizePlainTextForTransport(cleaned, 420);
}

function needsMoreResponseDepth(platformKey, text, question) {
  const cleaned = compactWhitespace(text);
  if (!cleaned) return true;
  if (isRankingQuestion(question) && cleaned.length < 120) return true;
  if (/^\d+[\.)]/.test(cleaned) && cleaned.length < 80) return true;
  if (platformKey === "gemini" && cleaned.length < 80) return true;
  if (platformKey === "grok" && cleaned.length < 90 && isRankingQuestion(question)) return true;
  return false;
}

function looksLikeTruncatedExtraction(text) {
  const cleaned = compactWhitespace(text);
  if (!cleaned) return false;
  if (cleaned.length < 120) return false;
  if (/[,:;，、：]\s*$/.test(cleaned)) return true;
  if (/\b(and|or|because|that|which|with|for|to|of|如果|因為|而且|並且|所以|因此|例如|以及|また|そして|ため)\s*$/i.test(cleaned)) return true;
  if (!/[.!?。！？]$/.test(cleaned) && cleaned.length < 500) return true;
  return false;
}

function analyzePlatformAnswer(text, question, locale) {
  const cleaned = stripPlanningPreamble(compactWhitespace(text));
  const items = extractNamedItems(cleaned);
  const tags = detectAnswerTags(cleaned);
  let stance = "";
  if (isRankingQuestion(question) && items.length) {
    stance = localize(locale, {
      zh: `以 ${items.slice(0, 3).join("、")} 為核心回答這個排序/推薦問題。`,
      ja: `${items.slice(0, 3).join("、")} を中心に順位付けや推薦を行っている。`,
      en: `Frames the answer around ${items.slice(0, 3).join(", ")} as the main top-tier picks.`
    });
  } else {
    stance = buildAnswerStance(cleaned, question, tags, locale);
  }

  const details = [];
  if (items.length) {
    details.push(localize(locale, {
      zh: `提到：${items.slice(0, 5).join("、")}`,
      ja: `言及：${items.slice(0, 5).join("、")}`,
      en: `Mentions: ${items.slice(0, 5).join(", ")}`
    }));
  }
  if (tags.length) {
    details.push(localize(locale, {
      zh: `重點：${tags.slice(0, 3).map((tag) => localizeTag(tag, "zh")).join("、")}`,
      ja: `観点：${tags.slice(0, 3).map((tag) => localizeTag(tag, "ja")).join("、")}`,
      en: `Focus: ${tags.slice(0, 3).map((tag) => localizeTag(tag, "en")).join(", ")}`
    }));
  }
  if (!details.length) {
    details.push(summarizePlainTextForTransport(cleaned, 140));
  }
  return { stance, details, items, tags, cleaned };
}

function buildAnswerComparison(successful, analyses, locale) {
  if (!successful.length) {
    return {
      shared: [localize(locale, { zh: "沒有可比較的成功回答。", ja: "比較できる成功回答がありません。", en: "No successful answers to compare." })],
      differences: [localize(locale, { zh: "沒有足夠資料。", ja: "十分なデータがありません。", en: "Not enough data." })],
      unique: [localize(locale, { zh: "沒有獨特補充。", ja: "独自補足はありません。", en: "No unique additions." })],
      takeaway: localize(locale, { zh: "這次沒有足夠的有效回答可整合。", ja: "今回は有効回答が不足しており統合できません。", en: "There were not enough valid answers to synthesize." })
    };
  }
  const itemCounts = new Map();
  const tagCounts = new Map();
  for (const entry of successful) {
    const analysis = analyses.get(entry.platform);
    for (const item of analysis?.items || []) itemCounts.set(item, (itemCounts.get(item) || 0) + 1);
    for (const tag of analysis?.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  }
  const sharedItems = [...itemCounts.entries()].filter(([, count]) => count >= Math.max(2, Math.ceil(successful.length / 2))).map(([item]) => item);
  const sharedTags = [...tagCounts.entries()].filter(([, count]) => count >= Math.max(2, Math.ceil(successful.length / 2))).map(([tag]) => tag);
  const shared = [];
  if (sharedItems.length) {
    shared.push(localize(locale, {
      zh: `多個平台都把 ${sharedItems.slice(0, 5).join("、")} 當成核心答案的一部分，這些點不是順手一提，而是各自結論中的共同主軸。`,
      ja: `複数のプラットフォームが ${sharedItems.slice(0, 5).join("、")} を結論の中核として扱っており、周辺情報ではなく共通の主軸になっている。`,
      en: `Multiple platforms treated ${sharedItems.slice(0, 5).join(", ")} as part of the core answer rather than a passing detail.`
    }));
  }
  if (sharedTags.length) {
    shared.push(localize(locale, {
      zh: `它們判斷這個問題時也反覆落在同幾個分析軸上：${sharedTags.slice(0, 4).map((tag) => localizeTag(tag, "zh")).join("、")}。這代表共識不只在結論，也在推理框架。`,
      ja: `分析の軸も ${sharedTags.slice(0, 4).map((tag) => localizeTag(tag, "ja")).join("、")} に収束しており、結論だけでなく考え方にも重なりがある。`,
      en: `They also converged on similar analytical lenses: ${sharedTags.slice(0, 4).map((tag) => localizeTag(tag, "en")).join(", ")}. The overlap is in both conclusion and reasoning frame.`
    }));
  }
  if (!shared.length) {
    shared.push(localize(locale, {
      zh: `可用回答之間沒有形成一句話就能概括的單一共識，但它們至少在核心立場上互相支撐：${successful.map((entry) => entry.name).join("、")} 都沒有走向彼此衝突的結論。`,
      ja: `一文で言い切れる単一の合意は弱いものの、${successful.map((entry) => entry.name).join("、")} の回答は互いに真正面から矛盾してはいない。`,
      en: `There was no single slogan-like consensus, but ${successful.map((entry) => entry.name).join(", ")} still support broadly compatible conclusions rather than directly conflicting ones.`
    }));
  }

  const differences = [];
  for (const entry of successful) {
    const analysis = analyses.get(entry.platform);
    const uniqueItems = (analysis?.items || []).filter((item) => (itemCounts.get(item) || 0) === 1).slice(0, 2);
    const uniqueTags = (analysis?.tags || []).filter((tag) => (tagCounts.get(tag) || 0) === 1).slice(0, 1).map((tag) => localizeTag(tag, locale));
    if (uniqueItems.length || uniqueTags.length) {
      differences.push(localize(locale, {
        zh: `${entry.name} 把重心放在 ${[...uniqueItems, ...uniqueTags].join("、")} 上，所以它用來回答這個問題的證據與判準，和其他平台並不完全一致。`,
        ja: `${entry.name} は ${[...uniqueItems, ...uniqueTags].join("、")} に比重を置いており、採用する根拠や判断基準が他と少し異なる。`,
        en: `${entry.name} leaned more heavily on ${[...uniqueItems, ...uniqueTags].join(", ")}, so its criteria and evidence differ from the others.`
      }));
    }
  }
  if (!differences.length) {
    differences.push(localize(locale, {
      zh: "這次差異更多體現在展開方式、證據密度與優先順序，而不是出現直接相反的主張。",
      ja: "今回の違いは、主張の真逆さよりも、展開の仕方・根拠の密度・優先順位にある。",
      en: "This round's differences were more about framing, evidence density, and prioritization than outright contradiction."
    }));
  }

  const unique = [];
  for (const entry of successful) {
    const analysis = analyses.get(entry.platform);
    const additions = [];
    for (const tag of analysis?.tags || []) {
      if ((tagCounts.get(tag) || 0) === 1) additions.push(localizeTag(tag, locale));
    }
    if (additions.length) {
      unique.push(localize(locale, {
        zh: `${entry.name} 額外展開了 ${additions.slice(0, 2).join("、")} 這一層，其他成功回答沒有把這部分講得同樣具體。`,
        ja: `${entry.name} だけが ${additions.slice(0, 2).join("、")} という論点を明確に補っており、他の回答ではそこまで展開されていない。`,
        en: `${entry.name} alone developed the ${additions.slice(0, 2).join(" and ")} angle clearly; the others did not cover it with the same specificity.`
      }));
    }
  }
  if (!unique.length) {
    unique.push(localize(locale, {
      zh: "這次沒有哪個平台拿出完全獨家的關鍵事實，但仍可從不同回答中吸收互補的論證方式與重點排序。",
      ja: "完全に独占的な決定打はなかったが、論証の仕方や重点の置き方には補完関係がある。",
      en: "No platform contributed a single decisive exclusive fact, but their reasoning styles still complement each other."
    }));
  }

  const takeawayItems = sharedItems.slice(0, 4);
  const takeaway = takeawayItems.length
    ? localize(locale, {
        zh: `把所有成功回答對齊來看，${takeawayItems.join("、")} 是最穩定的交集；真正拉開差距的不是是否提到它們，而是各平台如何權衡 ${sharedTags.slice(0, 4).map((tag) => localizeTag(tag, "zh")).join("、") || "不同判準"}。`,
        ja: `成功回答を重ねると、${takeawayItems.join("、")} が最も安定した交点になる。差を生むのは言及の有無より、${sharedTags.slice(0, 4).map((tag) => localizeTag(tag, "ja")).join("、") || "異なる判断基準"} をどう重み付けするかだ。`,
        en: `Across the successful answers, ${takeawayItems.join(", ")} form the most stable overlap. The real divergence comes from how each platform weights ${sharedTags.slice(0, 4).map((tag) => localizeTag(tag, "en")).join(", ") || "different criteria"}.`
      })
    : localize(locale, {
        zh: `沒有單一答案可以直接覆蓋全部重點，但把成功平台放在一起看，能補齊同一問題在結論、判準與使用情境上的缺口。`,
        ja: `単独で全体を覆える回答はないが、成功した回答を合わせると、結論・判断基準・利用文脈の抜けが埋まる。`,
        en: `No single answer covered everything alone, but the successful platforms fill each other's gaps across conclusion, criteria, and practical context.`
      });

  return { shared, differences, unique, takeaway };
}

function buildHeuristicSynthesis(question, locale, aggregation, options = {}) {
  const successful = aggregation.usable || [];
  const analyses = new Map(successful.map((entry) => [entry.platform, analyzePlatformAnswer(entry.responseText, question, locale)]));
  const comparison = buildAnswerComparison(successful, analyses, locale);
  const platformViews = {};

  for (const entry of successful) {
    const analysis = analyses.get(entry.platform);
    platformViews[entry.platform] = {
      summary: buildPlatformViewSummary(entry, analysis, locale),
      keyPoints: buildPlatformViewKeyPoints(entry, analysis, locale),
      caveats: buildPlatformViewCaveat(entry, locale)
    };
  }

  return {
    platformViews,
    consensus: comparison.shared,
    majorDifferences: comparison.differences,
    uniqueAdditions: comparison.unique,
    directAnswer: buildBestCombinedAnswer(question, locale, successful, analyses, comparison, aggregation.unusable || []),
    mode: options.mode || "heuristic"
  };
}

function buildPlatformViewSummary(entry, analysis, locale) {
  const stance = compactWhitespace(analysis?.stance || "");
  const cleanedResponse = stripPlanningPreamble(entry.responseText || "");
  const summary = compactWhitespace(summarizeResponse(cleanedResponse));
  if (stance && summary && stance !== summary) return summarizePlainTextForTransport(`${stance} ${summary}`, 420);
  return summarizePlainTextForTransport(stance || summary || firstMeaningfulSentence(cleanedResponse), 420);
}

function buildPlatformViewKeyPoints(entry, analysis, locale) {
  const direct = extractStructuredPoints(stripPlanningPreamble(entry.responseText || "")).slice(0, 3);
  if (direct.length) return direct;
  const details = Array.isArray(analysis?.details) ? analysis.details.filter(Boolean) : [];
  return details.slice(0, 3).map((item) => summarizePlainTextForTransport(item, 200));
}

function buildPlatformViewCaveat(entry, locale) {
  if (!entry.usability?.issues?.length) return "";
  const labels = entry.usability.issues.slice(0, 2).map((issue) => localizeIssue(issue, locale));
  return labels.length ? localize(locale, {
    zh: `保留注意：${labels.join("、")}。`,
    ja: `留意点：${labels.join("、")}。`,
    en: `Caveat: ${labels.join(", ")}.`
  }) : "";
}

function buildBestCombinedAnswer(question, locale, successful, analyses, comparison, unusable) {
  const paragraphs = [];
  paragraphs.push(localize(locale, {
    zh: `綜合判斷如下：${comparison.takeaway}`,
    ja: `質問への直接回答: ${comparison.takeaway}`,
    en: `Direct answer: ${comparison.takeaway}`
  }));

  const evidenceLines = [];
  for (const entry of successful) {
    const summary = buildPlatformViewSummary(entry, analyses.get(entry.platform), locale);
    const keyPoints = buildPlatformViewKeyPoints(entry, analyses.get(entry.platform), locale);
    const fragments = [summary, ...keyPoints].filter(Boolean).slice(0, 3);
    if (!fragments.length) continue;
    evidenceLines.push(`- **${entry.name}**: ${fragments.join("；")}`);
  }
  if (evidenceLines.length) {
    paragraphs.push(localize(locale, {
      zh: "把各平台真正值得保留的內容合在一起看，可以先抓住這些具體結論與依據：",
      ja: "各プラットフォームで実際に残す価値がある論点をまとめると、まず次の具体点が土台になる。",
      en: "Taken together, these are the concrete points and supporting reasons worth preserving across the platforms:"
    }));
    paragraphs.push(evidenceLines.join("\n"));
  }

  if (comparison.majorDifferences?.length) {
    paragraphs.push(localize(locale, {
      zh: `如果你要判斷哪個答案更適合直接採納，真正需要注意的分歧是這些：${comparison.majorDifferences.join(" ")}`,
      ja: `そのまま採用する際に見落としてはいけない相違点は次の通りです: ${comparison.majorDifferences.join(" ")}`,
      en: `If you need to decide which answer to trust more heavily, these are the meaningful disagreements to watch: ${comparison.majorDifferences.join(" ")}`
    }));
  }

  if (comparison.uniqueAdditions?.length) {
    paragraphs.push(localize(locale, {
      zh: `另外，這些只出現在單一平台、但足以提升最終答案品質的補充，也值得一併吸收：${comparison.uniqueAdditions.join(" ")}`,
      ja: `さらに、単一プラットフォーム由来でも最終回答の質を上げる補足は次の通りです: ${comparison.uniqueAdditions.join(" ")}`,
      en: `These single-platform additions are also worth carrying into the final answer because they improve the final synthesis: ${comparison.uniqueAdditions.join(" ")}`
    }));
  }

  if (unusable.length) {
    const failures = unusable
      .map((entry) => `${entry.name || entry.platform}: ${stripPlatformPrefix(entry.reason || "", entry.name || entry.platform)}`)
      .filter(Boolean)
      .slice(0, 3);
    if (failures.length) {
      paragraphs.push(localize(locale, {
        zh: `這次沒有納入最終結論的來源有：${failures.join("；")}。因此最終答案是根據成功取得的完整回答做整合，而不是把失敗來源硬湊進去。`,
        ja: `今回最終結論に含めていない入力は ${failures.join("；")} です。したがって、最終回答は取得できた完全な回答だけを土台にしています。`,
        en: `These inputs were excluded from the final answer: ${failures.join("; ")}. The synthesis above is grounded only in the fully collected successful answers.`
      }));
    }
  }

  return paragraphs.filter(Boolean).join("\n\n");
}

function localizeIssue(issue, locale) {
  const map = {
    missing_content: { zh: "內容缺失", ja: "内容不足", en: "missing content" },
    ui_or_history_dump: { zh: "頁面殘留", ja: "UI/履歴ノイズ", en: "UI/history residue" },
    weak_question_relevance: { zh: "相關性偏弱", ja: "関連性が弱い", en: "weak relevance" },
    thin_answer: { zh: "答案過薄", ja: "回答が薄い", en: "thin answer" }
  };
  return map[issue]?.[locale] || map[issue]?.en || issue;
}

function extractNamedItems(text) {
  const patterns = [
    /\b(?:GPT[-\s]?\d+(?:\.\d+)?(?:\s+(?:mini|high|thinking|pro))?|Gemini(?:\s+\d+(?:\.\d+)?)?(?:\s+Pro)?|Claude(?:\s+(?:Opus|Sonnet)\s*\d+(?:\.\d+)?)?|Grok(?:\s*\d+)?|DeepSeek(?:\s+[A-Za-z0-9]+)?|Qwen(?:\s*[A-Za-z0-9.-]+)?|Llama(?:\s*\d+)?|Mistral(?:\s*[A-Za-z0-9.-]+)?|Opus\s*\d+(?:\.\d+)?|Sonnet\s*\d+(?:\.\d+)?|o\d(?:\s*mini)?|4o)\b/gi
  ];
  const items = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = normalizeNamedItem(match[0]);
      if (!value) continue;
      if (!items.includes(value)) items.push(value);
    }
  }
  return dedupeNamedItems(items).slice(0, 8);
}

function detectAnswerTags(text) {
  const tags = [];
  const map = [
    ["benchmarks", /benchmark|leaderboard|arena|elo|gpqa|swe-bench|排行榜|榜單|基準|評測/i],
    ["multimodal", /multimodal|image|video|audio|多模態|圖片|影片|音訊/i],
    ["coding", /code|coding|programming|程式|編碼/i],
    ["context", /context|token|上下文/i],
    ["pricing", /price|pricing|cost|性價比|價格|cost-effective/i],
    ["caveats", /depends|no single|沒有單一|視情況|標準不同|criteria|評估標準/i],
    ["use cases", /use case|use-case|用途|應用|real-world|場景/i],
    ["syntax", /syntax|語法|易讀性|readability|beginner|初學者/i],
    ["runtime", /runtime|browser|node\.?js|server|前端|後端|frontend|backend/i],
    ["ecosystem", /ecosystem|library|framework|package|npm|pip|套件|生態/i],
    ["performance", /performance|speed|fast|效能|速度/i]
  ];
  for (const [tag, pattern] of map) {
    if (pattern.test(text)) tags.push(tag);
  }
  return tags;
}

function isRankingQuestion(question) {
  return /(best|top|\b5\b|five|排名|排行|最好的|前五|top-tier|models|電影|十部|ten)/i.test(String(question || ""));
}

function escapeMarkdownCell(text) {
  return String(text || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function generateModelSynthesis(question, locale, prepared, unusable, runLog) {
  const payload = {
    locale,
    question,
    usablePlatforms: prepared.map((entry) => ({
      platform: entry.platform,
      name: entry.name,
      answer: entry.answer
    })),
    unavailablePlatforms: (unusable || []).map((entry) => ({
      platform: entry.platform,
      name: entry.name,
      reason: entry.reason
    }))
  };
  traceRun(runLog, "synthesis_model_request", {
    platformCount: payload.usablePlatforms.length,
    unavailableCount: payload.unavailablePlatforms.length
  });
  const raw = await runGatewayChatCompletion({
    messages: buildSynthesisMessages(locale, payload),
    temperature: 0.2,
    max_tokens: 5000
  });
  traceRun(runLog, "synthesis_model_provider", raw?._cmpMeta || { provider: "github-copilot", stage: "primary" });
  const content = extractChatCompletionText(raw);
  traceRun(runLog, "synthesis_model_response", {
    contentLength: content.length
  });
  let parsed;
  try {
    parsed = parseStructuredJson(content);
  } catch (error) {
    traceRun(runLog, "synthesis_model_retry", { reason: toErrorMessage(error) });
    const retry = await runGatewayChatCompletion({
      messages: [
        {
          role: "system",
          content: localize(locale, {
            zh: "你剛才沒有輸出合法 JSON。現在只輸出合法 JSON，不要加任何其他文字。",
            ja: "前回は有効な JSON ではありませんでした。今回は JSON のみを返してください。",
            en: "Your previous reply was not valid JSON. Return valid JSON only, with no extra text."
          })
        },
        ...buildSynthesisMessages(locale, payload)
      ],
      temperature: 0,
      max_tokens: 3200
    });
    traceRun(runLog, "synthesis_model_provider", retry?._cmpMeta || { provider: "github-copilot", stage: "retry" });
    const retryContent = extractChatCompletionText(retry);
    traceRun(runLog, "synthesis_model_retry_response", {
      contentLength: retryContent.length
    });
    parsed = parseStructuredJson(retryContent);
  }
  const normalized = normalizeModelSynthesis(parsed, payload.usablePlatforms, locale);
  validateModelSynthesis(question, normalized);
  traceRun(runLog, "synthesis_model_parsed", {
    summaryPlatforms: Object.keys(normalized.platformViews || {}),
    directAnswerLength: normalized.directAnswer.length
  });
  return normalized;
}

async function generateAgentSynthesis(question, locale, prepared, unusable, runLog) {
  traceRun(runLog, "synthesis_agent_request", {
    platformCount: prepared.length,
    unavailableCount: unusable.length
  });
  const parsed = await runAgentJsonTask({
    prompt: buildSynthesisAgentPrompt(locale),
    input: {
      locale,
      question,
      usablePlatforms: prepared,
      unavailablePlatforms: unusable
    },
    timeoutMs: 180000,
    maxTokens: 3200,
    thinkLevel: "high"
  });
  const normalized = normalizeModelSynthesis(parsed, prepared, locale);
  validateModelSynthesis(question, normalized);
  traceRun(runLog, "synthesis_agent_response", {
    platformSummaries: Object.keys(normalized.platformViews || {})
  });
  return normalized;
}

function buildSynthesisMessages(locale, payload) {
  return [
    {
      role: "system",
      content: buildSynthesisSystemPrompt(locale)
    },
    {
      role: "user",
      content: JSON.stringify(payload)
    }
  ];
}

function buildSynthesisAgentPrompt(locale) {
  return localize(locale, {
    zh: [
      "你是 CMP 的 agent synthesis layer。你現在要把多個 AI 平台對同一問題的完整回答做高品質整合。",
      "若問題是中文，全部內容請使用繁體中文，不要使用簡體中文。",
      "你只輸出合法 JSON，不要輸出 markdown fence，也不要輸出任何額外說明。",
      "JSON 結構必須是：",
      '{ "platformViews": { "<platform>": { "summary": string, "keyPoints": string[], "caveats": string } }, "consensus": string[], "majorDifferences": string[], "uniqueAdditions": string[], "directAnswer": string }',
      "硬性要求：",
      "1. 你分析的是答案內容本身，不是模型文風。",
      "2. 必須逐一讀完每個平台的完整回答，再開始整合。",
      "3. consensus 必須寫出真正重疊的 claims / facts / conclusions，不能空泛。",
      "4. majorDifferences 必須點名是哪個平台主張了什麼差異。",
      "5. uniqueAdditions 只保留真正獨特且有價值的補充，必須標明平台。",
      "6. directAnswer 是整個輸出中最核心、最重要的部分，對任何實質性問題至少寫出 700 字以上，建議 1000-1200 字；直接回答原問題，深度整合多平台的論點、具體例子與數據；必要時用 Markdown 小標題與條列，讓 Discord / Telegram 上易讀；這是使用者最重視的部分，請盡力寫好。",
      "7. platformViews 必須是你自己寫的 4-8 句摘要，不可剪貼開頭段落，不可保留 planning/thinking 句。",
      "8. 全部內容必須與使用者問題同語言。",
      "9. 禁止輸出 placeholder、退化說明、未完成說明、UI 殘留說明。",
      "10. 禁止使用模板化句子，例如『主要整理了…這幾個面向』『共同的評估角度包括』『X 的分析明顯偏向』『X 單獨補進了…這條線索』。"
    ].join("\n"),
    ja: [
      "あなたは CMP の agent synthesis layer です。複数 AI の回答内容を高品質に統合してください。",
      "JSON だけを返してください。",
      '{ "platformViews": { "<platform>": { "summary": string, "keyPoints": string[], "caveats": string } }, "consensus": string[], "majorDifferences": string[], "uniqueAdditions": string[], "directAnswer": string }',
      "consensus / majorDifferences / uniqueAdditions は内容比較にすること。directAnswer は最長・最充実で、Discord/Telegram で読みやすい構成にすること。"
    ].join("\n"),
    en: [
      "You are the CMP agent synthesis layer. Produce a high-quality synthesis across multiple AI answers to the same question.",
      "Return valid JSON only.",
      '{ "platformViews": { "<platform>": { "summary": string, "keyPoints": string[], "caveats": string } }, "consensus": string[], "majorDifferences": string[], "uniqueAdditions": string[], "directAnswer": string }',
      "Requirements:",
      "1. Compare answer content, not writing style.",
      "2. Read every usable answer fully before synthesizing.",
      "3. Use concrete details from the answers: claims, examples, criteria, assumptions, and caveats.",
      "4. consensus must capture real overlap, not generic fluff.",
      "5. majorDifferences must identify which platform took which position.",
      "6. uniqueAdditions should keep only genuinely distinctive and useful contributions, labeled by platform.",
      "7. directAnswer must be the longest and most important section: write at least 700 words, targeting 1000-1200 words for any non-trivial topic. Directly answer the user's question with depth, drawing concrete reasoning, examples, and insights from all platform answers.",
      "8. Platform summaries must be real summaries, not clipped excerpts or planning text.",
      "9. Match the user's language.",
      "10. Never output template phrases such as 'organizes the answer around', 'common evaluation lenses', or similar fill-in-the-blank wording."
    ].join("\n")
  });
}

function buildPlatformSummaryAgentPrompt(locale) {
  return localize(locale, {
    zh: [
      "你要把單一平台的回答整理成可讀、可信、非截斷式的摘要。",
      "若問題是中文，全部內容請使用繁體中文，不要使用簡體中文。",
      "只輸出 JSON：{\"summary\": string, \"keyPoints\": string[], \"caveats\": string}",
      "summary 要是 2-4 句歸納摘要。",
      "keyPoints 最多 3 點，保留真正重要的結論、依據、前提或例子。",
      "caveats 只在必要時填寫。",
      "全部使用與問題相同的語言。"
    ].join("\n"),
    ja: [
      "単一プラットフォームの回答を、切り貼りではなく要約として整理してください。",
      "JSON のみ: {\"summary\": string, \"keyPoints\": string[], \"caveats\": string}",
      "summary は 2-4 文、keyPoints は最大3点。"
    ].join("\n"),
    en: [
      "Summarize one platform answer into a readable, faithful, non-clipped summary.",
      "Return JSON only: {\"summary\": string, \"keyPoints\": string[], \"caveats\": string}",
      "summary should be 2-4 real summary sentences.",
      "keyPoints should keep the most important conclusions, criteria, assumptions, or examples.",
      "Use the same language as the user question."
    ].join("\n")
  });
}

async function generatePlatformSummaryModel(question, locale, entry, runLog) {
  let parsed;
  try {
    parsed = await runAgentJsonTask({
      prompt: buildPlatformSummaryAgentPrompt(locale),
      input: {
        question,
        platform: entry.name,
        answer: entry.answer
      },
      timeoutMs: 90000,
      maxTokens: 700,
      thinkLevel: "medium"
    });
    traceRun(runLog, "platform_summary_agent_used", { platform: entry.platform });
  } catch (error) {
    traceRun(runLog, "platform_summary_agent_failed", {
      platform: entry.platform,
      error: toErrorMessage(error)
    });
    const raw = await runGatewayChatCompletion({
      messages: [
        {
          role: "system",
          content: buildPlatformSummaryAgentPrompt(locale)
        },
        {
          role: "user",
          content: JSON.stringify({
            question,
            platform: entry.name,
            answer: entry.answer
          })
        }
      ],
      temperature: 0.2,
      max_tokens: 700
    });
    parsed = parseStructuredJson(extractChatCompletionText(raw));
  }
  return {
    summary: compactWhitespace(parsed?.summary || ""),
    keyPoints: normalizeStringArray(parsed?.keyPoints, []).slice(0, 3),
    caveats: compactWhitespace(parsed?.caveats || "")
  };
}

function buildSynthesisSystemPrompt(locale) {
  return localize(locale, {
    zh: [
      "你是 cmp 的最終整合層。你會看到同一個使用者問題，以及多個 AI 平台對這個問題的已清理答案。",
      "若問題是中文，全部內容請使用繁體中文，不要使用簡體中文。",
      "你的任務不是評價哪個模型更好，而是比較這些答案本身，並幫使用者得到更完整、更平衡的答案。",
      "你會另外看到不可用平台的簡短失敗資訊。那些資訊只能用於安靜地交代缺席來源，不能主導主文。",
      "請只輸出 JSON，不要加 markdown、程式碼區塊或額外說明。",
      "JSON 結構必須是：",
      "{",
      '  "platformViews": {',
      '    "<platform>": { "summary": string, "keyPoints": string[], "caveats": string }',
      "  },",
      '  "consensus": string[],',
      '  "majorDifferences": string[],',
      '  "uniqueAdditions": string[],',
      '  "directAnswer": string',
      "}",
      "要求：",
      "1. summary 必須是真正的摘要，不是原文截斷。",
      "2. keyPoints 每個平台最多 3 點，保留關鍵結論、排名、候選項或前提。",
      "3. consensus / majorDifferences / uniqueAdditions 必須比較答案內容，而不是比較模型長短或風格。",
      "4. directAnswer 要直接回應使用者原始問題，吸收多平台共同資訊與合理差異。",
      "5. directAnswer 必須是五個區段裡最重要、最長、最完整的核心回答；對任何實質性問題至少 700 字，建議 1000 字以上；必要時用 markdown 小標題與條列，讓 Discord / Telegram 上易讀；這是整個 synthesis 的核心輸出，必須詳盡充實。",
      "6. 如果某平台答案較弱但仍可用，要在 caveats 裡低調說明，不要讓主文被失敗狀態淹沒。",
      "7. consensus / majorDifferences / uniqueAdditions 必須引用答案細節，不要空泛地說『都差不多』。",
      "8. majorDifferences 與 uniqueAdditions 都應盡量點名是哪個平台提出了什麼觀點。",
      "9. 禁止輸出任何『未完成』『退化輸出』『保底資訊』之類的占位句。",
      "10. 禁止使用模板化句子，例如『主要整理了…這幾個面向』『共同的評估角度包括』『X 的分析明顯偏向』『X 單獨補進了…這條線索』。",
      "11. 全部內容使用與問題相同的語言。"
    ].join("\n"),
    ja: [
      "あなたは cmp の最終統合レイヤーです。同じユーザー質問に対する複数 AI の回答を比較し、より良い統合回答を作ります。",
      "モデルの優劣ではなく、回答内容の共通点・差分・補足価値を整理してください。",
      "使えないプラットフォームの簡易失敗情報も渡されますが、それは主文ではなく補助情報です。",
      "JSON のみを出力し、markdown やコードフェンスは使わないでください。",
      "JSON 構造:",
      '{ "platformViews": { "<platform>": { "summary": string, "keyPoints": string[], "caveats": string } }, "consensus": string[], "majorDifferences": string[], "uniqueAdditions": string[], "directAnswer": string }',
      "summary は要約であり切り貼りではないこと。keyPoints は最大3点。主文は失敗情報に支配されないこと。内容は質問と同じ言語で書くこと。"
    ].join("\n"),
    en: [
      "You are the final synthesis layer for cmp.",
      "You will receive one user question, several cleaned usable answers, and compact metadata for failed or unusable platforms.",
      "Your job is to compare the substance of the usable answers and produce a better combined answer for the user.",
      "Do not let failure metadata dominate the response. It belongs in caveats or footer-style phrasing, not the main substance.",
      "Return JSON only. No markdown, no code fences, no extra commentary.",
      "Required JSON schema:",
      '{ "platformViews": { "<platform>": { "summary": string, "keyPoints": string[], "caveats": string } }, "consensus": string[], "majorDifferences": string[], "uniqueAdditions": string[], "directAnswer": string }',
      "Rules:",
      "1. Each platform summary must be a real summary, not a clipped fragment.",
      "2. keyPoints should keep important ranked items, recurring candidates, caveats, or criteria.",
      "3. consensus / majorDifferences / uniqueAdditions must compare answer content, not writing style.",
      "4. directAnswer must answer the original user question more usefully than any single platform response — synthesize the best reasoning and concrete details from all platforms.",
      "5. directAnswer is the most important output: write at least 700 words, targeting 1000+ words for any non-trivial question. Use markdown-friendly subheadings, bullet lists, and bold text so it reads well in Discord and Telegram. This is what the user cares about most — be thorough.",
      "6. Use caveats only for meaningful limitations or weak-input notes.",
      "7. consensus / majorDifferences / uniqueAdditions must use concrete answer details rather than generic filler.",
      "8. majorDifferences and uniqueAdditions should identify which platform contributed which idea whenever possible.",
      "9. Never output placeholder phrases about degraded or incomplete synthesis.",
      "10. Use the same language as the user question."
    ].join("\n")
  });
}

function extractChatCompletionText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((item) => item?.text || item?.content || "").join("").trim();
  }
  throw new Error("Missing chat completion content.");
}

function parseStructuredJson(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Model synthesis did not return JSON.");
  }
  return JSON.parse(match[0]);
}

function normalizeModelSynthesis(parsed, platforms, locale) {
  const platformSet = new Set(platforms.map((entry) => entry.platform));
  const aliases = new Map();
  for (const entry of platforms) {
    aliases.set(entry.platform.toLowerCase(), entry.platform);
    aliases.set(String(entry.name || "").toLowerCase(), entry.platform);
  }
  const summaries = {};
  for (const [platform, value] of Object.entries(parsed?.platformViews || {})) {
    const resolvedPlatform = aliases.get(String(platform || "").toLowerCase()) || platform;
    if (!platformSet.has(resolvedPlatform)) continue;
    summaries[resolvedPlatform] = {
      summary: compactWhitespace(value?.summary || ""),
      keyPoints: normalizeStringArray(value?.keyPoints, []).slice(0, 3),
      caveats: compactWhitespace(value?.caveats || "")
    };
  }
  return {
    platformViews: summaries,
    consensus: normalizeStringArray(parsed?.consensus ?? parsed?.sharedThemes, []),
    majorDifferences: normalizeStringArray(parsed?.majorDifferences, []),
    uniqueAdditions: normalizeStringArray(parsed?.uniqueAdditions, []),
    directAnswer: compactWhitespacePreservingLines(parsed?.directAnswer || ""),
    mode: "model"
  };
}

function validateModelSynthesis(question, synthesis) {
  const sections = [
    ...(synthesis?.consensus || []),
    ...(synthesis?.majorDifferences || []),
    ...(synthesis?.uniqueAdditions || []),
    synthesis?.directAnswer || "",
    ...Object.values(synthesis?.platformViews || {}).flatMap((entry) => [entry?.summary || "", ...(entry?.keyPoints || []), entry?.caveats || ""])
  ].filter(Boolean);
  const combined = sections.join("\n");
  if (!combined.trim()) {
    throw new Error("Synthesis model returned empty content.");
  }
  for (const pattern of FORBIDDEN_SYNTHESIS_PATTERNS) {
    if (pattern.test(combined)) {
      throw new Error(`Synthesis model returned forbidden template text: ${pattern}`);
    }
  }
  if (!(synthesis?.consensus || []).length || !(synthesis?.majorDifferences || []).length || !(synthesis?.platformViews && Object.keys(synthesis.platformViews).length)) {
    throw new Error("Synthesis model omitted required sections.");
  }
  const directAnswer = compactWhitespace(synthesis?.directAnswer || "");
  if (!directAnswer || directAnswer.length < (String(question || "").length > 20 ? 500 : 250)) {
    throw new Error("Synthesis direct answer is too short.");
  }
}

function normalizeStringArray(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.map((item) => compactWhitespace(item)).filter(Boolean);
  return cleaned.length ? cleaned : fallback;
}

function isPartialSummary(summary) {
  const text = compactWhitespace(`${summary?.summary || ""} ${summary?.caveats || ""}`);
  if (!text) return true;
  return /(no usable content|incomplete|placeholder|ui\/history dump|history dump|cannot draw|no substantive|snippet is incomplete|provided snippet|雜訊|不完整|片段|無法抽取完整|占位|履歷|歷史記錄|メニュー履歴|不完全)/i.test(text);
}

function buildAnswerStance(text, question, tags, locale) {
  const cleaned = compactWhitespace(text);
  const listSummary = summarizeStructuredAnswer(cleaned, locale);
  if (listSummary) return summarizePlainTextForTransport(listSummary, 220);
  if (/compare|比較|区别|差異|difference/i.test(question || "") && tags.length) {
    return localize(locale, {
      zh: `主要從 ${tags.slice(0, 3).map((tag) => localizeTag(tag, "zh")).join("、")} 來比較這個問題。`,
      ja: `${tags.slice(0, 3).map((tag) => localizeTag(tag, "ja")).join("、")} を軸に比較している。`,
      en: `Compares the question mainly through ${tags.slice(0, 3).map((tag) => localizeTag(tag, "en")).join(", ")}.`
    });
  }
  return summarizePlainTextForTransport(firstMeaningfulSentence(cleaned), 220);
}

function summarizeStructuredAnswer(text, locale) {
  const points = extractStructuredPoints(text);
  if (points.length >= 2) {
    return localize(locale, {
      zh: `回答主要沿著 ${points.slice(0, 3).join("、")} 這些軸線展開。`,
      ja: `${points.slice(0, 3).join("、")} という観点で整理している。`,
      en: `Organizes the answer around ${points.slice(0, 3).join(", ")}.`
    });
  }
  return "";
}

function extractStructuredPoints(text) {
  const candidates = [];
  for (const raw of text.split(/\n|(?=\d+[.)]\s)|(?=•\s)|(?=[-*]\s)/)) {
    const line = compactWhitespace(raw.replace(/^\d+[.)]\s*/, "").replace(/^[-*•]\s*/, ""));
    if (!line) continue;
    const snippet = line.split(/[：:，,。.!?]/)[0].trim();
    if (snippet.length < 2 || snippet.length > 28) continue;
    if (/^(here|以下|this|these|there are|three points|三點|comparison|比較)$/i.test(snippet)) continue;
    if (!candidates.includes(snippet)) candidates.push(snippet);
  }
  return candidates.slice(0, 4);
}

function firstMeaningfulSentence(text) {
  const sentences = String(text || "").split(/(?<=[。.!?])\s+/);
  for (const sentence of sentences) {
    const cleaned = compactWhitespace(sentence);
    if (!cleaned) continue;
    if (/^(here('|’)s|以下|這裡|下面|sure|當然|當然可以)/i.test(cleaned)) continue;
    return cleaned;
  }
  return firstSentence(text);
}

function normalizeNamedItem(value) {
  let normalized = compactWhitespace(String(value || ""));
  normalized = normalized.replace(/\bGPT[-\s]?5\s+GPT\b/i, "GPT-5");
  normalized = normalized.replace(/\bDeepSeek\s+Why\b/i, "DeepSeek R1");
  normalized = normalized.replace(/\bGemini\s+3\s+Pro\b/i, "Gemini 3 Pro");
  normalized = normalized.replace(/\bGPT[-\s]?(\d+(?:\.\d+)?)\s+/i, "GPT-$1 ");
  normalized = normalized.replace(/\s+/g, " ").trim();
  if (/^(Gemini|Claude|Grok)$/i.test(normalized)) return normalized[0].toUpperCase() + normalized.slice(1).toLowerCase();
  return normalized;
}

function dedupeNamedItems(items) {
  const specific = new Set(items);
  return items.filter((item) => {
    if (/^(Opus|Sonnet)\s/i.test(item)) {
      return !specific.has(`Claude ${item}`);
    }
    if (/^Claude$/i.test(item)) {
      return !items.some((candidate) => /^Claude\s+(Opus|Sonnet)\s/i.test(candidate));
    }
    return true;
  });
}

function localizeTag(tag, locale) {
  const labels = {
    benchmarks: { zh: "基準測試/排行榜", ja: "ベンチマーク/ランキング", en: "benchmarks/leaderboards" },
    multimodal: { zh: "多模態能力", ja: "マルチモーダル能力", en: "multimodal capability" },
    coding: { zh: "程式/開發", ja: "コード/開発", en: "coding/development" },
    context: { zh: "長上下文", ja: "長いコンテキスト", en: "long context" },
    pricing: { zh: "價格/性價比", ja: "価格/コスパ", en: "pricing/value" },
    caveats: { zh: "條件與前提", ja: "前提や留保", en: "caveats/assumptions" },
    "use cases": { zh: "使用情境", ja: "ユースケース", en: "use cases" },
    syntax: { zh: "語法與上手難度", ja: "文法と学習しやすさ", en: "syntax/learning curve" },
    runtime: { zh: "執行環境", ja: "実行環境", en: "runtime environment" },
    ecosystem: { zh: "生態與工具鏈", ja: "エコシステムとツール群", en: "ecosystem/tooling" },
    performance: { zh: "效能與速度", ja: "性能と速度", en: "performance/speed" }
  };
  return labels[tag]?.[locale] || labels[tag]?.en || tag;
}

function buildConsensus(successful, locale) {
  if (!successful.length) {
    return [localize(locale, {
      zh: "沒有可用回應。",
      ja: "利用できる応答がありません。",
      en: "No successful responses."
    })];
  }
  if (successful.length === 1) {
    return [localize(locale, {
      zh: `目前只有 ${successful[0].name} 成功回應，因此沒有交叉共識。`,
      ja: `${successful[0].name} だけが成功したため、比較用の合意点はありません。`,
      en: `Only ${successful[0].name} responded successfully, so there is no cross-platform consensus yet.`
    })];
  }
  const firstSentences = successful.map((entry) => firstSentence(entry.responseText).toLowerCase());
  const allSame = firstSentences.every((item) => similarity(item, firstSentences[0]) >= 0.65);
  if (allSame) {
    return [localize(locale, {
      zh: "成功的平台給出的核心結論高度一致。",
      ja: "成功したプラットフォームの主要結論はかなり一致しています。",
      en: "The successful platforms converged on a very similar core answer."
    })];
  }
  return [localize(locale, {
    zh: "多數平台都直接回答了同一個核心問題，但細節和排序有所不同。",
    ja: "大半のプラットフォームは同じ核心質問に答えましたが、詳細や優先順位には差があります。",
    en: "Most platforms answered the same core question directly, but the details and prioritization differ."
  })];
}

function buildDisagreements(successful, locale) {
  if (successful.length < 2) {
    return [localize(locale, {
      zh: "沒有足夠的成功回應可供比較。",
      ja: "比較できる成功応答が十分にありません。",
      en: "Not enough successful responses to compare."
    })];
  }
  const longest = [...successful].sort((a, b) => b.responseText.length - a.responseText.length)[0];
  const shortest = [...successful].sort((a, b) => a.responseText.length - b.responseText.length)[0];
  if (longest.platform === shortest.platform && successful.length > 1) {
    return [localize(locale, {
      zh: "目前差異不明顯，主要差在措辭而不是結論。",
      ja: "現時点では違いは小さく、結論より表現の差が中心です。",
      en: "The differences are minor so far and mostly about phrasing rather than conclusions."
    })];
  }
  return [localize(locale, {
    zh: `${longest.name} 的回答最完整，而 ${shortest.name} 的回答較精簡。`,
    ja: `${longest.name} は最も詳しく、${shortest.name} はより簡潔でした。`,
    en: `${longest.name} gave the most detailed answer, while ${shortest.name} was more concise.`
  })];
}

function buildUniqueInsights(successful, locale) {
  if (!successful.length) {
    return [localize(locale, {
      zh: "沒有可提取的獨特觀點。",
      ja: "抽出できる固有の観点はありません。",
      en: "No unique insights available."
    })];
  }
  const richest = [...successful].sort((a, b) => richnessScore(b.responseText) - richnessScore(a.responseText))[0];
  return [localize(locale, {
    zh: `${richest.name} 提供了目前最具細節的版本。`,
    ja: `${richest.name} が最も具体的な回答を出しました。`,
    en: `${richest.name} provided the most detailed version of the answer.`
  })];
}

function buildAssessment(successful, locale) {
  if (!successful.length) {
    return localize(locale, {
      zh: "這次沒有成功取得任何真實平台回應，請先檢查登入狀態與瀏覽器日誌。",
      ja: "今回は実際のプラットフォーム応答を取得できませんでした。ログイン状態とブラウザログを確認してください。",
      en: "No real platform response was collected. Check the managed browser sessions and debug log."
    });
  }
  const best = [...successful].sort((a, b) => richnessScore(b.responseText) - richnessScore(a.responseText))[0];
  return localize(locale, {
    zh: `若只看單一回答，${best.name} 這次資訊密度最高、結構也最完整；但最穩妥的做法仍是把它當主幹，再用其他成功平台補齊限制條件與反向觀點。`,
    ja: `${best.name} は今回もっとも情報密度と構造が高かったが、最も堅実なのはそれを土台にしつつ、他の成功回答で条件や反対側の視点を補うことです。`,
    en: `${best.name} was the densest and most structured single answer this round, but the safest use is still to treat it as the backbone and cross-check its limits with the other successful platforms.`
  });
}

function firstSentence(text) {
  const cleaned = compactWhitespace(text);
  const match = cleaned.match(/(.+?[.!?。！？])(\s|$)/);
  return match ? match[1] : summarizePlainTextForTransport(cleaned, 160);
}

function richnessScore(text) {
  const cleaned = compactWhitespace(text);
  const lineBreaks = (text.match(/\n/g) || []).length;
  const bullets = (text.match(/^-|\d+\./gm) || []).length;
  return cleaned.length + lineBreaks * 40 + bullets * 60;
}

function similarity(left, right) {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  const union = new Set([...a, ...b]);
  if (!union.size) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / union.size;
}

function tokenize(text) {
  return compactWhitespace(text)
    .toLowerCase()
    .split(/[^a-z0-9\u3400-\u9fff]+/u)
    .filter(Boolean);
}

function detectLocale(text) {
  if (/[\u3040-\u30ff]/u.test(text)) return "ja";
  if (/[\u3400-\u9fff]/u.test(text)) return "zh";
  return "en";
}

function localize(locale, values) {
  return values[locale] || values.en;
}

function truncate(text, max) {
  const cleaned = String(text || "");
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}...` : cleaned;
}

function compactWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function compactWhitespacePreservingLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trimEnd())
    .join("\n")
    .trim();
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripPlatformPrefix(text, platformName) {
  return String(text || "").replace(new RegExp(`^${escapeRegExp(platformName)}:\\s*`, "i"), "");
}

function addRunStep(runLog, platform, step) {
  const target = runLog.platforms.find((entry) => entry.platform === platform);
  if (!target) return;
  target.steps = target.steps || [];
  target.steps.push(step);
}

function traceRun(runLog, event, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    event,
    ...details
  };
  runLog.traces.push(entry);
  logTrace(event, details);
}

function logTrace(event, details = {}) {
  const logger = cmpLogger || console;
  const line = `[cmp] ${event} ${JSON.stringify(details)}`;
  if (typeof logger.info === "function") {
    logger.info(line);
    return;
  }
  if (typeof logger.log === "function") {
    logger.log(line);
  }
}

function summarizeContext(ctx) {
  if (!ctx || typeof ctx !== "object") return {};
  const summary = { keys: Object.keys(ctx).sort() };
  const fields = [
    "channel",
    "channelId",
    "guildId",
    "account",
    "accountId",
    "sender",
    "senderId",
    "target",
    "targetId",
    "transport",
    "threadId"
  ];
  for (const field of fields) {
    const value = ctx[field];
    if (value == null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      summary[field] = value;
    }
  }
  return summary;
}

async function persistRunLog(payload) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.writeFile(LAST_RUN_LOG, JSON.stringify(payload, null, 2), "utf8");
  const line = `${new Date().toISOString()} ${JSON.stringify({
    question: payload.question,
    enabledPlatforms: payload.enabledPlatforms,
    statuses: payload.platforms?.map((entry) => ({
      platform: entry.platform,
      status: entry.status,
      completion: entry.completion || null,
      responseLength: typeof entry.responseText === "string" ? entry.responseText.length : null,
      failure: entry.failure || null
    }))
  })}\n`;
  await fs.appendFile(RUN_LOG, line, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runCommand(file, args, options = {}) {
  if (file === "openclaw" && Array.isArray(args) && args[0] === "browser") {
    return await runBrowserCommand(args.slice(1), options);
  }
  const { json = false, timeoutMs = 30000 } = options;
  const stdout = [];
  const stderr = [];
  const command = buildShellCommand(file, args);
  const child = spawn("/bin/zsh", ["-lc", command], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });

  const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
  const stderrText = Buffer.concat(stderr).toString("utf8").trim();

  if (exitCode !== 0) {
    throw new Error(stderrText || stdoutText || `${command} failed`);
  }

  if (!json) return stdoutText;
  return parseJsonOutput(stdoutText);
}

async function runBrowserCommand(args, options = {}) {
  const { json = false, timeoutMs = 30000 } = options;
  const cfg = await readJson(OPENCLAW_CONFIG_PATH);
  const gatewayPort = Number(cfg?.gateway?.port || 18789);
  const controlPort = Number(cfg?.browser?.controlPort || gatewayPort + 2);
  const token = cfg?.gateway?.auth?.token || cfg?.gateway?.remote?.token || "";
  const baseUrl = `http://127.0.0.1:${controlPort}`;
  await ensureBrowserControlServer(baseUrl);
  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "status":
      return await browserRequest({
        baseUrl,
        token,
        method: "GET",
        path: "/",
        timeoutMs,
        json
      });
    case "start":
      return await browserRequest({
        baseUrl,
        token,
        method: "POST",
        path: "/start",
        body: {},
        timeoutMs,
        json
      });
    case "open":
      return await browserRequest({
        baseUrl,
        token,
        method: "POST",
        path: "/tabs/open",
        body: { url: rest[0] },
        timeoutMs,
        json
      });
    case "focus":
      browserCurrentTargetId = rest[0] || null;
      return await browserRequest({
        baseUrl,
        token,
        method: "POST",
        path: "/tabs/focus",
        body: { targetId: rest[0] },
        timeoutMs,
        json
      });
    case "tabs":
      return await browserRequest({
        baseUrl,
        token,
        method: "GET",
        path: "/tabs",
        timeoutMs,
        json
      });
    case "close":
      return await browserRequest({
        baseUrl,
        token,
        method: "DELETE",
        path: `/tabs/${encodeURIComponent(rest[0])}`,
        timeoutMs,
        json
      });
    case "snapshot": {
      const query = {};
      if (browserCurrentTargetId) query.targetId = browserCurrentTargetId;
      if (rest.includes("--efficient")) query.mode = "efficient";
      const format = readArgValue(rest, "--format");
      const limit = readArgValue(rest, "--limit");
      if (format) query.format = format;
      if (limit) query.limit = limit;
      return await browserRequest({
        baseUrl,
        token,
        method: "GET",
        path: "/snapshot",
        query,
        timeoutMs,
        json
      });
    }
    case "wait": {
      const body = { kind: "wait" };
      if (browserCurrentTargetId) body.targetId = browserCurrentTargetId;
      const load = readArgValue(rest, "--load");
      const fn = readArgValue(rest, "--fn");
      const timeout = readArgValue(rest, "--timeout");
      if (load) body.loadState = load;
      if (fn) body.fn = fn;
      if (timeout) body.timeoutMs = Number(timeout);
      return await browserRequest({
        baseUrl,
        token,
        method: "POST",
        path: "/act",
        body,
        timeoutMs,
        json
      });
    }
    case "click":
      return await browserRequest({
        baseUrl,
        token,
        method: "POST",
        path: "/act",
        body: { kind: "click", ref: rest[0], ...(browserCurrentTargetId ? { targetId: browserCurrentTargetId } : {}) },
        timeoutMs,
        json
      });
    case "type":
      return await browserRequest({
        baseUrl,
        token,
        method: "POST",
        path: "/act",
        body: { kind: "type", ref: rest[0], text: rest[1] || "", ...(browserCurrentTargetId ? { targetId: browserCurrentTargetId } : {}) },
        timeoutMs,
        json
      });
    case "press":
      return await browserRequest({
        baseUrl,
        token,
        method: "POST",
        path: "/act",
        body: { kind: "press", key: rest[0], ...(browserCurrentTargetId ? { targetId: browserCurrentTargetId } : {}) },
        timeoutMs,
        json
      });
    case "evaluate": {
      const fn = readArgValue(rest, "--fn");
      const ref = readArgValue(rest, "--ref");
      return await browserRequest({
        baseUrl,
        token,
        method: "POST",
        path: "/act",
        body: { kind: "evaluate", fn, ...(ref ? { ref } : {}), ...(browserCurrentTargetId ? { targetId: browserCurrentTargetId } : {}) },
        timeoutMs,
        json
      });
    }
    default:
      throw new Error(`Unsupported browser command in cmp runtime: ${command}`);
  }
}

async function ensureBrowserControlServer(baseUrl) {
  if (await isBrowserControlReachable(baseUrl)) return;
  if (!browserControlServerBootPromise) {
    browserControlServerBootPromise = startBrowserControlServer().finally(() => {
      browserControlServerBootPromise = null;
    });
  }
  await browserControlServerBootPromise;
  if (!await isBrowserControlReachable(baseUrl)) {
    throw new Error(`Managed browser control is not reachable at ${baseUrl}. ${managedBrowserHelpText()}`);
  }
}

async function isBrowserControlReachable(baseUrl) {
  try {
    await fetch(`${baseUrl}/`, { method: "GET" });
    return true;
  } catch {
    return false;
  }
}

async function startBrowserControlServer() {
  const modulePath = await resolveOpenClawDistModule("server-lGbSgrJu.js");
  if (!modulePath) return;
  const mod = await import(pathToFileURL(modulePath).href);
  if (typeof mod?.startBrowserControlServerFromConfig !== "function") return;
  await mod.startBrowserControlServerFromConfig();
}

async function resolveOpenClawDistModule(fileName) {
  const candidates = [];
  if (process.argv[1]) candidates.push(path.join(path.dirname(process.argv[1]), fileName));
  candidates.push(path.join("/opt/homebrew/lib/node_modules/openclaw/dist", fileName));
  candidates.push(path.join("/usr/local/lib/node_modules/openclaw/dist", fileName));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

async function browserRequest(params) {
  const {
    baseUrl,
    token,
    method,
    path,
    query,
    body,
    timeoutMs,
    json
  } = params;
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(params.extraHeaders || {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `${method} ${url.pathname} failed with ${response.status}`);
    }
    if (!json) return text;
    return parseJsonOutput(text);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Timed out after ${timeoutMs}ms: ${method} ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runGatewayChatCompletion(body) {
  /*
   * OpenClaw updates broke both built-in synthesis paths for CMP:
   * 1) runEmbeddedPiAgent resolves to anthropic on this host and fails without an Anthropic key.
   * 2) the local Gateway /v1/chat/completions route now rejects CMP's bearer token with missing scope: operator.write.
   *
   * CMP therefore bypasses the local Gateway for synthesis and talks directly to GitHub Copilot's
   * OpenAI-compatible API using the owner's existing GitHub Copilot auth profile.
   * Primary: gpt-4.1 (better instruction following and long-form generation than gpt-4o)
   * Fallback chain: gpt-4o → gpt-5-mini
   * All three are free/flat-rate under the GitHub Copilot subscription — use them generously.
   *
   * If this breaks after a future OpenClaw update, verify:
   * - ~/.openclaw/agents/main/agent/auth-profiles.json still has github-copilot:github or :default
   * - OpenClaw's dist still exports plugin-sdk/github-copilot-token.js
   * - the resolved Copilot baseUrl still accepts POST /chat/completions
   */
  const runtimeAuth = await resolveCmpCopilotRuntimeAuth();
  const primaryModel = body.model || "gpt-4.1";
  const completionBody = { ...body, model: primaryModel };
  const copilotHeaders = { "Editor-Version": "vscode/1.96.0", "Editor-Plugin-Version": "copilot-chat/0.24.2", "Copilot-Integration-Id": "vscode-chat", "Openai-Intent": "conversation-panel" };
  const makeRequest = async (model) => gatewayRequest({
    baseUrl: runtimeAuth.baseUrl,
    token: runtimeAuth.token,
    path: "/chat/completions",
    body: { ...completionBody, model },
    timeoutMs: 120000,
    extraHeaders: copilotHeaders
  });
  try {
    const response = await makeRequest(primaryModel);
    return { ...response, _cmpMeta: { provider: "github-copilot", model: primaryModel, baseUrl: runtimeAuth.baseUrl, tokenSource: runtimeAuth.source || "resolved" } };
  } catch (primaryError) {
    const fallbackModels = ["gpt-4o", "gpt-5-mini"].filter((m) => m !== primaryModel);
    let lastError = primaryError;
    for (const fallbackModel of fallbackModels) {
      try {
        const response = await makeRequest(fallbackModel);
        return { ...response, _cmpMeta: { provider: "github-copilot", model: fallbackModel, baseUrl: runtimeAuth.baseUrl, tokenSource: runtimeAuth.source || "resolved", primaryError: toErrorMessage(primaryError) } };
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`GitHub Copilot synthesis failed for all models (${[primaryModel, ...fallbackModels].join(", ")}). Last error: ${toErrorMessage(lastError)}`);
  }
}

function buildClaudeDirectAnswerSystemPrompt(locale) {
  return localize(locale, {
    zh: [
      "你是 CMP 的最終答案合成專家。你的唯一任務是撰寫「最佳綜合答案」（Best Combined Answer）。",
      "你已經看到多個 AI 平台對同一問題的完整回答。你必須以這些平台回答為素材，寫出一個比任何單一平台都更深入、更完整、更有價值的答案。",
      "若問題是中文，全部內容請使用繁體中文，不要使用簡體中文。",
      "硬性要求：",
      "1. 至少寫 800 字，建議 1000-1500 字。篇幅是你給予使用者深度的承諾，不要縮水。",
      "2. 以專家身份直接回答使用者的問題，不要說「A平台說…」「根據各平台回答」之類的話。",
      "3. 從所有平台回答中抽取最有價值的具體資訊、數據、推理鏈、例子和見解，整合成一個連貫、有深度的答案。",
      "4. 使用 Markdown 小標題（如 **一、背景分析** 或 **## 核心結論**）、條列清單、粗體重點，讓結構清晰、易讀。",
      "5. 不要只是列點羅列各平台的觀點，要做真正的整合——找出最強的論點，解釋為什麼某些觀點更有說服力，補充各平台沒有說清楚的部分。",
      "6. 不要輸出 JSON，只輸出純文字答案。",
      "7. 不要用模板化開頭，例如「以下是綜合分析」「綜合多平台回答」。直接進入核心內容。",
      "8. 如果有平台沒有成功回答，忽略它，基於成功的平台回答來寫。"
    ].join("\n"),
    ja: [
      "あなたは CMP の最終回答合成専門家です。唯一のタスクは「最良の統合回答（Best Combined Answer）」を書くことです。",
      "複数 AI プラットフォームの完全な回答を素材に、どの単一プラットフォームよりも深く、完全で、価値ある回答を書いてください。",
      "要件：",
      "1. 少なくとも 800 字、推奨 1000-1500 字。",
      "2. 専門家として直接回答する。プラットフォーム比較の言い回しを避ける。",
      "3. すべての回答から最も価値ある具体的情報、例、推論を抽出し、一貫した深い回答に統合する。",
      "4. Markdown の小見出し、箇条書き、太字を使い、Discord/Telegram で読みやすくする。",
      "5. JSON ではなく純テキストで回答する。テンプレート的な書き出しを避ける。"
    ].join("\n"),
    en: [
      "You are the CMP final answer synthesis expert. Your sole task is to write the Best Combined Answer.",
      "You have the full answers from multiple AI platforms to the same question. Use these as raw material to write an answer that is more thorough, insightful, and useful than any single platform's response.",
      "Requirements:",
      "1. Write at least 800 words, targeting 1000-1500 words. Length reflects the depth you give the user — don't cut it short.",
      "2. Write as an expert directly answering the user — avoid phrases like 'Platform X says' or 'According to the platform answers'.",
      "3. Extract the most valuable concrete information, data, reasoning chains, examples, and insights from all platform answers and integrate them into a coherent, in-depth response.",
      "4. Use Markdown subheadings, bullet lists, and bold text to make the answer well-structured and readable in Discord/Telegram.",
      "5. Don't just list each platform's points in sequence — do real synthesis: identify the strongest arguments, explain why some positions are more convincing, fill gaps that no single platform addressed.",
      "6. Output plain text only, not JSON.",
      "7. Do not use templated openings like 'Here is a comprehensive analysis' or 'Based on the platform answers'. Jump straight into the substance.",
      "8. If a platform failed to answer, ignore it and base your answer on the successful ones."
    ].join("\n")
  });
}

async function generateClaudeDirectAnswer(question, locale, prepared, unusable, runLog) {
  traceRun(runLog, "claude_direct_answer_start", { platformCount: prepared.length });
  const systemPrompt = buildClaudeDirectAnswerSystemPrompt(locale);
  const userContent = JSON.stringify({
    question,
    platforms: prepared.map((e) => ({ name: e.name, answer: e.answer })),
    unavailable: (unusable || []).map((e) => ({ name: e.name, reason: e.reason }))
  });
  // Use gpt-4.1 via GitHub Copilot (free/flat-rate). Large token budget since there is no per-token cost.
  const raw = await runGatewayChatCompletion({
    model: "gpt-4.1",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent }
    ],
    max_tokens: 8000,
    temperature: 0.3
  });
  const text = extractChatCompletionText(raw);
  const result = compactWhitespacePreservingLines(text.trim());
  traceRun(runLog, "claude_direct_answer_complete", { length: result.length, model: raw?._cmpMeta?.model || "gpt-4.1" });
  return result;
}

async function resolveCmpCopilotRuntimeAuth() {
  const authProfiles = await readJson(AUTH_PROFILES_PATH);
  const profiles = authProfiles?.profiles || {};
  const preferredProfile = profiles["github-copilot:github"] || profiles["github-copilot:default"];
  if (!preferredProfile || typeof preferredProfile !== "object") {
    throw new Error("Missing github-copilot auth profile for CMP synthesis.");
  }
  const githubToken = String(preferredProfile.token || preferredProfile.key || "").trim();
  if (!githubToken) {
    throw new Error("GitHub Copilot auth profile exists but does not contain a usable token/key.");
  }
  const { resolveCopilotApiToken } = await loadCopilotTokenResolver();
  return await resolveCopilotApiToken({ githubToken, env: process.env });
}

async function loadCopilotTokenResolver() {
  if (!copilotTokenResolverPromise) {
    copilotTokenResolverPromise = (async () => {
      const modulePath = await findOpenClawDistFile("plugin-sdk/github-copilot-token.js");
      if (!modulePath) {
        throw new Error("Could not locate OpenClaw github-copilot token helper in the global dist install.");
      }
      return await import(pathToFileURL(modulePath).href);
    })();
  }
  return await copilotTokenResolverPromise;
}

async function findOpenClawDistFile(relativePath) {
  const distRoots = [
    path.dirname(process.argv[1] || ""),
    "/opt/homebrew/lib/node_modules/openclaw/dist",
    "/usr/local/lib/node_modules/openclaw/dist"
  ].filter(Boolean);
  const directCandidates = [
    relativePath,
    "github-copilot-token.js",
    "extensions/github-copilot/token.js"
  ];
  for (const root of distRoots) {
    for (const candidate of directCandidates) {
      const fullPath = path.join(root, candidate);
      try {
        await fs.access(fullPath);
        return fullPath;
      } catch {}
    }
    try {
      const entries = await fs.readdir(root);
      const hashed = entries
        .filter((name) => /^github-copilot-token-.*\.js$/i.test(name))
        .sort()
        .at(-1);
      if (hashed) {
        return path.join(root, hashed);
      }
    } catch {}
  }
  return null;
}

async function runAgentJsonTask({ prompt, input, timeoutMs, maxTokens, thinkLevel }) {
  if (!cmpAgentRuntime?.runEmbeddedPiAgent || !cmpCoreConfig) {
    throw new Error("Embedded agent runtime is not available in the CMP plugin context.");
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cmp-agent-"));
  try {
    const sessionId = `cmp-agent-${Date.now()}`;
    const sessionFile = path.join(tmpDir, "session.json");
    const fullPrompt = [
      "You are a JSON-only function.",
      "Return ONLY a valid JSON value.",
      "Do not wrap the result in markdown fences.",
      "Do not add commentary.",
      "Do not call tools.",
      "",
      "TASK:",
      prompt,
      "",
      "INPUT_JSON:",
      JSON.stringify(input ?? null, null, 2)
    ].join("\n");
    const result = await cmpAgentRuntime.runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      workspaceDir: cmpCoreConfig?.agents?.defaults?.workspace ?? process.cwd(),
      config: { ...cmpCoreConfig, agents: { ...cmpCoreConfig?.agents, defaults: { ...cmpCoreConfig?.agents?.defaults, model: { primary: "github-copilot/gpt-4.1", fallbacks: ["github-copilot/gpt-4o", "github-copilot/gpt-5-mini"] } } } },
      prompt: fullPrompt,
      timeoutMs: timeoutMs || 120000,
      runId: `cmp-agent-${Date.now()}`,
      thinkLevel: thinkLevel || "medium",
      streamParams: {
        maxTokens: maxTokens || 2400,
        temperature: 0.2
      },
      disableTools: true
    });
    const text = collectAgentText(result?.payloads);
    if (!text) throw new Error("Embedded agent returned empty output.");
    return parseStructuredJson(stripCodeFences(text));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function gatewayRequest(params) {
  const { baseUrl, token, path, body, timeoutMs, extraHeaders } = params;
  const url = new URL(path, baseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(extraHeaders || {})
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `POST ${url.pathname} failed with ${response.status}`);
    }
    return parseJsonOutput(text);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Timed out after ${timeoutMs}ms: POST ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function collectAgentText(payloads) {
  return (payloads || [])
    .filter((item) => !item?.isError && typeof item?.text === "string")
    .map((item) => item.text || "")
    .join("\n")
    .trim();
}

function stripCodeFences(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? (match[1] || "").trim() : trimmed;
}

function readArgValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

function buildShellCommand(file, args) {
  return [file, ...args].map(shellQuote).join(" ");
}

function shellQuote(value) {
  const text = String(value);
  if (text === "") return "''";
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

function parseJsonOutput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    const start = Math.min(
      ...["{", "["]
        .map((token) => trimmed.indexOf(token))
        .filter((index) => index >= 0)
    );
    if (Number.isFinite(start) && start >= 0) {
      return JSON.parse(trimmed.slice(start));
    }
    throw new Error(`Unable to parse JSON output: ${trimmed}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
