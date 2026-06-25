// Headless smoke test: boots the game, starts a round, spawns enemies, fires, reports perf + errors.
const { chromium } = require('playwright-core');
const path = require('path');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox','--use-gl=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--disable-dev-shm-usage']
  });
  const page = await browser.newPage({ viewport:{width:1280,height:720} });
  const errors=[], logs=[];
  page.on('console', m=>{ const t=m.type(); logs.push(t+': '+m.text()); if(t==='error') errors.push(m.text()); });
  page.on('pageerror', e=> errors.push('PAGEERROR: '+e.message));

  const url = 'file://'+path.join(__dirname,'index.html');
  await page.goto(url, { waitUntil:'load' });
  await page.waitForTimeout(1200); // let build run

  // report phase + whether WebGL initialised
  const boot = await page.evaluate(()=>({
    phase: window.__G && window.__G.phase,
    hasKit: !!window.KIT,
    hasRenderer: !!(document.querySelector('canvas')),
    sceneReady: !!(window.__G),
  }));

  // start the game programmatically (click Begin)
  await page.evaluate(()=>{ const b=document.getElementById('playBtn'); if(b) b.click(); });
  await page.waitForTimeout(300);

  // force a round + spawn a full horde to stress the pools, then simulate ~2s
  const stress = await page.evaluate(async ()=>{
    const G=window.__G;
    // jump to a mid round and spawn to the cap
    if(window.__startRoundForTest) window.__startRoundForTest(7);
    return { phase:G.phase };
  });

  await page.waitForTimeout(2500);

  // pull renderer.info (draw calls / triangles) + live counts + fps estimate
  const stats = await page.evaluate(()=>{
    const r = window.__renderer; const info = r? r.info : null;
    return {
      phase: window.__G.phase,
      alive: window.__G.aliveCount,
      round: window.__G.round,
      health: Math.round(window.__G.health),
      drawCalls: info? info.render.calls : null,
      triangles: info? info.render.triangles : null,
      geometries: info? info.memory.geometries : null,
      textures: info? info.memory.textures : null,
      programs: info? (info.programs?info.programs.length:null) : null,
    };
  });

  console.log('── BOOT ──', JSON.stringify(boot));
  console.log('── STRESS ──', JSON.stringify(stress));
  console.log('── STATS ──', JSON.stringify(stats,null,0));
  console.log('── ERRORS ('+errors.length+') ──');
  errors.slice(0,30).forEach(e=>console.log('  '+e));
  console.log('── LAST LOGS ──');
  logs.slice(-12).forEach(l=>console.log('  '+l));

  await browser.close();
  process.exit(errors.length? 1 : 0);
})().catch(e=>{ console.error('TEST HARNESS ERROR:', e); process.exit(2); });
