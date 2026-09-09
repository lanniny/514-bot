import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const input = resolve(root, 'public/experience-preview.html');
const output = resolve(process.argv[2] || `${tmpdir()}/514cc-experience-stage-a-${Date.now()}`);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
let page = await context.newPage();
page.setDefaultTimeout(5000);
const errors = [];
const requests = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', (request) => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
const report = { stage: 'A', kind: 'isolated-interactive-prototype', ok: false, checks: [], layouts: [], screenshots: [], errors, requests, productionExecution: false };

async function check(name, action) {
  await action();
  report.checks.push(name);
  console.log(`PASS ${name}`);
}

async function route(hash) {
  await page.evaluate((value) => { location.hash = value; }, hash);
  await page.waitForFunction((value) => location.hash === value && document.getElementById('work-content').innerHTML.length > 0, hash);
  await page.waitForTimeout(60);
}

async function scene(name) {
  await page.selectOption('#scenario', name);
  await page.waitForTimeout(60);
}

async function layout() {
  return page.evaluate(() => {
    const visible = (element) => !!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const leaves = Array.from(document.querySelectorAll('button,p,h1,h2,h3,label,input,select,textarea,code,.small,.muted')).filter(visible);
    const small = leaves.filter((element) => parseFloat(getComputedStyle(element).fontSize) < 12).map((element) => element.outerHTML.slice(0,160));
    const missingIcons = Array.from(document.querySelectorAll('use')).filter((element) => !document.getElementById(element.getAttribute('href').slice(1))).map((element) => element.getAttribute('href'));
    const controls = ['prompt','send-button','runtime-button','attach-button'];
    const occluded = controls.map((id) => document.getElementById(id)).filter(visible).filter((element) => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !hit || !element.contains(hit) || r.bottom > innerHeight + 1;
    }).map((element) => element.id);
    return { width:innerWidth, height:innerHeight, documentWidth:document.documentElement.scrollWidth, bodyWidth:document.body.scrollWidth, small, missingIcons, occluded };
  });
}

function assertLayout(result, label) {
  assert.ok(result.documentWidth <= result.width + 1, `${label}: document overflow ${result.documentWidth}/${result.width}`);
  assert.ok(result.bodyWidth <= result.width + 1, `${label}: body overflow`);
  assert.deepEqual(result.small, [], `${label}: text below 12px`);
  assert.deepEqual(result.missingIcons, [], `${label}: missing icon assets`);
  assert.deepEqual(result.occluded, [], `${label}: blocked composer controls`);
}

async function screenshot(name) {
  await page.screenshot({ path:resolve(output, name), fullPage:true });
  report.screenshots.push(name);
}

try {
  await page.goto(pathToFileURL(input).href);
  await page.waitForSelector('#work-title');
  await check('initial scene, offline boundary and vendored icons', async () => {
    assert.match(await page.title(), /514cc/);
    assert.match(await page.locator('.preview-label').innerText(), /示例数据.*未连接执行服务/);
    assert.match(await page.locator('#work-status').innerText(), /执行中/);
    assertLayout(await layout(), 'initial');
    assert.equal(await page.locator('.avatar.codex use').getAttribute('href'), '#icon-cli-codex');
    assert.equal(await page.locator('.avatar.claude use').getAttribute('href'), '#icon-cli-claude');
  });
  await check('draft, recipient and refresh remain conversation-scoped', async () => {
    await page.fill('#prompt','保留这段草稿，不发起真实执行');
    await page.selectOption('#recipient','codex');
    await page.click('[data-conversation="review"]');
    await page.waitForFunction(() => document.querySelector('[data-conversation="review"]').getAttribute('aria-current') === 'true');
    assert.equal(await page.inputValue('#prompt'), '');
    await page.fill('#prompt','另一条独立草稿');
    await page.click('[data-conversation="running"]');
    await page.waitForFunction(() => document.querySelector('[data-conversation="running"]').getAttribute('aria-current') === 'true');
    assert.equal(await page.inputValue('#prompt'),'保留这段草稿，不发起真实执行');
    assert.equal(await page.inputValue('#recipient'),'codex');
    await page.reload();
    assert.equal(await page.inputValue('#prompt'),'保留这段草稿，不发起真实执行');
  });
  await check('view tabs, keyboard navigation and browser history', async () => {
    await page.focus('#tab-conversation');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('#tab-process').getAttribute('aria-selected') === 'true');
    assert.equal(await page.locator('#tab-process').evaluate((el) => el === document.activeElement),true);
    await page.click('summary');
    assert.equal(await page.locator('details').getAttribute('open'),'');
    await page.keyboard.press('Tab');
    await page.click('#tab-results');
    await page.waitForFunction(() => document.querySelector('#tab-results').getAttribute('aria-selected') === 'true');
    assert.match(await page.locator('#work-content').innerText(),/尚无可审阅成果/);
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('#tab-process').getAttribute('aria-selected') === 'true');
    assert.equal(await page.locator('#tab-process').getAttribute('aria-selected'),'true');
  });
  await check('side panel drag and keyboard resize', async () => {
    const handle = await page.locator('#splitter').boundingBox();
    await page.mouse.move(handle.x+2,handle.y+180);
    await page.mouse.down();
    await page.mouse.move(302,handle.y+180,{steps:8});
    await page.mouse.up();
    assert.equal(await page.locator('#splitter').getAttribute('aria-valuenow'),'302');
    const after = await page.locator('.sidebar').boundingBox();
    assert.ok(Math.abs(after.width-302)<2);
    await page.focus('#splitter');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#splitter').getAttribute('aria-valuenow'),'292');
    await page.keyboard.press('Home');
  });
  await check('settings refresh returns to the prior work identity and tab', async () => {
    await scene('review');
    await page.click('[data-nav="settings"]');
    await page.locator('#settings-pane').waitFor({state:'visible'});
    await page.reload();
    await page.click('[data-nav="work"]');
    await page.waitForFunction(()=>document.querySelector('#tab-results').getAttribute('aria-selected')==='true');
    assert.equal(new URL(page.url()).hash,'#work/review/results');
    assert.match(await page.locator('#work-title').innerText(),/统一项目/);
  });
  await check('keyboard selection restores focus to the new sidebar row', async () => {
    await page.focus('[data-conversation="running"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('[data-conversation="running"]').getAttribute('aria-current')==='true');
    assert.equal(await page.locator('[data-conversation="running"]').evaluate((el)=>el===document.activeElement),true);
  });
  await check('runtime settings and modal focus restoration', async () => {
    await scene('running');
    await page.click('#runtime-button');
    await page.fill('#budget','3.5');
    await page.selectOption('#model','性能优先');
    await page.click('#save-runtime');
    assert.equal(await page.locator('#runtime-button').evaluate((el) => el === document.activeElement),true);
    await page.click('#runtime-button');
    assert.equal(await page.inputValue('#budget'),'3.5');
    assert.equal(await page.inputValue('#model'),'性能优先');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#runtime-dialog').getAttribute('open'),null);
  });
  await check('auth and disconnection block send without losing drafts', async () => {
    await page.fill('#prompt','未授权时仍保留');
    await scene('unauthorized');
    assert.equal(await page.isDisabled('#send-button'),true);
    assert.match(await page.locator('#connection-status').innerText(),/401/);
    assert.equal(await page.inputValue('#prompt'),'未授权时仍保留');
    await scene('offline');
    assert.equal(await page.isDisabled('#send-button'),true);
    await page.click('[data-action="reconnect"]');
    await page.waitForFunction(() => !document.querySelector('#send-button').disabled);
    assert.equal(await page.inputValue('#prompt'),'未授权时仍保留');
    assert.equal(await page.isDisabled('#send-button'),false);
  });
  await check('approval requires explicit bounded confirmation', async () => {
    await scene('approval');
    await page.click('[data-action="approve"]');
    assert.match(await page.locator('#confirm-description').innerText(),/不调用审批 API/);
    await page.click('#confirm-cancel');
    assert.match(await page.locator('#work-status').innerText(),/等待审批/);
    await page.click('[data-action="approve"]');
    await page.click('#confirm-accept');
    await page.waitForFunction(() => document.querySelector('#work-status').textContent.includes('执行中'));
    assert.match(await page.locator('#work-status').innerText(),/执行中/);
  });
  await check('review, evidence, focus return and explicit non-release state', async () => {
    await scene('review');
    await page.click('[data-file="public/workbench-chrome.js"]');
    assert.match(await page.locator('#detail-body').innerText(),/navigateToConversation/);
    assert.doesNotMatch(await page.locator('#detail-body').innerText(),/restoreRunTab/);
    await page.keyboard.press('Escape');
    await page.locator('[data-action="tests"]').first().click();
    assert.equal(await page.isVisible('#inspector'),true);
    assert.match(await page.locator('#detail-body').innerText(),/不是当前工作区验证结果/);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#inspector'),false);
    assert.equal(await page.locator('[data-action="tests"]').first().evaluate((el) => el === document.activeElement),true);
    await page.click('[data-action="accept-review"]');
    assert.match(await page.locator('#confirm-description').innerText(),/不提交、不合并、不发布/);
    await page.click('#confirm-accept');
    assert.match(await page.locator('#work-status').innerText(),/审阅已确认.*未发布/);
    await page.click('[data-action="revise"]');
    await page.waitForFunction(() => document.querySelector('#tab-conversation').getAttribute('aria-selected') === 'true');
    assert.match(await page.inputValue('#prompt'),/继续补齐/);
  });
  await check('failed-run recovery only prepares a draft', async () => {
    await scene('failed');
    await page.click('[data-action="recovery"]');
    await page.click('[data-action="prepare-retry"]');
    assert.match(await page.inputValue('#prompt'),/不重复执行/);
    assert.match(await page.locator('#work-status').innerText(),/执行失败/);
  });
  await check('stop is confirmed and retains the current draft', async () => {
    await scene('running');
    await page.fill('#prompt','停止后仍保留的草稿');
    await page.click('#stop-button');
    await page.click('#confirm-cancel');
    assert.match(await page.locator('#work-status').innerText(),/执行中/);
    await page.click('#stop-button');
    await page.click('#confirm-accept');
    await page.waitForFunction(()=>document.querySelector('#work-status').textContent.includes('已停止'));
    assert.equal(await page.inputValue('#prompt'),'停止后仍保留的草稿');
  });
  await check('settings separate draft, saved, effective and official state', async () => {
    await scene('settings');
    assert.equal(await page.isDisabled('#activate-config'),true);
    await page.fill('#config-name','示例 Codex 连接');
    assert.match(await page.locator('#config-status').innerText(),/未保存/);
    await page.click('#config-form button[type="submit"]');
    assert.equal(await page.locator('#config-status').innerText(),'已保存 · 尚未生效');
    await page.click('#activate-config');
    assert.match(await page.locator('#config-status').innerText(),/示例配置已生效.*正式配置未修改/);
    await page.fill('#config-name','保留未保存修改');
    await page.click('[data-connection="claude"]');
    await page.click('#confirm-cancel');
    assert.equal(await page.inputValue('#config-name'),'保留未保存修改');
    await page.click('[data-connection="claude"]');
    await page.click('#confirm-accept');
    await page.click('[data-connection="codex"]');
    assert.equal(await page.inputValue('#config-name'),'保留未保存修改');
    await page.fill('#config-name','   ');
    await page.click('#config-form button[type="submit"]');
    assert.equal(await page.locator('#config-name').evaluate((el) => el.checkValidity()),false);
    await page.fill('#config-name','更正后的连接名');
    await page.click('#config-form button[type="submit"]');
    assert.equal(await page.locator('#config-status').innerText(),'已保存 · 尚未生效');
  });
  await check('new conversation does not create execution, markup is escaped', async () => {
    await scene('empty');
    assert.match(await page.locator('#work-status').innerText(),/草稿.*未执行/);
    const malicious = '<img src=x onerror="window.previewInjected=true">';
    await page.fill('#prompt',malicious);
    await page.click('#send-button');
    assert.equal(await page.locator('#work-content img').count(),0);
    assert.equal(await page.evaluate(() => window.previewInjected),undefined);
    assert.match(await page.locator('#work-content').innerText(),/<img src=x/);
    assert.match(await page.locator('#work-status').innerText(),/未执行/);
    await page.click('#tab-process');
    await page.waitForFunction(()=>document.querySelector('#tab-process').getAttribute('aria-selected')==='true');
    assert.match(await page.locator('#work-content').innerText(),/尚未开始执行/);
    assert.equal(await page.locator('.timeline').count(),0);
    await page.click('#tab-conversation');
    await page.waitForFunction(()=>document.querySelector('#tab-conversation').getAttribute('aria-selected')==='true');
  });
  await check('attachment metadata only, search and document evidence', async () => {
    await page.setInputFiles('#file-input',{name:'设计说明.txt',mimeType:'text/plain',buffer:Buffer.from('sample only')});
    assert.match(await page.locator('#attachments').innerText(),/设计说明.txt/);
    await page.click('[data-remove-attachment]');
    assert.equal(await page.locator('.attachment').count(),0);
    await page.fill('#search','梳理交付');
    assert.equal(await page.locator('.conversation').count(),1);
    await page.click('.conversation');
    await page.click('#tab-results');
    await page.click('[data-action="document"]');
    assert.match(await page.locator('#detail-body').innerText(),/外部来源待核验/);
    await page.keyboard.press('Escape');
    await page.fill('#search','');
  });
  await check('template boundary rejects active markup before adoption',async()=>{
    const results=await page.evaluate(()=>['<script>alert(1)</script>','<p onclick="alert(1)">x</p>','<svg><use href="https://example.invalid/icon.svg#x"></use></svg>'].map((markup)=>{const host=document.createElement('div');host.textContent='unchanged';try{renderMarkup(host,markup);return false;}catch{return host.textContent==='unchanged';}}));
    assert.deepEqual(results,[true,true,true]);
  });
  await check('primary semantic colors satisfy AA text contrast', async () => {
    for (const theme of ['light','dark']) {
      await page.evaluate((value) => document.documentElement.dataset.theme=value,theme);
      const ratios = await page.evaluate(() => {
        const css=getComputedStyle(document.documentElement);
        const luminance=(hex)=>{let value=hex.trim().replace('#','');if(value.length===3)value=Array.from(value).map((char)=>char+char).join('');const rgb=value.match(/../g).map((part)=>parseInt(part,16)/255).map((channel)=>channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
        return [['text','surface'],['muted','surface'],['muted','sidebar'],['accent','accent-soft'],['link','surface'],['warn','warn-soft'],['bad','bad-soft']].map(([fg,bg])=>{const a=luminance(css.getPropertyValue('--'+fg));const b=luminance(css.getPropertyValue('--'+bg));return{pair:`${fg}/${bg}`,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
      });
      for(const result of ratios) assert.ok(result.ratio>=4.5,`${theme} ${result.pair}: ${result.ratio}`);
    }
  });
  await check('three scenes, two themes, five viewports', async () => {
    // Visual evidence starts from clean representative data, not earlier adversarial test input.
    const galleryContext = await browser.newContext({ reducedMotion:'reduce' });
    page = await galleryContext.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror',(error)=>errors.push(error.message));
    page.on('console',(message)=>{if(message.type()==='error')errors.push(message.text());});
    page.on('request',(request)=>{if(/^https?:/.test(request.url()))requests.push(request.url());});
    await page.goto(pathToFileURL(input).href);
    for (const width of [1440,1280,1024,820,390]) {
      await page.setViewportSize({width,height:width===390?844:960});
      for (const theme of ['light','dark']) {
        await page.evaluate((value)=>document.documentElement.dataset.theme=value,theme);
        for (const state of ['running','review','settings']) {
          await scene(state);
          await page.evaluate(()=>{document.activeElement?.blur();document.querySelector('#work-scroll').scrollTop=0;});
          await page.mouse.move(0,0);
          const result=await layout();
          assertLayout(result,`${width}/${theme}/${state}`);
          if(state==='settings') {
            const firstObject=await page.locator('[data-connection]').first().boundingBox();
            assert.ok(firstObject.y/result.height<=(width===390?.4:.35),`configuration first actionable object too low: ${firstObject.y}/${result.height}`);
            result.firstConfigObjectY=firstObject.y;
          }
          report.layouts.push({...result,theme,state});
          await screenshot(`${width}-${theme}-${state}.png`);
        }
      }
    }
  });
  await check('mobile list, detail, composer and modal are mutually usable', async () => {
    await scene('review');
    await page.locator('[data-action="tests"]').first().click();
    assert.equal(await page.isVisible('.work-pane'),false);
    assert.equal(await page.isVisible('#inspector'),true);
    await screenshot('390-dark-evidence.png');
    await page.click('#close-detail');
    assert.equal(await page.isVisible('.work-pane'),true);
    await page.click('#menu-button');
    assert.equal(await page.isVisible('.sidebar'),true);
    assert.equal(await page.isVisible('.workspace'),false);
    await page.click('[data-conversation="running"]');
    await page.locator('.workspace').waitFor({state:'visible'});
    assert.equal(await page.isVisible('.workspace'),true);
    await page.click('#runtime-button');
    const modal=await page.locator('#runtime-dialog').boundingBox();
    assert.ok(modal.x>=0 && modal.x+modal.width<=390);
    await page.keyboard.press('Escape');
    for(const name of ['menu-button','detail-button','send-button','runtime-button','attach-button']) {
      const box=await page.locator('#'+name).boundingBox();
      assert.ok(box.width>=44&&box.height>=44,`${name} touch target`);
    }
  });
  await check('abnormal and long-content layouts', async () => {
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:width===390?844:960});
      for(const state of ['approval','failed','offline','unauthorized','empty','long']) {
        await scene(state);
        const result=await layout();assertLayout(result,`${width}/${state}`);
        report.layouts.push({...result,state,theme:'dark'});
        if(width===390&&['approval','unauthorized','long'].includes(state)) await screenshot(`390-dark-${state}.png`);
      }
    }
  });
  await check('layout gate rejects an intentionally broken width', async () => {
    await page.evaluate(()=>{document.body.style.minWidth='2000px';});
    const bad=await layout();
    assert.throws(()=>assertLayout(bad,'mutant'),/overflow/);
    await page.evaluate(()=>{document.body.style.minWidth='';});
    assertLayout(await layout(),'restored');
  });
  assert.deepEqual(errors,[]);
  assert.deepEqual(requests,[]);
  report.ok=true;
} catch(error) {
  report.failure=error.stack;
  await screenshot('failure.png').catch(()=>{});
  process.exitCode=1;
} finally {
  await browser.close();
  report.sourceBytes=(await readFile(input)).length;
  await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,layouts:report.layouts.length,screenshots:report.screenshots.length,output,failure:report.failure},null,2));
}
