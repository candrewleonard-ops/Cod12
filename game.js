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
const TOWER_H   = 34;          // tower wall half-extent (footprint ±34)
const TOWER_TALL= 34;
const R_OUT     = 58.5;        // outer walkable radius (fence at 60.5)
const PLAYER_R  = 0.6;
const EYE       = 1.7;
const STEP      = 1/60;        // fixed sim timestep
const GRAV      = 22;
const MAX_Z     = 25;          // hard cap: live zombies
const MAX_C     = 8;           // crawler pool

/* ════════════════════ engine singletons ════════════════════ */
let renderer, scene, camera, clock;
let shadowLight, needShadowBake = true;
const settings = { shadows:true, quality:true, fps:false };

/* ════════════════════ game state ════════════════════ */
const G = {
  phase:'load',            // load | menu | play | pause | over | win
  round:0, kills:0,
  points:500,
  powerOn:false,
  // player
  health:100, maxHealth:100, vy:0, onGround:true,
  hurtT:-9, regenT:0, lastDmg:-9,
  yaw:0, pitch:0,
  // weapons
  weapons:[], cur:0,
  // perks
  perks:new Set(),
  // wave director
  budget:0, spawnedThisRound:0, toSpawn:0, aliveCount:0,
  spawnTimer:0, roundActive:false, intermission:0,
  bossActive:false, megaActive:false,
  // powerups (timed)
  instaKill:0, doublePts:0, fireRateBuff:0,
  // input
  keys:{}, mouseDown:false, wantReload:false,
};
window.__G = G;

/* ════════════════════ weapon definitions ════════════════════ */
// dmg is per-hit; fireRate in shots/sec; auto = hold to fire; pellets/spread for shotgun.
const WDEF = {
  pistol:  { name:'M1911',        mag:8,  reserve:64,  rate:6,  dmg:42,  auto:false, reload:1.3, range:90, kind:'ballistic' },
  smg:     { name:'MP-40',        mag:32, reserve:240, rate:13, dmg:26,  auto:true,  reload:1.7, range:80, kind:'ballistic' },
  shotgun: { name:'TRENCH GUN',   mag:6,  reserve:48,  rate:2.2,dmg:30,  auto:false, reload:2.3, range:34, kind:'ballistic', pellets:8, spread:0.13 },
  rifle:   { name:'KAR-98',       mag:5,  reserve:50,  rate:1.6,dmg:160, auto:false, reload:2.0, range:140,kind:'ballistic' },
  ak:      { name:'AK-47',        mag:30, reserve:270, rate:10, dmg:48,  auto:true,  reload:2.0, range:110,kind:'ballistic' },
  lmg:     { name:'SLEDGEHAMMER', mag:75, reserve:300, rate:11, dmg:55,  auto:true,  reload:3.4, range:120,kind:'ballistic' },
  wonder:  { name:'WUNDER-DG2',   mag:20, reserve:120, rate:4,  dmg:240, auto:true,  reload:2.6, range:120,kind:'wonder', aoe:3.0 },
  hells:   { name:"HELL'S REVOLVER",mag:1,reserve:30,  rate:1,  dmg:900, auto:false, reload:2.2, range:60, kind:'hells', aoe:5.5 },
};
const WALL_WEAPONS = ['smg','shotgun','rifle','ak','lmg']; // assignable on walls

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
  return {
    resume(){ ensure(); if(ac.state==='suspended') ac.resume(); },
    shoot(kind){ ensure(); const t=now();
      if(kind==='shotgun'){ noise(t,0.18,0.5,2600); tone(120,t,0.12,'square',0.25,40); }
      else if(kind==='wonder'){ tone(880,t,0.14,'sawtooth',0.2,220); tone(440,t,0.18,'triangle',0.18,110); }
      else if(kind==='hells'){ noise(t,0.4,0.5,900); tone(70,t,0.5,'sawtooth',0.4,30); }
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
  };
})();

/* ════════════════════ WORLD ════════════════════ */
let towerDoorPivot=null, doorOpen=false;
const colliders = [];      // {x,z,r} cylinder colliders for props (cheap)
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
  scene.background = new T.Color(0x070c14);
  scene.fog = new T.FogExp2(0x0b1622, 0.018);

  // sky + angry moon (kit)
  scene.add(KIT.makeSky());
  const am = KIT.makeAngryMoon(); am.scale.setScalar(10); am.position.set(-18,46,-86); scene.add(am);

  // lights — ONE shadow-casting directional light (baked once), + ambient.
  scene.add(new T.AmbientLight(0x223247, 0.85));
  shadowLight = new T.DirectionalLight(0x9fc2ff, 0.95);
  shadowLight.position.set(-40,60,-26);
  shadowLight.castShadow = true;
  shadowLight.shadow.mapSize.set(2048,2048);
  Object.assign(shadowLight.shadow.camera,{left:-70,right:70,top:70,bottom:-70,far:200,near:1});
  scene.add(shadowLight);
  // soft cool fill from the moon side (no shadow)
  const fill=new T.DirectionalLight(0x4a6a9c,0.25); fill.position.set(30,20,40); scene.add(fill);

  // ground
  const ground = new T.Mesh(new T.PlaneGeometry(320,320),
                            new T.MeshStandardMaterial({color:0x16210f, roughness:0.99}));
  ground.rotation.x=-Math.PI/2; ground.receiveShadow=true; scene.add(ground);

  // ring road
  const road = new T.Mesh(new T.RingGeometry(34,59,80,1),
                          new T.MeshStandardMaterial({color:0x2a2418, roughness:0.98}));
  road.rotation.x=-Math.PI/2; road.position.y=0.02; road.receiveShadow=true; scene.add(road);

  buildTower();
  buildBoundaryAndForest();
  buildStations();
}

function buildTower(){
  const wallMat=new T.MeshStandardMaterial({color:0x22262b,roughness:0.96,metalness:0.05});
  const bandMat=new T.MeshStandardMaterial({color:0x171b1f,roughness:0.9,metalness:0.1});
  const trimMat=new T.MeshStandardMaterial({color:0x2c3138,roughness:0.8,metalness:0.2});
  const BH=TOWER_H, H=TOWER_TALL, FLOORS=10, FH=H/FLOORS, DOORW=8;
  const wallSeg=(w,x,z,ry)=>{ const m=new T.Mesh(new T.BoxGeometry(w,H,1.4),wallMat);
    m.position.set(x,H/2,z); m.rotation.y=ry; m.castShadow=true; m.receiveShadow=true; scene.add(m); };
  const sideW=(BH*2-DOORW)/2;
  wallSeg(sideW, -(DOORW/2+sideW/2), BH, 0);
  wallSeg(sideW,  (DOORW/2+sideW/2), BH, 0);
  { const lin=new T.Mesh(new T.BoxGeometry(DOORW+1.2,5,1.5),wallMat); lin.position.set(0,H-2.5,BH); lin.castShadow=true; scene.add(lin); }
  wallSeg(BH*2,0,-BH,0); wallSeg(BH*2,-BH,0,Math.PI/2); wallSeg(BH*2,BH,0,Math.PI/2);
  for(let f=1;f<FLOORS;f++){ const y=f*FH;
    [[0,BH],[0,-BH]].forEach(p=>{ const bd=new T.Mesh(new T.BoxGeometry(BH*2+0.6,0.5,1.7),bandMat); bd.position.set(p[0],y,p[1]); scene.add(bd); });
    [[BH,0],[-BH,0]].forEach(p=>{ const bd=new T.Mesh(new T.BoxGeometry(1.7,0.5,BH*2+0.6),bandMat); bd.position.set(p[0],y,p[1]); scene.add(bd); }); }
  [[BH,BH],[-BH,BH],[BH,-BH],[-BH,-BH]].forEach(p=>{ const pil=new T.Mesh(new T.BoxGeometry(2.4,H,2.4),trimMat); pil.position.set(p[0],H/2,p[1]); pil.castShadow=true; scene.add(pil); });
  [[0,BH],[0,-BH]].forEach(p=>{ const pr=new T.Mesh(new T.BoxGeometry(BH*2+2,1.6,2.2),trimMat); pr.position.set(p[0],H+0.6,p[1]); scene.add(pr); });
  [[BH,0],[-BH,0]].forEach(p=>{ const pr=new T.Mesh(new T.BoxGeometry(2.2,1.6,BH*2+2),trimMat); pr.position.set(p[0],H+0.6,p[1]); scene.add(pr); });
  const roofCap=new T.Mesh(new T.BoxGeometry(BH*2+1,0.6,BH*2+1), new T.MeshStandardMaterial({color:0x191d22,roughness:0.95}));
  roofCap.position.set(0,H+0.1,0); roofCap.receiveShadow=true; scene.add(roofCap);
  // glowing doorway frame + steps
  scene.add(KIT.at(KIT.box(DOORW+0.6,0.4,3,KIT.glow(KIT.accentHex,0.5)),0,0.2,BH+1.6));
  [0,1,2].forEach(i=> scene.add(KIT.at(KIT.box(DOORW+2-i*0.6,0.4,1.0,KIT.mat(0x20242a,0.9,0)),0,0.2,BH+2.4+i*1.0)));
  const enter=new T.Mesh(new T.PlaneGeometry(7,1.2), new T.MeshBasicMaterial({map:KIT.label('TOWER','#cdbfff'),transparent:true}));
  enter.position.set(0,7,BH+0.86); scene.add(enter);
  // swinging door
  const doorPivot=new T.Group(); doorPivot.position.set(-DOORW/2,0,BH);
  const door=KIT.box(DOORW,7.5,0.3, KIT.mat(0x3a2a1b,0.85,0)); door.position.set(DOORW/2,3.75,0); doorPivot.add(door);
  for(let i=0;i<4;i++) doorPivot.add(KIT.at(KIT.box(DOORW+0.2,0.26,0.34,KIT.mat(0x2c2014,0.85,0)),DOORW/2,1.0+i*1.9,0));
  KIT.shadow(doorPivot); scene.add(doorPivot); towerDoorPivot=doorPivot;
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
  posts.castShadow=rails.castShadow=true; scene.add(posts); scene.add(rails);

  // BOULDERS — instanced
  const bGeo=new T.DodecahedronGeometry(1,0); const bMat=new T.MeshStandardMaterial({color:0x2a2e30,roughness:0.97,metalness:0.1});
  const bN=40, boulders=new T.InstancedMesh(bGeo,bMat,bN);
  for(let i=0;i<bN;i++){ const a=(i/bN)*Math.PI*2+0.1, r=57+Math.random()*1.5, sc=0.8+Math.random()*0.8;
    s.set(sc,sc*0.8,sc); e.set(0,Math.random()*Math.PI,0); q.setFromEuler(e); _v1.set(Math.cos(a)*r,sc*0.4,Math.sin(a)*r);
    m.compose(_v1,q,s); boulders.setMatrixAt(i,m); } q.identity(); s.set(1,1,1);
  boulders.castShadow=boulders.receiveShadow=true; scene.add(boulders);

  // FOREST — instanced merged trees beyond the fence
  const treeGeo=mergedTreeGeometry();
  const treeMat=new T.MeshStandardMaterial({vertexColors:true, roughness:0.95});
  const tN=320, trees=new T.InstancedMesh(treeGeo,treeMat,tN);
  for(let i=0;i<tN;i++){ const a=Math.random()*Math.PI*2, r=64+Math.random()*70, sc=0.9+Math.random()*1.8;
    s.set(sc,sc,sc); e.set(0,Math.random()*Math.PI,0); q.setFromEuler(e); _v1.set(Math.cos(a)*r,0,Math.sin(a)*r);
    m.compose(_v1,q,s); trees.setMatrixAt(i,m); } q.identity(); s.set(1,1,1);
  trees.castShadow=true; scene.add(trees);
}

// add a capped flickering point light (campfire/lantern)
function addFireLight(x,z){
  if(pointLights.length>=7) return;
  const g=new T.Group();
  const flame=new T.Mesh(new T.ConeGeometry(0.5,1.4,8), KIT.glow(0xff8a1e,2.1)); flame.position.y=0.85; g.add(flame);
  for(let i=0;i<6;i++){ const a=i/6*Math.PI*2; g.add(KIT.at(KIT.box(0.4,0.28,0.4,KIT.mat(0x3a3a3a,0.95,0)),Math.cos(a)*1.0,0.14,Math.sin(a)*1.0)); }
  g.position.set(x,0,z); scene.add(g);
  const lp=new T.PointLight(0xff7a2a,2.2,20,2); lp.position.set(x,1.4,z); scene.add(lp);
  pointLights.push({light:lp, flame, base:2.2, ph:x});
  colliders.push({x,z,r:1.4});
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

function addInteractable(o){ interactables.push(o); if(o.group){ KIT.shadow(o.group); scene.add(o.group);}
  if(o.collide) colliders.push({x:o.x,z:o.z,r:o.collide}); return o; }

function buildStations(){
  // SOUTH spawn hub (deg 90 → +z): power, crate, PaP by the door, campfire, pickups
  const [sx,sz]=pos(90);
  addFireLight(sx-7,sz+3); addFireLight(sx+8,sz-3);

  // POWER
  { const g=KIT.makePowerMachine(); g.position.set(sx-9,0,sz-2); g.rotation.y=-2.4;
    addInteractable({group:g, x:sx-9, z:sz-2, radius:3.2, collide:1.2, type:'power',
      label:()=> G.powerOn?null:{key:'F', txt:'Restore POWER', cost:0},
      run:()=>{ if(G.powerOn) return false; G.powerOn=true; AU.power(); toast('POWER ONLINE','perks & Pack-a-Pingas active'); return true; },
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
  // TOWER DOOR
  addInteractable({ x:0, z:TOWER_H, radius:5, type:'door', cost:2000,
    label:()=> doorOpen?null:{key:'F', txt:'Open Tower Door', cost:2000},
    run:()=>{ if(doorOpen) return false; if(!spend(2000)) return false; doorOpen=true; AU.power();
      toast('TOWER OPEN','the ascent awaits…'); return true; } });

  // Wall-buys around the hub + ring
  const wallSpec=[ [sx+11,sz-4,'smg',1000], [sx-12,sz+6,'shotgun',1500] ];
  wallSpec.forEach(([x,z,wt,cost])=> addWallBuy(x,z,wt,cost));

  // GATES (5 rising-price paywalls) gating outward stations
  const gateDefs=[ [126,750],[186,1500],[246,2000],[306,2500],[6,3000] ];
  const gates=gateDefs.map(([deg,price])=> addGate(deg,price));

  // PERK STATIONS (each behind progression, needs power)
  station(150,['DOUBLE','SHOT'],   0x9c2b2b,0x35d6ff,'doubleshot', gates[0]);
  station(210,['MUG ROOTBEER','METH'],0x6a3b1a,0xffa23a,'rootbeer',  gates[1]);
  station(330,['PINGAS','LIQUID'], 0x4a2a66,0xff48c0,'pingasliquid',gates[3]);

  // BOSS YARD (north, deg 270): wall-buys + mini-boss spawns here
  { const [x,z]=pos(270); addFireLight(x,z+8);
    addWallBuy(x+9,z,'ak',2500); addWallBuy(x-9,z,'rifle',2000);
    G.bossYard={x,z}; }
  // East deep-woods (deg 30): lmg wall + wonder via crate only
  { const [x,z]=pos(30); addWallBuy(x,z+7,'lmg',6000); addFireLight(x+6,z); }
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
  const gate=addInteractable({group:g, x, z, radius:3.4, type:'gate', cost:price, open:false, planks, anim:0,
    label:()=> gate.open?null:{key:'F', txt:'Clear Barricade', cost:price},
    run:()=>{ if(gate.open) return false; if(!spend(price)) return false; gate.open=true; gate.anim=0.0001; AU.buy(); toast('PATH CLEARED',''); return true; } });
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

function poolEntry(isCrawler){
  const grp = isCrawler ? KIT.makeCrawler() : KIT.makeZombie();
  // enemies don't cast dynamic shadows (perf) → cheap blob instead
  grp.add(makeBlob());
  grp.visible=false; scene.add(grp);
  return { grp, anim:grp.userData.update, isCrawler, alive:false,
           hp:0, speed:0, atkCd:0, dieT:0, riseT:0,
           bodyY:isCrawler?0.34:1.2, bodyR:isCrawler?0.5:0.6, headY:isCrawler?0.4:1.74, headR:0.3 };
}
function initEnemyPools(){
  for(let i=0;i<MAX_Z;i++) zombies.push(poolEntry(false));
  for(let i=0;i<MAX_C;i++) zombies.push(poolEntry(true));
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

function spawnZombie(crawler){
  const e = zombies.find(z=>!z.alive && z.isCrawler===crawler) || zombies.find(z=>!z.alive);
  if(!e) return false;
  const [x,z]=spawnPositionNearPlayer();
  e.grp.position.set(x,0,z); e.grp.scale.setScalar(0.01); e.grp.visible=true;
  e.alive=true; e.dieT=0; e.riseT=0; e.atkCd=0;
  const r=G.round;
  e.hp = Math.round((e.isCrawler?70:100) * (1 + r*0.18)) + (e.isCrawler?0:r*4);
  e.speed = (e.isCrawler?3.4:2.0) + Math.min(2.4, r*0.12) + Math.random()*0.4;
  G.aliveCount++;
  if(Math.random()<0.3) AU.groan();
  return true;
}

function spawnMiniBoss(){
  if(!boss){ boss=KIT.makeBoss(); boss.add(makeBlob()); scene.add(boss); }
  const yd=G.bossYard||{x:0,z:-52};
  boss.position.set(yd.x,0,yd.z); boss.scale.setScalar(0.01); boss.visible=true;
  boss.userData.hp = 900 + G.round*220; boss.userData.maxhp=boss.userData.hp;
  boss.userData.alive=true; boss.userData.speed=1.7; boss.userData.atkCd=0; boss.userData.riseT=0;
  G.bossActive=true; G.aliveCount++;
  AU.round(); toast('HEAVY INCOMING','a brute stalks the boss yard');
}

function spawnMegaBoss(){
  if(!mega){ mega=KIT.makeRoyalEgg(); mega.scale.setScalar(3.0); scene.add(mega); }
  const yd=G.bossYard||{x:0,z:-52};
  mega.position.set(yd.x,4.2,yd.z); mega.visible=true;
  mega.userData.hp = 14000; mega.userData.maxhp=14000; mega.userData.alive=true; mega.userData.hatch=0;
  mega.userData.speed=1.4; mega.userData.atkCd=0;
  G.megaActive=true;
  AU.round(); toast('THE ROYAL EGG HATCHES','MEGA PINGAS BOSS','#ff48c0');
}

/* ════════════════════ PLAYER ARMS / WEAPONS ════════════════════ */
let arms=null, armBaseY=-0.0, recoil=0, muzzle=null, muzzleT=0;
let hells={phase:'idle', t:0, proj:null};

function buildPlayerArms(){
  if(arms){ camera.remove(arms); }
  const w=G.weapons[G.cur];
  arms = KIT.makeArms(w.type, w.pap);
  camera.add(arms);
  window.__SE.fpsArms=arms; window.__SE.weapon=w.type; window.__SE.pap=w.pap;
  // reusable muzzle flash light (constant light count — toggled, never added/removed)
  if(!muzzle){ muzzle=new T.PointLight(0xffd58a,0,6,2); camera.add(muzzle); muzzle.position.set(0.2,-0.2,-1.2); }
}

function curW(){ return G.weapons[G.cur]; }
function swapTo(i){ if(i<0||i>=G.weapons.length||i===G.cur) return; G.cur=i; const w=curW(); w.reloading=false; buildPlayerArms(); updateAmmoHUD(); AU.reload(); hells.phase='idle'; }
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
  const rate = d.rate * (G.perks.has('doubleshot')?1.45:1) * (G.fireRateBuff>0?2:1);
  if(now - w.lastShot < 1/rate) return;
  if(w.type==='hells'){ return; } // hells handled by charge system
  if(w.ammo<=0){ AU.dry(); flashReloadHint(); return; }
  w.lastShot=now; w.ammo--; updateAmmoHUD();
  recoil = Math.min(0.5, recoil + (d.kind==='ballistic'? (d.pellets?0.32:0.14) : 0.2));
  muzzle.intensity=2.4; muzzleT=now;
  AU.shoot(w.type==='shotgun'?'shotgun': w.type==='wonder'?'wonder': w.type);

  camera.getWorldDirection(_dir);
  const ox=camera.position.x, oy=camera.position.y, oz=camera.position.z;
  const dmgMul = (w.pap?2.2:1) * (G.instaKill>0?1000:1) * (G.perks.has('doubleshot')?1.1:1);

  if(w.type==='wonder'){ spawnBolt(ox,oy,oz,_dir.x,_dir.y,_dir.z, d.dmg*dmgMul, d.aoe); return; }

  const pellets = d.pellets||1;
  let anyHit=false;
  for(let p=0;p<pellets;p++){
    let dx=_dir.x, dy=_dir.y, dz=_dir.z;
    if(d.spread){ dx+=(Math.random()-0.5)*d.spread; dy+=(Math.random()-0.5)*d.spread; dz+=(Math.random()-0.5)*d.spread;
      const l=Math.hypot(dx,dy,dz); dx/=l; dy/=l; dz/=l; }
    const hit=rayHitEnemy(ox,oy,oz,dx,dy,dz,d.range);
    if(hit){ anyHit=true;
      const dmg = d.dmg*dmgMul*(hit.head?1.8:1);
      if(hit.e) damageEnemy(hit.e, dmg, hit.head);
      else if(hit.boss) damageBoss(dmg);
      else if(hit.mega) damageMega(dmg);
    }
  }
  if(anyHit){ AU.hit(); hitmarker(); }
}

/* Wonder weapon bolt pool */
const bolts=[]; const BOLT_MAX=8;
function spawnBolt(ox,oy,oz,dx,dy,dz,dmg,aoe){
  let b=bolts.find(b=>!b.active);
  if(!b){ if(bolts.length>=BOLT_MAX){ b=bolts[0]; } else {
    const m=new T.Mesh(new T.CylinderGeometry(0.06,0.06,1.4,8), KIT.glow(0x9beaff,2.8));
    const light=new T.PointLight(0x9beaff,0,5,2); m.add(light);
    scene.add(m); b={mesh:m, light, active:false}; bolts.push(b); } }
  b.mesh.visible=true; b.active=true; b.dmg=dmg; b.aoe=aoe; b.life=0;
  b.mesh.position.set(ox+dx,oy+dy,oz+dz); b.dir=new T.Vector3(dx,dy,dz);
  b.mesh.quaternion.setFromUnitVectors(_v2.set(0,1,0), b.dir); b.light.intensity=1.5;
}
function updateBolts(dt){
  for(const b of bolts){ if(!b.active) continue; b.life+=dt;
    b.mesh.position.addScaledVector(b.dir, 60*dt);
    if(b.life>2){ b.active=false; b.mesh.visible=false; b.light.intensity=0; continue; }
    // proximity to any enemy
    for(let i=0;i<zombies.length;i++){ const e=zombies[i]; if(!e.alive) continue;
      if(Math.abs(b.mesh.position.x-e.grp.position.x)<1.2 && Math.abs(b.mesh.position.z-e.grp.position.z)<1.2
         && Math.abs(b.mesh.position.y-(e.grp.position.y+e.bodyY))<1.6){
        wonderBurst(b.mesh.position.x,b.mesh.position.y,b.mesh.position.z, b.dmg, b.aoe);
        b.active=false; b.mesh.visible=false; b.light.intensity=0; break; } }
  }
}
function wonderBurst(x,y,z,dmg,aoe){
  fxExplosion(x,y,z, 0x9beaff, 0.7); AU.hit();
  for(let i=0;i<zombies.length;i++){ const e=zombies[i]; if(!e.alive) continue;
    if(Math.hypot(e.grp.position.x-x, e.grp.position.z-z) < aoe) damageEnemy(e, dmg, false); }
  if(boss&&boss.userData.alive && Math.hypot(boss.position.x-x,boss.position.z-z)<aoe) damageBoss(dmg*0.6);
}

/* Hells Revolver: hold to charge 3s (freeze at full) → throw up to 12u → AoE → return */
function updateHells(dt, charging){
  const w=curW(); if(!w || w.type!=='hells'){ hells.phase='idle'; setCharge(0); return; }
  const held = arms && arms.userData.weapon;
  if(hells.phase==='idle'){
    setCharge(0);
    if(charging && w.ammo>0){ hells.phase='charge'; hells.t=0; }
  } else if(hells.phase==='charge'){
    hells.t+=dt; const k=Math.min(1,hells.t/3); setCharge(k);
    if(held){ const shake=k<1?(Math.random()-0.5)*0.04*k:0;
      held.position.z = -0.62 + 0.22*k + shake; held.position.x=0.13+shake; held.rotation.x=-0.5*k; }
    if(!charging){ // released → throw, distance scales with charge
      if(k>0.15){ throwHells(k); } else { hells.phase='idle'; if(held){held.position.set(0.13,-0.30,-0.62); held.rotation.x=0;} }
    }
  } else if(hells.phase==='out' || hells.phase==='back'){
    setCharge(0);
    updateHellsProj(dt);
  }
}
function throwHells(k){
  const w=curW(); if(w.ammo<=0){ hells.phase='idle'; return; } w.ammo--; updateAmmoHUD();
  AU.shoot('hells'); hells.phase='out'; hells.t=0; hells.dist=4+k*12; hells.k=k;
  if(arms&&arms.userData.weapon) arms.userData.weapon.visible=false;
  if(!hells.proj){ hells.proj=KIT.makeWeapon('hells',w.pap); hells.proj.scale.setScalar(0.62); scene.add(hells.proj);
    hells.plight=new T.PointLight(0xff3a14,2,8,2); hells.proj.add(hells.plight); }
  hells.proj.visible=true;
  camera.getWorldDirection(_dir);
  hells.from=camera.position.clone();
  hells.dirv=_dir.clone();
}
function updateHellsProj(dt){
  hells.t+=dt; const p=hells.proj;
  p.rotation.x+=14*dt; p.rotation.y+=8*dt;
  if(hells.phase==='out'){
    const k=hells.t/0.5; const d=Math.min(1,k)*hells.dist;
    p.position.copy(hells.from).addScaledVector(hells.dirv, d); p.position.y=1.3;
    if(k>=1){ // detonate
      const w=curW(); const dmg=WDEF.hells.dmg*(w.pap?2.2:1)*(G.instaKill>0?1000:1);
      fxExplosion(p.position.x,p.position.y,p.position.z, 0xff4a14, 1.4); AU.explode();
      for(let i=0;i<zombies.length;i++){ const e=zombies[i]; if(!e.alive) continue;
        if(Math.hypot(e.grp.position.x-p.position.x,e.grp.position.z-p.position.z)<WDEF.hells.aoe) damageEnemy(e,dmg,false); }
      if(boss&&boss.userData.alive&&Math.hypot(boss.position.x-p.position.x,boss.position.z-p.position.z)<WDEF.hells.aoe) damageBoss(dmg);
      if(mega&&mega.userData.alive&&Math.hypot(mega.position.x-p.position.x,mega.position.z-p.position.z)<WDEF.hells.aoe+3) damageMega(dmg);
      hells.phase='back'; hells.t=0; hells.bfrom=p.position.clone();
    }
  } else { // back to hand
    const k=hells.t/0.55; p.position.lerpVectors(hells.bfrom, camera.position, Math.min(1,k)); p.position.y=Math.max(1.0,p.position.y);
    if(k>=1){ p.visible=false; hells.phase='idle';
      const held=arms&&arms.userData.weapon; if(held){ held.visible=true; held.position.set(0.13,-0.30,-0.62); held.rotation.x=0; }
      const w=curW(); if(w.ammo<=0 && w.reserve>0) startReload(); }
  }
}

/* ════════════════════ DAMAGE / DEATH / DROPS ════════════════════ */
function damageEnemy(e, dmg, head){
  if(!e.alive) return; e.hp-=dmg;
  if(e.hp<=0){ killEnemy(e, head); }
}
function killEnemy(e, head){
  e.alive=false; e.grp.visible=false; G.aliveCount--;
  G.kills++; addPoints(head?100:60);
  if(Math.random()<0.04 + (G.round>3?0.02:0)) spawnDrop(e.grp.position.x, e.grp.position.z);
  checkRoundProgress();
}
function damageBoss(dmg){ if(!boss||!boss.userData.alive) return; boss.userData.hp-=dmg;
  if(boss.userData.hp<=0){ boss.userData.alive=false; boss.visible=false; G.bossActive=false; G.aliveCount--;
    addPoints(800); toast('BRUTE DOWN','+800'); spawnDrop(boss.position.x,boss.position.z); checkRoundProgress(); } }
function damageMega(dmg){ if(!mega||!mega.userData.alive) return; mega.userData.hp-=dmg;
  const hp=mega.userData.hp;
  if(hp<=0){ mega.userData.alive=false; mega.visible=false; G.megaActive=false; winGame(); } }

const drops=[]; // {grp, kind, t, x, z}
const DROP_KINDS=['instakill','maxammo','doublepts','nuke','chips'];
function spawnDrop(x,z){
  const kind=DROP_KINDS[(Math.random()*DROP_KINDS.length)|0];
  let grp;
  if(kind==='instakill') grp=KIT.makeSkullDrop();
  else if(kind==='chips') grp=KIT.makePingasChips();
  else { grp=KIT.makePickups(); grp.scale.setScalar(0.6); }
  grp.position.set(x,1.1,z); scene.add(grp);
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
  const g=KIT.makeGrenade(); scene.add(g);
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
const fxPool=[];
function fxExplosion(x,y,z,color,scale){
  let f=fxPool.find(f=>!f.active);
  if(!f){ const g=KIT.makeExplosion(); scene.add(g); f={grp:g, active:false, t:0, anim:g.userData.update}; fxPool.push(f); }
  f.grp.position.set(x,y,z); f.grp.scale.setScalar(scale||1); f.grp.visible=true; f.active=true; f.t=0;
}
function updateFx(){
  for(const f of fxPool){ if(!f.active) continue; f.t+=STEP;
    if(f.anim) f.anim(f.t); if(f.t>2.1){ f.active=false; f.grp.visible=false; } }
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
  const pool=['smg','shotgun','rifle','ak','lmg','wonder','hells'];
  const pick=pool[(Math.random()*pool.length)|0];
  giveWeapon(pick, false); toast(WDEF[pick].name+'!','mystery reward','#ffd23a');
  return true;
}
function packAPunch(){
  if(!G.powerOn) return false; const w=curW(); if(!w||w.pap) return false;
  if(!spend(5000)) return false; AU.power();
  w.pap=true; w.name=WDEF[w.type].name+' +'; w.reserve=WDEF[w.type].reserve; w.ammo=w.mag;
  buildPlayerArms(); updateAmmoHUD(); toast('PACK-A-PINGAS','weapon upgraded','#35d6ff'); return true;
}
function buyPerk(id,cost,trimHex){
  if(!G.powerOn) return false; if(G.perks.has(id)) return false;
  if(!spend(cost)) return false; AU.powerup();
  G.perks.add(id);
  if(id==='rootbeer'){ G.maxHealth=200; G.health+=100; }
  updatePerksHUD(); updateHealthHUD(); toast('PERK ACQUIRED', perkName(id), '#'+(trimHex||0x5aa0ff).toString(16)); return true;
}
function perkName(id){ return id==='doubleshot'?'DOUBLE SHOT': id==='rootbeer'?'MUG ROOTBEER METH': id==='pingasliquid'?'PINGAS LIQUID':id; }

/* ════════════════════ WAVE DIRECTOR ════════════════════ */
const FINAL_ROUND=12;
function startRound(n){
  G.round=n; G.roundActive=true;
  G.budget = Math.round(6 + n*3.5 + n*n*0.35);
  if(n>=FINAL_ROUND){ G.budget=0; spawnMegaBoss(); }
  G.toSpawn=G.budget; G.spawnTimer=0;
  updateRoundHUD(true); if(n>1) AU.round();
  if(n%5===0 && n>0 && n<FINAL_ROUND) spawnMiniBoss();
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
  if(G.toSpawn>0 && G.aliveCount<MAX_Z){
    G.spawnTimer-=dt;
    // brisk cadence + small bursts so the arena fills toward the 25-cap and stays pressured
    const interval = Math.max(0.22, 0.75 - G.round*0.03);
    if(G.spawnTimer<=0){ G.spawnTimer=interval;
      const burst = 1 + (G.round>5?1:0) + (G.round>10?1:0);
      for(let k=0;k<burst && G.toSpawn>0 && G.aliveCount<MAX_Z;k++){
        const crawler = G.round>=4 && Math.random()<0.22;
        if(spawnZombie(crawler)) G.toSpawn--;
      }
    }
  }
}

/* ════════════════════ ENEMY AI (fixed-step) ════════════════════ */
function clampArena(x,z, rad){
  // outer radius
  const r=Math.hypot(x,z); if(r>R_OUT){ x*=R_OUT/r; z*=R_OUT/r; }
  // tower AABB push-out
  const h=TOWER_H+rad;
  if(Math.abs(x)<h && Math.abs(z)<h){
    if(!(doorOpen && Math.abs(x)<4 && z>0)){ // allow door gap when open
      const dx=h-Math.abs(x), dz=h-Math.abs(z);
      if(dx<dz) x=(x<0?-h:h); else z=(z<0?-h:h);
    }
  }
  // prop colliders
  for(let i=0;i<colliders.length;i++){ const c=colliders[i];
    const ddx=x-c.x, ddz=z-c.z, dd=Math.hypot(ddx,ddz), min=c.r+rad;
    if(dd<min && dd>0.0001){ x=c.x+ddx/dd*min; z=c.z+ddz/dd*min; } }
  _v3.set(x,0,z); return _v3;
}

function updateEnemies(dt){
  const px=camera.position.x, pz=camera.position.z, et=clock.elapsedTime;
  for(let i=0;i<zombies.length;i++){ const e=zombies[i]; if(!e.alive) continue;
    // rise-in scale
    if(e.grp.scale.x<1){ e.grp.scale.setScalar(Math.min(1, e.grp.scale.x+dt*3)); }
    const dx=px-e.grp.position.x, dz=pz-e.grp.position.z; const dist=Math.hypot(dx,dz);
    // face + walk
    e.grp.rotation.y = Math.atan2(dx,dz);
    if(dist>1.4){
      const sp=e.speed*dt; let nx=e.grp.position.x+dx/dist*sp, nz=e.grp.position.z+dz/dist*sp;
      const c=clampArena(nx,nz,0.5); e.grp.position.x=c.x; e.grp.position.z=c.z;
    } else {
      // melee
      e.atkCd-=dt; if(e.atkCd<=0){ e.atkCd=1.0; hurtPlayer(e.isCrawler?8:14); }
    }
    if(e.anim) e.anim(et + i); // shamble (kit closure)
  }
  // mini-boss
  if(boss && boss.userData.alive){ if(boss.scale.x<0.46) boss.scale.setScalar(Math.min(0.46,boss.scale.x+dt*0.6));
    const dx=px-boss.position.x, dz=pz-boss.position.z, dist=Math.hypot(dx,dz);
    boss.rotation.y=Math.atan2(dx,dz);
    if(dist>2.2){ const sp=boss.userData.speed*dt; const c=clampArena(boss.position.x+dx/dist*sp, boss.position.z+dz/dist*sp, 1.0); boss.position.x=c.x; boss.position.z=c.z; }
    else { boss.userData.atkCd-=dt; if(boss.userData.atkCd<=0){ boss.userData.atkCd=1.3; hurtPlayer(34); } }
    if(boss.userData.update) boss.userData.update(et);
  }
  // mega boss (egg → hatch → chase)
  if(mega && mega.userData.alive){
    mega.userData.hatch += dt*0.12;
    if(mega.userData.update) mega.userData.update(et);
    if(mega.userData.hatch>1.2){
      const dx=px-mega.position.x, dz=pz-mega.position.z, dist=Math.hypot(dx,dz);
      mega.rotation.y=Math.atan2(dx,dz);
      if(dist>8){ const sp=mega.userData.speed*dt; mega.position.x+=dx/dist*sp; mega.position.z+=dz/dist*sp; }
      else { mega.userData.atkCd-=dt; if(mega.userData.atkCd<=0){ mega.userData.atkCd=1.6; hurtPlayer(45); } }
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
  const baseSpeed = sprint?8.6:5.6;
  // forward/right from yaw
  _fwd.set(Math.sin(G.yaw),0,Math.cos(G.yaw));
  _right.set(Math.cos(G.yaw),0,-Math.sin(G.yaw));
  let mx=0,mz=0;
  if(G.keys['w']){ mx-=_fwd.x; mz-=_fwd.z; }
  if(G.keys['s']){ mx+=_fwd.x; mz+=_fwd.z; }
  if(G.keys['a']){ mx-=_right.x; mz-=_right.z; }
  if(G.keys['d']){ mx+=_right.x; mz+=_right.z; }
  const ml=Math.hypot(mx,mz); if(ml>0){ mx/=ml; mz/=ml; }
  const nx=camera.position.x + mx*baseSpeed*dt;
  const nz=camera.position.z + mz*baseSpeed*dt;
  const c=clampArena(nx,nz,PLAYER_R); camera.position.x=c.x; camera.position.z=c.z;
  // gravity / jump
  G.vy-=GRAV*dt; camera.position.y+=G.vy*dt;
  if(camera.position.y<=EYE){ camera.position.y=EYE; G.vy=0; G.onGround=true; } else G.onGround=false;
  // head bob
  if(ml>0 && G.onGround){ const bob=Math.sin(clock.elapsedTime*(sprint?16:11))*(sprint?0.06:0.04); camera.position.y+=bob; }
  // health regen
  if(clock.elapsedTime - G.lastDmg > 4 && G.health<G.maxHealth){ G.health=Math.min(G.maxHealth, G.health+30*dt); updateHealthHUD(); }
  // arms recoil/sway recover
  if(arms){ recoil*=Math.max(0,1-dt*9);
    arms.position.z = recoil*0.12; arms.rotation.x = recoil*0.5;
    arms.position.y = Math.sin(clock.elapsedTime*1.6)*0.01;
    arms.position.x = Math.sin(clock.elapsedTime*0.9)*0.008; }
  // muzzle flash decay
  if(muzzle && muzzle.intensity>0){ muzzle.intensity=Math.max(0, muzzle.intensity - dt*22); }
  // door swing
  if(towerDoorPivot){ const tgt=doorOpen?-Math.PI*0.62:0; towerDoorPivot.rotation.y += (tgt-towerDoorPivot.rotation.y)*Math.min(1,dt*3); }
  // gate plank animation
  for(const it of interactables){ if(it.type==='gate' && it.open && it.anim<1){ it.anim=Math.min(1,it.anim+dt*0.8);
    for(const pk of it.planks){ pk.mesh.position.y=pk.cy+(pk.oy-pk.cy)*it.anim; pk.mesh.rotation.z=pk.cr+(pk.or-pk.cr)*it.anim; if(it.anim>=1) pk.mesh.visible=false; } } }
  // expire timed powerups display
}

/* reload */
function startReload(){
  const w=curW(); if(!w||w.reloading) return; if(w.ammo>=w.mag || w.reserve<=0) return;
  const d=WDEF[w.type]; const rt=d.reload * (G.perks.has('pingasliquid')?0.55:1);
  w.reloading=true; w.reloadEnd=clock.elapsedTime+rt; AU.reload(); flashReloadHint(true);
}
function updateReload(){
  const w=curW(); if(!w||!w.reloading) return;
  if(clock.elapsedTime>=w.reloadEnd){ w.reloading=false;
    const need=w.mag-w.ammo, take=Math.min(need,w.reserve); w.ammo+=take; w.reserve-=take; updateAmmoHUD(); flashReloadHint(false); }
}

/* ════════════════════ INTERACTION ════════════════════ */
let nearInteract=null;
function updateInteraction(){
  const px=camera.position.x, pz=camera.position.z; let found=null, fd=99;
  for(const it of interactables){ const d=Math.hypot(px-it.x, pz-it.z);
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
function updateAmmoHUD(){ const w=curW(); if(!w) return; const a=$('ammo');
  a.querySelector('.mag').textContent = w.type==='hells'? (w.ammo?'●':'○') : w.ammo;
  a.querySelector('.res').textContent = w.reserve;
  a.classList.toggle('low', w.ammo<=Math.max(1,Math.ceil(w.mag*0.25)));
  $('wname').innerHTML = w.pap? '<span class="pap">'+w.name+'</span>' : w.name;
  updateNadeHUD();
}
function updateNadeHUD(){ /* could show nades; folded into wname for brevity */ }
function updateRoundHUD(flash){ $('round').querySelector('.num').textContent=G.round;
  if(flash){ const r=$('round'); r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash'); } updateZleftHUD(); }
function updateZleftHUD(){ const left = G.toSpawn + G.aliveCount; $('zleft').innerHTML='UNDEAD&nbsp;&nbsp;<b>'+Math.max(0,left)+'</b>'; }
function updatePerksHUD(){ const wrap=$('perks'); wrap.innerHTML='';
  const icons={doubleshot:['DS','#35d6ff'], rootbeer:['JG','#ffa23a'], pingasliquid:['PL','#ff48c0']};
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
function bindInput(){
  document.addEventListener('keydown', e=>{ const k=e.key.toLowerCase(); G.keys[k]=true;
    if(G.phase!=='play') return;
    if(k==='r') startReload();
    if(k==='g') throwGrenade();
    if(k==='f') doInteract();
    if(k==='1') swapTo(0);
    if(k==='2') swapTo(1);
    if(k==='q') cycleWeapon(1);
    if(k==='escape') pauseGame();
    if(e.code==='Space'){ if(G.onGround){ G.vy=8.0; G.onGround=false; } }
  });
  document.addEventListener('keyup', e=>{ G.keys[e.key.toLowerCase()]=false; });
  document.addEventListener('mousedown', e=>{ if(G.phase!=='play') return; if(e.button===0) G.mouseDown=true; });
  document.addEventListener('mouseup', e=>{ if(e.button===0) G.mouseDown=false; });
  document.addEventListener('wheel', e=>{ if(G.phase!=='play') return; cycleWeapon(e.deltaY>0?1:-1); }, {passive:true});
  document.addEventListener('mousemove', e=>{ if(G.phase!=='play') return;
    G.yaw   -= e.movementX*0.0022; G.pitch -= e.movementY*0.0022;
    G.pitch = Math.max(-1.4, Math.min(1.4, G.pitch));
    camera.rotation.order='YXZ'; camera.rotation.y=G.yaw; camera.rotation.x=G.pitch; });
  document.addEventListener('pointerlockchange', ()=>{
    if(!document.pointerLockElement && G.phase==='play'){ pauseGame(); } });
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
  G.aliveCount=0; G.bossActive=false; G.megaActive=false; G.roundActive=false; G.intermission=0;
  G.round=0; G.kills=0; G.points=500; G.powerOn=false; G.health=100; G.maxHealth=100;
  G.perks=new Set(); G.weapons=[newWeapon('pistol',false)]; G.cur=0; G.instaKill=0; G.doublePts=0; G.fireRateBuff=0;
  nadeCount=4; doorOpen=false;
  camera.position.set(pos(90)[0], EYE, pos(90)[1]-3); G.yaw=Math.PI; G.pitch=0;
  camera.rotation.order='YXZ'; camera.rotation.set(0,G.yaw,0);
  buildPlayerArms(); updateHealthHUD(); updatePointsHUD(); updateAmmoHUD(); updatePerksHUD(); updateZleftHUD();
}
function startGame(){
  resetRun(); G.phase='play'; $('hud').classList.add('on');
  hideAllScreens(); AU.resume(); lockMouse();
  G.intermission=clock.elapsedTime+2.0; updateRoundHUD();
  toast('UNDEAD SIEGE','prepare yourself');
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
    updateFx();
    if(fpsCounter) fpsTick();
  }
  if(renderer && scene && camera){
    renderer.render(scene,camera);
    if(needShadowBake){ // bake static shadows ONCE, then freeze the shadow map
      shadowLight.shadow.needsUpdate=true; needShadowBake=false;
      shadowLight.shadow.autoUpdate=false;
    }
  }
}
function simStep(dt){
  // input → fire
  const w=curW();
  if(w && w.type==='hells'){ updateHells(dt, G.mouseDown); }
  else if(G.mouseDown){ if(w && (WDEF[w.type].auto || canSemi())) fire(); }
  updatePlayer(dt);
  updateReload();
  updateEnemies(dt);
  updateBolts(dt);
  updateNades(dt);
  updateDrops(dt);
  directorTick(dt);
  updateInteraction();
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
      bindInput(); bindMenus();
      loop();
      G.phase='menu'; showScreen('menu');
    }catch(err){ console.error('BUILD ERROR', err); $('loadmsg').textContent='ERROR: '+err.message; }
  }, 60);
}

// test/debug hooks
window.__startRoundForTest=(n)=>{ G.round=n-1; G.intermission=clock.elapsedTime; startRound(n); };
window.__camera=()=>camera;
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

if(document.readyState==='complete'||document.readyState==='interactive') boot();
else addEventListener('DOMContentLoaded', boot);

})();
