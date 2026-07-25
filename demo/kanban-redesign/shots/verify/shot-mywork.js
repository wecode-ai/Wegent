const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const base = 'file:///Volumes/OuterHD/OuterIdeaProjects/weibo_wegent/github_wegent/demo/kanban-redesign/my-work.html';
  const out = '/Volumes/OuterHD/OuterIdeaProjects/weibo_wegent/github_wegent/demo/kanban-redesign/shots/verify/';
  for (const view of ['group', 'list', 'calendar', 'timeline']) {
    await page.goto(base);
    await page.waitForTimeout(600);
    await page.click(`[data-switch="${view}"]`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: out + 'my-work-' + view + '.png' });
  }
  await browser.close();
})();
