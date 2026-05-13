() => {
  if (window.__cmpActive) return;

  window.__cmpActive = true;
  window.__cmpDone = false;
  window.__cmpText = "";

  var lastLen = 0;
  var stableCount = 0;
  // Quality-first: require a longer stable window so CMP does not treat a
  // temporarily paused stream as "complete" and synthesize too early.
  var STABLE_NEEDED = 6;
  var INTERVAL = 3000;

  function getResponseText() {
    var selectors = [
      '[data-message-author-role="assistant"]',
      '[class*="font-claude"]',
      '[class*="assistant"]',
      '[class*="response"]',
      '[class*="bot-message"]',
      '[class*="ai-message"]',
      "article"
    ];
    var best = "";

    for (var i = 0; i < selectors.length; i++) {
      try {
        var elements = document.querySelectorAll(selectors[i]);
        if (elements.length > 0) {
          var text = (elements[elements.length - 1].innerText || "").trim();
          if (text.length > best.length) best = text;
        }
      } catch (error) {}
    }

    if (best.length < 50) {
      var blocks = document.querySelectorAll("div, section");
      for (var j = 0; j < blocks.length; j++) {
        var blockText = (blocks[j].innerText || "").trim();
        var rect = blocks[j].getBoundingClientRect();
        if (
          blockText.length > best.length &&
          blockText.length > 100 &&
          rect.top > window.innerHeight * 0.15 &&
          rect.left > window.innerWidth * 0.12 &&
          rect.width > window.innerWidth * 0.3
        ) {
          best = blockText;
        }
      }
    }

    return best;
  }

  function hasStopButton() {
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].getAttribute("aria-label") || "") + (buttons[i].innerText || "");
      if (label.toLowerCase().indexOf("stop") !== -1 && buttons[i].offsetParent !== null) {
        return true;
      }
    }
    return false;
  }

  function hasDoneSignals() {
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].getAttribute("aria-label") || "") + (buttons[i].innerText || "");
      var lower = label.toLowerCase();
      if (
        (lower.indexOf("copy") !== -1 ||
          lower.indexOf("regenerate") !== -1 ||
          lower.indexOf("retry") !== -1) &&
        buttons[i].offsetParent !== null
      ) {
        return true;
      }
    }
    return false;
  }

  var timer = setInterval(function () {
    var text = getResponseText();

    if (!hasStopButton() && hasDoneSignals() && text.length > 50) {
      window.__cmpDone = true;
      window.__cmpText = text;
      clearInterval(timer);
      return;
    }

    if (text.length === lastLen && text.length > 50) {
      stableCount++;
    } else {
      stableCount = 0;
    }

    lastLen = text.length;

    if (!hasStopButton() && stableCount >= STABLE_NEEDED) {
      window.__cmpDone = true;
      window.__cmpText = text;
      clearInterval(timer);
    }
  }, INTERVAL);

  setTimeout(function () {
    if (!window.__cmpDone) {
      window.__cmpDone = true;
      window.__cmpText = getResponseText() || "[Timed out]";
      clearInterval(timer);
    }
  }, 180000);
  return true;
}
