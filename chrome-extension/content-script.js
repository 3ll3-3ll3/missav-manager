(() => {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = node => {
    if (!node || !node.isConnected) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && node.getClientRects().length > 0;
  };
  const buttonText = button => clean(button?.getAttribute('aria-label') || button?.innerText || button?.textContent);

  function inspectPage() {
    const buttons = [...document.querySelectorAll('button')].filter(isVisible);
    const accountLabel = buttons.map(buttonText).find(text => /^\d{6,20}$/.test(text)) || '';
    const mainButtons = [...document.querySelectorAll('main button')].filter(isVisible);
    const savedButton = mainButtons.find(button => buttonText(button).startsWith('已保存'));
    const saveButton = savedButton || mainButtons.find(button => buttonText(button).startsWith('保存'));
    const codeTerm = [...document.querySelectorAll('main dt')]
      .find(node => /^(代码|番[號号]|code)$/i.test(clean(node.textContent)));
    const bodyText = clean(document.body?.innerText || '').slice(0, 4000);
    const title = clean(document.title).slice(0, 300);
    const rateLimited = /error\s*1015|you are being rate limited|banned you temporarily|temporarily from accessing/i
      .test(`${title} ${bodyText.slice(0, 3000)}`);
    const challenge = !rateLimited && /just a moment|verify you are human|captcha|人机验证|访问验证|安全验证/i
      .test(`${title} ${bodyText.slice(0, 3000)}`);
    const visiblePasswordInput = [...document.querySelectorAll('input[type="password"]')].some(isVisible);
    return {
      url: location.href.slice(0, 800),
      title,
      accountLabel: accountLabel.slice(0, 64),
      loggedOut: visiblePasswordInput || /\/(login|signin)(?:\/|$)/i.test(location.pathname),
      challenge,
      rateLimited,
      heading: clean(document.querySelector('main h1')?.innerText).slice(0, 1000),
      detailCode: clean(codeTerm?.nextElementSibling?.innerText).slice(0, 160),
      saveState: savedButton ? 'saved' : saveButton ? 'save' : '',
    };
  }

  function clickSave() {
    const button = [...document.querySelectorAll('main button')]
      .filter(isVisible)
      .find(node => buttonText(node).startsWith('保存'));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'inspect') {
      sendResponse({ ok: true, snapshot: inspectPage() });
      return;
    }
    if (message?.type === 'click-save') {
      sendResponse({ ok: true, clicked: clickSave() });
    }
  });
})();
