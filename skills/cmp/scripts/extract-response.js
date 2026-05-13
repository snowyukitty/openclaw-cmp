() => {
  if (window.__cmpText && window.__cmpText.length > 50) {
    window.__cmpExtracted = window.__cmpText;
    return window.__cmpExtracted;
  }

  var selectors = [
    '[data-message-author-role="assistant"]',
    '[class*="font-claude"]',
    '[class*="assistant"]',
    '[class*="response"]',
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
    var blocks = document.querySelectorAll("div, article, section");
    for (var j = 0; j < blocks.length; j++) {
      var blockText = (blocks[j].innerText || "").trim();
      var rect = blocks[j].getBoundingClientRect();
      if (
        blockText.length > best.length &&
        blockText.length > 100 &&
        rect.left > window.innerWidth * 0.12 &&
        rect.width > window.innerWidth * 0.3
      ) {
        best = blockText;
      }
    }
  }

  window.__cmpExtracted = best || "[Could not extract response]";
  return window.__cmpExtracted;
}
