// game.js — UNDEAD SIEGE engine.
// First-person wave-survival built on the procedural kit (window.KIT) + THREE r128.
// Performance contract (see brief §7): ONE renderer, ONE rAF, ONE scene, fixed-timestep sim,
// pooled enemies (≤25 zombies + 8 crawlers), instanced statics, ONE baked shadow light,
// hitscan via manual ray-sphere (no Raycaster traversal), zero per-frame allocation in hot paths.
/* global THREE, KIT */
"use strict";
(() => {
const T = THREE;

/* ════════════════════ shared temporaries (never `new` in the loop) ════════════════════ */
const _v1 = new T.Vector3(), _v2 = new T.Vector3(), _v3 = new T.Vector3();
const _fwd = new T.Vector3(), _right = new T.Vector3(), _dir = new T.Vector3();
const _col = new T.Color();

/* ════════════════════ tunables / world constants ════════════════════ */
const TOWER_H   = 34;          // tower wall half-extent (footprint ±34, CAMP-LOCAL)
const TOWER_TALL= 34;
const R_OUT     = 58.5;        // camp-local walkable radius (fence at 60.5, around the camp)
// ── NEW MAP (ported from designer buildMap): big 300×300 world, tower camp in a corner ──
const WB        = 150;         // world half-extent (square arena bound)
const CAMP_X    = -96, CAMP_Z = -96;   // the whole tower camp is translated here
const MCX       = 55,  MCZ   = 55;     // Minecraft compound center (world-anchored)
const MH        = 84;          // compound half-size
const MGAP      = 20;          // south-wall gate gap (faces the camp)
const PLAYER_R  = 0.6;
const EYE       = 1.7;
const STEP      = 1/60;        // fixed sim timestep
const GRAV      = 22;
const MAX_Z     = 25;          // hard cap: live zombies
const MAX_C     = 8;           // crawler pool
// spiral staircase (walkable, inside the tower) — a helix the player climbs to the roof
const STAIR_RIN  = 6;          // inner radius (central column)
const STAIR_ROUT = 16;         // outer radius (stairwell edge)
const STAIR_RMID = (STAIR_RIN+STAIR_ROUT)/2;
const STAIR_TURNS= 4.5;        // full revolutions from ground to roof
const STAIR_TOP  = 34;         // top of the climb (roof deck level)
const STAIR_PITCH= STAIR_TOP/STAIR_TURNS; // rise per revolution

/* ════════════════════ engine singletons ════════════════════ */
let renderer, scene, camera, clock;
let buildRoot, campGroup;      // camp geometry is added to campGroup (positioned at CAMP) → corner offset
const inCamp=()=> buildRoot===campGroup;
const campWX=(x)=> inCamp()? CAMP_X+x : x;     // local→world X for camp colliders/logic
const campWZ=(z)=> inCamp()? CAMP_Z+z : z;
let shadowLight, needShadowBake = true;
const settings = { shadows:true, quality:true, fps:false };

/* ════════════════════ game state ════════════════════ */
const G = {
  phase:'load',            // load | menu | play | pause | over | win
  round:0, kills:0,
  points:500,
  powerOn:false,
  // player
  health:100, maxHealth:100, vy:0, onGround:true, footY:0, eyeY:EYE,
  hurtT:-9, regenT:0, lastDmg:-9,
  yaw:0, pitch:0,
  // weapons
  weapons:[], cur:0,
  // perks
  perks:new Set(),
  // aiming + look
  aiming:false, zoomedFov:30, sens:0.0026,
  // wave director
  budget:0, spawnedThisRound:0, toSpawn:0, aliveCount:0,
  spawnTimer:0, roundActive:false, intermission:0,
  bossActive:false, megaActive:false,
  // powerups (timed)
  instaKill:0, doublePts:0, fireRateBuff:0,
  // input
  keys:{}, mouseDown:false, rightMouseDown:false, wantReload:false,
};
window.__G = G;

/* ════════════════════ weapon definitions ════════════════════ */
// dmg is per-hit; fireRate in shots/sec; auto = hold to fire; pellets/spread for shotgun.
const WDEF = {
  pistol:  { name:'M1911',        mag:8,  reserve:64,  rate:6,  dmg:42,  auto:false, reload:1.3, range:90, kind:'ballistic' },
  pickaxe: { name:'PICKAXE',         mag:1, reserve:0, rate:2.2, dmg:65,  auto:true, reload:0, range:4.2, kind:'melee', melee:true },
  diapick: { name:'DIAMOND PICKAXE', mag:1, reserve:0, rate:3.4, dmg:150, auto:true, reload:0, range:4.8, kind:'melee', melee:true },
  smg:     { name:'MP-40',        mag:32, reserve:240, rate:13, dmg:26,  auto:true,  reload:1.7, range:80, kind:'ballistic' },
  shotgun: { name:'TRENCH GUN',   mag:6,  reserve:48,  rate:2.2,dmg:30,  auto:false, reload:2.3, range:34, kind:'ballistic', pellets:8, spread:0.13 },
  rifle:   { name:'KAR-98',       mag:5,  reserve:50,  rate:1.6,dmg:160, auto:false, reload:2.0, range:140,kind:'ballistic' },
  sniper:  { name:'SPRINGFIELD',  mag:3,  reserve:30,  rate:0.8,dmg:240, auto:false, reload:2.4, range:200,kind:'ballistic' },
  ak:      { name:'AK-47',        mag:30, reserve:270, rate:10, dmg:48,  auto:true,  reload:2.0, range:110,kind:'ballistic' },
  lmg:     { name:'SLEDGEHAMMER', mag:75, reserve:300, rate:11, dmg:55,  auto:true,  reload:3.4, range:120,kind:'ballistic' },
  wonder:  { name:'WUNDER-DG2',   mag:20, reserve:120, rate:4,  dmg:240, auto:true,  reload:2.6, range:120,kind:'wonder', aoe:3.0 },
  axe:     { name:"RETRIEVER AXE", mag:1,reserve:30,  rate:1,  dmg:900, auto:false, reload:2.2, range:60, kind:'axe', aoe:5.5 },
};
const WALL_WEAPONS = ['smg','shotgun','rifle','sniper','ak','lmg']; // assignable on walls

function newWeapon(type, pap){
  const d = WDEF[type];
  return { type, pap:!!pap, mag:d.mag, ammo:d.mag, reserve:d.reserve,
           reloading:false, reloadEnd:0, lastShot:-9, name:d.name };
}

/* ════════════════════ AUDIO (tiny WebAudio synth — no asset files) ════════════════════ */
const AU = (() => {
  let ac=null, master=null;
  function ensure(){ if(ac) return; ac=new (window.AudioContext||window.webkitAudioContext)();
    master=ac.createGain(); master.gain.value=0.5; master.connect(ac.destination); }
  function tone(f,t,dur,type,vol,slideTo){ if(!ac) return;
    const o=ac.createOscillator(), g=ac.createGain(); o.type=type||'square';
    o.frequency.setValueAtTime(f, t); if(slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1,slideTo), t+dur);
    g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(vol||0.3,t+0.008);
    g.gain.exponentialRampToValueAtTime(0.0001,t+dur); o.connect(g); g.connect(master); o.start(t); o.stop(t+dur+0.02); }
  function noise(t,dur,vol,filt){ if(!ac) return;
    const n=ac.createBufferSource(), b=ac.createBuffer(1, ac.sampleRate*dur, ac.sampleRate); const d=b.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1); n.buffer=b;
    const g=ac.createGain(); g.gain.setValueAtTime(vol||0.3,t); g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
    const f=ac.createBiquadFilter(); f.type='lowpass'; f.frequency.value=filt||1800;
    n.connect(f); f.connect(g); g.connect(master); n.start(t); n.stop(t+dur); }
  const now=()=> ac?ac.currentTime:0;
  // optional sampled monkey call — uses assets/i-m-coming-for-your-pingas.mp3 if present
  // (HTMLAudio works from both file:// and http; falls back to the synth if absent)
  let monkeyAudio=null, monkeyOk=false, monkeyTried=false;
  function loadMonkey(){ if(monkeyTried) return; monkeyTried=true;
    try{ monkeyAudio=new Audio((window.__resources && window.__resources.monkeyCall) || 'assets/i-m-coming-for-your-pingas.mp3');
      monkeyAudio.preload='auto'; monkeyAudio.oncanplaythrough=()=>{ monkeyOk=true; }; monkeyAudio.onerror=()=>{ monkeyOk=false; }; }catch(e){} }
  return {
    resume(){ ensure(); if(ac.state==='suspended') ac.resume(); },
    shoot(kind){ ensure(); const t=now();
      if(kind==='shotgun'){ noise(t,0.18,0.5,2600); tone(120,t,0.12,'square',0.25,40); }
      else if(kind==='sniper'){ noise(t,0.08,0.6,1400); tone(100,t,0.10,'sawtooth',0.35,50); }
      else if(kind==='wonder'){ tone(880,t,0.14,'sawtooth',0.2,220); tone(440,t,0.18,'triangle',0.18,110); }
      else if(kind==='axe'){ noise(t,0.4,0.5,900); tone(70,t,0.5,'sawtooth',0.4,30); }
      else { noise(t,0.06,0.35,3200); tone(180,t,0.07,'square',0.22,80); } },
    dry(){ ensure(); tone(900,now(),0.04,'square',0.12); },
    reload(){ ensure(); const t=now(); tone(300,t,0.05,'square',0.2); tone(420,t+0.18,0.05,'square',0.2); tone(520,t+0.42,0.06,'square',0.22); },
    hit(){ ensure(); tone(700,now(),0.04,'square',0.12,400); },
    hurt(){ ensure(); const t=now(); noise(t,0.25,0.5,700); tone(90,t,0.25,'sawtooth',0.3,50); },
    buy(){ ensure(); const t=now(); tone(600,t,0.07,'triangle',0.25); tone(900,t+0.08,0.1,'triangle',0.25); },
    deny(){ ensure(); tone(160,now(),0.12,'sawtooth',0.2,110); },
    power(){ ensure(); const t=now(); tone(120,t,0.6,'sawtooth',0.3,600); noise(t,0.4,0.2,1200); },
    powerup(){ ensure(); const t=now(); [523,659,784,1046].forEach((f,i)=>tone(f,t+i*0.07,0.12,'triangle',0.25)); },
    explode(){ ensure(); const t=now(); noise(t,0.5,0.6,500); tone(60,t,0.5,'sawtooth',0.4,25); },
    round(){ ensure(); const t=now(); tone(80,t,0.9,'sawtooth',0.3,40); [196,233,294].forEach((f,i)=>tone(f,t+0.3+i*0.12,0.3,'triangle',0.18)); },
    groan(){ ensure(); const t=now(); tone(70+Math.random()*30,t,0.5,'sawtooth',0.08,40+Math.random()*20); },
    monkey(){ ensure(); loadMonkey();
      if(monkeyOk && monkeyAudio){ try{ const a=monkeyAudio.cloneNode(); a.volume=0.7; a.play().catch(()=>{}); return; }catch(e){} }
      const t=now(); [520,660,430,720].forEach((f,i)=>tone(f,t+i*0.09,0.08,'square',0.18,f*1.5)); noise(t,0.22,0.14,1500); },
  };
})();

/* ════════════════════ WORLD ════════════════════ */
let towerDoorPivot=null, doorOpen=false;
const colliders = [];      // {x,z,r} cylinder colliders for props (cheap)
const oreBlocks = [];      // minable Minecraft ore blocks {grp,x,y,z,r,hp,maxhp,reward,kind,glow,alive,respawn}
const radioBalls = [];     // shootable radio-tower balls by the pyramid (light all 4 → lightning easter egg)
const worldAnims = [];     // per-frame update() callbacks for compound props (cave, giant tree, villagers)
let giantTree = null, megaGate = null, round25Gate = null;
let pigFP = null, carPOV = null;       // first-person mount/drive viewmodels (attached to camera)
const PIG_COST = 2000, CAR_COST = 4000;
const interactables = [];  // stations/buys/gates/door
const pointLights = [];    // capped flickering lights {light, base, ph}

function mergedTreeGeometry(){
  // Merge a kit tree's child geometries into ONE BufferGeometry w/ vertex colors → instanceable.
  const tree = KIT.makeTree();
  const geos=[];
  tree.updateMatrixWorld(true);
  tree.traverse(o=>{ if(o.isMesh){
    const g=o.geometry.clone(); g.applyMatrix4(o.matrixWorld);
    const col=o.material.color; const arr=new Float32Array(g.attributes.position.count*3);
    for(let i=0;i<g.attributes.position.count;i++){ arr[i*3]=col.r; arr[i*3+1]=col.g; arr[i*3+2]=col.b; }
    g.setAttribute('color', new T.BufferAttribute(arr,3)); geos.push(g);
  }});
  const merged = T.BufferGeometryUtils ? T.BufferGeometryUtils.mergeBufferGeometries(geos)
                                       : mergeManual(geos);
  return merged;
}
// r128 ships BufferGeometryUtils as a separate module; provide a tiny manual fallback.
function mergeManual(geos){
  let vc=0, ic=0; geos.forEach(g=>{ vc+=g.attributes.position.count; ic+=(g.index?g.index.count:g.attributes.position.count); });
  const pos=new Float32Array(vc*3), col=new Float32Array(vc*3), idx=new Uint32Array(ic);
  let vo=0, io=0;
  geos.forEach(g=>{ const p=g.attributes.position.array, c=g.attributes.color.array;
    pos.set(p, vo*3); col.set(c, vo*3);
    const gi=g.index? g.index.array : null; const n=g.attributes.position.count;
    if(gi){ for(let i=0;i<gi.length;i++) idx[io++]=gi[i]+vo; } else { for(let i=0;i<n;i++) idx[io++]=i+vo; }
    vo+=n; });
  const m=new T.BufferGeometry(); m.setAttribute('position',new T.BufferAttribute(pos,3));
  m.setAttribute('color',new T.BufferAttribute(col,3)); m.setIndex(new T.BufferAttribute(idx,1));
  m.computeVertexNormals(); return m;
}

function buildWorld(){
  scene = new T.Scene();
  buildRoot = scene;                                   // default add target = scene
  scene.background = new T.Color(0x070c14);
  scene.fog = new T.FogExp2(0x0b1622, 0.0042);         // thin fog for the big 300×300 world

  // sky + angry moon (kit)
  buildRoot.add(KIT.makeSky());
  const am = KIT.makeAngryMoon(); am.scale.setScalar(14); am.position.set(-40,90,-170); buildRoot.add(am);
  if(camera) buildRoot.add(camera);
  G.inTower = false;

  buildRoot.add(new T.AmbientLight(0x223247, 0.9));
  shadowLight = new T.DirectionalLight(0x9fc2ff, 0.95);
  shadowLight.position.set(-60,110,-40); shadowLight.castShadow = true; shadowLight.shadow.mapSize.set(2048,2048);
  Object.assign(shadowLight.shadow.camera,{left:-170,right:170,top:170,bottom:-170,far:460,near:1});
  buildRoot.add(shadowLight);
  const fill=new T.DirectionalLight(0x4a6a9c,0.28); fill.position.set(30,30,60); buildRoot.add(fill);

  // big green ground covering the whole world
  const ground = new T.Mesh(new T.PlaneGeometry(WB*2+140, WB*2+140),
                            new T.MeshStandardMaterial({color:0x3a6b2c, roughness:0.99}));
  ground.rotation.x=-Math.PI/2; ground.receiveShadow=true; buildRoot.add(ground);

  // ════════ TOWER CAMP — built locally, offset to the corner via campGroup ════════
  campGroup = new T.Group(); campGroup.position.set(CAMP_X,0,CAMP_Z); scene.add(campGroup);
  buildRoot = campGroup;
  const road = new T.Mesh(new T.RingGeometry(44,61,80,1), new T.MeshStandardMaterial({color:0x2a2418, roughness:0.98}));
  road.rotation.x=-Math.PI/2; road.position.y=0.02; road.receiveShadow=true; buildRoot.add(road);
  buildTower();
  buildTowerInterior();
  buildBoundaryAndForest();
  buildStations();
  buildVendor();                                       // pig (+ car later) vendor at the camp
  buildRoot = scene;                                   // back to world space

  // ════════ MINECRAFT COMPOUND + road + gates (world-anchored) ════════
  buildCompound();
  buildSkyRoom();                                      // hidden easter-egg room far up in the sky
}

// The walled Minecraft compound: rocky walls (south gap), cave, village, giant tree,
// villagers, blocky forest, the $100k mega-gate, road, and the round-25 portal gate.
function buildCompound(){
  const rockMat=new T.MeshStandardMaterial({color:0x8d857a,roughness:1,metalness:0});
  // ── rocky perimeter walls (4 sides; south wall has the gate gap facing the camp) ──
  const wallSide=(x1,z1,x2,z2,gapAt)=>{ const dx=x2-x1,dz=z2-z1,len=Math.hypot(dx,dz),ry=-Math.atan2(dx,dz),n=Math.max(1,Math.floor(len/8));
    for(let i=0;i<n;i++){ const tc=(i+0.5)/n; if(gapAt!=null && Math.abs(tc-gapAt)<(MGAP/len)) continue;
      const cx=x1+dx*tc, cz=z1+dz*tc, h=42+(i%3)*8;
      const seg=new T.Mesh(new T.BoxGeometry(len/n+0.8,h,8), rockMat); seg.position.set(cx,h/2,cz); seg.rotation.y=ry; seg.castShadow=true; seg.receiveShadow=true; scene.add(seg);
      const pk=new T.Mesh(new T.ConeGeometry(5.5,12,5), rockMat); pk.position.set(cx,h+3,cz); pk.rotation.y=i; scene.add(pk);
      colliders.push({x:cx, z:cz, r:5}); } };
  wallSide(MCX-MH,MCZ-MH, MCX+MH,MCZ-MH, 0.16); // south (gap faces camp)
  wallSide(MCX-MH,MCZ+MH, MCX+MH,MCZ+MH, null); // north
  wallSide(MCX-MH,MCZ-MH, MCX-MH,MCZ+MH, null); // west
  wallSide(MCX+MH,MCZ-MH, MCX+MH,MCZ+MH, null); // east
  // ── cave (ore) ──
  const cave=KIT.makeCave(); cave.scale.setScalar(1.7); cave.position.set(80,0,90); KIT.shadow(cave); scene.add(cave);
  if(cave.userData.update) worldAnims.push(cave.userData.update); colliders.push({x:80,z:90,r:13});
  // ── village houses ──
  [[40,40,0],[70,46,0.7],[44,72,1.4],[72,76,2.1]].forEach(([hx,hz,ry])=>{ const h=KIT.makeHouse(); h.position.set(hx,0,hz); h.rotation.y=ry; KIT.shadow(h); scene.add(h); colliders.push({x:hx,z:hz,r:3.2}); });
  // ── giant climbable tree ──
  giantTree=KIT.makeGiantTree(); giantTree.position.set(56,0,56); KIT.shadow(giantTree); scene.add(giantTree);
  if(giantTree.userData.update) worldAnims.push(giantTree.userData.update); colliders.push({x:56,z:56,r:6.5});
  // ── villagers (big chungus) ──
  [[50,48],[60,52],[52,62]].forEach(p=>{ const v=KIT.makeChungus(); v.scale.setScalar(0.8); v.position.set(p[0],0,p[1]); KIT.shadow(v); scene.add(v); if(v.userData.update) worldAnims.push(v.userData.update); });
  // ── GIANT DOUBLE PYRAMID on steel supports (kit landmark at 12,80; walk under it) ──
  const pyr=KIT.makePyramid(22,26); pyr.position.set(12,0,80); KIT.shadow(pyr); scene.add(pyr);
  if(pyr.userData.update) worldAnims.push(pyr.userData.update);
  [[34,80],[-10,80],[12,102],[12,58]].forEach(c=> colliders.push({x:c[0],z:c[1],r:2.4}));   // 4 support legs only
  // ── 4 RADIO TOWERS around the pyramid — shoot all 4 balls → lightning easter egg ──
  [[-16,52],[40,52],[-16,108],[40,108]].forEach(c=>{ const rt=KIT.makeRadioTower(32); rt.position.set(c[0],0,c[1]); KIT.shadow(rt); scene.add(rt);
    if(rt.userData.update) worldAnims.push(rt.userData.update); colliders.push({x:c[0],z:c[1],r:3.4});
    radioBalls.push({grp:rt, x:c[0], y:rt.userData.topY, z:c[1], r:2.3, lit:false}); });
  // ── fancier village buildings: bank (96,28) + shop (28,16) (the modern estate goes on the giant tree in a later phase) ──
  const bank=KIT.makeVillageHouse('bank'); bank.position.set(96,0,28); bank.rotation.y=-0.9; KIT.shadow(bank); scene.add(bank); if(bank.userData.update) worldAnims.push(bank.userData.update); colliders.push({x:96,z:28,r:7});
  const shop=KIT.makeVillageHouse('shop'); shop.position.set(28,0,16); shop.rotation.y=0.5; KIT.shadow(shop); scene.add(shop); if(shop.userData.update) worldAnims.push(shop.userData.update); colliders.push({x:28,z:16,r:7});
  // ── scattered blocky trees + rocks (skip the structure footprints, like the kit's clearZones) ──
  const clearZones=[[12,80,44],[96,28,24],[28,16,24],[56,56,12],[80,90,16]];
  const blockedMC=(x,z)=> clearZones.some(c=> (x-c[0])*(x-c[0])+(z-c[1])*(z-c[1]) < c[2]*c[2]);
  for(let i=0;i<30;i++){ const a=i*2.39, rr=20+((i*53)%60); const tx=MCX+Math.cos(a)*rr*0.9, tz=MCZ+Math.sin(a)*rr*0.9; if(blockedMC(tx,tz)) continue;
    const t=KIT.makeBlockyTree(); t.position.set(tx,0,tz); t.scale.setScalar(0.8+((i*7)%5)/6); KIT.shadow(t); scene.add(t); }
  const rockGeo=new T.BoxGeometry(3,2.4,3), rkMat=new T.MeshStandardMaterial({color:0x6f7378,roughness:0.98});
  for(let i=0;i<38;i++){ const a=i*1.9, rr=18+((i*41)%62); const rx=MCX+Math.cos(a)*rr*0.95, rz=MCZ+Math.sin(a)*rr*0.95; if(blockedMC(rx,rz)) continue;
    const r=new T.Mesh(rockGeo,rkMat); r.position.set(rx,1.2,rz); r.rotation.y=i; r.castShadow=r.receiveShadow=true; scene.add(r); }
  buildMegaGate();
  buildCompoundRoad();
}
// $100,000 mega-gate barricade (same plank style as the buy-gates), in the south wall gap facing the camp
function buildMegaGate(){
  const gx=MCX-MH+MGAP*1.34, gz=MCZ-MH;            // world (-2.2, -29)
  const g=new T.Group(); g.position.set(gx,0,gz);
  [-10,10].forEach(x=> g.add(KIT.at(KIT.box(3.5,46,5,KIT.mat(0x2a2016,0.95,0)),x,23,0)));   // posts
  const bars=[];
  for(let i=0;i<13;i++){ const bar=KIT.at(KIT.box(20,2.8,3.4,KIT.mat(0x4a3a22,0.9,0)),0,2.4+i*3.2,0); g.add(bar); bars.push(bar); }
  const tag=new T.Mesh(new T.PlaneGeometry(15,3.4), new T.MeshBasicMaterial({map:KIT.label('$100,000','#ffe9a0'),transparent:true})); tag.position.set(0,49,0.4); tag.rotation.y=Math.PI; g.add(tag);
  KIT.shadow(g); scene.add(g);
  const gate=addInteractable({ x:gx, z:gz, radius:8, type:'gate', cost:100000, open:false, planks:[], anim:0,
    label:()=> gate.open?null:{key:'F', txt:'Breach the Mega-Gate', cost:100000},
    run:()=>{ if(gate.open||!spend(100000)) return false; gate.open=true; g.visible=false; AU.power();
      toast('MEGA-GATE BREACHED','the forbidden area is open','#ffc24a'); return true; } });
  colliders.push({x:gx, z:gz, r:11, gate});          // wide solid until paid; cleared on open
  megaGate=gate;
}
// brick road from the mega-gate to the camp + the round-25 obsidian portal gate
function buildCompoundRoad(){
  const gx=MCX-MH+MGAP*1.34, gz=MCZ-MH;
  const px=(t)=>gx-Math.pow(t,1.7)*34, pz=(t)=>(gz+8)+(CAMP_Z-(gz+8))*t;   // curve to the camp
  const roadMat=new T.MeshStandardMaterial({color:0x5b5f63,roughness:0.95});
  const rockMat=new T.MeshStandardMaterial({color:0x8d857a,roughness:1,metalness:0});
  const N=30, HW=6.6;
  for(let i=0;i<N;i++){ const x1=px(i/N),z1=pz(i/N),x2=px((i+1)/N),z2=pz((i+1)/N), dx=x2-x1,dz=z2-z1,len=Math.hypot(dx,dz),ry=-Math.atan2(dx,dz);
    const seg=new T.Mesh(new T.BoxGeometry(13,0.3,len+1.4), roadMat); seg.position.set((x1+x2)/2,0.16,(z1+z2)/2); seg.rotation.y=ry; seg.receiveShadow=true; scene.add(seg);
    // ROAD BOUNDARY: rocky walls down BOTH edges so you can't leave the road — the portal is the only way through
    const nx=dz/len, nz=-dx/len;
    [-1,1].forEach(s=>{ const wx=(x1+x2)/2+nx*s*HW, wz=(z1+z2)/2+nz*s*HW, hh=3.4+Math.sin(i*1.7+s)*0.8;
      const wseg=new T.Mesh(new T.BoxGeometry(1.4,hh,len+1.0), rockMat); wseg.position.set(wx,hh/2,wz); wseg.rotation.set((i%3-1)*0.02,ry,0); wseg.castShadow=wseg.receiveShadow=true; scene.add(wseg);
      colliders.push({x:wx,z:wz,r:1.3}); }); }
  // ── round-25 obsidian NETHER PORTAL (animated swirling-purple shader) — also the Sky-Room easter egg ──
  const TT=0.82, cx=px(TT), cz=pz(TT), dx=px(TT+0.012)-px(TT-0.012), dz=pz(TT+0.012)-pz(TT-0.012);
  const r25=new T.Group(); r25.position.set(cx,0,cz); r25.rotation.y=-Math.atan2(dx,dz);
  const obs=KIT.mat(0x150a22,0.6,0.25), FW=13,FH=12,TH=3.0, midY=TH+FH/2;
  [-(FW/2+TH/2),(FW/2+TH/2)].forEach(x=> r25.add(KIT.at(KIT.box(TH,FH+TH*2,TH,obs),x,midY,0)));
  r25.add(KIT.at(KIT.box(FW,TH,TH,obs),0,TH/2,0)); r25.add(KIT.at(KIT.box(FW,TH,TH,obs),0,FH+TH*1.5,0));
  [[-(FW/2+TH/2),TH/2],[(FW/2+TH/2),TH/2],[-(FW/2+TH/2),FH+TH*1.5],[(FW/2+TH/2),FH+TH*1.5]].forEach(c=> r25.add(KIT.at(KIT.box(TH*1.15,TH*1.15,TH*1.1,KIT.mat(0x241038,0.55,0.3)),c[0],c[1],0)));
  const portalMat=new T.ShaderMaterial({ transparent:true, depthWrite:false, side:T.DoubleSide, blending:T.AdditiveBlending,
    uniforms:{ t:{value:0} },
    vertexShader:'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader:`varying vec2 vUv; uniform float t;
      float h(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float n(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f); float a=h(i),b=h(i+vec2(1,0)),c=h(i+vec2(0,1)),d=h(i+vec2(1,1)); return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
      void main(){ vec2 uv=vUv; float v=0.0;
        v+=n(uv*4.0+vec2(0.0,t*0.5))*0.6;
        v+=n(uv*9.0-vec2(t*0.32,t*0.12))*0.28;
        v+=sin((uv.y*13.0+t*2.1)+sin(uv.x*7.0+t*1.3))*0.13;
        v=0.32+0.72*v;
        vec3 dark=vec3(0.13,0.02,0.24), mid=vec3(0.52,0.10,0.78), br=vec3(0.86,0.46,1.0);
        vec3 col=mix(dark,mid,smoothstep(0.28,0.6,v)); col=mix(col,br,smoothstep(0.66,0.97,v));
        float edge=smoothstep(0.0,0.12,uv.x)*smoothstep(0.0,0.12,1.0-uv.x)*smoothstep(0.0,0.08,uv.y)*smoothstep(0.0,0.08,1.0-uv.y);
        gl_FragColor=vec4(col, 0.55+0.4*edge); }` });
  const portal=new T.Mesh(new T.PlaneGeometry(FW,FH), portalMat); portal.position.set(0,midY,0); r25.add(portal);
  const portalBack=new T.Mesh(new T.PlaneGeometry(FW,FH), portalMat); portalBack.position.set(0,midY,-0.05); portalBack.rotation.y=Math.PI; r25.add(portalBack);
  const pl=new T.PointLight(0xb24bff,1.3,34); pl.position.set(0,midY,1.6); r25.add(pl);
  const sk=KIT.makeSkullDrop(); sk.scale.setScalar(1.3); sk.position.set(0,midY,1.9); r25.add(sk);
  const tag=new T.Mesh(new T.PlaneGeometry(6,2.4), new T.MeshBasicMaterial({map:KIT.label('RD 25','#e0b0ff'),transparent:true})); tag.position.set(0,FH+TH*2+1.8,0); r25.add(tag);
  KIT.shadow(r25); scene.add(r25); round25Gate={grp:r25, cleared:false, x:cx, z:cz};
  colliders.push({x:cx, z:cz, r:7, gate:{get open(){ return round25Gate.cleared; }}});  // solid until the giga boss dies
  worldAnims.push((t)=>{ portalMat.uniforms.t.value=t; pl.intensity=1.0+Math.sin(t*3)*0.4; sk.rotation.y=t*1.2; });
}

// ════════ PIG MOUNT — buy from the camp vendor, press V to ride (+50% speed, keep your gun) ════════
function buildVendor(){ // camp-local coords (added to campGroup); placed by the south spawn hub
  const vx=15, vz=44;
  const pig=KIT.makePig(); pig.position.set(vx,0,vz); pig.rotation.y=-0.6; pig.userData.moving=false; KIT.shadow(pig); buildRoot.add(pig);
  if(pig.userData.update) worldAnims.push(pig.userData.update);
  const vill=KIT.makeVillager(); vill.scale.setScalar(0.9); vill.position.set(vx-2.6,0,vz+1.6); vill.rotation.y=1.3; KIT.shadow(vill); buildRoot.add(vill);
  if(vill.userData.update) worldAnims.push(vill.userData.update);
  const sign=new T.Mesh(new T.PlaneGeometry(4.2,1.1), new T.MeshBasicMaterial({map:KIT.label('🐷 PIG MOUNT','#ffd0e0'),transparent:true})); sign.position.set(vx,2.6,vz); buildRoot.add(sign);
  addInteractable({ x:vx, z:vz, collide:1.3, type:'vendor',
    label:()=> G.ownsPig ? {key:'V', txt:'Ride Pig (V)', cost:0} : {key:'F', txt:'Buy Pig Mount', cost:PIG_COST},
    run:()=>{ if(G.ownsPig){ toggleMount(); return true; }
      if(!spend(PIG_COST)) return false; G.ownsPig=true; if(AU&&AU.power)AU.power(); toast('PIG MOUNT PURCHASED','press V to ride / dismount','#ffb0c8'); return true; } });
  // a parked car you can buy (B to drive)
  const cx=vx+8, cz=vz+1;
  const car=KIT.makeCar('sedan'); car.position.set(cx,0,cz); car.rotation.y=Math.PI*0.5; KIT.shadow(car); buildRoot.add(car);
  if(car.userData.update) worldAnims.push(car.userData.update); G._parkedCar=car;
  const csign=new T.Mesh(new T.PlaneGeometry(3.6,1.0), new T.MeshBasicMaterial({map:KIT.label('🚗 CAR','#bfe0ff'),transparent:true})); csign.position.set(cx,2.4,cz); buildRoot.add(csign);
  addInteractable({ x:cx, z:cz, collide:2.4, type:'cardealer',
    label:()=> G.ownsCar ? {key:'B', txt:'Drive (B)', cost:0} : {key:'F', txt:'Buy Car', cost:CAR_COST},
    run:()=>{ if(G.ownsCar){ toggleDrive(); return true; }
      if(!spend(CAR_COST)) return false; G.ownsCar=true; if(AU&&AU.power)AU.power(); toast('CAR PURCHASED','press B to drive · W/S throttle · A/D steer','#bfe0ff'); return true; } });
}
function toggleMount(){
  if(!G.ownsPig){ toast('NO PIG','buy the pig mount from the camp vendor','#ffb0c8'); return; }
  G.mounted=!G.mounted;
  if(G.mounted){ if(!pigFP) pigFP=KIT.makePigMountFP(); camera.add(pigFP); pigFP.visible=true; if(AU&&AU.buy)AU.buy(); toast('🐷 MOUNTED','+50% SPEED · shoot while riding','#ffb0c8'); }
  else { if(pigFP) camera.remove(pigFP); if(AU&&AU.buy)AU.buy(); toast('DISMOUNTED','','#ffb0c8'); }
}
function toggleDrive(){
  if(!G.ownsCar){ toast('NO CAR','buy a car from the camp vendor','#bfe0ff'); return; }
  if(G.mounted) toggleMount();                                // can't ride the pig and drive at once
  G.driving=!G.driving;
  if(G.driving){ if(!carPOV) carPOV=KIT.makeCarPOV(); camera.add(carPOV); carPOV.visible=true; G.carVel=new T.Vector3();
    if(arms) arms.visible=false; if(heldHandMesh) heldHandMesh.visible=false;
    if(G._parkedCar) G._parkedCar.visible=false; if(AU&&AU.power)AU.power(); toast('🚗 DRIVING','W/S throttle · A/D steer · B to exit','#bfe0ff'); }
  else { if(carPOV) camera.remove(carPOV); if(arms) arms.visible=true; if(G._parkedCar) G._parkedCar.visible=true; if(AU&&AU.buy)AU.buy(); toast('PARKED','','#bfe0ff'); }
}

// ════════ SKY ROOM — dwell 12s in the nether portal to teleport here (easter egg) ════════
const SRX=300, SRY=220, SRZ=300, SRW=48, SRH=40;   // far-up isolated black box
let skyRoom=null;
function buildSkyRoom(){
  const r=new T.Group(); r.position.set(SRX,SRY,SRZ); scene.add(r); skyRoom=r;
  const blackO=KIT.mat(0x070709,0.85,0.05), blackI=KIT.mat(0x0e0e14,0.9,0);
  r.add(KIT.at(KIT.box(SRW,1.5,SRW,blackI),0,-0.75,0));                     // floor (top at local y=0)
  r.add(KIT.at(KIT.box(SRW,1.5,SRW,blackO),0,SRH,0));                       // ceiling
  r.add(KIT.at(KIT.box(SRW-6,0.05,SRW-6,KIT.glow(0x2a1840,0.5)),0,0.06,0)); // floor glow
  [[0,-SRW/2,SRW,1.5],[0,SRW/2,SRW,1.5],[-SRW/2,0,1.5,SRW],[SRW/2,0,1.5,SRW]].forEach(w=> r.add(KIT.at(KIT.box(w[2],SRH,w[3],blackO),w[0],SRH/2,w[1])));
  // arrival pad + light
  r.add(KIT.at(new T.Mesh(new T.CylinderGeometry(3.2,3.2,0.2,32),KIT.glow(0xb24bff,1.2)),0,0.14,8));
  const padL=new T.PointLight(0xb24bff,1.0,30); padL.position.set(0,4,8); r.add(padL);
  worldAnims.push((t)=>{ padL.intensity=0.8+Math.sin(t*3)*0.4; });
  // hidden messages (readable only inside, looking around)
  const addMsg=(x,y,z,ry,text,col)=>{ const m=new T.Mesh(new T.PlaneGeometry(20,5), new T.MeshBasicMaterial({map:KIT.label(text,col),transparent:true,depthWrite:false})); m.position.set(x,y,z); m.rotation.y=ry; r.add(m); };
  addMsg(0,22,-SRW/2+1.2,0,'THE PINGAS SEES ALL','#ff66cc');
  addMsg(0,26,-SRW/2+1.2,0,'YOU WERE NEVER MEANT TO LEAVE','#7df0ff');
  addMsg(SRW/2-1.2,18,0,-Math.PI/2,'SUPER · PACK · A · PINGAS','#ff66cc');
  // SUPER PACK-A-PINGAS machine (interact = super-upgrade your held gun)
  const sm=new T.Group(); sm.position.set(0,0,-14); r.add(sm);
  sm.add(KIT.at(KIT.box(3,4.6,1.7,KIT.mat(0x140a20,0.5,0.35)),0,2.3,0));
  sm.add(KIT.at(KIT.box(3.25,0.5,1.85,KIT.mat(0xd8a93a,0.4,0.6)),0,4.7,0));
  sm.add(KIT.at(KIT.box(2.5,1.8,0.25,KIT.glow(0xffd24a,0.5)),0,3.0,0.78));
  const lbl=new T.Mesh(new T.PlaneGeometry(2.7,0.9), new T.MeshBasicMaterial({map:KIT.labelLines(['SUPER','PACK·A·PINGAS'],'#ffd24a'),transparent:true})); lbl.position.set(0,4.2,0.95); sm.add(lbl);
  const spot=new T.SpotLight(0xffd24a,1.4,80,0.7,0.5); spot.position.set(SRX,SRY+SRH-6,SRZ-4); spot.target.position.set(SRX,SRY+4,SRZ-14); scene.add(spot); scene.add(spot.target);
  // interactables (world coords; nothing else lives at x≈300 so no false triggers)
  addInteractable({ x:SRX, z:SRZ-14, collide:0, type:'superpingas',
    label:()=> ({key:'F', txt:'SUPER PACK-A-PINGAS (free)', cost:0}),
    run:()=>{ const w=curW(); if(!w||w.superUpgrade){ toast('ALREADY SUPER','','#ffd24a'); return false; } applySuperUpgrade(); toast('SUPER UPGRADE','your gun is reforged','#ffd24a'); return true; } });
  addInteractable({ x:SRX, z:SRZ+8, collide:0, type:'skyexit',
    label:()=> ({key:'F', txt:'Return to the world', cost:0}),
    run:()=>{ exitSkyRoom(); return true; } });
}
function enterSkyRoom(){ if(G.inSkyRoom) return; G.skyReturn={x:camera.position.x, z:camera.position.z};
  G.inSkyRoom=true; G.portalDwell=0; if(G.driving) toggleDrive(); if(G.mounted) toggleMount();
  camera.position.set(SRX, SRY+EYE, SRZ+8); G.eyeY=SRY+EYE; G.footY=SRY; G.vy=0;
  AU&&AU.power&&AU.power(); toast('🌀 THE SKY ROOM','dwelled into the portal · F to return','#b24bff'); }
function exitSkyRoom(){ if(!G.inSkyRoom) return; G.inSkyRoom=false;
  const rp=G.skyReturn||{x:round25Gate?round25Gate.x:CAMP_X, z:round25Gate?round25Gate.z+10:CAMP_Z};
  camera.position.set(rp.x, EYE, rp.z); G.eyeY=EYE; G.footY=0; G.vy=0; G.portalDwell=0;
  AU&&AU.buy&&AU.buy(); toast('RETURNED','','#b24bff'); }

// ════════ RADIO-TOWER EASTER EGG — shoot all 4 balls → the pyramid awakens ════════
function checkRadioHit(){ if(!radioBalls.length) return;
  camera.getWorldDirection(_dir);
  const ox=camera.position.x, oy=camera.position.y, oz=camera.position.z;
  let best=null, bd=260;
  for(const rb of radioBalls){ if(rb.lit) continue; const t=sphereT(ox,oy,oz,_dir.x,_dir.y,_dir.z,rb.x,rb.y,rb.z,rb.r,bd); if(t>0&&t<bd){ bd=t; best=rb; } }
  if(best){ best.lit=true; best.grp.userData.setLit(true); if(AU&&AU.hit)AU.hit();
    const n=radioBalls.filter(r=>r.lit).length;
    if(n>=4) radioEasterEgg(); else toast('RADIO BALL '+n+'/4','light all 4 towers by the pyramid','#3fc8ff'); }
}
function radioEasterEgg(){
  const px=12, pz=80;
  for(let i=0;i<6;i++) fxExplosion(px+(Math.random()-0.5)*42, 8+Math.random()*44, pz+(Math.random()-0.5)*42, 0x3fc8ff, 1.2);
  G.instaKill=clock.elapsedTime+30; G.fireRateBuff=clock.elapsedTime+60;
  G.weapons.forEach(w=>{ w.ammo=w.mag; w.reserve=Math.max(w.reserve, w.mag*4); }); updateAmmoHUD();
  if(AU&&AU.power)AU.power(); toast('⚡ THE PYRAMID AWAKENS','insta-kill 30s + 2× fire-rate 60s','#3fc8ff');
}

function buildTower(){
  const wallMat=new T.MeshStandardMaterial({color:0x22262b,roughness:0.96,metalness:0.05});
  const bandMat=new T.MeshStandardMaterial({color:0x171b1f,roughness:0.9,metalness:0.1});
  const trimMat=new T.MeshStandardMaterial({color:0x2c3138,roughness:0.8,metalness:0.2});
  const BH=TOWER_H, H=TOWER_TALL, FLOORS=10, FH=H/FLOORS, DOORW=8;
  const wallSeg=(w,x,z,ry)=>{ const m=new T.Mesh(new T.BoxGeometry(w,H,1.4),wallMat);
    m.position.set(x,H/2,z); m.rotation.y=ry; m.castShadow=true; m.receiveShadow=true; buildRoot.add(m); };
  const sideW=(BH*2-DOORW)/2;
  wallSeg(sideW, -(DOORW/2+sideW/2), BH, 0);
  wallSeg(sideW,  (DOORW/2+sideW/2), BH, 0);
  { const lin=new T.Mesh(new T.BoxGeometry(DOORW+1.2,5,1.5),wallMat); lin.position.set(0,H-2.5,BH); lin.castShadow=true; buildRoot.add(lin); }
  wallSeg(BH*2,0,-BH,0); wallSeg(BH*2,-BH,0,Math.PI/2); wallSeg(BH*2,BH,0,Math.PI/2);
  for(let f=1;f<FLOORS;f++){ const y=f*FH;
    [[0,BH],[0,-BH]].forEach(p=>{ const bd=new T.Mesh(new T.BoxGeometry(BH*2+0.6,0.5,1.7),bandMat); bd.position.set(p[0],y,p[1]); buildRoot.add(bd); });
    [[BH,0],[-BH,0]].forEach(p=>{ const bd=new T.Mesh(new T.BoxGeometry(1.7,0.5,BH*2+0.6),bandMat); bd.position.set(p[0],y,p[1]); buildRoot.add(bd); }); }
  [[BH,BH],[-BH,BH],[BH,-BH],[-BH,-BH]].forEach(p=>{ const pil=new T.Mesh(new T.BoxGeometry(2.4,H,2.4),trimMat); pil.position.set(p[0],H/2,p[1]); pil.castShadow=true; buildRoot.add(pil); });
  [[0,BH],[0,-BH]].forEach(p=>{ const pr=new T.Mesh(new T.BoxGeometry(BH*2+2,1.6,2.2),trimMat); pr.position.set(p[0],H+0.6,p[1]); buildRoot.add(pr); });
  [[BH,0],[-BH,0]].forEach(p=>{ const pr=new T.Mesh(new T.BoxGeometry(2.2,1.6,BH*2+2),trimMat); pr.position.set(p[0],H+0.6,p[1]); buildRoot.add(pr); });
  // NOTE: the solid roof slab is gone — the walkable roof (with a central stairwell hole)
  // is built in buildTowerInterior() so you can climb up through it and back down.
  // glowing doorway frame + steps
  buildRoot.add(KIT.at(KIT.box(DOORW+0.6,0.4,3,KIT.glow(KIT.accentHex,0.5)),0,0.2,BH+1.6));
  [0,1,2].forEach(i=> buildRoot.add(KIT.at(KIT.box(DOORW+2-i*0.6,0.4,1.0,KIT.mat(0x20242a,0.9,0)),0,0.2,BH+2.4+i*1.0)));
  const enter=new T.Mesh(new T.PlaneGeometry(7,1.2), new T.MeshBasicMaterial({map:KIT.label('TOWER','#cdbfff'),transparent:true}));
  enter.position.set(0,7,BH+0.86); buildRoot.add(enter);
  // swinging door
  const doorPivot=new T.Group(); doorPivot.position.set(-DOORW/2,0,BH);
  const door=KIT.box(DOORW,7.5,0.3, KIT.mat(0x3a2a1b,0.85,0)); door.position.set(DOORW/2,3.75,0); doorPivot.add(door);
  for(let i=0;i<4;i++) doorPivot.add(KIT.at(KIT.box(DOORW+0.2,0.26,0.34,KIT.mat(0x2c2014,0.85,0)),DOORW/2,1.0+i*1.9,0));
  KIT.shadow(doorPivot); buildRoot.add(doorPivot); towerDoorPivot=doorPivot;
}

let roofBarrier=null, roofOpen=false; // barrier at the top of the stairs → roof deck
const stairGates=[];                   // barricades partway up the spiral {h, a, cleared, grp}
function climbCap(){ let c=Infinity; for(const g of stairGates){ if(!g.cleared && g.h<c) c=g.h; } return c; }
const wallDogs=[];                     // werewolf wall mounts {grp, x,y,z, zone, hr, kind}

function buildTowerInterior(){
  // INTERIOR: ground floor, central column, walkable spiral staircase, roof deck + barrier.
  const wallMat=new T.MeshStandardMaterial({color:0x1a1e22,roughness:0.94,metalness:0.08});
  const floorMat=new T.MeshStandardMaterial({color:0x2a2e32,roughness:0.97});
  const stepMat=new T.MeshStandardMaterial({color:0x3a4048,roughness:0.8,metalness:0.18});
  const BH=TOWER_H, H=TOWER_TALL;

  // interior ground floor
  const gfloor=new T.Mesh(new T.CircleGeometry(BH-1,32),floorMat);
  gfloor.rotation.x=-Math.PI/2; gfloor.position.y=0.04; gfloor.receiveShadow=true; buildRoot.add(gfloor);

  // central column the spiral wraps around (also a collider via STAIR_RIN)
  const col=new T.Mesh(new T.CylinderGeometry(STAIR_RIN-0.4,STAIR_RIN-0.4,H+2,16),wallMat);
  col.position.set(0,(H+2)/2,0); col.castShadow=true; col.receiveShadow=true; buildRoot.add(col);

  // SPIRAL STAIRCASE — instanced steps along the helix the height-field walks on (1 draw call)
  const STEPS=Math.round(STAIR_TURNS*28); // ~28 steps per revolution
  const stepGeo=new T.BoxGeometry(STAIR_ROUT-STAIR_RIN,0.3,1.7);
  const steps=new T.InstancedMesh(stepGeo,stepMat,STEPS+1);
  const postGeo=new T.BoxGeometry(0.2,1.1,0.2);
  const nPosts=Math.floor(STEPS/4)+1;
  const posts=new T.InstancedMesh(postGeo,wallMat,nPosts);
  { const m=new T.Matrix4(), q=new T.Quaternion(), sc=new T.Vector3(1,1,1), eu=new T.Euler(); let pi=0;
    for(let i=0;i<=STEPS;i++){
      const frac=i/STEPS, a=frac*STAIR_TURNS*Math.PI*2, y=frac*STAIR_TOP;
      eu.set(0,-a,0); q.setFromEuler(eu);
      _v1.set(Math.cos(a)*STAIR_RMID, y, Math.sin(a)*STAIR_RMID); m.compose(_v1,q,sc); steps.setMatrixAt(i,m);
      if(i%4===0 && pi<nPosts){ q.identity();
        _v1.set(Math.cos(a)*(STAIR_ROUT-0.3), y+0.7, Math.sin(a)*(STAIR_ROUT-0.3)); m.compose(_v1,q,sc); posts.setMatrixAt(pi++,m); }
    } }
  steps.castShadow=steps.receiveShadow=true; buildRoot.add(steps);
  posts.castShadow=true; buildRoot.add(posts);

  // STAIRCASE BARRICADES — block the climb partway up until you pay to clear them.
  stairGates.length=0;
  [[STAIR_TOP*0.34, 1500],[STAIR_TOP*0.67, 2500]].forEach(([h,cost],gi)=>{
    const a=(h/STAIR_PITCH)*Math.PI*2;                  // helix angle at this height
    const cx=Math.cos(a)*STAIR_RMID, cz=Math.sin(a)*STAIR_RMID;
    const grp=new T.Group(); grp.position.set(cx,h,cz); grp.rotation.y=-a;
    const pm=new T.MeshStandardMaterial({color:0x5a3a1f,roughness:0.85});
    for(let i=0;i<4;i++){ const plank=new T.Mesh(new T.BoxGeometry(STAIR_ROUT-STAIR_RIN,0.3,0.22),pm);
      plank.position.set(0,0.5+i*0.6,0); plank.rotation.z=(i%2?1:-1)*0.05; grp.add(plank); }
    [-1,1].forEach(s=> grp.add(KIT.at(new T.Mesh(new T.BoxGeometry(0.25,2.4,0.25),pm),s*(STAIR_ROUT-STAIR_RIN)/2,1.2,0)));
    grp.add(KIT.at(new T.Mesh(new T.PlaneGeometry(2.2,0.6),
      new T.MeshBasicMaterial({map:KIT.label('$'+cost,'#ffe9a0'),transparent:true,side:T.DoubleSide})),0,2.9,0));
    buildRoot.add(grp);
    const gate={h, a, cx, cz, cost, cleared:false, grp};
    stairGates.push(gate);
    addInteractable({ x:cx, z:cz, radius:4, type:'stairgate', cost, gate,
      label:()=>{ if(gate.cleared) return null; if(Math.abs((G.eyeY||0)-(h+EYE))>3) return null;
        return {key:'F', txt:'Clear Stair Barricade', cost}; },
      run:()=>{ if(gate.cleared) return false; if(Math.abs((G.eyeY||0)-(h+EYE))>3) return false;
        if(!spend(cost)) return false; gate.cleared=true; if(gate.grp) gate.grp.visible=false; AU.buy(); toast('STAIRWAY CLEARED','climb higher'); return true; } });
  });

  // ROOF DECK — a RING (flat roof with a central stairwell HOLE) so you climb up through it
  // and walk back down the same way. Top surface at STAIR_TOP+0.5 = the height-field roof level.
  const deckMat=new T.MeshStandardMaterial({color:0x2a2e32,roughness:0.97,side:T.DoubleSide});
  const deck=new T.Mesh(new T.RingGeometry(STAIR_ROUT, BH-1, 40), deckMat);
  deck.rotation.x=-Math.PI/2; deck.position.y=STAIR_TOP+0.5; deck.receiveShadow=true; buildRoot.add(deck);
  // parapet rails around the OUTER edge (waist-high, four sides)
  const railGeo=new T.BoxGeometry((BH-1)*1.6,1.0,0.3);
  [0,Math.PI/2,Math.PI,Math.PI*1.5].forEach(a=>{
    const rail=new T.Mesh(railGeo,wallMat);
    rail.position.set(Math.cos(a)*(BH-1.2),STAIR_TOP+1.0,Math.sin(a)*(BH-1.2));
    rail.rotation.y=a; rail.castShadow=true; buildRoot.add(rail);
  });
  G.rooftopY = STAIR_TOP+0.5;

  // interior lighting (2 static lamps, no flicker) so the climb reads clearly
  const lampMat=KIT.glow(0xffd9a0,1.6);
  [[0,4,STAIR_RMID+2],[0,STAIR_TOP-3,-STAIR_RMID-2]].forEach(p=>{
    const lp=new T.PointLight(0xffce8a,1.5,34,2); lp.position.set(p[0],p[1],p[2]); buildRoot.add(lp);
    const bulb=new T.Mesh(new T.SphereGeometry(0.3,8,8),lampMat); bulb.position.set(p[0],p[1],p[2]); buildRoot.add(bulb);
  });

  // ROOF BARRICADE — a fence ringing the hole rim. Blocks you from stepping out onto the roof
  // (enforced by clampArena) until you pay; then it drops away, revealing the open hole.
  const bgrp=new T.Group();   // pivots from y=0; whole fence sits at the rim
  const barMat=new T.MeshStandardMaterial({color:0x4a3525,roughness:0.85});
  const NB=22;
  for(let i=0;i<NB;i++){ const a=i/NB*Math.PI*2;
    const bar=new T.Mesh(new T.BoxGeometry(0.2,2.0,0.2),barMat);
    bar.position.set(Math.cos(a)*(STAIR_ROUT+0.1),STAIR_TOP+1.0,Math.sin(a)*(STAIR_ROUT+0.1)); bgrp.add(bar);
    if(i%2===0){ const rail=new T.Mesh(new T.BoxGeometry(0.12,0.12,2*Math.PI*STAIR_ROUT/NB*1.05),barMat);
      rail.position.set(Math.cos(a)*(STAIR_ROUT+0.1),STAIR_TOP+1.6,Math.sin(a)*(STAIR_ROUT+0.1)); rail.rotation.y=-a; bgrp.add(rail); } }
  bgrp.add(KIT.at(new T.Mesh(new T.PlaneGeometry(3.4,0.8),
    new T.MeshBasicMaterial({map:KIT.label('ROOF 3000','#ffe9a0'),transparent:true,side:T.DoubleSide})),0,STAIR_TOP+2.6,STAIR_ROUT+0.2));
  buildRoot.add(bgrp); roofBarrier=bgrp;

  // interact gate to the roof — prompt shows only when you're up at the top of the stairs
  addInteractable({ x:0, z:0, radius:STAIR_ROUT+2, type:'roofgate', cost:3000,
    label:()=> (roofOpen || camera.position.y < STAIR_TOP-6) ? null : {key:'F', txt:'Clear Roof Barricade', cost:3000},
    run:()=>{ if(roofOpen) return false; if(camera.position.y<STAIR_TOP-6) return false; if(!spend(3000)) return false; roofOpen=true; AU.buy();
      toast('ROOF UNLOCKED','the rooftop opens up'); return true; } });
}

/* Height of the walkable floor at (x,z), resolving which spiral loop you're on via refY.
   Candidates: ground floor (0), the spiral ramp loops, and the roof deck. We pick the HIGHEST
   surface you can step onto (≤ refY+STEP_UP) — so the gently-rising stairs win over the flat
   floor beneath them (you climb), but you never teleport up more than one step. */
const STEP_UP=1.7;
function groundPlusBlocks(base,x,z,cap){ // stand on top of placed build blocks
  if(typeof placedBlocks==='undefined' || !placedBlocks.size) return base;
  const bt=blockTopColumn(x,z,cap); return bt>base?bt:base; }
function groundHeightAt(x,z, refY){
  if(G.inSkyRoom) return SRY;                                // standing on the sky-room floor
  const lx=x-CAMP_X, lz=z-CAMP_Z;                            // tower/stairs are CAMP-LOCAL
  if(Math.abs(lx)>=TOWER_H || Math.abs(lz)>=TOWER_H) return groundPlusBlocks(0,x,z,(refY||0)+STEP_UP); // outside tower → open ground (+ build blocks)
  refY=refY||0;
  const r=Math.hypot(lx,lz), cap=refY+STEP_UP;
  let best=0;                                                // ground floor: always underfoot
  // spiral ramp (annulus only)
  if(r>=STAIR_RIN && r<=STAIR_ROUT){
    let th=Math.atan2(lz,lx); if(th<0) th+=Math.PI*2;        // 0..2π
    const maxK=Math.ceil(STAIR_TURNS)+1;
    for(let k=0;k<=maxK;k++){
      const h=((th+k*Math.PI*2)/(Math.PI*2))*STAIR_PITCH;
      if(h>STAIR_TOP+0.5) break;
      if(h<=cap && h>best) best=h;                           // highest reachable step
    }
  }
  // roof deck is a RING around the central stairwell hole (r in [STAIR_ROUT, TOWER_H-1]);
  // the hole itself (r<STAIR_ROUT) stays open so the stairs emerge through it
  if(r>=STAIR_ROUT && r<=TOWER_H-1){ const h=STAIR_TOP+0.5; if(h<=cap && h>best) best=h; }
  // uncleared staircase barricades cap how high you can climb
  const cc=climbCap(); if(best>cc) best=cc;
  return groundPlusBlocks(best,x,z,cap);
}
// raw spiral height at (x,z) nearest refY (ignores barricade cap) — used to block stepping past a gate
function spiralHeightAt(x,z, refY){
  const lx=x-CAMP_X, lz=z-CAMP_Z;
  const r=Math.hypot(lx,lz); if(r<STAIR_RIN||r>STAIR_ROUT) return 0;
  refY=refY||0; const cap=refY+STEP_UP; let best=0;
  let th=Math.atan2(lz,lx); if(th<0) th+=Math.PI*2;
  const maxK=Math.ceil(STAIR_TURNS)+1;
  for(let k=0;k<=maxK;k++){ const h=((th+k*Math.PI*2)/(Math.PI*2))*STAIR_PITCH;
    if(h>STAIR_TOP+0.5) break; if(h<=cap && h>best) best=h; }
  return best;
}

function buildBoundaryAndForest(){
  // OUTER FENCE — instanced posts + rails (hundreds → 2 draw calls)
  const FR=60.5, seg=96;
  const postGeo=new T.BoxGeometry(0.16,1.3,0.16);
  const railGeo=new T.BoxGeometry(0.08,0.08,FR*2*Math.PI/seg*1.06);
  const fenceMat=new T.MeshStandardMaterial({color:0x3a2c1a,roughness:0.9});
  const posts=new T.InstancedMesh(postGeo,fenceMat,seg);
  const rails=new T.InstancedMesh(railGeo,fenceMat,seg*2);
  const m=new T.Matrix4(), q=new T.Quaternion(), s=new T.Vector3(1,1,1), e=new T.Euler();
  let ri=0;
  for(let i=0;i<seg;i++){ const a=i/seg*Math.PI*2;
    _v1.set(Math.cos(a)*FR,0.62,Math.sin(a)*FR); m.compose(_v1,q,s); posts.setMatrixAt(i,m);
    const a2=(i+1)/seg*Math.PI*2, mx=(Math.cos(a)+Math.cos(a2))/2*FR, mz=(Math.sin(a)+Math.sin(a2))/2*FR;
    const ry=-Math.atan2(Math.cos(a2)-Math.cos(a),Math.sin(a2)-Math.sin(a));
    [0.5,0.95].forEach(yy=>{ e.set(0,ry,0); q.setFromEuler(e); _v1.set(mx,yy,mz); m.compose(_v1,q,s); rails.setMatrixAt(ri++,m); }); q.identity(); }
  posts.castShadow=rails.castShadow=true; buildRoot.add(posts); buildRoot.add(rails);

  // BOULDERS — instanced
  const bGeo=new T.DodecahedronGeometry(1,0); const bMat=new T.MeshStandardMaterial({color:0x2a2e30,roughness:0.97,metalness:0.1});
  const bN=40, boulders=new T.InstancedMesh(bGeo,bMat,bN);
  for(let i=0;i<bN;i++){ const a=(i/bN)*Math.PI*2+0.1, r=57+Math.random()*1.5, sc=0.8+Math.random()*0.8;
    s.set(sc,sc*0.8,sc); e.set(0,Math.random()*Math.PI,0); q.setFromEuler(e); _v1.set(Math.cos(a)*r,sc*0.4,Math.sin(a)*r);
    m.compose(_v1,q,s); boulders.setMatrixAt(i,m); } q.identity(); s.set(1,1,1);
  boulders.castShadow=boulders.receiveShadow=true; buildRoot.add(boulders);

  // FOREST — instanced merged trees beyond the fence
  const treeGeo=mergedTreeGeometry();
  const treeMat=new T.MeshStandardMaterial({vertexColors:true, roughness:0.95});
  const tN=320, trees=new T.InstancedMesh(treeGeo,treeMat,tN);
  for(let i=0;i<tN;i++){ const a=Math.random()*Math.PI*2, r=64+Math.random()*70, sc=0.9+Math.random()*1.8;
    s.set(sc,sc,sc); e.set(0,Math.random()*Math.PI,0); q.setFromEuler(e); _v1.set(Math.cos(a)*r,0,Math.sin(a)*r);
    m.compose(_v1,q,s); trees.setMatrixAt(i,m); } q.identity(); s.set(1,1,1);
  trees.castShadow=true; buildRoot.add(trees);
}

/* ════════════════════ MINECRAFT MINE ZONE ════════════════════
   A blocky mine precinct that EXTENDS the existing map (northwest open ground of
   the ring). Bulk terrain/trees are InstancedMesh (a few draw calls total); only
   the minable ore blocks are individual meshes so they can be shot + broken. */
const MINE = { cx:-40, cz:-34, R:6.5 };     // center + footprint radius (walkable ring, off the stations)
function buildMineZone(){
  const cube=new T.BoxGeometry(1,1,1);
  const grassMat=new T.MeshStandardMaterial({color:0x4a7a32,roughness:0.95});
  const dirtMat =new T.MeshStandardMaterial({color:0x6b4a2a,roughness:0.97});
  const stoneMat=new T.MeshStandardMaterial({color:0x6b6b6b,roughness:0.96});
  const logMat  =new T.MeshStandardMaterial({color:0x6b4a2a,roughness:0.95});
  const leafMat =new T.MeshStandardMaterial({color:0x3a7a2a,roughness:0.9});
  const grass=[], dirt=[], stone=[], logs=[], leaves=[];
  const C=MINE;
  // stepped blocky mesa (top is grass, body dirt, buried stone) — a landmark you fight around
  for(let gx=-5;gx<=5;gx++) for(let gz=-5;gz<=5;gz++){
    const d=Math.hypot(gx,gz); if(d>5.4) continue;
    const h=Math.max(1, Math.round(4 - d*0.62));
    for(let y=0;y<h;y++) (y===h-1?grass:dirt).push([C.cx+gx, y+0.5, C.cz+gz]);
    stone.push([C.cx+gx,-0.5,C.cz+gz]);
  }
  // mine entrance: a dark stone-arched shaft cut into the south face of the mesa
  for(let y=0;y<4;y++) for(let bx=-2;bx<=2;bx++){
    if(y<3 && bx>-2 && bx<2) continue;                 // hollow doorway
    stone.push([C.cx+bx, y+0.5, C.cz+5.5]); }
  const back=new T.Mesh(new T.PlaneGeometry(3,3), new T.MeshBasicMaterial({color:0x05070a}));
  back.position.set(C.cx,1.5,C.cz+5.05); back.rotation.y=Math.PI; buildRoot.add(back);
  // a couple of blocky trees flanking the mine
  [[-8,4],[7,6],[9,-3]].forEach(([tx,tz])=>{
    for(let y=0;y<4;y++) logs.push([C.cx+tx,y+0.5,C.cz+tz]);
    for(let lx=-1;lx<=1;lx++) for(let lz=-1;lz<=1;lz++) for(let ly=0;ly<2;ly++){
      if(lx===0&&lz===0&&ly===0) continue; leaves.push([C.cx+tx+lx,4.5+ly,C.cz+tz+lz]); }
    leaves.push([C.cx+tx,6.5,C.cz+tz]);
  });
  const mk=(arr,mat)=>{ if(!arr.length) return; const im=new T.InstancedMesh(cube,mat,arr.length); const m=new T.Matrix4();
    arr.forEach((p,i)=>{ m.makeTranslation(p[0],p[1],p[2]); im.setMatrixAt(i,m); });
    im.instanceMatrix.needsUpdate=true; im.castShadow=im.receiveShadow=true; buildRoot.add(im); };
  mk(grass,grassMat); mk(dirt,dirtMat); mk(stone,stoneMat); mk(logs,logMat); mk(leaves,leafMat);
  // collider so the player + enemies path AROUND the mesa (anti-stuck routing handles the rest)
  colliders.push({x:C.cx, z:C.cz, r:C.R});
  // minable ore blocks studded around the base (individual meshes — shoot to break)
  const ores=[ ['coal',60],['iron',90],['iron',90],['gold',160],['redstone',140],['diamond',260],['emerald',220],['gold',160] ];
  for(let i=0;i<ores.length;i++){ const [kind,reward]=ores[i]; const a=i/ores.length*Math.PI*2;
    const r=C.R+1.0, x=C.cx+Math.cos(a)*r, z=C.cz+Math.sin(a)*r;
    const grp=KIT.makeOreBlock(kind); grp.position.set(x,0.5,z); KIT.shadow(grp); buildRoot.add(grp);
    const hp = 80 + reward*0.6;
    oreBlocks.push({grp, x, y:0.9, z, r:0.85, hp, maxhp:hp, reward, kind, glow:grp.userData.glow, alive:true, respawn:0});
  }
}
function damageOre(o, dmg){
  if(!o.alive) return; o.hp-=dmg;
  if(o.hp<=0){ o.alive=false; o.grp.visible=false; o.respawn=clock.elapsedTime+18;
    fxExplosion(o.x,o.y,o.z, o.kind==='diamond'?0x6ff0ff:o.kind==='emerald'?0x2ee06a:0xffb060, 0.6);
    AU.buy(); addPoints(o.reward); mcOnMined(o.kind); toast('MINED '+o.kind.toUpperCase(),'+'+o.reward,'#7fd0ff'); }
}
function updateOre(dt){
  const et=clock.elapsedTime;
  for(let i=0;i<oreBlocks.length;i++){ const o=oreBlocks[i];
    if(!o.alive){ if(o.respawn && et>=o.respawn){ o.alive=true; o.hp=o.maxhp; o.respawn=0; o.grp.visible=true; } continue; }
    if(o.glow) o.glow.emissiveIntensity = 1.4 + Math.sin(et*2.5 + i)*0.5;   // gentle pulse
  }
}

// add a capped flickering point light (campfire/lantern)
function addFireLight(x,z){
  if(pointLights.length>=7) return;
  const g=new T.Group();
  const flame=new T.Mesh(new T.ConeGeometry(0.5,1.4,8), KIT.glow(0xff8a1e,2.1)); flame.position.y=0.85; g.add(flame);
  for(let i=0;i<6;i++){ const a=i/6*Math.PI*2; g.add(KIT.at(KIT.box(0.4,0.28,0.4,KIT.mat(0x3a3a3a,0.95,0)),Math.cos(a)*1.0,0.14,Math.sin(a)*1.0)); }
  g.position.set(x,0,z); buildRoot.add(g);
  const lp=new T.PointLight(0xff7a2a,2.2,20,2); lp.position.set(x,1.4,z); buildRoot.add(lp);
  pointLights.push({light:lp, flame, base:2.2, ph:x});
  colliders.push({x:campWX(x),z:campWZ(z),r:1.4});
}

window.__SE = { pap:false }; // kit's makeArms reads window.__SE for pap occasionally

let SCENE_READY=false;
function buildEverything(){
  buildWorld();
  initEnemyPools();
  buildPlayerArms();
  SCENE_READY=true;
}

/* ════════════════════ STATIONS / INTERACTABLES ════════════════════ */
function pos(deg){ return [Math.cos(deg*Math.PI/180)*52, Math.sin(deg*Math.PI/180)*52]; }
// smallest angular distance (degrees) between two bearings
function angDist(a,b){ let d=Math.abs((a-b)%360); if(d>180) d=360-d; return d; }
// unlock spawn points near a bearing (called when a gate/area opens)
function unlockSpawnsNear(deg){ if(!G.spawnPoints) return;
  for(const sp of G.spawnPoints){ if(angDist(sp.deg,deg)<46) sp.locked=false; } }
// which zone is the player in — controls where zombies spawn so there's always action nearby
function playerZone(){
  const y=G.eyeY||EYE;
  if(y > STAIR_TOP-4) return 'roof';
  if(Math.abs(camera.position.x-CAMP_X)<TOWER_H && Math.abs(camera.position.z-CAMP_Z)<TOWER_H && y<10) return 'inside';
  return 'outside';
}
/* ── Player-relative spawning (multiplayer-ready) ──────────────────────────────
   Spawn origins are derived from the LIVE player position(s) + walkable space, not
   fixed map coordinates, so the system survives map edits. Zombies appear in a ring
   AROUND the targeted player — never close (COD-zombies feel), never inside the tower
   body, never in a region you haven't unlocked yet. */
const SPAWN_RING = { outside:[20,42], inside:[10,20], roof:[10,22] };  // [min,max] spawn distance

// MULTIPLAYER HOOK: the live player list. Single-player today (the local camera); when
// co-op lands, push the other players onto G.players and the director splits the horde
// across them by equal share (1p=100%, 2p=50/50, 3p≈33/33/34, …) — no other changes.
function getPlayers(){
  return (G.players && G.players.length) ? G.players
       : [{ x:camera.position.x, z:camera.position.z, eyeY:(G.eyeY||EYE), zone:playerZone() }];
}
function spawnTargetPlayer(){ const ps=getPlayers(); return ps[(Math.random()*ps.length)|0]; }

// is the outdoor arc at this point still locked (gated) ? — keeps spawns out of areas
// you haven't paid into yet.
function regionLockedAt(x,z){
  if(!G.spawnPoints) return false;
  const deg=Math.atan2(z-CAMP_Z, x-CAMP_X)*180/Math.PI;
  let near=null, best=1e9;
  for(const s of G.spawnPoints){ if(s.zone!=='outside') continue;
    const d=angDist(s.deg,deg); if(d<best){ best=d; near=s; } }
  return near ? near.locked : false;
}
// is (x,z) a legal standing spot for an enemy in this zone (walkable, unlocked) ?
function spawnValid(x,z,zone){
  if(Math.abs(x)>WB-4 || Math.abs(z)>WB-4) return false;              // inside the world box
  const lx=x-CAMP_X, lz=z-CAMP_Z, r=Math.hypot(lx,lz);
  if(zone==='outside'){
    if(Math.abs(lx)<TOWER_H+1 && Math.abs(lz)<TOWER_H+1) return false; // not in the tower body
    // keep spawns where the player can actually reach them: on the camp ring road, OR inside the
    // Minecraft compound once the mega-gate is open. Never out in the open green no-man's-land.
    const inCampRing = r>TOWER_H+1.5 && r<R_OUT-2;
    const inMcZone   = megaGate && megaGate.open && Math.abs(x-MCX)<MH-4 && Math.abs(z-MCZ)<MH-4;
    if(!inCampRing && !inMcZone) return false;
    if(regionLockedAt(x,z)) return false;                             // not in a locked arc
  } else if(zone==='inside'){
    if(r<STAIR_RIN+1 || r>TOWER_H-2) return false;                    // in the room, off the column
  } else if(zone==='roof'){
    if(r<STAIR_ROUT+1.5 || r>TOWER_H-2.5) return false;               // on the deck ring
  }
  return true;
}
// choose a spawn origin in a RING around a targeted player; never on top of anyone,
// never in the tower body, never in a locked region. Falls back to the nearest unlocked
// fixed spawn point if the random ring can't find a clear spot.
function pickSpawn(){
  const tp=spawnTargetPlayer(), zone=tp.zone||'outside';
  const [minD,maxD]=SPAWN_RING[zone]||SPAWN_RING.outside;
  const ps=getPlayers();
  const baseY = zone==='roof' ? (STAIR_TOP+0.5) : 0;
  for(let tries=0;tries<14;tries++){
    const a=Math.random()*Math.PI*2, d=minD+Math.random()*(maxD-minD);
    const x=tp.x+Math.cos(a)*d, z=tp.z+Math.sin(a)*d;
    if(!spawnValid(x,z,zone)) continue;
    let ok=true; for(const p of ps){ if(Math.hypot(x-p.x,z-p.z)<minD){ ok=false; break; } }  // clear of every player
    if(ok) return [x,z,baseY,zone];
  }
  // fallback: nearest unlocked fixed spawn point in the zone (farthest-half, like before)
  const all=G.spawnPoints||[];
  let pool=all.filter(s=>s.zone===zone && !s.locked);
  if(!pool.length) pool=all.filter(s=>s.zone==='outside' && !s.locked);
  if(!pool.length) pool=all.slice();
  let cands=pool.filter(s=>Math.hypot(s.x-tp.x,s.z-tp.z)>minD); if(!cands.length) cands=pool;
  cands.sort((a,b)=>Math.hypot(b.x-tp.x,b.z-tp.z)-Math.hypot(a.x-tp.x,a.z-tp.z));
  const top=Math.max(1,Math.ceil(cands.length/2));
  const s=cands[(Math.random()*top)|0] || {x:46,z:0,zone:'outside',y:0};
  const jit = zone==='outside'?5:3;
  return [s.x+(Math.random()-0.5)*jit, s.z+(Math.random()-0.5)*jit, s.y||baseY, zone];
}

function addInteractable(o){ interactables.push(o);
  o.wx=campWX(o.x); o.wz=campWZ(o.z);                 // world position (camp-offset aware) for prompts/collision
  if(o.group){ KIT.shadow(o.group); buildRoot.add(o.group);}
  if(o.collide) colliders.push({x:o.wx,z:o.wz,r:o.collide}); return o; }

function buildStations(){
  // SOUTH spawn hub (deg 90 → +z): power, crate, PaP by the door, campfire, pickups
  const [sx,sz]=pos(90);
  addFireLight(sx-7,sz+3); addFireLight(sx+8,sz-3);

  // POWER (unlocks perks, door, and pack-a-pingas)
  { const g=KIT.makePowerMachine(); g.position.set(sx-9,0,sz-2); g.rotation.y=-2.4;
    addInteractable({group:g, x:sx-9, z:sz-2, radius:3.2, collide:1.2, type:'power',
      label:()=> G.powerOn?null:{key:'F', txt:'Restore POWER', cost:0},
      run:()=>{ if(G.powerOn) return false; G.powerOn=true; AU.power(); toast('POWER ONLINE','perks & door unlocked'); return true; },
      anim:g.userData.update }); }
  // MYSTERY CRATE
  { const g=KIT.makeCrate(); g.scale.setScalar(1.3); g.position.set(sx+7,0,sz+2);
    addInteractable({group:g, x:sx+7, z:sz+2, radius:3.0, collide:1.1, type:'crate', cost:950,
      label:()=>({key:'F', txt:'Mystery Crate', cost:950}),
      run:()=> mysteryCrate(), anim:g.userData.update }); }
  // PACK-A-PINGAS (by the door)
  { const g=KIT.makePingasMachine(); g.scale.setScalar(1.25); g.position.set(9,0,TOWER_H+7); g.rotation.y=Math.PI;
    addInteractable({group:g, x:9, z:TOWER_H+7, radius:3.4, collide:1.3, type:'pap', cost:5000,
      label:()=>{ if(!G.powerOn) return {key:'F', txt:'Pack-a-Pingas (needs power)', cost:0, cant:true};
        const w=G.weapons[G.cur]; if(!w) return null; if(w.pap) return {key:'F', txt:'Already Pingas-Punched', cost:0, cant:true};
        return {key:'F', txt:'Pack-a-Pingas', cost:5000}; },
      run:()=> packAPunch(), anim:g.userData.update }); }
  // TOWER DOOR — power alone unlocks entry (free to open once power is on)
  addInteractable({ x:0, z:TOWER_H, radius:5, type:'door',
    label:()=>{ if(!G.powerOn) return {key:'F', txt:'Tower Door (needs power)', cost:0, cant:true};
      if(doorOpen) return null;
      return {key:'F', txt:'Enter Tower', cost:0}; },
    run:()=>{ if(doorOpen||!G.powerOn) return false; doorOpen=true; AU.power();
      toast('TOWER OPEN','climb to the roof…'); return true; } });

  // Wall-buys around the hub + ring
  const wallSpec=[ [sx+11,sz-4,'smg',1000], [sx-12,sz+6,'shotgun',1500] ];
  wallSpec.forEach(([x,z,wt,cost])=> addWallBuy(x,z,wt,cost));

  // GATES (5 rising-price paywalls) gating outward stations
  const gateDefs=[ [126,750],[186,1500],[246,2000],[306,2500],[6,3000] ];
  const gates=gateDefs.map(([deg,price])=> addGate(deg,price));

  // SPAWN POINTS — fixed ring of zombie origins. Start: the southern hub arc is open;
  // opening a gate unlocks the spawn points in that region (never affects live zombies).
  G.spawnPoints=[];
  const NSP=12;
  for(let i=0;i<NSP;i++){ const deg=i*(360/NSP);
    const x=Math.cos(deg*Math.PI/180)*46, z=Math.sin(deg*Math.PI/180)*46;
    const dHub=angDist(deg,90);            // angular distance to the start hub (90°)
    G.spawnPoints.push({x:campWX(x),z:campWZ(z),deg,zone:'outside',y:0,locked:dHub>52}); }
  // interior ground-floor spawns (zombies appear in the room when you're inside)
  for(let i=0;i<5;i++){ const a=i/5*Math.PI*2; G.spawnPoints.push({x:campWX(Math.cos(a)*24),z:campWZ(Math.sin(a)*24),deg:0,zone:'inside',y:0,locked:false}); }
  // rooftop spawns (zombies to train near the roof dog when you're up top)
  for(let i=0;i<5;i++){ const a=i/5*Math.PI*2+0.3; G.spawnPoints.push({x:campWX(Math.cos(a)*26),z:campWZ(Math.sin(a)*26),deg:0,zone:'roof',y:STAIR_TOP+0.5,locked:false}); }

  // JUGGERNAUT PERK (early, south side, no gate)
  { const [x,z]=pos(90+20); const g=KIT.makePerkMachine(['JUGGERNAUT'],0x8B4513,0xff6b35);
    g.position.set(x,0,z); g.rotation.y=Math.atan2(x,z);
    addInteractable({group:g, x, z, radius:3.2, collide:1.2, type:'perk', perkId:'juggernaut', cost:2500, gate:null,
      label:()=>{ if(!G.powerOn) return {key:'F', txt:'Juggernaut (needs power)', cost:0, cant:true};
        if(G.perks.has('juggernaut')) return null; return {key:'F', txt:'Perk: JUGGERNAUT (2× HP)', cost:2500}; },
      run:()=> buyPerk('juggernaut',2500,0xff6b35), anim:g.userData.update }); }

  // PERK STATIONS (each behind progression, needs power)
  station(150,['DOUBLE','SHOT'],   0x9c2b2b,0x35d6ff,'doubleshot', gates[0]);
  station(210,['MUG ROOTBEER','METH'],0x6a3b1a,0xffa23a,'rootbeer',  gates[1]);
  station(330,['PINGAS','LIQUID'], 0x4a2a66,0xff48c0,'pingasliquid',gates[3]);

  // ROOFTOP STATIONS (mystery crate + pack-a-pingas on the roof deck).
  // NO ground-level collider (they're up high) and prompts only show when you're on the roof.
  const roofY=G.rooftopY||34, onRoof=()=> camera.position.y > STAIR_TOP-6;
  { const g=KIT.makeCrate(); g.scale.setScalar(1.2); g.position.set(0,roofY,-9);
    addInteractable({group:g, x:0, z:-9, radius:3.0, type:'crate', cost:950,
      label:()=> onRoof()?{key:'F', txt:'Mystery Crate', cost:950}:null,
      run:()=> onRoof() && mysteryCrate(), anim:g.userData.update }); }
  { const g=KIT.makePingasMachine(); g.scale.setScalar(1.25); g.position.set(0,roofY,9);
    addInteractable({group:g, x:0, z:9, radius:3.4, type:'pap', cost:5000,
      label:()=> onRoof()?{key:'F', txt:'Pack-a-Pingas', cost:5000}:null,
      run:()=> onRoof() && packAPunch(), anim:g.userData.update }); }
  // ROOF EGG ALTAR — pay to FORM the Royal Egg; it hatches into the Mega Pingas Boss (health bar)
  { const ex=-22, ez=0;
    const altar=KIT.box(4,1.2,4, KIT.mat(0x2a1a3a,0.8,0.2)); altar.position.set(ex,roofY+0.2,ez); buildRoot.add(altar);
    const orb=new T.Mesh(new T.SphereGeometry(0.6,12,12), KIT.glow(0xff48c0,1.8)); orb.position.set(ex,roofY+1.6,ez); buildRoot.add(orb);
    const al=new T.PointLight(0xff48c0,1.6,18,2); al.position.set(ex,roofY+2.4,ez); buildRoot.add(al);
    addInteractable({ x:ex, z:ez, radius:4.5, type:'eggaltar', cost:8000,
      label:()=>{ if(!onRoof()) return null; if(G.megaActive) return null;
        if(G.megaDefeated) return {key:'F', txt:'The egg lies shattered', cost:0, cant:true};
        return {key:'F', txt:'Form the Royal Egg', cost:8000}; },
      run:()=>{ if(!onRoof()||G.megaActive||G.megaDefeated) return false; if(!spend(8000)) return false;
        spawnMegaBoss(CAMP_X+ex, CAMP_Z+ez+6, roofY); return true; } }); }   // world coords (camp is offset)

  // BOSS YARD (north, deg 270): wall-buys + mini-boss spawns here
  { const [x,z]=pos(270); addFireLight(x,z+8);
    addWallBuy(x+9,z,'ak',2500); addWallBuy(x-9,z,'rifle',2000);
    G.bossYard={x:campWX(x),z:campWZ(z)}; }
  // East deep-woods (deg 30): lmg wall + wonder via crate only
  { const [x,z]=pos(30); addWallBuy(x,z+7,'lmg',6000); addFireLight(x+6,z); }

  buildWallDogs();
}

// Two werewolf wall-mounts you FEED by killing zombies nearby (same zone, within hr).
// #1 (ground floor) gives the Retriever Axe; #2 (roof) upgrades it.
function buildWallDogs(){
  wallDogs.length=0;
  const mk=(x,y,z,ry,zone,kind,max)=>{
    const g=KIT.makeWerewolf(); g.scale.setScalar(1.0); g.position.set(x,y,z); g.rotation.y=ry;
    g.userData.max=max; if(g.userData.feed) g.userData.feed(0);
    buildRoot.add(g);
    // accent light so the beast reads in the dark interior / on the roof
    const dl=new T.PointLight(0xffb060, 1.4, 16, 2); dl.position.set(x, y+1, z+3); buildRoot.add(dl);
    const dog={grp:g, ud:g.userData, x, y, z, zone, kind, hr:20, fed:0};
    wallDogs.push(dog);
    addInteractable({ x, z, radius:5, type:'walldog', dog,
      label:()=>{ if(dogPromptHidden(dog)) return null;
        if(!dog.ud.full) return {key:'F', txt:'Feed the beast — '+dog.ud.fed+'/'+dog.ud.max+' kills', cost:0, cant:true};
        if(kind==='give') return dog.ud.used?null:{key:'F', txt:'Take the RETRIEVER AXE', cost:0};
        // upgrade dog
        const ax=G.weapons.find(w=>w.type==='axe');
        if(!ax) return {key:'F', txt:'Need the Retriever Axe first', cost:0, cant:true};
        if(ax.pap) return null;
        return {key:'F', txt:'Empower the RETRIEVER AXE', cost:0}; },
      run:()=> dogInteract(dog) });
    return dog;
  };
  // #1 — ground floor, mounted low on the north interior wall (not the staircase)
  mk(0, 3.0, -(TOWER_H-2), 0, 'inside', 'give', 20);
  // #2 — rooftop, mounted on the north parapet, a nice training spot
  mk(0, STAIR_TOP+3.0, -(TOWER_H-2), 0, 'roof', 'upgrade', 20);
}
function dogPromptHidden(dog){
  // only show the dog prompt when you're actually in its zone (height-gated)
  const y=G.eyeY||EYE;
  if(dog.zone==='roof') return y < STAIR_TOP-6;
  return y > 12;   // ground-floor dog hidden when you're up high
}
function dogInteract(dog){
  if(dogPromptHidden(dog) || !dog.ud.full) return false;
  if(dog.kind==='give'){
    if(dog.ud.used) return false;
    giveWeapon('axe', false); dog.ud.used=true;
    AU.powerup(); toast('RETRIEVER AXE','hold L-click to charge & hurl'); return true;
  } else {
    const ax=G.weapons.find(w=>w.type==='axe'); if(!ax || ax.pap) return false;
    ax.pap=true; ax.reserve=WDEF.axe.reserve; dog.ud.upgraded=true;
    if(curW()===ax) buildPlayerArms();
    AU.powerup(); toast('AXE EMPOWERED','Hell\'s Redeemer — max damage'); return true;
  }
}
// called from killEnemy: feed any dog whose zone matches and is within horizontal range
function feedDogs(x,z,zone){
  for(const dog of wallDogs){
    if(dog.ud.full || dog.zone!==zone) continue;
    if(Math.hypot(x-dog.x, z-dog.z) < dog.hr){ dog.fed++; dog.ud.feed(dog.fed); }
  }
}

function addWallBuy(x,z,wtype,cost){
  const g=KIT.makeWallBuy(); g.position.set(x,0,z); g.rotation.y=Math.atan2(-x,-z);
  // replace the placeholder weapon mesh with the correct silhouette
  return addInteractable({group:g, x, z, radius:2.8, collide:1.0, type:'wallbuy', wtype, cost,
    label:()=>{ const have=G.weapons.find(w=>w.type===wtype);
      if(have) return {key:'F', txt:'Refill '+WDEF[wtype].name+' ammo', cost:Math.round(cost*0.45)};
      return {key:'F', txt:'Buy '+WDEF[wtype].name, cost}; },
    run:()=> buyWall(wtype,cost), anim:g.userData.update });
}

function addGate(deg,price){
  const [x,z]=pos(deg); const ry=(deg-90)*Math.PI/180;
  const g=new T.Group(); const planks=[];
  [-2.6,2.6].forEach(px=> g.add(KIT.at(KIT.box(0.3,3.8,0.3,KIT.mat(0x2c2014,0.9,0)),px,1.9,0)));
  for(let i=0;i<5;i++){ const p=KIT.box(5.4,0.34,0.22,KIT.mat(0x4a3525,0.85,0)); p.position.set(0,0.7+i*0.66,0); p.rotation.z=(i%2?1:-1)*0.04; g.add(p);
    planks.push({mesh:p, cy:p.position.y, oy:p.position.y+4.2+i*0.46, cr:p.rotation.z, or:(i%2?1:-1)*1.2}); }
  const tag=new T.Mesh(new T.PlaneGeometry(1.3,0.46), new T.MeshBasicMaterial({map:KIT.label(String(price),'#ffe9a0'),transparent:true})); tag.position.set(0,4.0,0.1); g.add(tag);
  g.position.set(x,0,z); g.rotation.y=ry;
  const gate=addInteractable({group:g, x, z, radius:3.4, type:'gate', cost:price, open:false, planks, anim:0, deg,
    label:()=> gate.open?null:{key:'F', txt:'Clear Barricade', cost:price},
    run:()=>{ if(gate.open) return false; if(!spend(price)) return false; gate.open=true; gate.anim=0.0001; AU.buy();
      unlockSpawnsNear(deg); toast('PATH CLEARED','new spawn ground opened'); return true; } });
  // physical block so the player can't walk through until it's cleared (removed on open)
  colliders.push({x:campWX(x), z:campWZ(z), r:3.0, gate});
  return gate;
}

function station(deg,perkLines,col,trim,perkId,gate){
  const [x,z]=pos(deg);
  const pm=KIT.makePerkMachine(perkLines,col,trim); pm.position.set(x,0,z); pm.rotation.y=Math.atan2(x,z);
  const cost=2500;
  addInteractable({group:pm, x, z, radius:3.2, collide:1.2, type:'perk', perkId, cost, gate,
    label:()=>{ if(gate && !gate.open) return {key:'F', txt:'Locked — clear barricade first', cost:0, cant:true};
      if(!G.powerOn) return {key:'F', txt:perkLines.join(' ')+' (needs power)', cost:0, cant:true};
      if(G.perks.has(perkId)) return null; return {key:'F', txt:'Perk: '+perkLines.join(' '), cost}; },
    run:()=> buyPerk(perkId,cost,trim), anim:pm.userData.update });
  addFireLight(x+Math.cos((deg-30)*Math.PI/180)*8, z+Math.sin((deg-30)*Math.PI/180)*8);
}

/* ════════════════════ ENEMY POOLS ════════════════════ */
const zombies=[]; // pool entries
let boss=null, mega=null;

function makeBlob(){ const m=new T.Mesh(new T.CircleGeometry(0.55,16),
  new T.MeshBasicMaterial({color:0x000000,transparent:true,opacity:0.38,depthWrite:false}));
  m.rotation.x=-Math.PI/2; m.position.y=0.03; return m; }

const MAX_VILLAGER=6, MAX_SAIYAN=2, MAX_MONKEY=4;   // special-enemy pools (pre-allocated like crawlers)
function makeEnemyModel(kind){
  switch(kind){
    case 'c':        return KIT.makeCrawler();
    case 'saiyan':   return KIT.makeSuperSaiyanZombie();
    case 'monkey':   return KIT.makeMonkey();
    case 'villager': return KIT.makeVillager();
    default:         return KIT.makeZombie();
  }
}
function poolEntry(kind){
  const isCrawler = kind==='c';
  const grp = makeEnemyModel(kind);
  // enemies don't cast dynamic shadows (perf) → cheap blob instead
  grp.add(makeBlob());
  grp.visible=false; buildRoot.add(grp);
  return { grp, anim:grp.userData.update, kind, isCrawler, alive:false,
           hp:0, speed:0, atkCd:0, dieT:0, riseT:0, zone:'outside', baseY:0, dmg:14,
           px:0, pz:0, stuckT:0, side:1, lastDist:1e9,   // stuck-detection + wall-follow state
           bodyY:isCrawler?0.34:1.2, bodyR:isCrawler?0.5:0.6, headY:isCrawler?0.4:1.74, headR:0.3 };
}
function initEnemyPools(){
  for(let i=0;i<MAX_Z;i++) zombies.push(poolEntry('z'));
  for(let i=0;i<MAX_C;i++) zombies.push(poolEntry('c'));
  for(let i=0;i<MAX_VILLAGER;i++) zombies.push(poolEntry('villager'));
  for(let i=0;i<MAX_SAIYAN;i++)   zombies.push(poolEntry('saiyan'));
  for(let i=0;i<MAX_MONKEY;i++)   zombies.push(poolEntry('monkey'));
}

function spawnPositionNearPlayer(){
  // pick an angle, prefer behind the player, on the ring radius, away from tower
  const px=camera.position.x, pz=camera.position.z;
  let best=null, bestScore=-1;
  for(let k=0;k<6;k++){
    const a=Math.random()*Math.PI*2, r=40+Math.random()*16;
    const x=Math.cos(a)*r, z=Math.sin(a)*r;
    const d=Math.hypot(x-px,z-pz);
    // want within 18..42u, not on top of player
    const score = (d>14 && d<46) ? (1 - Math.abs(d-28)/28) + Math.random()*0.3 : -1;
    if(score>bestScore){ bestScore=score; best=[x,z]; }
  }
  return best || [Math.cos(0)*46, Math.sin(0)*46];
}

function spawnZombie(kind){
  if(kind===true) kind='c'; if(!kind) kind='z';      // back-compat: spawnZombie(true) → crawler
  // resolve a free pool entry (villager<->z interchangeable; crawler/saiyan/monkey stay bounded)
  let e = zombies.find(z=>!z.alive && z.kind===kind);
  if(!e && kind==='z')        e = zombies.find(z=>!z.alive && z.kind==='villager');
  if(!e && kind==='villager') e = zombies.find(z=>!z.alive && z.kind==='z');
  if(!e) return false;                               // that pool is exhausted → skip this spawn
  const k=e.kind;
  const [x,z,baseY,zone]=pickSpawn();
  e.zone=zone||'outside'; e.baseY=baseY||0;
  e.grp.position.set(x,e.baseY,z); e.grp.scale.setScalar(0.01); e.grp.visible=true;
  e.alive=true; e.dieT=0; e.riseT=0; e.atkCd=0;
  if(e.grp.userData.resetHead) e.grp.userData.resetHead();   // restore a head popped last life
  e.stuckT=0; e.lastDist=1e9; e.side=(Math.random()<0.5?-1:1);
  const r=G.round;
  let hp = Math.round((e.isCrawler?70:100) * (1 + r*0.18)) + (e.isCrawler?0:r*4);
  let speed = (e.isCrawler?3.4:2.0) + Math.min(2.4, r*0.12) + Math.random()*0.4;
  let dmg = e.isCrawler?8:14;
  // SPRINTERS: from round 6, standing walkers (NOT crawlers, saiyans, or monkeys) can sprint —
  // 5% chance at round 6, +2% each round up to 100%. Speed sits just under the player's walk so
  // you can still outrun them by sprinting.
  e.isSprinter = false;
  if(!e.isCrawler && k!=='saiyan' && k!=='monkey' && r>=6 && Math.random() < Math.min(1, 0.05 + (r-6)*0.02)){
    e.isSprinter = true; speed = 5.0 + Math.min(0.5, (r-6)*0.02);   // ~5.0–5.5 (player walk = 5.6)
  }
  if(k==='saiyan'){ hp*=20; speed*=1.75; dmg*=2; }            // rare elite (never a sprinter)
  else if(k==='monkey'){ hp=Math.round(hp*2.2); speed*=1.3; dmg=20; }
  e.hp=hp; e.speed=speed; e.dmg=dmg;
  G.aliveCount++;
  if(Math.random()<0.3) AU.groan();
  return true;
}

function spawnMiniBoss(){
  if(!boss){ boss=KIT.makeBoss(); boss.add(makeBlob()); buildRoot.add(boss); }
  const yd=G.bossYard||{x:0,z:-52};
  boss.position.set(yd.x,0,yd.z); boss.scale.setScalar(0.01); boss.visible=true;
  boss.userData.hp = 900 + G.round*220; boss.userData.maxhp=boss.userData.hp;
  boss.userData.alive=true; boss.userData.speed=1.7; boss.userData.atkCd=0; boss.userData.riseT=0;
  G.bossActive=true; G.aliveCount++;
  AU.round(); toast('HEAVY INCOMING','a brute stalks the boss yard');
}

function spawnMegaBoss(px, pz, py, opts){
  opts=opts||{};
  // round-20 finale uses the distinct Giga model; round-12/altar use the Royal Egg → Mega
  const wantGiga = opts.source==='lvl25';
  if(!mega || !!mega.userData.giga !== wantGiga){
    if(mega) scene.remove(mega);
    mega = wantGiga ? KIT.makeGigaBoss() : KIT.makeRoyalEgg();
    buildRoot.add(mega);
  }
  const scale=opts.scale||3.0; mega.scale.setScalar(scale);
  const yd = (px!=null)? {x:px,z:pz} : (G.bossYard||{x:0,z:-52});
  G.megaY = py||0; G.megaScale=scale;
  mega.position.set(yd.x, G.megaY+4.2, yd.z); mega.visible=true;
  mega.userData.hp = opts.hp||14000; mega.userData.maxhp=mega.userData.hp;
  mega.userData.alive=true; mega.userData.hatch = wantGiga ? 2.0 : 0;   // giga awakens at once (no egg)
  mega.userData.speed=(1.4)*(opts.speedMul||1); mega.userData.dmg=45*(opts.dmgMul||1);
  mega.userData.source=opts.source||'altar'; mega.userData.atkCd=0;
  G.megaActive=true;
  AU.round();
  if(opts.source==='lvl25') toast('GIGA PINGAS AWAKENS','3× everything — survive','#ff48c0');
  else toast('THE ROYAL EGG HATCHES','MEGA PINGAS BOSS','#ff48c0');
}

/* ════════════════════ PLAYER ARMS / WEAPONS ════════════════════ */
let arms=null, armBaseY=-0.0, recoil=0, muzzle=null, muzzleT=0, viewLight=null;
let axe={phase:'idle', t:0, proj:null};

function buildPlayerArms(){
  if(arms){ camera.remove(arms); }
  const w=G.weapons[G.cur];
  arms = KIT.makeArms(w.type, w.pap);
  camera.add(arms);
  window.__SE.fpsArms=arms; window.__SE.weapon=w.type; window.__SE.pap=w.pap;
  tagReloadParts(arms);                                    // capture the reload rig (mag/charge/pump/core + arms)
  // reusable muzzle flash light (constant light count — toggled, never added/removed)
  if(!muzzle){ muzzle=new T.PointLight(0xffd58a,0,6,2); camera.add(muzzle); muzzle.position.set(0.2,-0.2,-1.2); }
  // steady viewmodel fill so the held weapon reads clearly even at night / indoors
  if(!viewLight){ viewLight=new T.PointLight(0xcfe0ff,0.9,4,2); camera.add(viewLight); viewLight.position.set(0.1,-0.1,-0.5); }
}

function curW(){ return G.weapons[G.cur]; }
function swapTo(i){ if(i<0||i>=G.weapons.length||i===G.cur) return; G.cur=i; const w=curW(); w.reloading=false; buildPlayerArms(); updateAmmoHUD(); AU.reload(); axe.phase='idle'; }
function cycleWeapon(dir){ if(G.weapons.length<2) return; swapTo((G.cur+dir+G.weapons.length)%G.weapons.length); }

function giveWeapon(type, pap){
  const existing=G.weapons.find(w=>w.type===type);
  if(existing){ existing.reserve=WDEF[type].reserve; existing.ammo=existing.mag; }
  else {
    const w=newWeapon(type,pap);
    if(G.weapons.length<2) G.weapons.push(w); else G.weapons[G.cur]=w; // 2-slot inventory
    G.cur=G.weapons.indexOf(w);
  }
  buildPlayerArms(); updateAmmoHUD();
}

/* ════════════════════ FIRING (hitscan via manual ray-sphere) ════════════════════ */
function rayHitEnemy(ox,oy,oz, dx,dy,dz, range){
  // returns {e, t, head} closest alive enemy along ray, or null
  let best=null, bestT=range;
  for(let i=0;i<zombies.length;i++){ const e=zombies[i]; if(!e.alive) continue;
    const ex=e.grp.position.x, ez=e.grp.position.z;
    // body sphere
    let hit=sphereT(ox,oy,oz,dx,dy,dz, ex,e.grp.position.y+e.bodyY,ez, e.bodyR, bestT);
    let head=false;
    const ht=sphereT(ox,oy,oz,dx,dy,dz, ex,e.grp.position.y+e.headY,ez, e.headR, bestT);
    if(ht>0 && (hit<0 || ht<hit)){ hit=ht; head=true; }
    if(hit>0 && hit<bestT){ bestT=hit; best={e, t:hit, head}; }
  }
  // boss
  if(boss && boss.userData.alive){ const t=sphereT(ox,oy,oz,dx,dy,dz, boss.position.x,boss.position.y+1.6,boss.position.z, 1.4, bestT);
    if(t>0 && t<bestT){ bestT=t; best={boss:true, t}; } }
  if(mega && mega.userData.alive && mega.userData.hatch>1){ const t=sphereT(ox,oy,oz,dx,dy,dz, mega.position.x,mega.position.y+ (mega.userData.hatch>1?12:4),mega.position.z, 4.5, bestT);
    if(t>0 && t<bestT){ bestT=t; best={mega:true, t}; } }
  // minable ore blocks (shoot to mine)
  for(let i=0;i<oreBlocks.length;i++){ const o=oreBlocks[i]; if(!o.alive) continue;
    const t=sphereT(ox,oy,oz,dx,dy,dz, o.x,o.y,o.z, o.r, bestT);
    if(t>0 && t<bestT){ bestT=t; best={ore:o, t}; } }
  return best;
}
function sphereT(ox,oy,oz, dx,dy,dz, cx,cy,cz, r, maxT){
  const lx=cx-ox, ly=cy-oy, lz=cz-oz;
  const tca=lx*dx+ly*dy+lz*dz; if(tca<0) return -1;
  const d2=(lx*lx+ly*ly+lz*lz)-tca*tca; const r2=r*r; if(d2>r2) return -1;
  const thc=Math.sqrt(r2-d2); const t=tca-thc; if(t<0||t>maxT) return (tca<maxT?tca:-1);
  return t;
}

function fire(){
  const w=curW(); if(!w) return;
  const d=WDEF[w.type]; const now=clock.elapsedTime;
  if(w.reloading) return;
  const rate = d.rate * (G.perks.has('doubleshot')?1.45:1) * (G.fireRateBuff>0?2:1) * (w.superUpgrade?1.3:1);
  if(now - w.lastShot < 1/rate) return;
  if(w.type==='axe'){ return; } // axe handled by charge system
  // Melee weapons (pickaxe / diamond pickaxe): no ammo, swing + ray hit, big point reward
  if(d.kind==='melee'){
    w.lastShot=now; recoil=Math.min(0.5, recoil+0.4); AU.shoot('pistol');  // bigger kick = swing
    camera.getWorldDirection(_dir);
    const ox=camera.position.x, oy=camera.position.y, oz=camera.position.z;
    const dmgMul=(w.superUpgrade?2:1)*(G.instaKill>0?1000:1);
    const hit=rayHitEnemy(ox,oy,oz,_dir.x,_dir.y,_dir.z,d.range);
    if(hit){ const dmg=d.dmg*dmgMul;
      if(hit.e) damageEnemy(hit.e, dmg, false, 0, true);
      else if(hit.boss) damageBoss(dmg);
      else if(hit.mega) damageMega(dmg);
      else if(hit.ore) damageOre(hit.ore, dmg);
      AU.hit(); hitmarker(); }
    else { mineLook(d.dmg*(w.superUpgrade?2:1)); }   // missed the undead → mine the tree/rock/block you swung at
    addPoints(5); return;
  }
  checkRadioHit();                                   // a ballistic shot can light a radio-tower ball
  if(w.ammo<=0){ AU.dry(); flashReloadHint(); return; }
  w.lastShot=now; w.ammo--; updateAmmoHUD();
  recoil = Math.min(0.5, recoil + (d.kind==='ballistic'? (d.pellets?0.32:0.14) : 0.2) * (G.perks.has('pingasliquid')?0.6:1));
  muzzle.intensity=2.4; muzzleT=now;
  AU.shoot(w.type==='shotgun'?'shotgun': w.type==='sniper'?'sniper': w.type==='wonder'?'wonder': w.type);

  camera.getWorldDirection(_dir);
  const ox=camera.position.x, oy=camera.position.y, oz=camera.position.z;
  const dmgMul = (w.pap?2.2:1) * (G.instaKill>0?1000:1) * (w.superUpgrade?2:1);

  if(w.type==='wonder'){ spawnBolt(ox,oy,oz,_dir.x,_dir.y,_dir.z, d.dmg*dmgMul, d.aoe); return; }

  // Double Shot: fire a real second bullet (per pellet) on top of the faster fire rate
  const pellets = (d.pellets||1) * (G.perks.has('doubleshot')?2:1);
  let anyHit=false;
  for(let p=0;p<pellets;p++){
    let dx=_dir.x, dy=_dir.y, dz=_dir.z;
    if(d.spread){ dx+=(Math.random()-0.5)*d.spread; dy+=(Math.random()-0.5)*d.spread; dz+=(Math.random()-0.5)*d.spread;
      const l=Math.hypot(dx,dy,dz); dx/=l; dy/=l; dz/=l; }
    const hit=rayHitEnemy(ox,oy,oz,dx,dy,dz,d.range);
    if(hit){ anyHit=true;
      const dmg = d.dmg*dmgMul*(hit.head?1.8:1);
      const bearingDeg = Math.atan2(dz, dx) * 180/Math.PI;   // bullet travel bearing (head pops away from it)
      if(hit.e) damageEnemy(hit.e, dmg, hit.head, bearingDeg);
      else if(hit.boss) damageBoss(dmg);
      else if(hit.mega) damageMega(dmg);
      else if(hit.ore) damageOre(hit.ore, dmg);
    }
  }
  if(anyHit){ AU.hit(); hitmarker(); }
  addPoints(10); // additional money per shot fired
}

/* Wonder weapon bolt pool — FULLY pre-allocated at boot (see prewarmFX).
   Firing must never create a mesh/material/light: adding a light to the scene
   forces three.js to recompile every shader, which is the per-shot hitch the
   Wonder gun used to cause. One shared geometry + one shared material + a single
   moving point light keep both the spawn cost and the steady-state cost flat. */
const bolts=[]; const BOLT_MAX=8;
let boltLight=null;
function prewarmBolts(){
  if(bolts.length || !scene) return;
  const geo=new T.CylinderGeometry(0.06,0.06,1.4,8);   // shared across all bolts
  const mat=KIT.glow(0x9beaff,2.8);                    // shared material
  for(let i=0;i<BOLT_MAX;i++){
    const m=new T.Mesh(geo,mat); m.visible=false; buildRoot.add(m);
    bolts.push({mesh:m, active:false, dmg:0, aoe:0, life:0, dir:new T.Vector3()});
  }
  boltLight=new T.PointLight(0x9beaff,0,7,2); buildRoot.add(boltLight); // one shared light
}
function spawnBolt(ox,oy,oz,dx,dy,dz,dmg,aoe){
  if(!bolts.length) prewarmBolts();                    // safety net; normally pre-warmed
  const b=bolts.find(b=>!b.active) || bolts[0];        // reuse — never allocate
  b.active=true; b.dmg=dmg; b.aoe=aoe; b.life=0; b.mesh.visible=true;
  b.mesh.position.set(ox+dx,oy+dy,oz+dz);
  b.dir.set(dx,dy,dz);
  b.mesh.quaternion.setFromUnitVectors(_v2.set(0,1,0), b.dir);
}
function updateBolts(dt){
  let lead=null;
  for(const b of bolts){ if(!b.active) continue; b.life+=dt;
    b.mesh.position.addScaledVector(b.dir, 60*dt);
    if(b.life>2){ b.active=false; b.mesh.visible=false; continue; }
    let det=false;
    // proximity to any enemy
    for(let i=0;i<zombies.length;i++){ const e=zombies[i]; if(!e.alive) continue;
      if(Math.abs(b.mesh.position.x-e.grp.position.x)<1.2 && Math.abs(b.mesh.position.z-e.grp.position.z)<1.2
         && Math.abs(b.mesh.position.y-(e.grp.position.y+e.bodyY))<1.6){
        wonderBurst(b.mesh.position.x,b.mesh.position.y,b.mesh.position.z, b.dmg, b.aoe);
        b.active=false; b.mesh.visible=false; det=true; break; } }
    if(!det && !lead) lead=b;                          // light follows the lead bolt
  }
  if(boltLight){ if(lead){ boltLight.position.copy(lead.mesh.position); boltLight.intensity=1.6; }
                 else boltLight.intensity=0; }
}
function wonderBurst(x,y,z,dmg,aoe){
  fxExplosion(x,y,z, 0x9beaff, 0.7); AU.hit();
  for(let i=0;i<zombies.length;i++){ const e=zombies[i]; if(!e.alive) continue;
    if(Math.hypot(e.grp.position.x-x, e.grp.position.z-z) < aoe) damageEnemy(e, dmg, false); }
  if(boss&&boss.userData.alive && Math.hypot(boss.position.x-x,boss.position.z-z)<aoe) damageBoss(dmg*0.6);
}

/* Retriever Axe: hold to charge up to 3s → throw → AoE → return. Release anytime for shorter throw */
function updateAxe(dt, charging){
  const w=curW(); if(!w || w.type!=='axe'){ axe.phase='idle'; setCharge(0); return; }
  const held = arms && arms.userData.weapon;
  if(axe.phase==='idle'){
    setCharge(0);
    if(charging && w.ammo>0){ axe.phase='charge'; axe.t=0; }
  } else if(axe.phase==='charge'){
    axe.t+=dt; const k=Math.min(1,axe.t/3); setCharge(k);
    if(held){ const shake=k<1?(Math.random()-0.5)*0.04*k:0;
      held.position.z = -0.62 + 0.22*k + shake; held.position.x=0.13+shake; held.rotation.x=-0.5*k; }
    if(!charging){ // released → throw, distance scales with charge (allow early release)
      throwAxe(k); }
  } else if(axe.phase==='out' || axe.phase==='back'){
    setCharge(0);
    updateAxeProj(dt);
  }
}
function throwAxe(k){
  const w=curW(); if(w.ammo<=0){ axe.phase='idle'; return; } w.ammo--; updateAmmoHUD();
  AU.shoot('axe'); axe.phase='out'; axe.t=0; axe.dist=2+k*14; axe.k=k;
  if(arms&&arms.userData.weapon) arms.userData.weapon.visible=false;
  if(!axe.proj){ axe.proj=KIT.makeWeapon('axe',w.pap); axe.proj.scale.setScalar(0.62); buildRoot.add(axe.proj);
    axe.plight=new T.PointLight(0xff3a14,2,8,2); axe.proj.add(axe.plight); }
  axe.proj.visible=true;
  camera.getWorldDirection(_dir);
  axe.from=camera.position.clone();
  axe.dirv=_dir.clone();
  addPoints(10); // money for throwing axe
}
function updateAxeProj(dt){
  axe.t+=dt; const p=axe.proj;
  p.rotation.x+=14*dt; p.rotation.y+=8*dt;
  if(axe.phase==='out'){
    const k=axe.t/0.5; const d=Math.min(1,k)*axe.dist;
    p.position.copy(axe.from).addScaledVector(axe.dirv, d); p.position.y=1.3;
    if(k>=1){ // detonate
      const w=curW(); const dmg=WDEF.axe.dmg*(w.pap?2.2:1)*(G.instaKill>0?1000:1);
      fxExplosion(p.position.x,p.position.y,p.position.z, 0xff4a14, 1.4); AU.explode();
      for(let i=0;i<zombies.length;i++){ const e=zombies[i]; if(!e.alive) continue;
        if(Math.hypot(e.grp.position.x-p.position.x,e.grp.position.z-p.position.z)<WDEF.axe.aoe) damageEnemy(e,dmg,false); }
      if(boss&&boss.userData.alive&&Math.hypot(boss.position.x-p.position.x,boss.position.z-p.position.z)<WDEF.axe.aoe) damageBoss(dmg);
      if(mega&&mega.userData.alive&&Math.hypot(mega.position.x-p.position.x,mega.position.z-p.position.z)<WDEF.axe.aoe+3) damageMega(dmg);
      axe.phase='back'; axe.t=0; axe.bfrom=p.position.clone();
    }
  } else { // back to hand
    const k=axe.t/0.55; p.position.lerpVectors(axe.bfrom, camera.position, Math.min(1,k)); p.position.y=Math.max(1.0,p.position.y);
    if(k>=1){ p.visible=false; axe.phase='idle';
      const held=arms&&arms.userData.weapon; if(held){ held.visible=true; held.position.set(0.13,-0.30,-0.62); held.rotation.x=0; }
      const w=curW(); if(w.ammo<=0 && w.reserve>0) startReload(); }
  }
}

/* ════════════════════ DAMAGE / DEATH / DROPS ════════════════════ */
function damageEnemy(e, dmg, head, bearingDeg, melee){
  if(!e.alive) return; e.hp-=dmg;
  const lethal = e.hp<=0;
  if(head && lethal && e.grp.userData.blowHead) e.grp.userData.blowHead(bearingDeg||0);  // FATAL headshot → pop the head
  if(lethal){ killEnemy(e, head, melee); }
}
function killEnemy(e, head, melee){
  e.alive=false; e.grp.visible=false; G.aliveCount--;
  G.kills++; addPoints(melee?130:(head?100:60));
  feedDogs(e.grp.position.x, e.grp.position.z, e.zone);   // feed a nearby wall dog
  if(Math.random()<0.04 + (G.round>3?0.02:0)) spawnDrop(e.grp.position.x, e.grp.position.z);
  checkRoundProgress();
}
function damageBoss(dmg){ if(!boss||!boss.userData.alive) return; boss.userData.hp-=dmg;
  if(boss.userData.hp<=0){ boss.userData.alive=false; boss.visible=false; G.bossActive=false; G.aliveCount--;
    addPoints(800); toast('BRUTE DOWN','+800'); spawnDrop(boss.position.x,boss.position.z); checkRoundProgress(); } }
function damageMega(dmg){ if(!mega||!mega.userData.alive) return; mega.userData.hp-=dmg;
  const hp=mega.userData.hp;
  if(hp<=0){ mega.userData.alive=false; mega.visible=false; G.megaActive=false;
    const src=mega.userData.source;
    fxExplosion(mega.position.x, mega.position.y+2, mega.position.z, 0xff48c0, 2.2); AU.explode();
    if(src==='lvl12'){ G.lvl12Done=true; G.bunkerUnlocked=true; addPoints(2500);
      toast('PINGAS BOSS DOWN','BUNKER UNLOCKED · the siege continues','#ff48c0'); }
    else if(src==='lvl25'){ G.lvl25Done=true; addPoints(6000);
      if(round25Gate){ round25Gate.cleared=true; round25Gate.grp.visible=false; }   // round-25 portal opens
      mcUnlock();                                                                    // unlock MINECRAFT MODE (press E)
      toast('GIGA PINGAS DOWN','+6000 · MINECRAFT MODE unlocked','#ff48c0'); }
    else { G.megaDefeated=true; addPoints(3000); toast('PINGAS BOSS DOWN','+3000','#ff48c0'); }
    updateBossBar(); checkRoundProgress();   // resume the waves — the game never ends now
  } }

const drops=[]; // {grp, kind, t, x, z}
const DROP_KINDS=['instakill','maxammo','doublepts','nuke','chips'];
function spawnDrop(x,z){
  const kind=DROP_KINDS[(Math.random()*DROP_KINDS.length)|0];
  let grp;
  if(kind==='instakill') grp=KIT.makeSkullDrop();
  else if(kind==='chips') grp=KIT.makePingasChips();
  else { grp=KIT.makePickups(); grp.scale.setScalar(0.6); }
  grp.position.set(x,1.1,z); buildRoot.add(grp);
  drops.push({grp, kind, t:0, x, z, anim:grp.userData.update});
}
function updateDrops(dt){
  for(let i=drops.length-1;i>=0;i--){ const d=drops[i]; d.t+=dt;
    if(d.anim) d.anim(clock.elapsedTime);
    d.grp.position.y=1.1+Math.sin(clock.elapsedTime*2)*0.14;
    // pickup
    if(Math.hypot(camera.position.x-d.x, camera.position.z-d.z)<2.2){ applyDrop(d.kind); scene.remove(d.grp); drops.splice(i,1); continue; }
    if(d.t>10){ // blink out
      d.grp.visible = (d.t%0.3)<0.18; if(d.t>13){ scene.remove(d.grp); drops.splice(i,1); } }
  }
}
function applyDrop(kind){
  AU.powerup();
  if(kind==='instakill'){ G.instaKill=clock.elapsedTime+18; toast('INSTA-KILL','18s'); }
  else if(kind==='maxammo'){ G.weapons.forEach(w=>{ w.ammo=w.mag; w.reserve=WDEF[w.type].reserve; }); updateAmmoHUD(); toast('MAX AMMO',''); }
  else if(kind==='doublepts'){ G.doublePts=clock.elapsedTime+30; toast('DOUBLE POINTS','30s'); }
  else if(kind==='nuke'){ let n=0; for(const e of zombies){ if(e.alive){ killEnemy(e,false); n++; } } toast('NUKE','+'+(n*40)); addPoints(n*40); }
  else if(kind==='chips'){ G.fireRateBuff=clock.elapsedTime+60; G.weapons.forEach(w=>{w.ammo=w.mag; w.reserve=WDEF[w.type].reserve;}); updateAmmoHUD(); toast('PINGAS CHIPS','2× fire-rate · 60s','#ff48c0'); }
}

/* grenades */
const nades=[]; let nadeCount=4;
function throwGrenade(){
  if(nadeCount<=0) return; nadeCount--;
  const g=KIT.makeGrenade(); buildRoot.add(g);
  camera.getWorldDirection(_dir);
  const n={grp:g, vx:_dir.x*22, vy:8, vz:_dir.z*22, t:0};
  g.position.copy(camera.position);
  nades.push(n); updateNadeHUD();
}
function updateNades(dt){
  for(let i=nades.length-1;i>=0;i--){ const n=nades[i]; n.t+=dt;
    n.vy-=GRAV*dt; n.grp.position.x+=n.vx*dt; n.grp.position.y+=n.vy*dt; n.grp.position.z+=n.vz*dt;
    n.grp.rotation.x+=6*dt; n.grp.rotation.z+=4*dt;
    if(n.grp.position.y<=0.2 || n.t>2.2){ // explode
      const x=n.grp.position.x, z=n.grp.position.z;
      fxExplosion(x,0.8,z,0xffb838,1.6); AU.explode();
      for(let j=0;j<zombies.length;j++){ const e=zombies[j]; if(!e.alive) continue;
        if(Math.hypot(e.grp.position.x-x,e.grp.position.z-z)<5) damageEnemy(e,400,false); }
      if(boss&&boss.userData.alive&&Math.hypot(boss.position.x-x,boss.position.z-z)<5) damageBoss(300);
      scene.remove(n.grp); nades.splice(i,1);
    }
  }
}

/* explosion FX pool (reused) */
const fxPool=[]; const FX_MAX=6;   // bounded so explosions never add a light mid-combat (recompile)
function fxExplosion(x,y,z,color,scale){
  let f=fxPool.find(f=>!f.active);
  if(!f){ if(fxPool.length>=FX_MAX){ f=fxPool[0]; }            // reuse oldest — never grow past the cap
    else { const g=KIT.makeExplosion(); buildRoot.add(g); f={grp:g, active:false, t:0, anim:g.userData.update}; fxPool.push(f); } }
  f.grp.position.set(x,y,z); f.grp.scale.setScalar(scale||1); f.grp.visible=true; f.active=true; f.t=0;
}
function updateFx(){
  for(const f of fxPool){ if(!f.active) continue; f.t+=STEP;
    if(f.anim) f.anim(f.t); if(f.t>2.1){ f.active=false; f.grp.visible=false; } }
}
/* Pre-build the projectile + explosion pools at boot and compile their shaders
   up front, so the FIRST Wonder shot/burst doesn't allocate meshes/lights mid-
   combat (which would recompile every shader and stutter). Each makeExplosion()
   also carries its own PointLight, so seeding the pool fixes the scene light
   count once and for all. */
function prewarmFX(){
  prewarmBolts();
  while(fxPool.length<FX_MAX){
    const g=KIT.makeExplosion(); g.visible=false; buildRoot.add(g);
    fxPool.push({grp:g, active:false, t:0, anim:g.userData.update});
  }
  if(renderer && renderer.compile){ try{ renderer.compile(scene, camera); }catch(e){} }
}

/* ════════════════════ ECONOMY ════════════════════ */
function spend(n){ if(G.points<n){ AU.deny(); flashDeny(); return false; } G.points-=n; updatePointsHUD(); return true; }
function addPoints(n){ if(G.doublePts>clock.elapsedTime) n*=2; G.points+=n; updatePointsHUD(); pointsPop(n); }

function buyWall(wtype,cost){
  const have=G.weapons.find(w=>w.type===wtype);
  if(have){ const c=Math.round(cost*0.45); if(!spend(c)) return false; have.reserve=WDEF[wtype].reserve; have.ammo=have.mag; AU.buy(); updateAmmoHUD(); return true; }
  if(!spend(cost)) return false; giveWeapon(wtype,false); AU.buy(); toast(WDEF[wtype].name,''); return true;
}
function mysteryCrate(){
  if(!spend(950)) return false; AU.buy();
  const pool=['smg','shotgun','rifle','sniper','ak','lmg','wonder','axe'];
  const pick=pool[(Math.random()*pool.length)|0];
  giveWeapon(pick, false); toast(WDEF[pick].name+'!','mystery reward','#ffd23a');
  return true;
}
function packAPunch(){
  if(!G.powerOn) return false; const w=curW(); if(!w||w.pap) return false;
  if(!spend(5000)) return false; AU.power();
  w.pap=true; w.name=WDEF[w.type].name+' +';
  w.mag=Math.round(WDEF[w.type].mag*1.5);                       // bigger magazine…
  w.reserve=Math.round(WDEF[w.type].reserve*1.5); w.ammo=w.mag; // …and a full, larger reserve
  buildPlayerArms(); updateAmmoHUD(); toast('PACK-A-PINGAS','2.2× dmg · bigger mag','#35d6ff'); return true;
}
/* ── Minecraft melee + super upgrades ───────────────────────────────── */
function upgradeToDiamondPick(){
  // turn the wooden pickaxe slot into a diamond pickaxe (keeps any super-upgrade)
  let w=G.weapons.find(x=>x.type==='pickaxe');
  if(!w){ // no plain pickaxe? upgrade an existing diamond one is a no-op
    if(G.weapons.find(x=>x.type==='diapick')){ toast('ALREADY DIAMOND','your pickaxe is maxed','#4fe8e0'); return; }
    w=newWeapon('diapick',false); if(G.weapons.length<2) G.weapons.push(w); else G.weapons[1]=w;
  } else {
    const sup=w.superUpgrade, idx=G.weapons.indexOf(w);
    const nw=newWeapon('diapick',false); nw.superUpgrade=sup; if(sup) applySuperName(nw);
    G.weapons[idx]=nw;
  }
  buildPlayerArms(); updateAmmoHUD();
  toast('DIAMOND PICKAXE','crafted · massive melee','#4fe8e0');
}
function applySuperName(w){ if(!w) return; const base=WDEF[w.type].name+(w.pap?' +':''); w.name='✦ '+base; }
function applySuperUpgrade(){
  // core: super-upgrade the CURRENT weapon (no inventory deduction — grid already consumed)
  const w=curW(); if(!w) return false;
  if(w.superUpgrade){ toast('ALREADY DIAMOND','this weapon is super-upgraded','#4fe8e0'); return false; }
  w.superUpgrade=true; applySuperName(w);
  buildPlayerArms(); updateAmmoHUD();
  toast('DIAMOND SUPER-UPGRADE','2× damage · +30% fire rate','#4fe8e0'); return true;
}
function diamondSuperUpgrade(){
  // direct path: spend 3 diamond blocks, then super-upgrade current weapon
  if(invCount('diamondblock')<3){ toast('NEED 3 DIAMOND BLOCKS','craft them from 9 diamonds each','#4fe8e0'); return false; }
  const w=curW(); if(!w || w.superUpgrade){ toast('CANT UPGRADE','already super-upgraded','#4fe8e0'); return false; }
  invRemove('diamondblock',3);
  return applySuperUpgrade();
}
if(typeof window!=='undefined') window.__diamondSuper=diamondSuperUpgrade;
function buyPerk(id,cost,trimHex){
  if(!G.powerOn) return false; if(G.perks.has(id)) return false;
  if(!spend(cost)) return false; AU.powerup();
  G.perks.add(id);
  if(id==='juggernaut'){ G.maxHealth*=2; G.health=G.maxHealth; }
  else if(id==='rootbeer'){ G.maxHealth=200; G.health+=100; }
  updatePerksHUD(); updateHealthHUD(); toast('PERK ACQUIRED', perkName(id), '#'+(trimHex||0x5aa0ff).toString(16)); return true;
}
function perkName(id){ return id==='doubleshot'?'DOUBLE SHOT': id==='rootbeer'?'MUG ROOTBEER METH': id==='juggernaut'?'JUGGERNAUT': id==='pingasliquid'?'PINGAS LIQUID':id; }

/* ════════════════════ WAVE DIRECTOR ════════════════════ */
// Endless: milestone bosses at 12 (Mega → unlocks bunker) and 20 (Giga); waves never stop.
const MEGA_ROUND=12, GIGA_ROUND=20;
function startRound(n){
  G.round=n; G.roundActive=true;
  G.budget = Math.round(6 + n*3.5 + n*n*0.35);
  if(n===MEGA_ROUND && !G.lvl12Done){ G.budget=0; spawnMegaBoss(null,null,0,{source:'lvl12'}); }
  else if(n===GIGA_ROUND && !G.lvl25Done){ G.budget=0; spawnMegaBoss(null,null,0,{source:'lvl25', scale:9.0, hp:42000, dmgMul:2, speedMul:1.2}); }
  G.toSpawn=G.budget; G.spawnTimer=0;
  updateRoundHUD(true); if(n>1) AU.round();
  if(n%5===0 && n>0 && n!==MEGA_ROUND && n!==GIGA_ROUND) spawnMiniBoss();
  // monkey invasion every 6th (non-boss) round
  if(n%6===0 && n>0 && n!==MEGA_ROUND && n!==GIGA_ROUND){
    G.monkeyWave=Math.min(MAX_MONKEY, 2+Math.floor(n/6)); G.monkeyTimer=2.0;
    AU.monkey(); toast('MONKEY INVASION',"they're coming for your pingas",'#ffcf3a'); }
}
function checkRoundProgress(){
  updateZleftHUD();
  if(G.megaActive) return;
  if(G.roundActive && G.toSpawn<=0 && G.aliveCount<=0 && !G.bossActive){
    G.roundActive=false; G.intermission=clock.elapsedTime+4.5;
    // round-end reward
    addPoints(80+G.round*10);
  }
}
function directorTick(dt){
  if(G.megaActive) return;
  if(!G.roundActive){
    if(G.intermission>0 && clock.elapsedTime>=G.intermission){ G.intermission=0; startRound(G.round+1); }
    return;
  }
  // monkey invasion (queued on every 6th non-boss round): drip the apes in alongside the wave
  if(G.monkeyWave>0 && G.aliveCount<MAX_Z){ G.monkeyTimer=(G.monkeyTimer||0)-dt;
    if(G.monkeyTimer<=0){ G.monkeyTimer=1.4; if(spawnZombie('monkey')) G.monkeyWave--; } }
  if(G.toSpawn>0 && G.aliveCount<MAX_Z){
    G.spawnTimer-=dt;
    // brisk cadence + small bursts so the arena fills toward the 25-cap and stays pressured
    const interval = Math.max(0.22, 0.75 - G.round*0.03);
    if(G.spawnTimer<=0){ G.spawnTimer=interval;
      const burst = 1 + (G.round>5?1:0) + (G.round>10?1:0);
      for(let k=0;k<burst && G.toSpawn>0 && G.aliveCount<MAX_Z;k++){
        if(spawnZombie(pickEnemyKind())) G.toSpawn--;
      }
    }
  }
  // STRAGGLER SAFETY: wave fully spawned but enemies linger → after a short grace, pull any far/
  // unreachable zombie to a fresh spawn near the player so the round can never get stuck on "1 left".
  if(G.toSpawn<=0 && G.aliveCount>0 && !G.bossActive){
    G.cleanupT=(G.cleanupT||0)+dt;
    if(G.cleanupT>5){ G.cleanupT=0; const players=getPlayers();
      for(const e of zombies){ if(!e.alive) continue; const tg=nearestPlayer(e.grp.position.x,e.grp.position.z,players);
        if(Math.hypot(e.grp.position.x-tg.x, e.grp.position.z-tg.z)>26){ const s=pickSpawn(); e.zone=s[3]||'outside'; e.baseY=s[2]||0; e.grp.position.set(s[0],e.baseY,s[1]); e.noProg=0; e.bestDist=1e9; } } }
  } else G.cleanupT=0;
}
// what to spawn next: mostly walkers, some crawlers, a few villager variants, a 0.1% super-saiyan
function pickEnemyKind(){
  const r=G.round;
  if(r>=8 && Math.random()<0.001) return 'saiyan';     // 0.1% rare elite
  const roll=Math.random();
  if(r>=4 && roll<0.22) return 'c';                    // crawler
  if(r>=3 && roll<0.40) return 'villager';             // cosmetic villager variant
  return 'z';
}

/* ════════════════════ ENEMY AI (fixed-step) ════════════════════ */
function clampArena(x,z, rad, isPlayer, playerY){
  if(isPlayer && G.inSkyRoom){ const m=SRW/2-1.2;          // keep the player inside the sky-room walls
    x=Math.max(SRX-m,Math.min(SRX+m,x)); z=Math.max(SRZ-m,Math.min(SRZ+m,z)); _v3.set(x,0,z); return _v3; }
  // square WORLD boundary (the big 300×300 arena)
  const lim=WB-2;
  if(x>lim) x=lim; else if(x<-lim) x=-lim;
  if(z>lim) z=lim; else if(z<-lim) z=-lim;
  // tower collision is CAMP-LOCAL (the camp is offset to the corner)
  let lx=x-CAMP_X, lz=z-CAMP_Z;
  const W=TOWER_H;
  if(isPlayer){
    const t=0.7+rad;
    if(Math.abs(lz)<=W && Math.abs(lx+W)<t){ lx = (lx+W<0)? -W-t : -W+t; } // west wall
    if(Math.abs(lz)<=W && Math.abs(lx-W)<t){ lx = (lx-W>0)?  W+t :  W-t; } // east wall
    if(Math.abs(lx)<=W && Math.abs(lz+W)<t){ lz = (lz+W<0)? -W-t : -W+t; } // north wall
    const inDoorGap = doorOpen && Math.abs(lx)<4;                          // south door
    if(!inDoorGap && Math.abs(lx)<=W && Math.abs(lz-W)<t){ lz = (lz-W>0)? W+t : W-t; }
    if(Math.abs(lx)<W && Math.abs(lz)<W){
      const ir=Math.hypot(lx,lz);
      if(ir<STAIR_RIN+rad && ir>0.001){ const f=(STAIR_RIN+rad)/ir; lx*=f; lz*=f; }
      else if(!roofOpen && (playerY||0) > STAIR_TOP-3+EYE && ir>STAIR_ROUT-1){ const f=(STAIR_ROUT-1)/ir; lx*=f; lz*=f; }
    }
    // SOFT FENCE — keep the player on the camp ring road; the only way out is the mega-gate road
    // corridor (a gap toward the gate). Once the $100k gate is breached, roam free.
    if(megaGate && !megaGate.open){
      const fr=Math.hypot(lx,lz);
      if(fr>R_OUT-rad && fr>0.001){
        const gAng=Math.atan2(megaGate.z-CAMP_Z, megaGate.x-CAMP_X);
        let dA=Math.abs(Math.atan2(lz,lx)-gAng); if(dA>Math.PI) dA=2*Math.PI-dA;
        if(dA>0.6){ const f=(R_OUT-rad)/fr; lx*=f; lz*=f; }   // outside the road corridor → push back to the fence
      }
    }
  } else {
    const h=W+rad;
    if(Math.abs(lx)<h && Math.abs(lz)<h){
      const dx=h-Math.abs(lx), dz=h-Math.abs(lz);
      const atSouthDoor = doorOpen && Math.abs(lx)<3.5 && lz>0 && dz<=dx;
      if(!atSouthDoor){ if(dx<dz) lx=(lx<0?-h:h); else lz=(lz<0?-h:h); }
    }
  }
  x=CAMP_X+lx; z=CAMP_Z+lz;
  // prop colliders (world coords; gate colliders disappear once the gate is opened)
  for(let i=0;i<colliders.length;i++){ const c=colliders[i];
    if(c.gate && c.gate.open) continue;
    const ddx=x-c.x, ddz=z-c.z, dd=Math.hypot(ddx,ddz), min=c.r+rad;
    if(dd<min && dd>0.0001){ x=c.x+ddx/dd*min; z=c.z+ddz/dd*min; } }
  // placed build blocks (voxel collision) — push the player/enemy out of any non-steppable block
  if(typeof placedBlocks!=='undefined' && placedBlocks.size){
    const fY = isPlayer ? (G.footY||0) : 0, eY = isPlayer ? (playerY||G.eyeY||EYE) : 1.7;
    const r=resolveBlockCollision(x,z,fY,eY,rad); x=r[0]; z=r[1];
  }
  _v3.set(x,0,z); return _v3;
}

// zone-aware enemy collision: 'outside' = solid tower + props; 'inside' = stay in the room,
// off the column; 'roof' = stay on the deck ring (don't fall through the hole).
function clampEnemy(x,z, rad, zone){
  if(zone==='inside'){
    let lx=x-CAMP_X, lz=z-CAMP_Z;
    const r=Math.hypot(lx,lz); const maxR=TOWER_H-1.5;
    if(r>maxR){ lx*=maxR/r; lz*=maxR/r; }
    const minR=STAIR_RIN+rad; const r2=Math.hypot(lx,lz);
    if(r2<minR && r2>0.001){ const f=minR/r2; lx*=f; lz*=f; }
    _v3.set(CAMP_X+lx,0,CAMP_Z+lz); return _v3;
  }
  if(zone==='roof'){
    let lx=x-CAMP_X, lz=z-CAMP_Z;
    const r=Math.hypot(lx,lz)||0.001; const inR=STAIR_ROUT+1.2, outR=TOWER_H-2.5;
    if(r<inR){ const f=inR/r; lx*=f; lz*=f; } else if(r>outR){ const f=outR/r; lx*=f; lz*=f; }
    _v3.set(CAMP_X+lx,0,CAMP_Z+lz); return _v3;
  }
  return clampArena(x,z,rad,false);
}

// nearest player to (x,z) — co-op safe; each enemy independently hunts its closest target
function nearestPlayer(x,z,players){ let best=players[0],bd=1e18;
  for(const p of players){ const d=(p.x-x)*(p.x-x)+(p.z-z)*(p.z-z); if(d<bd){ bd=d; best=p; } } return best; }
// route an enemy via the south tower door when its quarry is in a different zone, so it can
// actually get inside/out instead of grinding on the wall. (Roof has its own spawns.)
function routeWaypoint(e,tgt){
  const TZ=tgt.zone||'outside';
  if(e.zone===TZ) return tgt;
  if(doorOpen){
    if(e.zone==='outside' && (TZ==='inside'||TZ==='roof')) return {x:CAMP_X,z:CAMP_Z+TOWER_H-2};  // step inside
    if(e.zone==='inside'  && TZ==='outside')               return {x:CAMP_X,z:CAMP_Z+TOWER_H+2};  // step outside
  }
  return tgt;
}
// flip an enemy's zone as it crosses the open south doorway (both sides are ground level)
function maybeCrossDoor(e,nx,nz){
  if(!doorOpen || Math.abs(nx-CAMP_X)>=3.4) return;
  if(e.zone==='outside' && (nz-CAMP_Z) < TOWER_H-0.2){ e.zone='inside';  e.baseY=0; }
  else if(e.zone==='inside' && (nz-CAMP_Z) > TOWER_H+0.2){ e.zone='outside'; e.baseY=0; }
}
// cheap "is this spot blocked?" test for path probing (world bound + tower body + prop colliders)
function pathBlocked(x,z,rad,zone){
  if(Math.abs(x)>WB-2 || Math.abs(z)>WB-2) return true;
  if(zone!=='inside' && zone!=='roof'){
    const lx=x-CAMP_X, lz=z-CAMP_Z;
    if(Math.abs(lx)<TOWER_H+rad && Math.abs(lz)<TOWER_H+rad && !(doorOpen && Math.abs(lx)<3.5 && lz>0)) return true;
  }
  for(let i=0;i<colliders.length;i++){ const c=colliders[i]; if(c.gate && c.gate.open) continue;
    const dx=x-c.x, dz=z-c.z, m=c.r+rad; if(dx*dx+dz*dz < m*m) return true; }
  return false;
}
// SMOOTH obstacle avoidance — probe the desired heading first, then widening angles (committed
// side first); take the first CLEAR heading. No straight↔veer oscillation → no zig-zag.
const _steer=[0,0];
function steerDir(e, ox, oz, dirx, dirz, rad, zone){
  const base=Math.atan2(dirz,dirx), probe=2.8, s=e.side||1;
  const offs=[0, 0.45*s, 0.45*-s, 0.9*s, 0.9*-s, 1.35*s, 1.35*-s, 1.8*s, 1.8*-s];
  for(let i=0;i<offs.length;i++){ const a=base+offs[i], tx=ox+Math.cos(a)*probe, tz=oz+Math.sin(a)*probe;
    if(!pathBlocked(tx,tz,rad,zone)){ if(offs[i]!==0) e.side=(offs[i]>0?1:-1); _steer[0]=Math.cos(a); _steer[1]=Math.sin(a); return _steer; } }
  _steer[0]=dirx; _steer[1]=dirz; return _steer;   // fully boxed in → push straight (clamp slides us)
}
function updateEnemies(dt){
  const players=getPlayers(), et=clock.elapsedTime;
  for(let i=0;i<zombies.length;i++){ const e=zombies[i]; if(!e.alive) continue;
    // rise-in scale
    if(e.grp.scale.x<1){ e.grp.scale.setScalar(Math.min(1, e.grp.scale.x+dt*3)); }
    const tgt=nearestPlayer(e.grp.position.x, e.grp.position.z, players);
    const pdx=tgt.x-e.grp.position.x, pdz=tgt.z-e.grp.position.z; const pdist=Math.hypot(pdx,pdz);
    e.grp.rotation.y = Math.atan2(pdx,pdz);              // always face the player
    if(pdist>1.4){
      const wp=routeWaypoint(e,tgt);
      const wx=wp.x-e.grp.position.x, wz=wp.z-e.grp.position.z; const wd=Math.hypot(wx,wz)||1;
      const st=steerDir(e, e.grp.position.x, e.grp.position.z, wx/wd, wz/wd, 0.55, e.zone);
      const sp=e.speed*dt;
      const c=clampEnemy(e.grp.position.x+st[0]*sp, e.grp.position.z+st[1]*sp, 0.5, e.zone);
      maybeCrossDoor(e, c.x, c.z);
      e.grp.position.x=c.x; e.grp.position.z=c.z;
      if(e.zone==='outside') enemyAttackBlocks(e, dt);    // chew through any player-built blocks in the way
    } else {
      // melee — only if on roughly the same level as the player
      if(Math.abs(e.baseY-((tgt.eyeY||EYE)-EYE))<3){ e.atkCd-=dt; if(e.atkCd<=0){ e.atkCd=1.0; hurtPlayer(e.dmg||14); } }
    }
    // SAFETY: a zombie that can't get closer to any player for too long (walled off / wedged) is
    // relocated near the player — guarantees the round can always finish ("1 remaining" can't get stuck).
    if(pdist>6){ if(pdist < (e.bestDist||1e9)-0.5){ e.bestDist=pdist; e.noProg=0; }
      else if((e.noProg=(e.noProg||0)+dt) > 9){ const s=pickSpawn(); e.zone=s[3]||'outside'; e.baseY=s[2]||0; e.grp.position.set(s[0],e.baseY,s[1]); e.noProg=0; e.bestDist=1e9; } }
    else { e.noProg=0; e.bestDist=0; }
    e.grp.position.y=e.baseY;                 // sit on this zone's floor (ground or roof)
    if(e.anim) e.anim((e.isSprinter? et*1.8 : et) + i); // shamble (sprinters churn faster → read as running)
  }
  // mini-boss (greedy seek + the same wall-follow so it can't wedge on the tower/props)
  if(boss && boss.userData.alive){ if(boss.scale.x<0.46) boss.scale.setScalar(Math.min(0.46,boss.scale.x+dt*0.6));
    const bd=boss.userData; const tgt=nearestPlayer(boss.position.x, boss.position.z, players);
    const dx=tgt.x-boss.position.x, dz=tgt.z-boss.position.z, dist=Math.hypot(dx,dz);
    boss.rotation.y=Math.atan2(dx,dz);
    if(dist>2.2){
      const st=steerDir(bd, boss.position.x, boss.position.z, dx/dist, dz/dist, 1.1, 'outside');
      const sp=bd.speed*dt; const c=clampArena(boss.position.x+st[0]*sp, boss.position.z+st[1]*sp, 1.0, false);
      boss.position.x=c.x; boss.position.z=c.z;
    }
    else { bd.atkCd-=dt; if(bd.atkCd<=0){ bd.atkCd=1.3; hurtPlayer(34); } }
    if(boss.userData.update) boss.userData.update(et);
  }
  // mega boss (egg → hatch → chase)
  if(mega && mega.userData.alive){
    const megaY=G.megaY||0;
    mega.userData.hatch += dt*0.12;
    if(mega.userData.update) mega.userData.update(et);
    if(mega.userData.hatch>1.2){
      const tgt=nearestPlayer(mega.position.x, mega.position.z, players);
      const dx=tgt.x-mega.position.x, dz=tgt.z-mega.position.z, dist=Math.hypot(dx,dz);
      mega.rotation.y=Math.atan2(dx,dz);
      if(dist>8){ const sp=mega.userData.speed*dt; let nx=mega.position.x+dx/dist*sp, nz=mega.position.z+dz/dist*sp;
        if(megaY>10){ const c=clampEnemy(nx,nz,2.5,'roof'); nx=c.x; nz=c.z; }   // keep it on the roof deck
        mega.position.x=nx; mega.position.z=nz; }
      else if(Math.abs(megaY-((G.eyeY||EYE)-EYE))<6){ mega.userData.atkCd-=dt; if(mega.userData.atkCd<=0){ mega.userData.atkCd=1.6; hurtPlayer(mega.userData.dmg||45); } }
      mega.position.y=megaY+ (mega.userData.hatch<2? (2-mega.userData.hatch)*4.2 : 0);  // settle from the egg onto the deck
    }
  }
}

/* ════════════════════ PLAYER (fixed-step) ════════════════════ */
function hurtPlayer(n){
  if(G.phase!=='play') return;
  G.health-=n; G.lastDmg=clock.elapsedTime; AU.hurt(); damageFlash();
  if(G.health<=0){ G.health=0; updateHealthHUD(); gameOver(); }
  else updateHealthHUD();
}
function updatePlayer(dt){
  // look already applied on mousemove; here do movement + gravity + collision
  const sprint = G.keys['shift'] && !G.keys['s'];
  const baseSpeed = (sprint?8.6:5.6) * (G.perks.has('rootbeer')?1.25:1) * (G.mounted?1.5:1);   // Rootbeer Meth + pig mount (+50%)
  if(G.mounted && pigFP && pigFP.userData.update) pigFP.userData.update(clock.elapsedTime);
  // forward/right from yaw
  _fwd.set(Math.sin(G.yaw),0,Math.cos(G.yaw));
  _right.set(Math.cos(G.yaw),0,-Math.sin(G.yaw));
  let mx=0,mz=0;
  if(G.keys['w']){ mx-=_fwd.x; mz-=_fwd.z; }
  if(G.keys['s']){ mx+=_fwd.x; mz+=_fwd.z; }
  if(G.keys['a']){ mx-=_right.x; mz-=_right.z; }
  if(G.keys['d']){ mx+=_right.x; mz+=_right.z; }
  const ml=Math.hypot(mx,mz); if(ml>0){ mx/=ml; mz/=ml; }
  const oldx=camera.position.x, oldz=camera.position.z;
  let nx, nz;
  if(G.driving){
    // arcade car: A/D steer (rotate heading), W/S throttle along facing, momentum + friction
    const steer=(G.keys['a']?1:0)-(G.keys['d']?1:0), throttle=(G.keys['w']?1:0)-(G.keys['s']?1:0);
    if(!G.carVel) G.carVel=new T.Vector3();
    let spd0=Math.hypot(G.carVel.x,G.carVel.z);
    G.yaw += steer*1.7*dt*Math.min(1, spd0/3);              // steering bites once you're rolling
    const fx=-Math.sin(G.yaw), fz=-Math.cos(G.yaw);          // "forward" (W) direction
    const ACC=30, MAXV=20, FR=0.96;
    G.carVel.x += fx*throttle*ACC*dt; G.carVel.z += fz*throttle*ACC*dt;
    G.carVel.multiplyScalar(FR);
    let spd=Math.hypot(G.carVel.x,G.carVel.z); if(spd>MAXV){ G.carVel.x*=MAXV/spd; G.carVel.z*=MAXV/spd; spd=MAXV; }
    nx=oldx+G.carVel.x*dt; nz=oldz+G.carVel.z*dt;
    if(carPOV && carPOV.userData.update){ carPOV.userData.setSpeed(Math.round(spd*5)); carPOV.userData.setSteer(steer); carPOV.userData.setHealth(G.health); carPOV.userData.update(clock.elapsedTime); }
  } else {
    nx=oldx + mx*baseSpeed*dt;
    nz=oldz + mz*baseSpeed*dt;
  }
  const c=clampArena(nx,nz,PLAYER_R,true,G.eyeY); camera.position.x=c.x; camera.position.z=c.z;
  // staircase barricade: refuse a step that would climb past an uncleared gate
  const cc=climbCap();
  if(cc<Infinity && spiralHeightAt(camera.position.x,camera.position.z,G.footY||0) > cc+0.6){
    camera.position.x=oldx; camera.position.z=oldz;
  }
  // gravity / jump with height-field floor (ground, spiral stairs, or roof deck).
  // Physics runs on G.eyeY (the TRUE eye height, no bob) so head-bob never feeds back into
  // the ground check — that feedback used to make the view micro-bounce while walking.
  const gh=groundHeightAt(camera.position.x, camera.position.z, G.footY||0);
  const floorY=gh+EYE;
  G.vy-=GRAV*dt; G.eyeY+=G.vy*dt;
  if(G.eyeY<=floorY){ G.eyeY=floorY; G.vy=0; G.onGround=true; G.footY=gh; } else G.onGround=false;
  // head bob is a VISUAL offset only — applied to the camera, never to the physics height
  let bob=0;
  if(ml>0 && G.onGround) bob=Math.sin(clock.elapsedTime*(sprint?16:11))*(sprint?0.05:0.035);
  camera.position.y = G.eyeY + bob;
  // health regen (Rootbeer Meth: regen sooner + faster)
  const _rb=G.perks.has('rootbeer');
  if(clock.elapsedTime - G.lastDmg > (_rb?2.2:4) && G.health<G.maxHealth){ G.health=Math.min(G.maxHealth, G.health+(_rb?55:30)*dt); updateHealthHUD(); }
  // arms recoil/sway recover
  if(arms){ recoil*=Math.max(0,1-dt*9);
    arms.position.z = recoil*0.12; arms.rotation.x = recoil*0.5;
    arms.position.y = Math.sin(clock.elapsedTime*1.6)*0.01;
    arms.position.x = Math.sin(clock.elapsedTime*0.9)*0.008; }
  // muzzle flash decay
  if(muzzle && muzzle.intensity>0){ muzzle.intensity=Math.max(0, muzzle.intensity - dt*22); }
  // door swing
  if(towerDoorPivot){ const tgt=doorOpen?-Math.PI*0.62:0; towerDoorPivot.rotation.y += (tgt-towerDoorPivot.rotation.y)*Math.min(1,dt*3); }
  // roof barricade drops away once cleared
  if(roofBarrier && roofOpen && roofBarrier.visible){ roofBarrier.position.y -= dt*6; if(roofBarrier.position.y<-8){ roofBarrier.visible=false; } }
  // gate plank animation
  for(const it of interactables){ if(it.type==='gate' && it.open && it.anim<1){ it.anim=Math.min(1,it.anim+dt*0.8);
    for(const pk of it.planks){ pk.mesh.position.y=pk.cy+(pk.oy-pk.cy)*it.anim; pk.mesh.rotation.z=pk.cr+(pk.or-pk.cr)*it.anim; if(it.anim>=1) pk.mesh.visible=false; } } }
  // expire timed powerups display
}

/* reload */
/* ════════════════════ RELOAD ANIMATION ════════════════════
   Lightweight first-person reload anim — no new meshes; reuses the held weapon group
   + arm groups, driven by the existing reload timer. */
function _win(p,a,b){ return (p<=a||p>=b)?0:Math.sin((p-a)/(b-a)*Math.PI); }   // 0→1→0 bell
function _ramp(p,a,b){ return Math.min(1,Math.max(0,(p-a)/(b-a))); }
function _swap(p,a,b){ const k=_ramp(p,a,b); return k<0.5? k*2 : (1-k)*2; }     // drop then seat
function tagReloadParts(arms){
  if(!arms) return; const weapon=arms.userData.weapon; if(!weapon) return;
  const rArm=arms.children[1], lArm=arms.children[2]; const ch=weapon.children;
  const type=window.__SE && window.__SE.weapon; const part={};
  if(type==='pistol'){ part.slide=ch[0]; }
  else if(type==='smg'){ part.mag=ch[2]; part.charge=ch[3]; }
  else if(type==='shotgun'){ part.pump=ch[2]; }
  else if(type==='ak'){ part.mag=ch[2]; part.charge=ch[6]; }
  else if(type==='lmg'){ part.drum=ch[2]; part.charge=ch[6]; }
  else if(type==='wonder'){ part.core=weapon.children.find(o=>o.geometry&&o.geometry.type==='SphereGeometry'); }
  else if(type==='sniper'){ part.charge=ch[5]; }
  else { part.mag=ch[2]; part.charge=ch[5]; }
  const base=(o)=>o?{o, p:o.position.clone(), r:o.rotation.clone(), s:o.scale.clone()}:null;
  const r={ W:base(weapon), R:base(rArm), L:base(lArm), part:{} };
  for(const k in part){ const b=base(part[k]); if(b) r.part[k]=b; }
  arms.userData.reloadRig=r;
}
function _resetBase(b){ if(!b) return; b.o.position.copy(b.p); b.o.rotation.copy(b.r); b.o.scale.copy(b.s); }
function clearReloadAnim(arms){ const rig=arms&&arms.userData.reloadRig; if(!rig) return;
  _resetBase(rig.W); _resetBase(rig.L); _resetBase(rig.R); for(const k in rig.part) _resetBase(rig.part[k]); }
function applyReloadAnim(arms, type, p){
  const rig=arms&&arms.userData.reloadRig; if(!rig) return; p=Math.min(1,Math.max(0,p));
  const W=rig.W, L=rig.L, R=rig.R, part=rig.part;
  _resetBase(W); _resetBase(L); _resetBase(R); for(const k in part) _resetBase(part[k]);
  const bell=_win(p,0,1);
  if(W){ W.o.position.y += -0.09*bell; W.o.position.z += 0.05*bell; }              // gun dips toward player
  if(type==='pistol'){ if(W) W.o.rotation.z += 0.45*bell; if(part.slide){ part.slide.o.position.z += -0.13*_win(p,0.78,0.96); } if(L){ L.o.position.y += -0.24*_win(p,0.08,0.62); } }
  else if(type==='smg'){ if(W) W.o.rotation.z += 0.32*bell; if(part.mag){ part.mag.o.position.y += -0.7*_swap(p,0.06,0.58); } if(part.charge){ part.charge.o.position.z += -0.16*_win(p,0.8,0.96); } if(L){ L.o.position.y += -0.32*_win(p,0.06,0.58); } }
  else if(type==='shotgun'){ const pmp=_win(p,0.28,0.5)+_win(p,0.6,0.82); if(part.pump){ part.pump.o.position.z += -0.2*pmp; } if(W) W.o.rotation.x += -0.12*bell; if(L){ L.o.position.z += -0.2*pmp; } }
  else if(type==='ak'){ if(W) W.o.rotation.z += 0.35*bell; if(part.mag){ const o=_win(p,0.08,0.72); part.mag.o.position.y += -0.5*o; part.mag.o.rotation.x += 0.7*o; } if(part.charge){ part.charge.o.position.z += -0.14*_win(p,0.8,0.95); } if(L){ L.o.position.y += -0.3*_win(p,0.08,0.72); } }
  else if(type==='lmg'){ if(W){ W.o.position.y += -0.16*bell; W.o.rotation.z += 0.2*bell; } if(part.drum){ const o=_win(p,0.2,0.72); part.drum.o.position.y += -0.34*o; part.drum.o.rotation.z += 6.0*_ramp(p,0.2,0.72); } if(L){ L.o.position.y += -0.34*_win(p,0.18,0.78); } }
  else if(type==='wonder'){ if(W) W.o.rotation.x += -0.18*bell; if(part.core){ const o=_win(p,0.14,0.84); part.core.o.position.z += 0.42*o; const s=1+0.7*o; part.core.o.scale.set(s,s,s); } if(L){ L.o.position.y += -0.2*_win(p,0.2,0.7); } }
  else if(type==='sniper'){ if(W) W.o.rotation.z += 0.4*bell; if(part.charge){ part.charge.o.position.z += -0.12*_win(p,0.82,0.96); } if(L) L.o.position.y += -0.28*_win(p,0.08,0.6); }
  else { if(W) W.o.rotation.z += 0.4*bell; if(part.mag){ part.mag.o.position.y += -0.62*_swap(p,0.08,0.6); } if(part.charge){ part.charge.o.position.z += -0.12*_win(p,0.82,0.96); } if(L) L.o.position.y += -0.28*_win(p,0.08,0.6); }
}
function startReload(){
  const w=curW(); if(!w||w.reloading) return; if(w.ammo>=w.mag || w.reserve<=0) return;
  const d=WDEF[w.type]; const rt=d.reload * (G.perks.has('pingasliquid')?0.55:1);
  w.reloading=true; w.reloadStart=clock.elapsedTime; w.reloadEnd=clock.elapsedTime+rt; AU.reload(); flashReloadHint(true);
}
function updateReload(){
  const w=curW();
  if(!w||!w.reloading){ if(arms && arms.userData.reloadRig && arms.userData._wasReloading){ clearReloadAnim(arms); arms.userData._wasReloading=false; } return; }
  const dur=(w.reloadEnd-w.reloadStart)||1, p=(clock.elapsedTime-(w.reloadStart||clock.elapsedTime))/dur;
  applyReloadAnim(arms, w.type, p); if(arms&&arms.userData) arms.userData._wasReloading=true;
  if(clock.elapsedTime>=w.reloadEnd){ w.reloading=false; clearReloadAnim(arms); if(arms&&arms.userData) arms.userData._wasReloading=false;
    const need=w.mag-w.ammo, take=Math.min(need,w.reserve); w.ammo+=take; w.reserve-=take; updateAmmoHUD(); flashReloadHint(false); }
}

/* ════════════════════ INTERACTION ════════════════════ */
let nearInteract=null;
let _justLocked=false;   // guards the first mouse delta after pointer-lock (prevents view snap)
function updateInteraction(){
  const px=camera.position.x, pz=camera.position.z; let found=null, fd=99;
  for(const it of interactables){ const d=Math.hypot(px-(it.wx!=null?it.wx:it.x), pz-(it.wz!=null?it.wz:it.z));
    if(d<it.radius && d<fd){ const lbl=it.label&&it.label(); if(lbl){ found=it; fd=d; found._lbl=lbl; } } }
  nearInteract=found; renderPrompt(found?found._lbl:null);
}
function doInteract(){ if(nearInteract && nearInteract.run){ nearInteract.run(); } }

/* ════════════════════ HUD ════════════════════ */
const $=id=>document.getElementById(id);
function updateHealthHUD(){ const p=Math.max(0,G.health/G.maxHealth); $('hpfill').style.width=(p*100)+'%';
  $('lowhp').style.opacity = p<0.34?String((0.34-p)/0.34):'0'; }
function updatePointsHUD(){ $('points').querySelector('.val').textContent=G.points; }
let popT=0;
function pointsPop(n){ const el=$('pointsPop'); el.textContent='+'+n; el.style.opacity='1'; el.style.transform='translateY(-6px)'; popT=clock.elapsedTime; }
function updateAmmoHUD(){ const a=$('ammo'), wn=$('wname');
  // holding a build item (block / food / material) → show its name only, no ammo readout
  const aid=(typeof hotActiveId==='function')?hotActiveId():null, ad=aid?itemDef(aid):null;
  if(ad && ad.kind!=='gun'){ if(wn) wn.innerHTML=itemName(aid);
    if(a) a.style.display='none'; const rh=$('reloadHint'); if(rh) rh.style.opacity='0'; updateNadeHUD(); return; }
  const w=curW(); if(!w) return;
  const melee = WDEF[w.type] && WDEF[w.type].kind==='melee';
  if(a) a.style.display = melee? 'none':'';      // melee tools (pickaxe) have no ammo either
  if(!melee){
    a.querySelector('.mag').textContent = w.type==='axe'? (w.ammo?'●':'○') : w.ammo;
    a.querySelector('.res').textContent = w.reserve;
    a.classList.toggle('low', w.ammo<=Math.max(1,Math.ceil(w.mag*0.25)));
  }
  if(wn) wn.innerHTML = w.pap? '<span class="pap">'+w.name+'</span>' : w.name;
  updateNadeHUD();
}
function updateNadeHUD(){ /* could show nades; folded into wname for brevity */ }
function updateRoundHUD(flash){ $('round').querySelector('.num').textContent=G.round;
  if(flash){ const r=$('round'); r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash'); } updateZleftHUD(); }
function updateZleftHUD(){ const left = G.toSpawn + G.aliveCount; $('zleft').innerHTML='UNDEAD&nbsp;&nbsp;<b>'+Math.max(0,left)+'</b>'; }
function updateBossBar(){
  const bar=$('bossbar'); if(!bar) return;
  let active=null, name='';
  if(mega && mega.userData.alive){ active=mega.userData; name=(mega.userData.source==='lvl25')?'GIGA PINGAS BOSS':'MEGA PINGAS BOSS'; }
  else if(boss && boss.userData.alive){ active=boss.userData; name='BRUTE'; }
  if(active){ bar.classList.remove('hidden'); $('bossname').textContent=name;
    const p=Math.max(0,Math.min(1, active.hp/active.maxhp)); $('bosshpfill').style.width=(p*100)+'%';
  } else bar.classList.add('hidden');
}
function updatePerksHUD(){ const wrap=$('perks'); wrap.innerHTML='';
  const icons={doubleshot:['DS','#35d6ff'], rootbeer:['RM','#ffa23a'], juggernaut:['JUG','#ff6b35'], pingasliquid:['PL','#ff48c0']};
  G.perks.forEach(p=>{ const [t,c]=icons[p]||['?','#fff']; const d=document.createElement('div'); d.className='perk';
    d.style.borderColor=c; d.style.color=c; d.textContent=t; wrap.appendChild(d); }); }
function renderPrompt(lbl){ const el=$('prompt'); if(!lbl){ el.style.opacity='0'; return; }
  el.style.opacity='1'; el.classList.toggle('cant', !!lbl.cant);
  el.querySelector('.key').textContent=lbl.key||'F';
  el.querySelector('.txt').innerHTML = lbl.txt + (lbl.cost>0?' <span class="cost">$'+lbl.cost+'</span>':''); }
let toastT=0;
function toast(big,small,color){ const t=$('toast'), s=$('subtoast'); t.textContent=big; t.style.color=color||'#eaf2ff';
  t.style.opacity='1'; s.textContent=small||''; s.style.opacity=small?'1':'0'; toastT=clock.elapsedTime; }
function updateToasts(){ if(toastT && clock.elapsedTime-toastT>2.2){ $('toast').style.opacity='0'; $('subtoast').style.opacity='0'; toastT=0; }
  if(popT && clock.elapsedTime-popT>0.8){ $('pointsPop').style.opacity='0'; $('pointsPop').style.transform='translateY(0)'; popT=0; } }
let hmT=0;
function hitmarker(){ const h=$('hitmark'); h.style.opacity='1'; hmT=clock.elapsedTime; const c=$('cross'); c.classList.add('hit'); }
function updateHitmark(){ if(hmT && clock.elapsedTime-hmT>0.12){ $('hitmark').style.opacity='0'; $('cross').classList.remove('hit'); hmT=0; } }
function damageFlash(){ $('vignette').style.background='radial-gradient(ellipse at center, transparent 35%, rgba(150,10,10,.5) 100%)';
  setTimeout(()=>{ $('vignette').style.background='radial-gradient(ellipse at center, transparent 55%, rgba(140,10,10,0) 100%)'; },140); }
let denyT=0; function flashDeny(){ const p=$('prompt'); p.classList.add('cant'); denyT=clock.elapsedTime; }
function flashReloadHint(show){ $('reloadHint').style.opacity = show? '1':'0'; }
function setCharge(k){ $('chargebar').style.width=(k*120)+'px'; }

/* ════════════════════ INPUT / POINTER LOCK ════════════════════ */
/* ════════════════════ MINECRAFT BUILD MODE — inventory · hotbar · mining · building · crafting ════════════════════
   Slot-based inventory (20 main + 5 hotbar + 3×3 craft), stacks of 64, drag + right-click-drop-one,
   mine trees/rocks/ore, place 1×1 voxels with structural support + per-material HP, eat to heal. */
const STK = 64;                 // default stack size
const BS  = 0.5;                // voxel size (matches the kit's makeMcBlock 0.5u cube)

// ── item registry: every block / material / food / gun, with player-facing descriptions ──
const MC_ITEMS = {
  // building blocks (placeable)
  stone:       { name:'STONE',        kind:'block', stack:64, place:true,  hp:60,   desc:'Sturdy build block (60 HP). Mined from rocks.' },
  cobblestone: { name:'COBBLESTONE',  kind:'block', stack:64, place:true,  hp:55,   desc:'Rough stone build block (55 HP).' },
  wood:        { name:'WOOD',         kind:'block', stack:64, place:true,  hp:40,   desc:'Log. Build with it or craft planks (40 HP).' },
  plank:       { name:'PLANKS',       kind:'block', stack:64, place:true,  hp:35,   desc:'Cut wood. Build, or craft sticks/doors (35 HP).' },
  glass:       { name:'GLASS',        kind:'block', stack:64, place:true,  hp:12,   desc:'See-through block — lets light in. Fragile (12 HP).' },
  dirt:        { name:'DIRT',         kind:'block', stack:64, place:true,  hp:20,   desc:'Plantable soil. Plant wheat on it (20 HP).' },
  grass:       { name:'GRASS',        kind:'block', stack:64, place:true,  hp:20,   desc:'Grassy dirt block (20 HP).' },
  brick:       { name:'BRICK',        kind:'block', stack:64, place:true,  hp:120,  desc:'Tough crafted block (120 HP). Great walls.' },
  obsidian:    { name:'OBSIDIAN',     kind:'block', stack:64, place:true,  hp:1000, desc:'Nearly indestructible — 1000 HP. The best wall.' },
  diamondblock:{ name:'DIAMOND BLOCK',kind:'block', stack:64, place:true,  hp:300,  desc:'Pure diamond block (300 HP). 3 make a Super Upgrade.' },
  leaves:      { name:'LEAVES',       kind:'block', stack:64, place:true,  hp:15,   desc:'Leafy block (15 HP). Decorative cover.' },
  door:        { name:'DOOR',         kind:'block', stack:64, place:true,  hp:50,   desc:'Placeable door — right-click it to open/close (50 HP).' },
  // materials (not placeable)
  coal:        { name:'COAL',         kind:'mat',  stack:64, place:false, desc:'Fuel & crafting material. Mined from rocks.' },
  iron:        { name:'IRON',         kind:'mat',  stack:64, place:false, desc:'Metal material from rocks. Used for obsidian.' },
  diamond:     { name:'DIAMOND',      kind:'mat',  stack:64, place:false, desc:'Rare gem from the cave. Tools & super-upgrades.' },
  stick:       { name:'STICK',        kind:'mat',  stack:64, place:false, desc:'Crafting material — combine for tools.' },
  wheat:       { name:'WHEAT',        kind:'mat',  stack:64, place:false, desc:'Harvested crop. 3 in a row craft Bread.' },
  pingasore:   { name:'PINGAS ORE',   kind:'mat',  stack:64, place:false, desc:'Glowing ore from the cave.' },
  // food
  bread:       { name:'BREAD',        kind:'food', stack:64, place:false, heal:9999, desc:'Right-click to EAT — instantly heal to full.' },
  // guns / tools (live in G.weapons; shown in slots 0-1 of the hotbar, never stacked)
  pistol:{ name:'M1911', kind:'gun', stack:1, place:false, desc:'Starter sidearm.' },
  pickaxe:{ name:'PICKAXE', kind:'gun', stack:1, place:false, desc:'Melee tool — mines blocks & swings at the undead (130 pts/kill).' },
  diapick:{ name:'DIAMOND PICKAXE', kind:'gun', stack:1, place:false, desc:'Upgraded pickaxe — big melee + faster mining.' },
  smg:{ name:'MP-40', kind:'gun', stack:1, place:false, desc:'Wall-buy SMG.' },
  shotgun:{ name:'TRENCH GUN', kind:'gun', stack:1, place:false, desc:'Close-range shotgun.' },
  sniper:{ name:'SNIPER', kind:'gun', stack:1, place:false, desc:'Scoped bolt-action.' },
  ak:{ name:'AK', kind:'gun', stack:1, place:false, desc:'Assault rifle.' },
  lmg:{ name:'LMG', kind:'gun', stack:1, place:false, desc:'Belt-fed machine gun.' },
  wonder:{ name:'DG WONDERWAFFE', kind:'gun', stack:1, place:false, desc:'Wonder weapon — chain lightning.' },
};
function itemDef(id){ return id?MC_ITEMS[id]:null; }
function itemStack(id){ const d=itemDef(id); return d?(d.stack||STK):STK; }
function isPlaceable(id){ const d=itemDef(id); return !!(d&&d.place); }
function itemName(id){ const d=itemDef(id); return d?d.name:(id||'').toUpperCase(); }

// ── crafting recipes (shaped 3×3, matched after trimming empty rows/cols) ──
const MC_RECIPES = [
  { name:'Planks',         desc:'1 wood → 4 planks',                 out:{type:'plank',count:4},        shape:[['wood']] },
  { name:'Sticks',         desc:'2 planks → 4 sticks',               out:{type:'stick',count:4},        shape:[['plank'],['plank']] },
  { name:'Glass',          desc:'1 stone + 2 coal → 2 glass',        out:{type:'glass',count:2},        shape:[['stone','coal','coal']] },
  { name:'Door',           desc:'2 wood → 1 door',                   out:{type:'door',count:1},         shape:[['wood','wood']] },
  { name:'Bread',          desc:'3 wheat in a row → 1 bread (heals to full)', out:{type:'bread',count:1}, shape:[['wheat','wheat','wheat']] },
  { name:'Bricks',         desc:'4 stone (2×2) → 4 bricks (tough)',  out:{type:'brick',count:4},        shape:[['stone','stone'],['stone','stone']] },
  { name:'Obsidian',       desc:'stone ring + coal + iron core → 1 obsidian (1000 HP)', out:{type:'obsidian',count:1},
      shape:[['stone','coal','stone'],['coal','iron','coal'],['stone','coal','stone']] },
  { name:'Diamond Block',  desc:'9 diamonds → 1 diamond block',      out:{type:'diamondblock',count:1}, shape:[['diamond','diamond','diamond'],['diamond','diamond','diamond'],['diamond','diamond','diamond']] },
  { name:'Diamond Pickaxe',desc:'3 diamonds + 2 planks → upgrade your pickaxe', out:{type:'diapick',count:1}, shape:[['diamond','diamond','diamond'],['','plank',''],['','plank','']] },
  { name:'Super Upgrade',  desc:'3 diamond blocks → 2× damage + 30% fire-rate on your held weapon', out:{type:'super',count:1}, shape:[['diamondblock','diamondblock','diamondblock']] },
  { name:'House Kit',      desc:'planks + door + wood → build a house in front of you', out:{type:'housekit',count:1},
      shape:[['plank','plank','plank'],['plank','door','plank'],['wood','wood','wood']] },
];
function mcRecipeBookHTML(){
  return MC_RECIPES.map(r=>{
    const t = (r.out.type==='diapick')?'diapick' : (r.out.type==='super')?'super' : (r.out.type==='housekit')?'plank' : r.out.type;
    return '<div class="recipeRow"><div class="mcBlk" data-t="'+t+'"></div>'
      + '<div class="rInfo"><div class="rName">'+r.name+(r.out.count>1?' ×'+r.out.count:'')+'</div>'
      + '<div class="rDesc">'+r.desc+'</div></div></div>';
  }).join('');
}

// ── inventory state: slots hold {id,n} or null ──
const INV = { main:new Array(20).fill(null), hot:new Array(5).fill(null), craft:new Array(9).fill(null), held:null, sel:0 };
function slotsForZone(z){ return z==='main'?INV.main : z==='hot'?INV.hot : z==='craft'?INV.craft : null; }
function invCount(id){ let n=0; for(const z of [INV.hot,INV.main]) for(const s of z) if(s&&s.id===id) n+=s.n; return n; }
// add up to n of id into hotbar(item slots 2-4) then main; returns leftover that didn't fit
function invAdd(id,n){ const d=itemDef(id); if(!d||d.kind==='gun') return n; const max=itemStack(id);
  const fill=(arr,lo)=>{ for(let i=lo;i<arr.length&&n>0;i++){ const s=arr[i]; if(s&&s.id===id&&s.n<max){ const t=Math.min(max-s.n,n); s.n+=t; n-=t; } } };
  const empty=(arr,lo)=>{ for(let i=lo;i<arr.length&&n>0;i++){ if(!arr[i]){ const t=Math.min(max,n); arr[i]={id,n:t}; n-=t; } } };
  fill(INV.hot,2); fill(INV.main,0); empty(INV.hot,2); empty(INV.main,0);
  if(G.phase==='inv') renderInv(); renderHotbar(); return n; }
function invRemove(id,n){ // remove up to n; returns amount actually removed
  let got=0; for(const arr of [INV.hot,INV.main]) for(let i=0;i<arr.length;i++){ const s=arr[i]; if(s&&s.id===id){ const t=Math.min(s.n,n-got); s.n-=t; got+=t; if(s.n<=0) arr[i]=null; if(got>=n) return got; } }
  if(G.phase==='inv') renderInv(); renderHotbar(); return got; }

// ── slot HTML ──
function mcBlkHTML(id){ if(!id) return ''; const d=itemDef(id);
  if(d&&d.kind==='gun') return '<div class="mcBlk gunChip" data-t="'+id+'"><span>'+(d.name||id).slice(0,3)+'</span></div>';
  return '<div class="mcBlk" data-t="'+id+'"></div>'; }
function slotInner(s){ if(!s) return ''; return mcBlkHTML(s.id)+(s.n>1?'<span class="mcCount">'+s.n+'</span>':''); }

// ── crafting: read INV.craft ids, match a recipe ──
let mcMatch=null;
function craftId(i){ return INV.craft[i]?INV.craft[i].id:''; }
function mcNormalize(){ let cells=[]; for(let r=0;r<3;r++) cells.push([craftId(r*3),craftId(r*3+1),craftId(r*3+2)]);
  if(!cells.some(row=>row.some(c=>c))) return null;
  while(cells.length && cells[0].every(c=>!c)) cells.shift();
  while(cells.length && cells[cells.length-1].every(c=>!c)) cells.pop();
  while(cells[0].length>1 && cells.every(row=>!row[0])) cells.forEach(row=>row.shift());
  while(cells[0].length>1 && cells.every(row=>!row[row.length-1])) cells.forEach(row=>row.pop());
  return cells.map(row=>row.map(c=>c||'')); }
function mcShapesEqual(a,b){ if(a.length!==b.length) return false;
  for(let r=0;r<a.length;r++){ if(a[r].length!==b[r].length) return false; for(let c=0;c<a[r].length;c++) if((a[r][c]||'')!==(b[r][c]||'')) return false; } return true; }
function mcEvalRecipe(){ const norm=mcNormalize(); mcMatch=null;
  if(norm) for(const rec of MC_RECIPES) if(mcShapesEqual(norm,rec.shape)){ mcMatch=rec; break; }
  const rs=$('mcCraftResult'), rn=$('mcCraftName'), btn=$('mcCraftBtn');
  if(!rs) return;
  if(mcMatch){ const o=mcMatch.out; const t=(o.type==='diapick')?'diapick':(o.type==='super')?'super':(o.type==='housekit')?'plank':o.type;
    rs.innerHTML=mcBlkHTML(t)+(o.count>1?'<span class="mcCount">'+o.count+'</span>':''); rs.classList.add('ready');
    if(rn) rn.textContent=mcMatch.name; if(btn) btn.disabled=false; }
  else { rs.innerHTML=''; rs.classList.remove('ready'); if(rn) rn.textContent='—'; if(btn) btn.disabled=true; } }
function mcCraft(){ if(!mcMatch) return; const rec=mcMatch, o=rec.out;   // capture before invAdd re-evaluates the grid
  for(let i=0;i<9;i++){ const s=INV.craft[i]; if(s){ s.n--; if(s.n<=0) INV.craft[i]=null; } }  // consume one per filled cell
  if(o.type==='diapick'){ upgradeToDiamondPick(); }
  else if(o.type==='super'){ applySuperUpgrade(); }
  else if(o.type==='housekit'){ placeHousePrefabInFront(); }
  else invAdd(o.type,o.count);
  if(AU&&AU.buy) AU.buy(); toast('CRAFTED '+rec.name.toUpperCase(), o.type==='super'||o.type==='diapick'||o.type==='housekit'?'':'+'+o.count, '#9fd0ff');
  renderInv(); renderHotbar(); mcEvalRecipe(); }

// ── rendering ──
function renderZone(zone){ const arr=slotsForZone(zone); if(!arr) return;
  document.querySelectorAll('#mcInv [data-'+zone+']').forEach(el=>{ const i=+el.dataset[zone]; el.innerHTML=slotInner(arr[i]); }); }
function renderInv(){ renderZone('main'); renderZone('hot'); renderZone('craft'); mcEvalRecipe(); }
function renderHotbar(){ const bar=$('hotbar'); if(!bar) return;
  for(let i=0;i<5;i++){ const cell=bar.querySelector('[data-hotslot="'+i+'"]'); if(!cell) continue;
    const ic=cell.querySelector('.hicon'), cn=cell.querySelector('.hcount');
    let id=null,n=0;
    if(i<2){ const w=G.weapons[i]; if(w){ id=w.type; n=0; } }   // gun slots mirror G.weapons
    else { const s=INV.hot[i]; if(s){ id=s.id; n=s.n; } }
    ic.innerHTML = id?mcBlkHTML(id):''; cn.textContent = n>1?n:'';
    cell.classList.toggle('sel', i===INV.sel); }
}
let _heldEl=null;
function updateHeldCursor(x,y){ if(!_heldEl) _heldEl=$('mcHeld'); if(!_heldEl) return;
  if(INV.held){ _heldEl.classList.remove('hidden'); _heldEl.innerHTML=slotInner(INV.held);
    if(x!=null){ _heldEl.style.left=x+'px'; _heldEl.style.top=y+'px'; } }
  else _heldEl.classList.add('hidden'); }

// ── drag / click logic (left = whole stack, right = one) ──
function slotGet(zone,i){ const arr=slotsForZone(zone); return arr?arr[i]:null; }
function slotSet(zone,i,v){ const arr=slotsForZone(zone); if(arr) arr[i]=v; }
function slotClick(zone,i,right){
  // hotbar gun slots (0,1) are not editable via drag — selecting them just equips the gun
  if(zone==='hot' && i<2){ hotSelect(i); return; }
  const cur=slotGet(zone,i), held=INV.held;
  if(right){
    if(held){ // drop ONE of held into this slot
      if(!cur){ slotSet(zone,i,{id:held.id,n:1}); held.n--; }
      else if(cur.id===held.id && cur.n<itemStack(cur.id)){ cur.n++; held.n--; }
      if(held.n<=0) INV.held=null;
    } else if(cur){ // pick up HALF
      const take=Math.ceil(cur.n/2); INV.held={id:cur.id,n:take}; cur.n-=take; if(cur.n<=0) slotSet(zone,i,null);
    }
  } else {
    if(held){
      if(!cur){ slotSet(zone,i,held); INV.held=null; }
      else if(cur.id===held.id){ const max=itemStack(cur.id), room=max-cur.n; const t=Math.min(room,held.n); cur.n+=t; held.n-=t; if(held.n<=0) INV.held=null; }
      else { slotSet(zone,i,held); INV.held=cur; }       // swap
    } else if(cur){ INV.held=cur; slotSet(zone,i,null); } // pick up whole stack
  }
  renderInv(); renderHotbar(); updateHeldCursor();
}
function mcReturnHeldAndCraft(){ // when closing: dump held + craft grid back into inventory
  for(let i=0;i<9;i++){ const s=INV.craft[i]; if(s){ const left=invAdd(s.id,s.n); INV.craft[i]=null; } }
  if(INV.held){ invAdd(INV.held.id,INV.held.n); INV.held=null; }
}

// ── open / close ──
function mcOpen(){ if(G.phase!=='play') return; G.phase='inv';
  document.exitPointerLock&&document.exitPointerLock(); const ov=$('mcInv'); if(ov) ov.classList.remove('hidden');
  const rb=$('mcRecipeBook'); if(rb && !rb.dataset.filled){ rb.innerHTML=mcRecipeBookHTML(); rb.dataset.filled='1'; }
  renderInv(); renderHotbar(); updateHeldCursor(); }
function mcClose(){ if(G.phase!=='inv') return; mcReturnHeldAndCraft(); const ov=$('mcInv'); if(ov) ov.classList.add('hidden');
  renderInv(); renderHotbar(); G.phase='play'; lockMouse(); }
function mcToggle(){ (G.phase==='inv')?mcClose():mcOpen(); }
function mcBindOverlay(){ if(G._mcBound) return; G._mcBound=true; const ov=$('mcInv'); if(!ov) return;
  const zoneOf=(el)=>{ const s=el.closest('.mcSlot'); if(!s) return null;
    if(s.dataset.main!=null) return ['main',+s.dataset.main]; if(s.dataset.hot!=null) return ['hot',+s.dataset.hot]; if(s.dataset.craft!=null) return ['craft',+s.dataset.craft]; return null; };
  ov.addEventListener('click', e=>{ if(e.target.closest('#mcCraftResult')){ mcCraft(); return; }
    const z=zoneOf(e.target); if(z) slotClick(z[0],z[1],false); });
  ov.addEventListener('contextmenu', e=>{ e.preventDefault(); const z=zoneOf(e.target); if(z) slotClick(z[0],z[1],true); });
  ov.addEventListener('mousemove', e=>{ updateHeldCursor(e.clientX+14,e.clientY+14); });
  const btn=$('mcCraftBtn'); if(btn) btn.addEventListener('click', mcCraft); }

// ── hotbar selection (scroll / number keys) ──
function hotSelect(i){ if(i<0||i>4) return; INV.sel=i; renderHotbar(); refreshHeldHand();
  if(i<2){ swapTo(i); } }   // selecting a gun slot equips that gun
function hotScroll(dir){ hotSelect((INV.sel+dir+5)%5); }
function hotActiveId(){ if(INV.sel<2){ const w=G.weapons[INV.sel]; return w?w.type:null; } const s=INV.hot[INV.sel]; return s?s.id:null; }
function holdingBlock(){ const id=hotActiveId(); return isPlaceable(id)?id:null; }
function holdingFood(){ const id=hotActiveId(); const d=itemDef(id); return (d&&d.kind==='food')?id:null; }
let heldHandMesh=null;
function refreshHeldHand(){ if(heldHandMesh){ camera.remove(heldHandMesh); heldHandMesh=null; }
  const id=hotActiveId(); const d=itemDef(id);
  if(d && d.kind!=='gun'){ if(arms) arms.visible=isPlaceable(id)||d.kind==='food'?false:true;
    const m=KIT.makeHeldItem(isPlaceable(id)?id:null); if(m){ heldHandMesh=m; camera.add(m); } if(arms) arms.visible = !m; }
  else { if(arms) arms.visible=true; }   // gun selected → show arms
  updateAmmoHUD();                         // refresh the bottom-right HUD (block name vs gun ammo)
}

// ── eat food ──
function eatHeld(){ const id=holdingFood(); if(!id) return false; if(invCount(id)<=0) return false;
  invRemove(id,1); const d=itemDef(id); if(d.heal>=9999){ G.health=G.maxHealth; } else G.health=Math.min(G.maxHealth,G.health+d.heal);
  updateHealthHUD(); AU&&AU.buy&&AU.buy(); toast('ATE '+itemName(id),'healed','#7be88a'); renderHotbar(); return true; }

/* ════════════════════ MINING NODES (trees · rocks · wheat) ════════════════════ */
const mineables = [];   // {grp,x,y,z,r,hp,maxhp,drops:[{id,p,min,max}],kind,alive,respawn}
function addMineNode(grp,x,z,kind,hp,drops,r){ grp.position.set(x,0,z); KIT.shadow(grp); buildRoot.add(grp);
  mineables.push({grp,x,y:0.7,z,r:r||0.9,hp,maxhp:hp,drops,kind,alive:true,respawn:0}); }
function spawnMineNodes(){
  if(mineables.length) return;                  // once
  // Place nodes ON THE WALKABLE RING ROAD around the camp (between the tower r=34 and the fence r=58.5),
  // in CAMP-world coords, so they're reachable from round 1 (the old code scattered them in the sealed
  // Minecraft zone at world-origin — unreachable). 16 nodes keeps draw calls down.
  const N=16;
  for(let i=0;i<N;i++){
    const a=(i/N)*Math.PI*2 + 0.39;                 // offset so nothing sits on the south spawn hub
    const rad=39 + (i%3)*4 + ((i*7)%5)*0.7;          // ~39..52, on the ring road
    const x=CAMP_X+Math.cos(a)*rad, z=CAMP_Z+Math.sin(a)*rad;
    if(i%2===0) addMineNode(KIT.makeRockNode(), x,z,'rock',45,[{id:'stone',p:1,min:1,max:3},{id:'coal',p:0.6,min:1,max:2},{id:'iron',p:0.32,min:1,max:1}],1.05);
    else        addMineNode(KIT.makeTreeNode(), x,z,'tree',30,[{id:'wood',p:1,min:2,max:4}],0.9);
  }
}
function damageMineable(o,dmg){ if(!o.alive) return; o.hp-=dmg;
  if(o.hp<=0){ o.alive=false; o.grp.visible=false; o.respawn=clock.elapsedTime+22;
    fxExplosion(o.x,o.y,o.z, o.kind==='tree'?0x4a8a2a:0x9a9aa2, 0.5);
    let any='';
    for(const d of o.drops){ if(Math.random()<=d.p){ const q=d.min+((Math.random()*(d.max-d.min+1))|0); if(q>0){ invAdd(d.id,q); any=d.id; } } }
    AU&&AU.buy&&AU.buy(); addPoints(5); if(any) toast('MINED '+itemName(any),'+inventory','#9fd0ff'); }
}
function updateMineables(dt){ const et=clock.elapsedTime;
  for(const o of mineables){ if(!o.alive && o.respawn && et>=o.respawn){ o.alive=true; o.hp=o.maxhp; o.respawn=0; o.grp.visible=true; } } }
function mcOnMined(kind){ // cave-ore drop table → items (kept for the existing ore cave)
  const map={ cobblestone:'stone', coal:'coal', steel:'iron', obsidian:'obsidian', pingasore:'pingasore', diamond:'diamond' };
  const id=map[kind]||'stone'; invAdd(id,1); }
// raycast the nearest minable thing (node / cave-ore / placed block) and damage it
function mineLook(dmg){ camera.getWorldDirection(_dir);
  const ox=camera.position.x, oy=camera.position.y, oz=camera.position.z, reach=4.6;
  let bestT=reach, hit=null;
  for(const o of mineables){ if(!o.alive) continue; const t=sphereT(ox,oy,oz,_dir.x,_dir.y,_dir.z,o.x,o.y,o.z,o.r,bestT); if(t>0&&t<bestT){ bestT=t; hit={mine:o}; } }
  for(let i=0;i<oreBlocks.length;i++){ const o=oreBlocks[i]; if(!o.alive) continue; const t=sphereT(ox,oy,oz,_dir.x,_dir.y,_dir.z,o.x,o.y,o.z,o.r,bestT); if(t>0&&t<bestT){ bestT=t; hit={ore:o}; } }
  for(let t=0.3;t<reach;t+=0.1){ const px=ox+_dir.x*t, py=oy+_dir.y*t, pz=oz+_dir.z*t; if(py<0) break;
    const b=blockAt(worldCellX(px),Math.floor(py/BS),worldCellX(pz)); if(b){ if(t<bestT){ hit={placed:b}; } break; } }
  if(!hit) return false;
  if(hit.mine) damageMineable(hit.mine,dmg); else if(hit.ore) damageOre(hit.ore,dmg); else if(hit.placed) damagePlacedBlock(hit.placed,dmg,true);
  return true; }
let _mineT=0;
function tryMine(dmg,rate){ const now=clock.elapsedTime; if(now-_mineT<1/(rate||3)) return; _mineT=now;
  recoil=Math.min(0.5, recoil+0.3); AU&&AU.shoot&&AU.shoot('pistol'); mineLook(dmg||25); }
// zombies chew through placed blocks that stand between them and the player
function enemyAttackBlocks(e,dt){ if(placedBlocks.size===0) return false;
  const px=e.grp.position.x, pz=e.grp.position.z;
  const tx=camera.position.x-px, tz=camera.position.z-pz; const tl=Math.hypot(tx,tz)||1;
  const fx=px+tx/tl*0.55, fz=pz+tz/tl*0.55;                 // a step ahead, toward the player
  for(let gy=0;gy<6;gy++){ const b=blockAt(worldCellX(fx),gy,worldCellX(fz)); if(b){
    b.hp-=18*dt*(e.dmgMul||1); if(b.hp<=0){ damagePlacedBlock(b,9999,false); } return true; } }
  return false; }

/* ════════════════════ VOXEL BUILDING (placement · support · block HP) ════════════════════ */
const placedBlocks = new Map();   // "gx,gy,gz" -> {id,mesh,hp,maxhp,gx,gy,gz}
function cellKey(gx,gy,gz){ return gx+','+gy+','+gz; }
function worldCellX(x){ return Math.floor(x/BS); }
function cellCenter(g){ return (g+0.5)*BS; }
function blockAt(gx,gy,gz){ return placedBlocks.get(cellKey(gx,gy,gz)); }
function makePlacedMesh(id){ let m; if(id==='door'){ m=KIT.makeMcDoor(); } else { m=KIT.makeMcBlock(id); } KIT.shadow(m); return m; }
function addPlacedBlock(gx,gy,gz,id){ if(blockAt(gx,gy,gz)) return false; if(gy<0) return false;
  const d=itemDef(id); const m=makePlacedMesh(id);
  m.position.set(cellCenter(gx), gy*BS+BS/2, cellCenter(gz)); buildRoot.add(m);
  const b={id,mesh:m,hp:(d&&d.hp)||40,maxhp:(d&&d.hp)||40,gx,gy,gz}; placedBlocks.set(cellKey(gx,gy,gz),b);
  if(m.userData.update) worldAnims.push(m.userData.update);
  return true; }
function removePlacedBlock(b,drop){ if(!b) return; placedBlocks.delete(cellKey(b.gx,b.gy,b.gz));
  if(b.mesh){ buildRoot.remove(b.mesh); if(b.mesh.userData.update){ const k=worldAnims.indexOf(b.mesh.userData.update); if(k>=0) worldAnims.splice(k,1); } }
  if(drop) invAdd(b.id,1); }
// place the currently-held hotbar block at the cell you're looking at
function placeHeldBlock(){ const id=holdingBlock(); if(!id) return false; if(invCount(id)<=0){ AU&&AU.dry&&AU.dry(); return false; }
  camera.getWorldDirection(_dir);
  const ox=camera.position.x, oy=camera.position.y, oz=camera.position.z;
  let lastEmpty=null;
  for(let t=0.4;t<=5.0;t+=0.12){ const px=ox+_dir.x*t, py=oy+_dir.y*t, pz=oz+_dir.z*t;
    if(py<0){ break; }                                   // hit ground → use last empty (or ground cell below)
    const gx=worldCellX(px), gy=Math.floor(py/BS), gz=worldCellX(pz);
    if(blockAt(gx,gy,gz)){ break; }                      // hit a block → place at lastEmpty against its face
    lastEmpty=[gx,gy,gz];
  }
  if(!lastEmpty){ // looking at open ground in front: place a ground block where the ray crosses y=0-ish
    for(let t=0.4;t<=5.0;t+=0.12){ const px=ox+_dir.x*t, py=oy+_dir.y*t, pz=oz+_dir.z*t; if(py<=BS){ lastEmpty=[worldCellX(px),0,worldCellX(pz)]; break; } } }
  if(!lastEmpty) return false;
  const [gx,gy,gz]=lastEmpty; if(blockAt(gx,gy,gz)) return false;
  // don't seal the block into the player's own body
  const cx=cellCenter(gx), cz=cellCenter(gz), cyl=gy*BS, cyh=gy*BS+BS;
  const pr=PLAYER_R+0.05; if(Math.abs(camera.position.x-cx)<BS/2+pr && Math.abs(camera.position.z-cz)<BS/2+pr
      && cyh>G.footY+0.1 && cyl<G.eyeY+0.2) return false;
  if(!addPlacedBlock(gx,gy,gz,id)) return false;
  invRemove(id,1); AU&&AU.shoot&&AU.shoot('pistol'); renderHotbar(); return true; }
// left-click while holding a block/tool: mine the placed block (or door toggle) you're looking at
function minePlacedLook(){ camera.getWorldDirection(_dir);
  const ox=camera.position.x, oy=camera.position.y, oz=camera.position.z;
  for(let t=0.3;t<=4.5;t+=0.1){ const gx=worldCellX(ox+_dir.x*t), gy=Math.floor((oy+_dir.y*t)/BS), gz=worldCellX(oz+_dir.z*t);
    const b=blockAt(gx,gy,gz); if(b){ damagePlacedBlock(b, 9999, true); return true; } if(oy+_dir.y*t<0) break; }
  return false; }
function damagePlacedBlock(b,dmg,mined){ if(!b) return; b.hp-=dmg;
  if(b.hp<=0){ fxExplosion(cellCenter(b.gx), b.gy*BS+BS/2, cellCenter(b.gz), 0x9a9aa2, 0.4);
    removePlacedBlock(b, mined); AU&&AU.buy&&AU.buy(); supportCheck(); }
}
// door open/close on right-click
function toggleDoorLook(){ camera.getWorldDirection(_dir);
  const ox=camera.position.x, oy=camera.position.y, oz=camera.position.z;
  for(let t=0.3;t<=4.0;t+=0.1){ const gx=worldCellX(ox+_dir.x*t), gy=Math.floor((oy+_dir.y*t)/BS), gz=worldCellX(oz+_dir.z*t);
    const b=blockAt(gx,gy,gz); if(b){ if(b.id==='door' && b.mesh.userData.toggle){ b.mesh.userData.toggle(); AU&&AU.reload&&AU.reload(); return true; } return false; } if(oy+_dir.y*t<0) break; }
  return false; }
// structural support: every block must connect (6-neighbour) to a block resting on the ground (gy===0)
function supportCheck(){ if(placedBlocks.size===0) return;
  const seen=new Set(), q=[];
  for(const b of placedBlocks.values()) if(b.gy===0){ seen.add(cellKey(b.gx,b.gy,b.gz)); q.push(b); }
  const N=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  while(q.length){ const b=q.pop(); for(const n of N){ const nb=blockAt(b.gx+n[0],b.gy+n[1],b.gz+n[2]); if(nb){ const k=cellKey(nb.gx,nb.gy,nb.gz); if(!seen.has(k)){ seen.add(k); q.push(nb); } } } }
  const doomed=[]; for(const b of placedBlocks.values()) if(!seen.has(cellKey(b.gx,b.gy,b.gz))) doomed.push(b);
  if(doomed.length){ for(const b of doomed){ fxExplosion(cellCenter(b.gx),b.gy*BS+BS/2,cellCenter(b.gz),0x9a7a4a,0.3); removePlacedBlock(b,true); }
    toast('STRUCTURE COLLAPSED','unsupported blocks fell','#d8a24a'); }
}
// physics queries used by groundHeightAt / clampArena
function blockTopColumn(x,z,cap){ // highest block top at (x,z) column that is <= cap (for standing/stepping up)
  const gx=worldCellX(x), gz=worldCellX(z); let best=-1;
  for(let gy=0;gy<40;gy++){ if(blockAt(gx,gy,gz)){ const top=(gy+1)*BS; if(top<=cap+0.001 && top>best) best=top; } }
  return best; }
function resolveBlockCollision(x,z,footY,eyeY,rad){ // push a circle out of any block whose vertical span overlaps [footY+step, eyeY]
  const minGx=worldCellX(x-rad-BS), maxGx=worldCellX(x+rad+BS), minGz=worldCellX(z-rad-BS), maxGz=worldCellX(z+rad+BS);
  const yLo=footY+STEP_UP+0.02, yHi=eyeY;
  for(let gx=minGx;gx<=maxGx;gx++) for(let gz=minGz;gz<=maxGz;gz++){
    // tallest relevant block in this column whose body is at the player's torso height
    for(let gy=0;gy<40;gy++){ const b=blockAt(gx,gy,gz); if(!b) continue; const bl=gy*BS, bh=gy*BS+BS;
      if(bh<=yLo || bl>=yHi) continue;                 // steppable or above head → ignore
      const cx=cellCenter(gx), cz=cellCenter(gz); const half=BS/2+rad;
      const dx=x-cx, dz=z-cz; if(Math.abs(dx)<half && Math.abs(dz)<half){
        const px=half-Math.abs(dx), pz=half-Math.abs(dz);
        if(px<pz) x=cx+(dx<0?-half:half); else z=cz+(dz<0?-half:half); }
    }
  }
  return [x,z]; }
function blockSolidForEnemy(x,z,y){ const b=blockAt(worldCellX(x),Math.floor(y/BS),worldCellX(z)); return !!b; }

// place a prefab house in front of the player (House Kit recipe)
function placeHousePrefabInFront(){ camera.getWorldDirection(_dir);
  const hx=camera.position.x+_dir.x*5, hz=camera.position.z+_dir.z*5;
  const h=KIT.makeHousePrefab(); h.position.set(hx,0,hz); h.rotation.y=Math.atan2(-_dir.x,-_dir.z); KIT.shadow(h); buildRoot.add(h);
  colliders.push({x:hx,z:hz,r:2.6}); toast('HOUSE BUILT','a fresh cabin appears','#9fd0ff'); }

/* ════════════════════ INIT / COMPAT ════════════════════ */
function mcInitInventory(){
  for(let i=0;i<20;i++) INV.main[i]=null; for(let i=0;i<5;i++) INV.hot[i]=null; for(let i=0;i<9;i++) INV.craft[i]=null;
  INV.held=null; INV.sel=0;
  // starter kit so building/crafting is usable from round 1
  const start={ stone:32, wood:16, plank:8, coal:8, dirt:16, wheat:6 };
  for(const id in start) invAdd(id, start[id]);
  spawnMineNodes();
}
function mcUnlock(){ /* build mode is available from round 1; kept for the giga-boss callsite */
  toast('MINECRAFT MODE','press E for inventory + crafting','#5a9e3a'); }


function bindInput(){
  document.addEventListener('keydown', e=>{ const k=e.key.toLowerCase(); G.keys[k]=true;
    if(k==='e' && G.minecraftMode && (G.phase==='play'||G.phase==='inv')){ mcToggle(); return; }
    if(G.phase!=='play') return;
    if(k==='r') startReload();
    if(k==='g') throwGrenade();
    if(k==='v') toggleMount();
    if(k==='b') toggleDrive();
    if(k==='f') doInteract();
    if(k==='1') hotSelect(0);
    if(k==='2') hotSelect(1);
    if(k==='3') hotSelect(2);
    if(k==='4') hotSelect(3);
    if(k==='5') hotSelect(4);
    if(k==='q') hotScroll(1);
    if(k==='escape') pauseGame();
    if(e.code==='Space'){ if(G.onGround){ G.vy=8.0; G.onGround=false; } }
  });
  document.addEventListener('keyup', e=>{ G.keys[e.key.toLowerCase()]=false; });
  document.addEventListener('mousedown', e=>{
    if(G.phase!=='play') return;
    if(e.button===0){ G.mouseDown=true;
      // ☠ ADMIN SECRET: triple-click while standing at the Mug Rootbeer Meth machine → +100,000
      if(nearInteract && nearInteract.perkId==='rootbeer'){ const now=clock.elapsedTime;
        if(now-(G._rbT||0)>1.2) G._rbN=0; G._rbT=now; G._rbN=(G._rbN||0)+1;
        if(G._rbN>=3){ G._rbN=0; addPoints(100000); AU.power(); toast('☠ ADMIN','+100,000 points','#ffd23a'); } }
    }
    else if(e.button===2){ G.rightMouseDown=true;
      // right-click with a build item: place block / eat food / toggle a door
      if(holdingBlock()){ if(!placeHeldBlock()) toggleDoorLook(); }
      else if(holdingFood()){ eatHeld(); }
      else toggleDoorLook();
    }
    e.preventDefault();
  });
  document.addEventListener('mouseup', e=>{
    if(e.button===0) G.mouseDown=false;
    else if(e.button===2) G.rightMouseDown=false;
  });
  document.addEventListener('contextmenu', e=>{ if(G.phase==='play') e.preventDefault(); });
  document.addEventListener('wheel', e=>{ if(G.phase!=='play') return; hotScroll(e.deltaY>0?1:-1); }, {passive:true});
  document.addEventListener('mousemove', e=>{ if(G.phase!=='play') return;
    // Skip the first event right after (re)acquiring pointer lock — browsers can report a
    // huge accumulated delta here, which used to snap the view ~90°.
    if(_justLocked){ _justLocked=false; return; }
    let mx=e.movementX||0, my=e.movementY||0;
    // Clamp implausibly large single-event deltas (pointer-lock spikes) so the view never jumps.
    const MAXD=180;
    if(mx> MAXD) mx= MAXD; else if(mx<-MAXD) mx=-MAXD;
    if(my> MAXD) my= MAXD; else if(my<-MAXD) my=-MAXD;
    // aiming down sights slows the turn rate for fine control
    const sens = G.sens * (G.rightMouseDown ? 0.5 : 1);
    G.yaw   -= mx*sens; G.pitch -= my*sens;
    G.pitch = Math.max(-1.4, Math.min(1.4, G.pitch));
    camera.rotation.order='YXZ'; camera.rotation.y=G.yaw; camera.rotation.x=G.pitch; });
  document.addEventListener('pointerlockchange', ()=>{
    if(document.pointerLockElement){ _justLocked=true; }      // just locked → ignore the first delta
    else if(G.phase==='play'){ pauseGame(); } });
}
function lockMouse(){ renderer.domElement.requestPointerLock&&renderer.domElement.requestPointerLock(); }

/* ════════════════════ GAME FLOW ════════════════════ */
function resetRun(){
  // clear enemies
  for(const e of zombies){ e.alive=false; e.grp.visible=false; }
  if(boss){ boss.userData.alive=false; boss.visible=false; }
  if(mega){ mega.userData.alive=false; mega.visible=false; }
  for(const d of drops){ scene.remove(d.grp); } drops.length=0;
  for(const n of nades){ scene.remove(n.grp); } nades.length=0;
  G.aliveCount=0; G.bossActive=false; G.megaActive=false; G.megaDefeated=false; G.roundActive=false; G.intermission=0;
  G.lvl12Done=false; G.lvl25Done=false; G.bunkerUnlocked=false; G.monkeyWave=0; G.monkeyTimer=0;
  G.minecraftMode=false; { const m=$('mcInv'); if(m) m.classList.add('hidden'); } if(G.phase==='inv') G.phase='play';
  G.ownsPig=false; G.mounted=false; if(pigFP && camera){ camera.remove(pigFP); }   // clear pig mount on reset
  G.ownsCar=false; G.driving=false; G.carVel=null; if(carPOV && camera){ camera.remove(carPOV); }   // clear car on reset
  G.inSkyRoom=false; G.portalDwell=0;   // clear sky-room state on reset
  // clear any placed build blocks from a previous run
  if(typeof placedBlocks!=='undefined'){ for(const b of Array.from(placedBlocks.values())) removePlacedBlock(b,false); }
  { const bb=$('bossbar'); if(bb) bb.classList.add('hidden'); }
  G.round=0; G.kills=0; G.points=500; G.powerOn=false; G.health=100; G.maxHealth=100;
  G.perks=new Set(); G.weapons=[newWeapon('pistol',false), newWeapon('pickaxe',false)]; G.cur=0; G.instaKill=0; G.doublePts=0; G.fireRateBuff=0;
  nadeCount=4; doorOpen=false; roofOpen=false; G.footY=0;
  if(roofBarrier){ roofBarrier.visible=true; roofBarrier.position.y=0; }
  for(const g of stairGates){ g.cleared=false; if(g.grp) g.grp.visible=true; }
  for(const dog of wallDogs){ dog.fed=0; dog.ud.full=false; dog.ud.used=false; dog.ud.upgraded=false; if(dog.ud.feed) dog.ud.feed(0); }
  // re-lock OUTSIDE spawn points except the starting hub arc; interior/roof stay open; re-close gates
  if(G.spawnPoints) for(const sp of G.spawnPoints){ sp.locked = (sp.zone==='outside') && angDist(sp.deg,90)>52; }
  for(const it of interactables){ if(it.type==='gate'){ it.open=false; it.anim=0;
    for(const pk of it.planks){ pk.mesh.visible=true; pk.mesh.position.y=pk.cy; pk.mesh.rotation.z=pk.cr; } } }
  camera.position.set(CAMP_X+pos(90)[0], EYE, CAMP_Z+pos(90)[1]-3); G.yaw=Math.PI; G.pitch=0; G.eyeY=EYE; G.vy=0;
  camera.rotation.order='YXZ'; camera.rotation.set(0,G.yaw,0);
  buildPlayerArms(); updateHealthHUD(); updatePointsHUD(); updateAmmoHUD(); updatePerksHUD(); updateZleftHUD();
}
function startGame(){
  resetRun(); G.phase='play'; $('hud').classList.add('on');
  hideAllScreens(); AU.resume(); lockMouse();
  G.minecraftMode=true; mcInitInventory(); mcBindOverlay();   // inventory + crafting available from round 1 (press E)
  INV.sel=0; renderHotbar(); refreshHeldHand();
  G.intermission=clock.elapsedTime+2.0; updateRoundHUD();
  toast('UNDEAD SIEGE','prepare yourself · press E for crafting');
}
function pauseGame(){ if(G.phase!=='play') return; G.phase='pause'; showScreen('pause'); document.exitPointerLock&&document.exitPointerLock(); }
function resumeGame(){ if(G.phase!=='pause') return; G.phase='play'; hideAllScreens(); lockMouse(); }
function gameOver(){ G.phase='over'; document.exitPointerLock&&document.exitPointerLock();
  $('gostats').innerHTML='Reached round <b>'+G.round+'</b> · <b>'+G.kills+'</b> kills · <b>'+G.points+'</b> points';
  $('hud').classList.remove('on'); showScreen('over'); }
function winGame(){ G.phase='win'; document.exitPointerLock&&document.exitPointerLock();
  $('hud').classList.remove('on'); showScreen('win'); }
function showScreen(id){ hideAllScreens(); $(id).classList.remove('hidden'); }
function hideAllScreens(){ ['loading','menu','pause','over','win'].forEach(s=>$(s).classList.add('hidden')); }

/* ════════════════════ CAMERA ZOOM ════════════════════ */
function updateCameraZoom(){
  const w=curW();
  let targetFov=74;
  if(G.rightMouseDown && w){
    if(w.type==='sniper') targetFov=30;       // scoped
    else if(w.type==='rifle') targetFov=45;   // marksman zoom
    else if(w.type==='pistol') targetFov=55;  // iron-sight zoom
    else targetFov=60;                        // light ADS on everything else
  }
  camera.fov+=(targetFov-camera.fov)*0.15;
  camera.updateProjectionMatrix();
  // sniper scope: at near-full zoom, show the circular scope overlay + hide the viewmodel
  const scoped = w && w.type==='sniper' && G.rightMouseDown && camera.fov < 34;
  const sc=$('scope'); if(sc) sc.classList.toggle('hidden', !scoped);
  if(scoped){ if(arms) arms.visible=false; if(heldHandMesh) heldHandMesh.visible=false; }
  else if(G._wasScoped){ if(arms) arms.visible=true; if(heldHandMesh) heldHandMesh.visible=true; }
  G._wasScoped=scoped;
}

/* ════════════════════ MAIN LOOP (one rAF, fixed timestep) ════════════════════ */
let acc=0;
function loop(){
  requestAnimationFrame(loop);
  const dt=Math.min(0.1, clock.getDelta());

  if(G.phase==='play'){
    acc+=dt;
    while(acc>=STEP){ simStep(STEP); acc-=STEP; }
  }
  // visual-only updates (lights flicker, fx) can run per-frame
  if(SCENE_READY){
    const et=clock.elapsedTime;
    for(const pl of pointLights){ pl.light.intensity=pl.base+Math.sin(et*11+pl.ph)*0.35+Math.random()*0.12;
      if(pl.flame) pl.flame.scale.y=1+Math.sin(et*10+pl.ph)*0.2; }
    for(const dog of wallDogs){ if(dog.ud.update) dog.ud.update(et); }
    updateFx();
    updateBossBar();
    updateCameraZoom();
    if(fpsCounter) fpsTick();
  }
  if(renderer && scene && camera){
    camera.updateMatrixWorld();  // ensure camera's local space (for arms/weapons) is up to date
    renderer.render(scene,camera);
    if(needShadowBake){ // bake static shadows ONCE, then freeze the shadow map
      shadowLight.shadow.needsUpdate=true; needShadowBake=false;
      shadowLight.shadow.autoUpdate=false;
    }
  }
}
function simStep(dt){
  // input → fire / mine
  const w=curW();
  const _aid=hotActiveId(), _ad=itemDef(_aid), _holdGun=!(_ad)|| _ad.kind==='gun';
  if(w && w.type==='axe'){ updateAxe(dt, G.mouseDown); }
  else if(G.mouseDown){
    if(_holdGun){ if(w && (WDEF[w.type].auto || canSemi())) fire(); }   // gun / pickaxe in hand
    else { tryMine(28, 3.2); }                                          // block/food in hand → left-click mines by hand
  }
  updatePlayer(dt);
  updateReload();
  updateEnemies(dt);
  updateBolts(dt);
  updateNades(dt);
  updateDrops(dt);
  updateOre(dt);
  updateMineables(dt);
  { const et=clock.elapsedTime; for(let i=0;i<worldAnims.length;i++) worldAnims[i](et); }  // compound props
  directorTick(dt);
  updateInteraction();
  // nether-portal dwell → Sky Room (stand in the round-25 portal ~12s)
  if(round25Gate && !G.inSkyRoom){
    const pd=Math.hypot(camera.position.x-round25Gate.x, camera.position.z-round25Gate.z);
    if(pd<8){ const was=G.portalDwell||0; G.portalDwell=was+dt;
      if(was<12 && G.portalDwell>=12){ enterSkyRoom(); }
      else { const sec=Math.ceil(12-G.portalDwell); const ws=Math.ceil(12-was); if(sec!==ws && sec>0 && sec<=12) toast('THE PORTAL HUMS…', sec+'s', '#b24bff'); }
    } else G.portalDwell=0;
  }
  // expire powerup timers
  if(G.instaKill>0 && clock.elapsedTime>G.instaKill) G.instaKill=0;
  if(G.fireRateBuff>0 && clock.elapsedTime>G.fireRateBuff) G.fireRateBuff=0;
  // HUD light updates
  updateToasts(); updateHitmark();
}
let _semiLatch=false;
function canSemi(){ // for non-auto weapons, one shot per click
  if(_semiLatch) return false; _semiLatch=true; return true;
}
// reset semi latch on mouseup
document.addEventListener('mouseup', e=>{ if(e.button===0) _semiLatch=false; });

/* fps counter */
let fpsCounter=false, fpsAcc=0, fpsFrames=0, fpsLast=0;
function fpsTick(){ fpsFrames++; const now=performance.now(); if(now-fpsLast>500){ const f=Math.round(fpsFrames*1000/(now-fpsLast)); $('fps').textContent=f+' FPS'; fpsFrames=0; fpsLast=now; } }

/* ════════════════════ SETTINGS TOGGLES ════════════════════ */
function applyShadows(on){ settings.shadows=on; renderer.shadowMap.enabled=on; if(on){ needShadowBake=true; shadowLight.shadow.autoUpdate=true; }
  scene.traverse(o=>{ if(o.isMesh && o.material){ /* keep */ } }); }
function applyQuality(high){ settings.quality=high; renderer.setPixelRatio(high?Math.min(devicePixelRatio,2):1); }
function bindMenus(){
  $('playBtn').onclick=()=>{ AU.resume(); startGame(); };
  $('resumeBtn').onclick=resumeGame;
  $('quitBtn').onclick=()=>{ G.phase='menu'; $('hud').classList.remove('on'); showScreen('menu'); };
  $('againBtn').onclick=()=>{ startGame(); };
  $('winAgainBtn').onclick=()=>{ startGame(); };
  const tog=(el,fn)=>{ el.onclick=()=>{ const on=el.dataset.on==='1'; el.dataset.on=on?'0':'1';
    el.classList.toggle('off',on); el.textContent = el.id.includes('Qual')?(on?'LOW':'HIGH'):(on?'OFF':'ON'); fn(!on); }; };
  tog($('tgShadow'), applyShadows); tog($('tgQual'), applyQuality);
  tog($('tgFps'), v=>{ fpsCounter=v; $('fps').classList.toggle('on',v); });
  $('tgShadow2')&&tog($('tgShadow2'), applyShadows);
  $('tgFps2')&&tog($('tgFps2'), v=>{ fpsCounter=v; $('fps').classList.toggle('on',v); });
}

/* ════════════════════ BOOT ════════════════════ */
function boot(){
  clock=new T.Clock();
  renderer=new T.WebGLRenderer({antialias:true, powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputEncoding=T.sRGBEncoding;
  renderer.toneMapping=T.ACESFilmicToneMapping; renderer.toneMappingExposure=1.05;
  renderer.shadowMap.enabled=true; renderer.shadowMap.type=T.PCFSoftShadowMap;
  document.getElementById('app').appendChild(renderer.domElement);
  window.__renderer=renderer; // test/debug hook
  camera=new T.PerspectiveCamera(74, innerWidth/innerHeight, 0.05, 400);
  camera.rotation.order='YXZ'; camera.position.set(0,EYE,40);

  addEventListener('resize', ()=>{ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight); });

  // build world on next frames so the loading screen can paint
  $('loadmsg').textContent='FORGING THE ARENA…';
  setTimeout(()=>{
    try{
      G.weapons=[newWeapon('pistol',false)];
      buildEverything();
      prewarmFX();           // pre-build bolt + explosion pools, compile shaders now
      bindInput(); bindMenus();
      loop();
      G.phase='menu'; showScreen('menu');
    }catch(err){ console.error('BUILD ERROR', err); $('loadmsg').textContent='ERROR: '+err.message; }
  }, 60);
}

// test/debug hooks
window.__startRoundForTest=(n)=>{ G.round=n-1; G.intermission=clock.elapsedTime; startRound(n); };
window.__camera=()=>camera;
window.__giveWeapon=(t,pap)=>{ giveWeapon(t,!!pap); return curW().type; };
window.__fireN=(n)=>{ const w=curW(); w.ammo=99999; for(let i=0;i<(n||1);i++){ w.lastShot=-999; fire(); } return curW().type; };
window.__spawnKind=(k)=>spawnZombie(k);
window.__megaInfo=()=> mega&&mega.userData?{alive:!!mega.userData.alive,giga:!!mega.userData.giga,hp:mega.userData.hp,source:mega.userData.source}:null;
window.__ore=()=>oreBlocks;
window.__pap=()=>packAPunch();
window.__groundHeightAt=(x,z,refY)=>groundHeightAt(x,z,refY);
window.__zombies=()=>zombies;
window.__clampArena=(x,z,rad,isP,py)=>clampArena(x,z,rad,isP,py);
window.__step=(dt)=>simStep(dt||1/60);
window.__interactables=()=>interactables;
window.__doorOpen=()=>doorOpen;
window.__roofOpen=()=>roofOpen;
window.__stairGates=()=>stairGates;
window.__wallDogs=()=>wallDogs;
window.__feedDogs=(x,z,zone)=>feedDogs(x,z,zone);
window.__updateBossBar=()=>updateBossBar();
window.__damageMega=(d)=>damageMega(d);
window.__megaSource=()=> mega&&mega.userData?mega.userData.source:null;
window.__fillHorde=()=>{ // spawn straight to the cap for stress measurement
  let n=0; while(G.aliveCount<MAX_Z && n<MAX_Z){ if(!spawnZombie(n%4===0)) break; G.toSpawn=Math.max(0,G.toSpawn-1); n++; } return G.aliveCount; };
window.__fireTest=()=>{ // aim at an alive enemy and confirm hitscan kills + awards points
  const e=zombies.find(z=>z.alive); if(!e) return {err:'no enemy'};
  const before=G.kills, pBefore=G.points;
  camera.lookAt(e.grp.position.x, e.grp.position.y+e.bodyY, e.grp.position.z);
  camera.updateMatrixWorld(true);
  const w=curW(); w.ammo=999;
  for(let i=0;i<40;i++){ w.lastShot=-99; fire(); }
  return {killsBefore:before, killsAfter:G.kills, pointsBefore:pBefore, pointsAfter:G.points}; };
window.__buyTest=(wtype)=>{ // teleport to a matching wall-buy and purchase
  const it=interactables.find(i=>i.type==='wallbuy'&&i.wtype===wtype); if(!it) return {err:'no wall '+wtype};
  G.points=99999; const had=G.weapons.length; const ok=it.run();
  return {ok, hadWeapons:had, nowWeapons:G.weapons.length, cur:curW().type, names:G.weapons.map(w=>w.type)}; };
window.__perf=(n)=>{ // isolate JS sim cost (the only thing MY code controls) from GPU raster
  let s=performance.now(); for(let i=0;i<n;i++) simStep(STEP); const simMs=(performance.now()-s)/n;
  s=performance.now(); for(let i=0;i<n;i++) renderer.render(scene,camera); const renderMs=(performance.now()-s)/n;
  return { simMs:+simMs.toFixed(4), renderMs:+renderMs.toFixed(3), alive:G.aliveCount, drawCalls:renderer.info.render.calls, triangles:renderer.info.render.triangles }; };
// build-mode test hook
window.__mc={ INV, invCount, invAdd, invRemove, mcOpen, mcClose, mcEvalRecipe, mcCraft, slotClick, hotSelect,
  holdingBlock, holdingFood, placeHeldBlock, damagePlacedBlock, addPlacedBlock, blockAt, placedBlocks,
  mineables, damageMineable, eatHeld, supportCheck, get match(){ return mcMatch; } };
// world-diagnostic hook (for debugging layout / spawn / perf)
window.__diag=()=>{ const fwd=new THREE.Vector3(); camera.getWorldDirection(fwd);
  const rc=new THREE.Raycaster(camera.position.clone(), fwd.clone(), 0.1, 8);
  const hits=rc.intersectObjects(scene.children,true).filter(h=>h.object.visible);
  const firstHit=hits[0]?{dist:+hits[0].distance.toFixed(2), name:hits[0].object.name||'(unnamed)', type:hits[0].object.type}:null;
  return {
    camp:[+CAMP_X.toFixed(1),+CAMP_Z.toFixed(1)], R_OUT, towerH:(typeof TOWER_H!=='undefined'?TOWER_H:null),
    camPos:[+camera.position.x.toFixed(1),+camera.position.y.toFixed(1),+camera.position.z.toFixed(1)],
    colliders: colliders.length,
    colliderSample: colliders.slice(0,10).map(c=>({x:+c.x.toFixed(1),z:+c.z.toFixed(1),r:+(c.r||0).toFixed(1),gate:c.gate?(c.gate.open?'open':'closed'):false})),
    mineables: (typeof mineables!=='undefined')? mineables.map(m=>({x:+m.x.toFixed(1),z:+m.z.toFixed(1),kind:m.kind})) : 'n/a',
    drawCalls: renderer.info.render.calls, programs: renderer.info.programs?renderer.info.programs.length:null,
    worldAnims: (typeof worldAnims!=='undefined')?worldAnims.length:null,
    lookingAt: firstHit
  }; };
window.__spawnSample=()=>{ if(typeof pickSpawn!=='function') return 'n/a'; const s=[];
  for(let i=0;i<16;i++){ const p=pickSpawn(); s.push({x:+p[0].toFixed(1),z:+p[1].toFixed(1),zone:p[3]||'?',
    inWalkable: Math.hypot(p[0]-CAMP_X,p[1]-CAMP_Z) < R_OUT+2 }); } return s; };
window.__teleport=(x,z)=>{ camera.position.x=CAMP_X+(x||0); camera.position.z=CAMP_Z+(z||0); };

if(document.readyState==='complete'||document.readyState==='interactive') boot();
else addEventListener('DOMContentLoaded', boot);

})();
