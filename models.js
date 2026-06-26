// models.js — model factory ported VERBATIM from the Undead Siege Kit.
// Builder methods are unchanged; only wrapped in a class so the game can call KIT.makeZombie() etc.
// THREE is global (loaded from three.min.js). window.__resources holds the two image data-URIs.
/* global THREE */
"use strict";
class Kit {
  constructor() {
    this.accentHex = 0x5aa0ff; // kit default accent (#5aa0ff)
  }
  mat(c, r=0.9, m=0) { return new THREE.MeshStandardMaterial({ color:c, roughness:r, metalness:m }); }
  glow(c, i=1) { return new THREE.MeshStandardMaterial({ color:0x05070a, emissive:c, emissiveIntensity:i, roughness:0.4 }); }
  box(w, h, d, m) { return new THREE.Mesh(new THREE.BoxGeometry(w,h,d), m); }
  cyl(rt, rb, h, m, axis) { const me=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,20), m); if(axis==='z') me.rotation.x=Math.PI/2; if(axis==='x') me.rotation.z=Math.PI/2; return me; }
  at(me, x, y, z) { me.position.set(x,y,z); return me; }
  shadow(g) { g.traverse(o => { if (o.isMesh) { o.castShadow=true; o.receiveShadow=true; } }); return g; }
  label(text, fg) {
    const c=document.createElement('canvas'); c.width=256; c.height=128;
    const x=c.getContext('2d'); x.clearRect(0,0,256,128);
    x.fillStyle=fg||'#bfe0ff'; x.font='700 72px Oswald, sans-serif'; x.textAlign='center'; x.textBaseline='middle';
    x.fillText(text, 128, 70);
    const t=new THREE.CanvasTexture(c); t.anisotropy=4; t.needsUpdate=true; return t;
  }

  /* ---------- model builders ---------- */
  limb(skin, sleeve) {
    const a=new THREE.Group();
    a.add(this.at(this.box(0.15,0.34,0.16, sleeve), 0,-0.17,0));
    a.add(this.at(this.box(0.12,0.32,0.13, skin), 0,-0.5,0));
    a.add(this.at(this.box(0.15,0.15,0.17, skin), 0,-0.7,0.01));
    return a;
  }
  leg(cloth) {
    const l=new THREE.Group();
    l.add(this.at(this.box(0.2,0.42,0.22, cloth), 0,-0.2,0));
    l.add(this.at(this.box(0.17,0.4,0.19, this.mat(0x222019,0.95,0)), 0,-0.6,0));
    l.add(this.at(this.box(0.2,0.13,0.3, this.mat(0x14110d,0.9,0)), 0,-0.83,0.05));
    return l;
  }
  makeZombie() {
    const g=new THREE.Group();
    const skin=this.mat(0x6f7d5c,0.98,0);
    const cloth=this.mat(0x23261f,0.95,0);
    const sleeve=this.mat(0x33271c,0.95,0);
    const torso=this.box(0.56,0.8,0.32, cloth); torso.position.set(0,1.28,0); torso.rotation.x=0.2; g.add(torso);
    const head=this.box(0.3,0.32,0.3, skin); head.position.set(0,1.74,0.06); head.rotation.x=0.16; g.add(head);
    head.add(this.at(this.box(0.26,0.1,0.24, skin), 0,-0.18,0.01));
    const eye=this.glow(0xffd23a,1.6);
    [-0.07,0.07].forEach(x => head.add(this.at(this.box(0.05,0.05,0.02, eye), x,0.02,0.16)));
    const armL=this.limb(skin, sleeve); armL.position.set(-0.35,1.55,0.02); armL.rotation.set(-1.42,0,0.18); g.add(armL);
    const armR=this.limb(skin, sleeve); armR.position.set(0.35,1.55,0.02); armR.rotation.set(-1.3,0,-0.18); g.add(armR);
    const legL=this.leg(cloth); legL.position.set(-0.16,0.92,0); g.add(legL);
    const legR=this.leg(cloth); legR.position.set(0.16,0.92,0); g.add(legR);
    g.userData.update = (t) => {
      g.rotation.z=Math.sin(t*2)*0.05;
      g.position.y=Math.abs(Math.sin(t*4))*0.04;
      legL.rotation.x=Math.sin(t*4)*0.5; legR.rotation.x=-Math.sin(t*4)*0.5;
      armL.rotation.z=0.18+Math.sin(t*3)*0.09; armR.rotation.z=-0.18-Math.sin(t*3+1)*0.09;
      head.rotation.z=Math.sin(t*2+1)*0.08;
    };
    return g;
  }
  makeCrate() {
    const g=new THREE.Group();
    const wood=this.mat(0x52402c,0.85,0);
    const band=this.mat(0x2a2d30,0.5,0.7);
    g.add(this.at(this.box(1.12,0.72,0.86, wood), 0,0.36,0));
    [-0.3,0.3].forEach(z => g.add(this.at(this.box(1.16,0.76,0.07, band), 0,0.36,z)));
    g.add(this.at(this.box(0.07,0.76,0.9, band), 0,0.36,0));
    const rune=this.glow(this.accentHex,1.6);
    [-0.26,0,0.26].forEach(x => g.add(this.at(this.box(0.05,0.3,0.02, rune), x,0.36,0.45)));
    const lid=new THREE.Group(); lid.position.set(0,0.72,-0.43);
    lid.add(this.at(this.box(1.14,0.16,0.88, wood), 0,0.02,0.43));
    g.add(lid);
    const orb=new THREE.Mesh(new THREE.SphereGeometry(0.2,18,18), this.glow(this.accentHex,2.4)); orb.position.set(0,0.8,0); g.add(orb);
    const pl=new THREE.PointLight(this.accentHex,0,3.5); pl.position.set(0,0.95,0); g.add(pl);
    g.userData.update = (t) => {
      const o=Math.sin(t*0.6)*0.5+0.5;
      lid.rotation.x=-o*1.15;
      orb.visible=o>0.45; orb.position.y=0.74+o*0.4; orb.scale.setScalar(0.5+o*0.7);
      orb.material.emissiveIntensity=1.8+Math.sin(t*6)*0.7;
      pl.intensity=o*2.6;
    };
    return g;
  }
  makeWindow() {
    const g=new THREE.Group();
    const stone=this.mat(0x3a3d40,0.96,0);
    const wood=this.mat(0x4a3525,0.85,0);
    g.add(this.at(this.box(1.3,0.24,0.42, stone), 0,1.55,0));
    g.add(this.at(this.box(1.3,0.24,0.42, stone), 0,0.2,0));
    g.add(this.at(this.box(0.24,1.6,0.42, stone), -0.55,0.87,0));
    g.add(this.at(this.box(0.24,1.6,0.42, stone), 0.55,0.87,0));
    const planks=[];
    for (let i=0;i<4;i++) {
      const p=this.box(1.4,0.17,0.07, wood); p.position.set(0,0.55+i*0.27,0.2); p.rotation.z=(i%2?1:-1)*0.06; g.add(p); planks.push(p);
    }
    g.userData.update = (t) => { planks[1].rotation.z=-0.06+Math.sin(t*8)*0.035; };
    return g;
  }
  makePickups() {
    const g=new THREE.Group();
    const ammo=new THREE.Group();
    ammo.add(this.box(0.42,0.27,0.3, this.mat(0x3a4a32,0.8,0.1)));
    ammo.add(this.at(this.box(0.44,0.05,0.32, this.mat(0xd9a441,0.6,0.2)), 0,0.16,0));
    ammo.position.set(-0.62,0.18,0);
    const med=new THREE.Group();
    med.add(this.box(0.36,0.36,0.22, this.mat(0xdcdcdc,0.6,0)));
    const cross=this.glow(0xff3b30,0.9);
    med.add(this.at(this.box(0.22,0.07,0.23, cross),0,0,0.1));
    med.add(this.at(this.box(0.07,0.22,0.23, cross),0,0,0.1));
    med.position.set(0.62,0.2,0);
    const coinG=new THREE.Group(); coinG.position.set(0,0.25,0);
    const coin=new THREE.Mesh(new THREE.CylinderGeometry(0.24,0.24,0.06,24), this.glow(this.accentHex,1.3)); coin.rotation.x=Math.PI/2; coinG.add(coin);
    g.add(ammo, med, coinG);
    g.userData.update = (t) => {
      coinG.rotation.y=t*1.6;
      ammo.position.y=0.18+Math.sin(t*2)*0.05;
      med.position.y=0.2+Math.sin(t*2+1)*0.05;
      coinG.position.y=0.25+Math.sin(t*2+2)*0.06;
    };
    return g;
  }
  makeWallBuy() {
    const g=new THREE.Group();
    g.add(this.at(this.box(1.7,1.05,0.09, this.mat(0x2a2622,0.95,0)), 0,1.0,0));
    const w=this.makeWeapon('rifle'); w.scale.setScalar(0.85); w.position.set(0,1.1,0.12); w.rotation.set(0,Math.PI/2,0);
    w.traverse(o => { if (o.isMesh) o.material=this.mat(0x14110e,0.92,0); }); g.add(w);
    const tag=new THREE.Mesh(new THREE.PlaneGeometry(0.78,0.32), new THREE.MeshBasicMaterial({ map:this.label('1200','#bfe0ff'), transparent:true }));
    tag.position.set(0,0.46,0.07); g.add(tag);
    g.add(this.at(this.box(0.86,0.4,0.02, this.glow(this.accentHex,0.5)), 0,0.46,0.05));
    g.userData.update = (t) => {};
    return g;
  }
  makeWeapon(type, pap) {
    const g=new THREE.Group();
    const metal=this.mat(0x1d2024,0.5,0.6);
    const dark=this.mat(0x101214,0.6,0.5);
    const wood=this.mat(0x3a2a1b,0.8,0);
    if (type==='pistol') {
      g.add(this.box(0.11,0.18,0.52, metal));
      const grip=this.box(0.1,0.27,0.15, dark); grip.position.set(0,-0.2,-0.17); grip.rotation.x=-0.26; g.add(grip);
      g.add(this.at(this.cyl(0.03,0.03,0.16, metal,'z'), 0,0.02,0.32));
    } else if (type==='smg') {
      g.add(this.box(0.12,0.17,0.72, metal));
      const grip=this.box(0.1,0.25,0.14, dark); grip.position.set(0,-0.19,-0.06); grip.rotation.x=-0.2; g.add(grip);
      g.add(this.at(this.box(0.08,0.32,0.13, dark), 0,-0.28,0.13));
      g.add(this.at(this.cyl(0.025,0.025,0.42, metal,'z'), 0,0.03,0.52));
      g.add(this.at(this.box(0.06,0.1,0.32, dark), 0,0,-0.44));
    } else if (type==='shotgun') {
      g.add(this.box(0.13,0.15,1.02, metal));
      g.add(this.at(this.cyl(0.04,0.04,0.72, metal,'z'), 0,0.02,0.56));
      g.add(this.at(this.box(0.15,0.13,0.24, dark), 0,-0.11,0.26));
      g.add(this.at(this.box(0.11,0.19,0.42, wood), 0,-0.05,-0.56));
      const grip=this.box(0.1,0.2,0.13, wood); grip.position.set(0,-0.17,-0.16); grip.rotation.x=-0.2; g.add(grip);
    } else if (type==='ak') {
      g.add(this.box(0.1,0.17,1.04, metal));
      g.add(this.at(this.cyl(0.028,0.028,0.52, metal,'z'), 0,0.03,0.68));
      const mag=this.box(0.12,0.42,0.16, dark); mag.position.set(0,-0.31,0.12); mag.rotation.x=0.5; g.add(mag);
      g.add(this.at(this.box(0.1,0.2,0.46, wood), 0,-0.02,-0.62));
      const grip=this.box(0.1,0.22,0.13, wood); grip.position.set(0,-0.18,-0.16); grip.rotation.x=-0.2; g.add(grip);
      g.add(this.at(this.box(0.09,0.15,0.32, wood), 0,-0.02,0.34));
      g.add(this.at(this.box(0.04,0.1,0.05, dark), 0,0.17,0.2));
    } else if (type==='sniper') {
      g.add(this.box(0.08,0.14,1.48, metal));
      g.add(this.at(this.cyl(0.022,0.022,0.84, metal,'z'), 0,0.03,0.92));
      g.add(this.at(this.box(0.14,0.08,0.52, dark), 0,0.18,0.24));
      g.add(this.at(this.box(0.08,0.18,0.38, wood), 0,-0.02,-0.62));
      const grip=this.box(0.08,0.2,0.12, wood); grip.position.set(0,-0.17,-0.18); grip.rotation.x=-0.2; g.add(grip);
      g.add(this.at(this.box(0.04,0.1,0.05, dark), 0,0.15,0.2));
      g.add(this.at(this.cyl(0.035,0.035,0.08, dark,'x'), 0.08,0.24,0.4));
    } else if (type==='lmg') {
      g.add(this.box(0.15,0.21,1.34, metal));
      g.add(this.at(this.cyl(0.036,0.036,0.74, metal,'z'), 0,0.04,0.94));
      g.add(this.at(this.cyl(0.2,0.2,0.24, dark,'z'), 0,-0.26,0.06));
      g.add(this.at(this.box(0.13,0.26,0.52, dark), 0,-0.04,-0.74));
      const grip=this.box(0.11,0.24,0.14, dark); grip.position.set(0,-0.21,-0.2); grip.rotation.x=-0.2; g.add(grip);
      g.add(this.at(this.box(0.1,0.16,0.36, dark), 0,-0.02,0.42));
      g.add(this.at(this.box(0.05,0.14,0.06, dark), 0,0.2,0.22));
      g.add(this.at(this.box(0.02,0.32,0.02, dark), -0.07,-0.24,0.72));
      g.add(this.at(this.box(0.02,0.32,0.02, dark), 0.07,-0.24,0.72));
    } else if (type==='wonder') {
      const body=this.mat(0x0c0e12,0.45,0.6);
      const cyan=this.glow(0x35d6ff,1.9);
      g.add(this.box(0.13,0.21,1.22, body));
      g.add(this.at(this.box(0.17,0.1,0.54, body), 0,0.15,0.18));
      g.add(this.at(this.box(0.022,0.13,0.92, cyan), 0.066,0.0,0.04));
      g.add(this.at(this.box(0.022,0.13,0.92, cyan), -0.066,0.0,0.04));
      g.add(this.at(this.box(0.05,0.04,0.94, cyan), 0,0.21,0.12));
      g.add(this.at(this.box(0.03,0.17,0.52, body), 0,0.06,0.86));
      g.add(this.at(this.box(0.024,0.12,0.42, cyan), 0,0.06,0.92));
      const core=new THREE.Mesh(new THREE.SphereGeometry(0.085,16,16), this.glow(0x9beaff,2.6)); core.position.set(0,0.02,1.02); g.add(core);
      g.add(this.at(this.cyl(0.135,0.135,0.22, body,'z'), 0,-0.24,0.08));
      g.add(this.at(this.box(0.04,0.04,0.2, cyan), 0,-0.4,0.08));
      const grip=this.box(0.1,0.24,0.14, body); grip.position.set(0,-0.2,-0.16); grip.rotation.x=-0.18; g.add(grip);
      g.add(this.at(this.box(0.1,0.18,0.44, body), 0,-0.02,-0.62));
      g.userData.muzzle=new THREE.Vector3(0,0.02,1.1);
    } else if (type==='axe' || type==='hells') {
      const blk=this.mat(0x140a0a,0.45,0.65), red=this.glow(0xff2a14,1.9), ember=this.glow(0xff7a1e,1.5), bone=this.mat(0x2a1410,0.6,0);
      g.add(this.box(0.13,0.2,0.62, blk));                                  // frame
      g.add(this.at(this.cyl(0.052,0.052,0.4, blk,'z'), 0,0.04,0.42));      // barrel
      g.add(this.at(this.cyl(0.062,0.062,0.06, ember,'z'), 0,0.04,0.63));   // muzzle ember
      g.add(this.at(this.cyl(0.15,0.15,0.24, red,'z'), 0,-0.02,0.02));      // glowing cylinder
      g.add(this.at(this.cyl(0.155,0.155,0.05, blk,'z'), 0,-0.02,0.14));
      const grip=this.box(0.12,0.32,0.17, bone); grip.position.set(0,-0.26,-0.2); grip.rotation.x=-0.32; g.add(grip);
      g.add(this.at(this.box(0.06,0.13,0.09, blk), 0,0.13,-0.22));          // hammer
      [-1,1].forEach(s=>{ const horn=new THREE.Mesh(new THREE.ConeGeometry(0.045,0.2,5), red); horn.position.set(s*0.09,0.2,-0.2); horn.rotation.z=s*0.45; g.add(horn); });
      g.add(this.at(this.box(0.16,0.05,0.05, red), 0,-0.02,0.26));          // sigil bar
      g.userData.muzzle=new THREE.Vector3(0,0.04,0.66);
    } else {
      g.add(this.box(0.1,0.17,1.12, metal));
      g.add(this.at(this.cyl(0.03,0.03,0.62, metal,'z'), 0,0.03,0.72));
      const mag=this.box(0.1,0.36,0.15, dark); mag.position.set(0,-0.29,0.1); mag.rotation.x=0.16; g.add(mag);
      g.add(this.at(this.box(0.1,0.21,0.46, wood), 0,-0.02,-0.62));
      const grip=this.box(0.1,0.23,0.13, wood); grip.position.set(0,-0.19,-0.19); grip.rotation.x=-0.2; g.add(grip);
      g.add(this.at(this.box(0.04,0.11,0.05, dark), 0,0.17,0.22));
    }
    if (pap) {
      // Pack-a-Punch upgrade: dark camo body + cyan racing accents (glowing parts kept)
      g.traverse(o => { if (o.isMesh) { const m=o.material; const isGlow=m && m.emissive && m.emissive.getHex && m.emissive.getHex()!==0; if (!isGlow) o.material=this.mat(0x16120f,0.42,0.7); } });
      const acc=this.glow(0x35d6ff,1.8);
      g.add(this.at(this.box(0.02,0.05,0.78, acc), 0.073,0.05,0.06));
      g.add(this.at(this.box(0.02,0.05,0.78, acc), -0.073,0.05,0.06));
      g.add(this.at(this.box(0.05,0.02,0.6, acc), 0,0.12,0.0));
    }
    return g;
  }
  makeArms(type, pap) {
    const g=new THREE.Group();
    const sleeve=this.mat(0x2f3a2a,0.9,0);
    const glove=this.mat(0x1c130c,0.85,0);
    const r=this.ARM_RIG[type] || this.ARM_RIG.smg;
    const weapon=this.makeWeapon(type, pap); weapon.scale.setScalar(r.ws); weapon.position.set(r.wp[0],r.wp[1],r.wp[2]); weapon.rotation.set(r.wr[0],r.wr[1],r.wr[2]); g.add(weapon);
    g.add(this.buildArm(sleeve, glove, r.rh, r.rr, 0.62));
    g.add(this.buildArm(sleeve, glove, r.lh, r.lr, 0.60));
    this.shadow(g);
    g.userData.weapon=weapon;
    return g;
  }
  get ARM_RIG() {
    return {
      // wp/wr = weapon pos/rot, ws = scale; rh/rr = right hand, lh/lr = left hand (camera space).
      // Hand rotation X is POSITIVE so the forearm recedes down-and-back toward the player.
      pistol:  { ws:0.70, wp:[0.12,-0.34,-0.66], wr:[0.05,Math.PI,0], rh:[0.13,-0.45,-0.48], rr:[0.7,0.15,0.05],  lh:[0.00,-0.49,-0.54], lr:[0.85,-0.2,0.1] },
      smg:     { ws:0.62, wp:[0.15,-0.32,-0.82], wr:[0.05,Math.PI,0], rh:[0.17,-0.45,-0.56], rr:[0.68,0.18,0.05], lh:[0.03,-0.42,-1.00], lr:[1.0,-0.28,0] },
      shotgun: { ws:0.62, wp:[0.14,-0.33,-0.90], wr:[0.05,Math.PI,0], rh:[0.16,-0.46,-0.56], rr:[0.68,0.18,0.05], lh:[0.04,-0.43,-1.14], lr:[1.02,-0.3,0] },
      rifle:   { ws:0.60, wp:[0.14,-0.33,-0.94], wr:[0.05,Math.PI,0], rh:[0.16,-0.47,-0.58], rr:[0.7,0.18,0.05],  lh:[0.02,-0.42,-1.18], lr:[1.04,-0.26,0] },
      sniper:  { ws:0.58, wp:[0.13,-0.34,-1.00], wr:[0.05,Math.PI,0], rh:[0.15,-0.48,-0.62], rr:[0.7,0.18,0.05],  lh:[0.01,-0.43,-1.26], lr:[1.06,-0.24,0] },
      ak:      { ws:0.60, wp:[0.14,-0.33,-0.92], wr:[0.05,Math.PI,0], rh:[0.16,-0.47,-0.56], rr:[0.7,0.18,0.05],  lh:[0.02,-0.42,-1.16], lr:[1.04,-0.26,0] },
      lmg:     { ws:0.56, wp:[0.15,-0.34,-1.00], wr:[0.05,Math.PI,0], rh:[0.17,-0.48,-0.60], rr:[0.7,0.18,0.05],  lh:[0.03,-0.44,-1.26], lr:[1.04,-0.26,0] },
      wonder:  { ws:0.58, wp:[0.14,-0.32,-0.98], wr:[0.05,Math.PI,0], rh:[0.16,-0.47,-0.60], rr:[0.7,0.18,0.05],  lh:[0.02,-0.42,-1.22], lr:[1.04,-0.24,0] },
      axe:     { ws:0.74, wp:[0.13,-0.30,-0.62], wr:[0.05,Math.PI,0], rh:[0.13,-0.44,-0.46], rr:[0.72,0.12,0.05], lh:[0.02,-0.50,-0.52], lr:[0.82,-0.16,0.1] },
      hells:   { ws:0.74, wp:[0.13,-0.30,-0.62], wr:[0.05,Math.PI,0], rh:[0.13,-0.44,-0.46], rr:[0.72,0.12,0.05], lh:[0.02,-0.50,-0.52], lr:[0.82,-0.16,0.1] }
    };
  }
  buildArm(sleeve, glove, pos, rot, len) {
    const a=new THREE.Group(); a.position.set(pos[0],pos[1],pos[2]); a.rotation.set(rot[0],rot[1],rot[2]);
    a.add(this.at(this.box(0.125,0.13,len, sleeve), 0,0,len*0.5+0.05));   // forearm recedes toward camera
    a.add(this.at(this.box(0.115,0.12,0.15, glove), 0,-0.01,-0.03));        // gloved hand on the grip
    return a;
  }

  /* ---------- scenes ---------- */
  aspect() { const el=this.mountEl; return el ? el.clientWidth/Math.max(1,el.clientHeight) : 1.6; }

  galleryModelFor(id) {
    if (id==='zombie') return { m:this.makeZombie(), y:0.8 };
    if (id==='crate') return { m:this.makeCrate(), y:0.8 };
    if (id==='window') { const m=this.makeWindow(); m.scale.setScalar(0.82); return { m, y:0.8 }; }
    if (id==='wallbuy') { const m=this.makeWallBuy(); m.scale.setScalar(0.78); return { m, y:0.8 }; }
    if (id==='power') { const m=this.makePowerMachine(); m.scale.setScalar(0.6); return { m, y:0.8 }; }
    if (id==='pingas') { const m=this.makePingasMachine(); m.scale.setScalar(0.55); return { m, y:0.8 }; }
    if (id==='pickups') { const m=this.makePickups(); m.scale.setScalar(1.25); return { m, y:0.86 }; }
    if (id==='crawler') { const m=this.makeCrawler(); m.scale.setScalar(1.15); return { m, y:0.82 }; }
    if (id==='boss') { const m=this.makeBoss(); m.scale.setScalar(0.46); return { m, y:0.8 }; }
    if (id==='grenade') { const m=this.makeGrenade(); m.scale.setScalar(1.5); return { m, y:0.9, hover:true }; }
    if (id==='explosion') { const m=this.makeExplosion(); m.scale.setScalar(0.7); return { m, y:1.4 }; }
    if (id==='skull') { const m=this.makeSkullDrop(); m.scale.setScalar(1.4); return { m, y:1.2, hover:true }; }
    if (id==='chips') { const m=this.makePingasChips(); m.scale.setScalar(1.2); return { m, y:0.86 }; }
    if (id==='doubleshot') { const m=this.makePerkMachine(['DOUBLE','SHOT'],0x9c2b2b,0x35d6ff); m.scale.setScalar(0.58); return { m, y:0.8 }; }
    if (id==='rootbeer') { const m=this.makePerkMachine(['MUG ROOTBEER','METH'],0x6a3b1a,0xffa23a); m.scale.setScalar(0.58); return { m, y:0.8 }; }
    if (id==='pingasliquid') { const m=this.makePerkMachine(['PINGAS','LIQUID'],0x4a2a66,0xff48c0); m.scale.setScalar(0.58); return { m, y:0.8 }; }
    if (id==='axe') { const m=this.makeWeapon('axe'); m.scale.setScalar(1.7); return { m, y:1.75, hover:true, spin:true }; }
    if (id==='hells') { const m=this.makeWeapon('axe'); m.scale.setScalar(1.7); return { m, y:1.75, hover:true, spin:true }; }
    if (id==='werewolf') { const m=this.makeWerewolf(); m.scale.setScalar(0.5); return { m, y:1.4 }; }
    if (id==='egg') { const m=this.makeRoyalEgg(); m.scale.setScalar(0.62); return { m, y:0.8 }; }
    if (id==='megaboss') { const m=this.makeMegaBoss(); m.scale.setScalar(0.42); return { m, y:0.8 }; }
    if (id==='building') { const m=this.makeTowerModel(); m.scale.setScalar(0.26); return { m, y:0.8 }; }
    const m=this.makeWeapon(id); m.scale.setScalar(1.55); return { m, y:1.75, hover:true, spin:true };
  }
  /* ---------- environment ---------- */
  makeTree() {
    const g=new THREE.Group();
    const trunk=this.cyl(0.11,0.2,1.2, this.mat(0x352719,0.96,0)); trunk.position.y=0.6; g.add(trunk);
    const fol=this.mat(0x1b3325,0.96,0);
    for (let i=0;i<3;i++) { const c=new THREE.Mesh(new THREE.ConeGeometry(0.95-i*0.22,1.05,7), fol); c.position.y=1.15+i*0.5; g.add(c); }
    return g;
  }
  addForest(scene, count, rIn, rOut) {
    for (let i=0;i<count;i++) {
      const a=Math.random()*Math.PI*2, rr=rIn+Math.random()*(rOut-rIn);
      const t=this.makeTree(); const s=0.8+Math.random()*1.6;
      t.scale.setScalar(s); t.position.set(Math.cos(a)*rr, 0, Math.sin(a)*rr); t.rotation.y=Math.random()*Math.PI;
      scene.add(t);
      if (i%8===0 && rr<rOut*0.8) { const h=this.makeHedgehog(); h.scale.setScalar(0.7); h.position.set(t.position.x+0.55, 1.5*s, t.position.z+0.2); scene.add(h); }
    }
  }
  makeSky() {
    const c=document.createElement('canvas'); c.width=16; c.height=256;
    const x=c.getContext('2d'); const grd=x.createLinearGradient(0,0,0,256);
    grd.addColorStop(0,'#04060c'); grd.addColorStop(0.5,'#0a1322'); grd.addColorStop(0.78,'#16243a'); grd.addColorStop(1,'#243650');
    x.fillStyle=grd; x.fillRect(0,0,16,256);
    const tex=new THREE.CanvasTexture(c);
    return new THREE.Mesh(new THREE.SphereGeometry(240,24,16), new THREE.MeshBasicMaterial({ map:tex, side:THREE.BackSide, fog:false }));
  }
  addWorld(scene, opts) {
    opts=opts||{};
    scene.add(this.makeSky());
    scene.add(new THREE.AmbientLight(0x172230,0.7));
    const moon=new THREE.DirectionalLight(this.accentHex,0.85); moon.position.set(-32,42,-22); moon.castShadow=true;
    moon.shadow.mapSize.set(2048,2048); Object.assign(moon.shadow.camera,{left:-34,right:34,top:34,bottom:-34,far:130}); scene.add(moon);
    scene.add(this.at(new THREE.Mesh(new THREE.SphereGeometry(3.2,24,24), this.glow(0xd2e2ff,1.6)), 999,999,999));
    const am=this.makeAngryMoon(); am.scale.setScalar(9); am.position.set(-10,40,-78); am.rotation.y=0.12; scene.add(am);
    const redLight=new THREE.DirectionalLight(0x5a6a86,0.18); redLight.position.set(-10,40,-78); scene.add(redLight);
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(280,280), this.mat(0x16210f,0.99,0)); ground.rotation.x=-Math.PI/2; ground.receiveShadow=true; scene.add(ground);
    this.addForest(scene, opts.trees||100, opts.rIn||28, opts.rOut||95);
    return moon;
  }
  makePowerMachine() {
    const g=new THREE.Group();
    const metal=this.mat(0x2c3138,0.7,0.5), dark=this.mat(0x14171a,0.85,0.3);
    g.add(this.at(this.box(1.3,2.0,0.85,metal),0,1.0,0));
    g.add(this.at(this.box(1.38,0.52,0.9,dark),0,1.46,0));
    const gauges=[];
    [-0.32,0.32].forEach(x=>{ const m=new THREE.Mesh(new THREE.CircleGeometry(0.15,18), this.glow(0x74e69a,1.3)); m.position.set(x,1.46,0.46); g.add(m); gauges.push(m); });
    const lever=new THREE.Group(); lever.position.set(0,0.85,0.48);
    lever.add(this.at(this.box(0.07,0.55,0.07,this.mat(0x9c3a30,0.6,0.3)),0,0.27,0));
    lever.add(this.at(this.box(0.16,0.16,0.16,this.mat(0xb84a3c,0.5,0.3)),0,0.55,0));
    lever.rotation.x=0.55; g.add(lever);
    const tex=this.label('POWER','#cfeede');
    const lab=new THREE.Mesh(new THREE.PlaneGeometry(1.0,0.36), new THREE.MeshBasicMaterial({ map:tex, transparent:true }));
    lab.position.set(0,2.18,0.0); g.add(lab);
    const pl=new THREE.PointLight(0x74e69a,0.0,4); pl.position.set(0,1.5,0.6); g.add(pl);
    g.userData.update=(t)=>{ const f=0.9+Math.sin(t*3)*0.4; gauges.forEach(m=>m.material.emissiveIntensity=f); pl.intensity=0.5+Math.sin(t*3)*0.4; };
    return g;
  }
  makePingasMachine() {
    const g=new THREE.Group();
    const body=this.mat(0x3a2150,0.55,0.3), housing=this.mat(0x190f24,0.7,0.2);
    g.add(this.at(this.box(1.25,2.2,0.95,body),0,1.1,0));
    g.add(this.at(this.box(1.32,0.74,1.02,housing),0,1.72,0));
    const tex=this.labelLines(['PACK·A','PINGAS'],'#7df0ff');
    const screen=new THREE.Mesh(new THREE.PlaneGeometry(1.02,0.58), new THREE.MeshBasicMaterial({ map:tex, transparent:true }));
    screen.position.set(0,1.72,0.52); g.add(screen);
    const slot=new THREE.Mesh(this.box(0.72,0.2,0.06,this.glow(this.accentHex,1.7)).geometry, this.glow(this.accentHex,1.7)); slot.position.set(0,0.74,0.49); g.add(slot);
    const trims=[];
    [-0.64,0.64].forEach(x=>{ const tm=this.box(0.06,2.0,0.06,this.glow(0xff48c0,1.3)); tm.position.set(x,1.1,0.49); g.add(tm); trims.push(tm); });
    const pl=new THREE.PointLight(0xff48c0,0.6,5); pl.position.set(0,1.4,0.8); g.add(pl);
    g.userData.update=(t)=>{ const f=1.1+Math.sin(t*4)*0.5; trims.forEach(m=>m.material.emissiveIntensity=f); slot.material.emissiveIntensity=1.3+Math.sin(t*5)*0.6; pl.intensity=0.5+Math.sin(t*4)*0.4; };
    return g;
  }
  labelLines(lines, fg) {
    const c=document.createElement('canvas'); c.width=256; c.height=128;
    const x=c.getContext('2d'); x.clearRect(0,0,256,128);
    x.fillStyle=fg||'#7df0ff'; x.font='700 52px Oswald, sans-serif'; x.textAlign='center'; x.textBaseline='middle';
    lines.forEach((ln,i)=> x.fillText(ln, 128, 38+i*52));
    const t=new THREE.CanvasTexture(c); t.anisotropy=4; return t;
  }

  makeCrawler() {
    const g=new THREE.Group();
    const skin=this.mat(0x6f7d5c,0.98,0), cloth=this.mat(0x23261f,0.95,0);
    const torso=this.box(0.5,0.3,0.72, cloth); torso.position.set(0,0.28,0); torso.rotation.x=-0.12; g.add(torso);
    const head=this.box(0.28,0.28,0.28, skin); head.position.set(0,0.36,0.44); g.add(head);
    const eye=this.glow(0xffd23a,1.6); [-0.06,0.06].forEach(x=> head.add(this.at(this.box(0.05,0.05,0.02,eye),x,0.02,0.15)));
    const armL=this.limb(skin,cloth); armL.position.set(-0.26,0.34,0.32); armL.rotation.set(-1.7,0,0.2); g.add(armL);
    const armR=this.limb(skin,cloth); armR.position.set(0.26,0.34,0.32); armR.rotation.set(-1.6,0,-0.2); g.add(armR);
    g.add(this.at(this.box(0.18,0.16,0.3, this.mat(0x3a1c18,0.9,0)), -0.12,0.18,-0.3));
    g.add(this.at(this.box(0.18,0.16,0.26, this.mat(0x3a1c18,0.9,0)), 0.12,0.18,-0.34));
    g.userData.update=(t)=>{ g.position.y=Math.abs(Math.sin(t*5))*0.03; armL.rotation.z=0.2+Math.sin(t*4)*0.22; armR.rotation.z=-0.2-Math.sin(t*4+1)*0.22; head.rotation.z=Math.sin(t*3)*0.1; };
    return g;
  }
  makeBoss() {
    const g=new THREE.Group();
    const skin=this.mat(0xf0c9a0,0.8,0), coat=this.mat(0x8e2018,0.7,0), yellow=this.mat(0xe0a52a,0.7,0),
          black=this.mat(0x0e0e12,0.7,0), white=this.mat(0xededed,0.6,0), brown=this.mat(0x5a3a1e,0.9,0);
    [-0.34,0.34].forEach(x=>{ g.add(this.at(this.box(0.34,1.1,0.4,black),x,0.55,0)); g.add(this.at(this.box(0.5,0.22,0.72,black),x,0.07,0.14)); });
    g.add(this.at(this.box(1.0,1.0,0.6,coat),0,1.55,0));
    g.add(this.at(this.box(0.42,0.92,0.05,yellow),0,1.55,0.31));
    g.add(this.at(this.box(0.12,0.5,0.06,yellow),0,1.45,0.34));
    [-1,1].forEach(s=>{ const up=this.box(0.34,0.72,0.42,coat); up.position.set(s*0.62,1.6,0); up.rotation.z=s*0.5; g.add(up);
      g.add(this.at(this.box(0.3,0.2,0.42,yellow), s*0.5,1.2,0.05));
      g.add(this.at(this.box(0.3,0.3,0.34,white), s*0.42,1.12,0.13)); });
    g.add(this.at(this.box(0.5,0.2,0.5,coat),0,2.06,0));
    const head=this.box(0.6,0.6,0.6,skin); head.position.set(0,2.5,0); g.add(head);
    g.add(this.at(this.box(0.5,0.26,0.5,skin),0,2.78,0));
    const glass=this.glow(0x6aa0ff,0.6); [-0.13,0.13].forEach(x=> g.add(this.at(new THREE.Mesh(new THREE.CircleGeometry(0.09,16),glass),x,2.54,0.31)));
    [-1,1].forEach(s=>{ const m=this.box(0.36,0.18,0.2,brown); m.position.set(s*0.2,2.34,0.3); m.rotation.z=s*-0.3; g.add(m);
      g.add(this.at(this.box(0.16,0.32,0.18,brown), s*0.34,2.2,0.28)); });
    g.add(this.at(this.box(0.12,0.12,0.14,this.mat(0xc0392b,0.7,0)),0,2.42,0.34));
    g.userData.update=(t)=>{ g.rotation.y=Math.sin(t*0.6)*0.12; head.rotation.z=Math.sin(t*1.4)*0.04; };
    return g;
  }
  makeGrenade() {
    const g=new THREE.Group();
    const body=new THREE.Mesh(new THREE.SphereGeometry(0.22,16,16), this.mat(0x2c3a2a,0.8,0.2)); body.scale.y=1.2; body.position.y=0.26; g.add(body);
    g.add(this.at(this.cyl(0.085,0.085,0.12, this.mat(0x44443a,0.6,0.5)),0,0.52,0));
    g.add(this.at(this.box(0.04,0.18,0.06, this.mat(0x9a9a8a,0.5,0.6)),0.1,0.5,0));
    g.add(this.at(new THREE.Mesh(new THREE.TorusGeometry(0.05,0.016,8,16), this.mat(0xc0a040,0.5,0.6)),0.17,0.54,0));
    return g;
  }
  makeExplosion() {
    const g=new THREE.Group();
    const core=new THREE.Mesh(new THREE.SphereGeometry(0.5,18,18), this.glow(0xffb838,2.4)); g.add(core);
    const ring=new THREE.Mesh(new THREE.SphereGeometry(0.7,18,18), this.glow(0xff5a1e,1.6)); g.add(ring);
    const shards=[];
    for (let i=0;i<10;i++){ const s=this.box(0.08,0.08,0.18, this.mat(0x201d16,0.9,0)); const a=Math.random()*Math.PI*2, e=Math.random()*Math.PI; s.userData.dir=new THREE.Vector3(Math.sin(e)*Math.cos(a),Math.abs(Math.cos(e))+0.2,Math.sin(e)*Math.sin(a)); g.add(s); shards.push(s); }
    const pl=new THREE.PointLight(0xff7a2a,0,6); g.add(pl);
    g.userData.update=(t)=>{ const p=(t%2.2)/2.2; const sc=0.4+p*2.4; core.scale.setScalar(sc*0.7); ring.scale.setScalar(sc); core.material.emissiveIntensity=2.4*(1-p); ring.material.emissiveIntensity=1.6*(1-p); core.visible=ring.visible=p<0.96; pl.intensity=4*(1-p)*(p<0.96?1:0);
      shards.forEach(s=>{ s.position.copy(s.userData.dir).multiplyScalar(p*2.4); s.scale.setScalar(Math.max(0.01,1-p)); }); };
    return g;
  }
  makeSkullDrop() {
    const g=new THREE.Group(); const bone=this.mat(0xeae4d2,0.7,0);
    const skull=new THREE.Mesh(new THREE.SphereGeometry(0.3,16,16), bone); skull.scale.set(1,1.05,0.95); skull.position.y=0.05; g.add(skull);
    g.add(this.at(this.box(0.34,0.2,0.22,bone),0,-0.2,0.05));
    const eye=this.glow(0xff2a2a,1.9); [-0.12,0.12].forEach(x=> g.add(this.at(new THREE.Mesh(new THREE.SphereGeometry(0.07,12,12),eye),x,0.07,0.25)));
    g.add(this.at(this.box(0.05,0.1,0.08,this.mat(0x161616,0.8,0)),0,-0.03,0.29));
    const base=new THREE.Mesh(new THREE.CircleGeometry(0.42,22), this.glow(0xff2a2a,0.6)); base.rotation.x=-Math.PI/2; base.position.y=-0.5; g.add(base);
    g.userData.update=(t)=>{ g.rotation.y=t*1.2; };
    return g;
  }
  chipLabel(label, bodyHex) {
    const c=document.createElement('canvas'); c.width=256; c.height=128; const x=c.getContext('2d');
    x.fillStyle=bodyHex||'#c0392b'; x.fillRect(0,0,256,128);
    x.strokeStyle='#e07b1e'; x.lineWidth=11; x.lineCap='round';
    x.beginPath(); x.moveTo(128,58); x.quadraticCurveTo(86,70,62,56); x.moveTo(128,58); x.quadraticCurveTo(170,70,194,56); x.stroke();
    x.fillStyle='#ffffff'; x.beginPath(); x.arc(116,50,7,0,7); x.arc(140,50,7,0,7); x.fill();
    x.fillStyle='#e84393'; x.beginPath(); x.ellipse(128,72,15,9,0,0,7); x.fill();
    x.fillStyle='#f4d35e'; x.font='700 34px Oswald, sans-serif'; x.textAlign='center'; x.fillText(label||'PINGAS',128,108);
    return new THREE.CanvasTexture(c);
  }
  makePingasChips() {
    const g=new THREE.Group();
    const can=new THREE.Mesh(new THREE.CylinderGeometry(0.26,0.26,0.9,24), this.mat(0xc0392b,0.5,0.1)); can.position.y=0.45; g.add(can);
    g.add(this.at(new THREE.Mesh(new THREE.CylinderGeometry(0.275,0.275,0.12,24), this.mat(0xcfcfcf,0.4,0.6)),0,0.94,0));
    const band=new THREE.Mesh(new THREE.CylinderGeometry(0.262,0.262,0.62,24,1,true), new THREE.MeshBasicMaterial({ map:this.chipLabel('PINGAS','#c0392b'), transparent:true })); band.position.y=0.44; g.add(band);
    g.userData.update=(t)=>{ g.rotation.y=t*0.8; };
    return g;
  }
  makeHedgehog() {
    const g=new THREE.Group(); const blue=this.mat(0x2a6fd6,0.7,0);
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.3,16,16), blue));
    for (let i=0;i<7;i++){ const s=new THREE.Mesh(new THREE.ConeGeometry(0.09,0.36,6), blue); const a=(i/6)*Math.PI - Math.PI/2; s.position.set(0,Math.sin(a)*0.22-0.04,Math.cos(a)*-0.22); s.rotation.x=-1.0+a*0.2; g.add(s); }
    g.add(this.at(new THREE.Mesh(new THREE.SphereGeometry(0.2,16,16), this.mat(0xe8c79a,0.7,0)),0,-0.04,0.2));
    [-0.08,0.08].forEach(x=> g.add(this.at(this.box(0.07,0.13,0.04,this.mat(0xffffff,0.5,0)),x,0.06,0.34)));
    [-0.1,0.1].forEach(x=> g.add(this.at(this.box(0.17,0.1,0.24,this.mat(0xc0392b,0.6,0)),x,-0.3,0.12)));
    g.userData.update=(t)=>{ g.rotation.z=Math.sin(t*1.5)*0.22; };
    return g;
  }
  makeAngryMoon() {
    const g=new THREE.Group();
    const tex=new THREE.TextureLoader().load((window.__resources && window.__resources.moonImg) || 'assets/moon.png');
    if ('sRGBEncoding' in THREE) tex.encoding=THREE.sRGBEncoding;
    const mat=new THREE.MeshBasicMaterial({ map:tex, transparent:true, fog:false, depthWrite:false, side:THREE.DoubleSide });
    const plane=new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4*(204/220)), mat);
    g.add(plane);
    return g;
  }
  makePerkMachine(title, bodyHex, trimHex) {
    const g=new THREE.Group();
    const body=this.mat(bodyHex,0.55,0.2), housing=this.mat(0x14110f,0.7,0.2);
    g.add(this.at(this.box(1.1,2.1,0.85,body),0,1.05,0));
    g.add(this.at(this.box(1.16,0.6,0.92,housing),0,1.62,0));
    const screen=new THREE.Mesh(new THREE.PlaneGeometry(0.94,0.5), new THREE.MeshBasicMaterial({ map:this.labelLines(title, '#ffffff'), transparent:true })); screen.position.set(0,1.62,0.47); g.add(screen);
    const trims=[]; [-0.56,0.56].forEach(x=>{ const tm=this.box(0.06,2.0,0.06,this.glow(trimHex,1.3)); tm.position.set(x,1.05,0.45); g.add(tm); trims.push(tm); });
    const slot=this.box(0.6,0.16,0.05,this.glow(trimHex,1.4)); slot.position.set(0,0.66,0.44); g.add(slot);
    const pl=new THREE.PointLight(trimHex,0.5,5); pl.position.set(0,1.4,0.9); g.add(pl);
    g.userData.update=(t)=>{ const f=1.0+Math.sin(t*3)*0.4; trims.forEach(m=>m.material.emissiveIntensity=f); slot.material.emissiveIntensity=1.1+Math.sin(t*5)*0.5; pl.intensity=0.4+Math.sin(t*3)*0.3; };
    return g;
  }

  makeSpawnPoint(kind) {
    const g=new THREE.Group();
    const moundMat=this.mat(0x241c10,0.99,0), darkMat=this.mat(0x0a0805,1,0);
    // dirt mound ring + dark hole
    for (let i=0;i<9;i++){ const a=i/9*Math.PI*2; const c=new THREE.Mesh(new THREE.ConeGeometry(0.34,0.5,5), moundMat); c.position.set(Math.cos(a)*0.78,0.18,Math.sin(a)*0.78); c.rotation.y=a; c.receiveShadow=true; g.add(c); }
    const hole=new THREE.Mesh(new THREE.CircleGeometry(0.66,18), darkMat); hole.rotation.x=-Math.PI/2; hole.position.y=0.04; g.add(hole);
    // rising zombie in a vertical riser group (its own update animates limbs)
    const riser=new THREE.Group(); const z=(kind==='c')?this.makeCrawler():this.makeZombie(); z.scale.setScalar(0.95); riser.add(z); g.add(riser);
    const zu=z.userData.update;
    // dirt burst particles
    const parts=[]; for (let i=0;i<9;i++){ const p=this.box(0.12,0.12,0.12,moundMat); p.visible=false; g.add(p); parts.push(p); }
    g.userData.update=(t)=>{
      const ph=(t%2.5)/2.5; let y=0, burst=0;
      if (ph<0.08){ const k=ph/0.08; y=-2.4+k*2.4; burst=Math.sin(k*Math.PI); }
      else if (ph>0.88){ const k=(ph-0.88)/0.12; y=-k*2.4; }
      riser.position.y=y;
      parts.forEach((p,i)=>{ if (burst>0.04){ const a=i/9*Math.PI*2; const r=0.18+burst*1.6; p.visible=true; p.position.set(Math.cos(a)*r,0.14+burst*1.5,Math.sin(a)*r); p.scale.setScalar(burst*0.9); } else p.visible=false; });
      if (zu) zu(t);
    };
    return g;
  }

  pingasTex() {
    if (!this._pt) { this._pt=new THREE.TextureLoader().load((window.__resources && window.__resources.pingasImg) || 'assets/pingasface.png'); if ('sRGBEncoding' in THREE) this._pt.encoding=THREE.sRGBEncoding; }
    return this._pt;
  }
  makeWerewolf() {
    const g=new THREE.Group();
    const fur=this.mat(0x3a3026,0.95,0), furDark=this.mat(0x241d16,0.95,0), white=this.mat(0xeeeeee,0.4,0);
    // wall plaque
    g.add(this.at(this.box(3.4,3.4,0.3,this.mat(0x241a12,0.92,0)),0,0,-0.25));
    g.add(this.at(this.box(3.7,0.18,0.42,this.mat(0x3a2a1b,0.9,0)),0,1.7,-0.1));
    g.add(this.at(this.box(3.7,0.18,0.42,this.mat(0x3a2a1b,0.9,0)),0,-1.7,-0.1));
    // lunging body + gripping arms
    g.add(this.at(this.box(1.8,1.5,1.1,fur),0,-0.4,0.45));
    [-1,1].forEach(s=>{ const arm=this.box(0.42,1.3,0.42,fur); arm.position.set(s*1.05,-0.55,0.55); arm.rotation.z=s*0.32; g.add(arm); g.add(this.at(this.box(0.5,0.32,0.55,furDark),s*1.32,-1.15,0.78)); });
    // head/face group (swapped out when full)
    const face=new THREE.Group(); face.position.set(0,0.7,0.65); g.add(face);
    face.add(this.box(1.2,1.05,1.0,fur));
    [-1,1].forEach(s=>{ const ear=new THREE.Mesh(new THREE.ConeGeometry(0.3,0.62,5),fur); ear.position.set(s*0.46,0.74,-0.1); ear.rotation.z=s*0.22; face.add(ear); });
    const snout=this.box(0.74,0.52,0.82,furDark); snout.position.set(0,-0.12,0.72); face.add(snout);
    face.add(this.at(new THREE.Mesh(new THREE.SphereGeometry(0.15,12,12),this.mat(0x0a0a0a,0.5,0)),0,0.02,1.18));
    const eyeMat=this.glow(0xffd23a,1.9);
    [-0.3,0.3].forEach(x=> face.add(this.at(new THREE.Mesh(new THREE.SphereGeometry(0.13,12,12),eyeMat),x,0.24,0.56)));
    // upper teeth
    for(let i=0;i<5;i++){ const tx=-0.26+i*0.13; face.add(this.at(this.box(0.07,0.16,0.07,white),tx,-0.2,0.96)); }
    // animated lower jaw
    const jaw=new THREE.Group(); jaw.position.set(0,-0.34,0.5); face.add(jaw);
    jaw.add(this.at(this.box(0.7,0.22,0.74,furDark),0,0,0.28));
    for(let i=0;i<5;i++){ const tx=-0.26+i*0.13; jaw.add(this.at(this.box(0.07,0.16,0.07,white),tx,0.12,0.54)); }
    jaw.add(this.at(new THREE.Mesh(new THREE.SphereGeometry(0.18,10,10),this.mat(0xc0392b,0.6,0)),0,0.08,0.4));
    // pingas full-face (hidden until full)
    const pin=new THREE.Mesh(new THREE.PlaneGeometry(2.1,2.1*(394/507)), new THREE.MeshBasicMaterial({ map:this.pingasTex(), transparent:true })); pin.position.set(0,0.55,1.05); pin.visible=false; g.add(pin);
    // victim zombie for eat anim
    const victim=this.makeZombie(); victim.scale.setScalar(0.5); victim.visible=false; g.add(victim); const vu=victim.userData.update;
    // fed counter label
    let shown=''; const cmat=new THREE.MeshBasicMaterial({ transparent:true });
    const cplane=new THREE.Mesh(new THREE.PlaneGeometry(1.7,0.42), cmat); cplane.position.set(0,-2.0,0.6); g.add(cplane);
    const setLabel=(n,max,txt)=>{ const key=txt||(n+'/'+max); if (key===shown) return; shown=key;
      cmat.map=this.label(txt||(n>=max?'FULL':('FED '+n+'/'+max)), n>=max?'#ff8a3a':'#cfe0ff'); cmat.needsUpdate=true; };
    // ── GAMEPLAY API: feed externally; swaps to the Pingas face when full ──
    let lastT=0, eatStart=-9;
    g.userData.fed=0; g.userData.max=20; g.userData.full=false; g.userData.upgraded=false;
    g.userData.feed=(n)=>{ g.userData.fed=Math.min(g.userData.max, (n==null? g.userData.fed+1 : n));
      eatStart=lastT; setLabel(g.userData.fed,g.userData.max);
      if(g.userData.fed>=g.userData.max) g.userData.full=true; };
    g.userData.setLabel=(txt)=>setLabel(0,g.userData.max,txt);
    g.userData.update=(t)=>{ lastT=t;
      if(g.userData.full){ face.visible=false; pin.visible=true; victim.visible=false; g.rotation.z=Math.sin(t*2)*0.04;
        setLabel(g.userData.max,g.userData.max, g.userData.upgraded?'UPGRADED':'READY — HOLD F'); return; }
      face.visible=true; pin.visible=false; g.rotation.z=0;
      jaw.rotation.x=Math.max(0,Math.sin(t*7))*0.35;            // idle chomp
      face.position.y=0.7+Math.sin(t*3)*0.04;
      const e=t-eatStart;                                       // brief eat anim after each feed
      if(e>=0 && e<0.7){ victim.visible=true; const k=e/0.7; victim.position.set(0,-0.1,3.0-k*2.4); victim.scale.setScalar(0.5*(1-k*0.6)); if(vu)vu(t); jaw.rotation.x=0.6; }
      else victim.visible=false;
    };
    setLabel(0,20);
    return g;
  }
  makeMegaBoss() {
    const g=new THREE.Group();
    const robe=this.mat(0x3a1a4a,0.75,0), robe2=this.mat(0x2a1238,0.8,0), flesh=this.mat(0xf0c9a0,0.8,0);
    g.add(this.at(new THREE.Mesh(new THREE.CylinderGeometry(1.2,2.0,3.2,14),robe),0,1.6,0));
    g.add(this.at(new THREE.Mesh(new THREE.CylinderGeometry(1.25,1.3,0.5,14),robe2),0,3.1,0));
    g.add(this.at(this.box(2.9,0.8,1.3,robe),0,3.2,0));
    [-1,1].forEach(s=>{ const arm=new THREE.Mesh(new THREE.CylinderGeometry(0.38,0.5,2.4,10),robe); arm.position.set(s*1.6,2.3,0.3); arm.rotation.z=s*0.32; g.add(arm); g.add(this.at(new THREE.Mesh(new THREE.SphereGeometry(0.55,14,14),flesh),s*2.05,1.2,0.5)); });
    g.add(this.at(this.box(0.8,0.55,0.8,flesh),0,3.7,0));
    // pingas billboard face + solid backing
    g.add(this.at(new THREE.Mesh(new THREE.SphereGeometry(1.5,18,18),flesh),0,4.85,-0.35));
    const face=new THREE.Mesh(new THREE.PlaneGeometry(3.8,3.8*(394/507)), new THREE.MeshBasicMaterial({ map:this.pingasTex(), transparent:true })); face.position.set(0,4.95,0.7); g.add(face);
    g.userData.face=face;
    g.userData.update=(t)=>{ g.rotation.y=Math.sin(t*0.35)*0.1; face.position.y=4.85+Math.sin(t*1.1)*0.06; };
    return g; // ~6 units tall; scale up at placement for 10x player
  }
  // ── procedural face billboard (self-contained; real PNGs swap in during the audio/faces pass) ──
  faceTex(kind){
    const key='_ft_'+kind; if(this[key]) return this[key];
    const c=document.createElement('canvas'); c.width=128; c.height=128; const x=c.getContext('2d');
    if(kind==='monkey'){
      x.fillStyle='#5a3b22'; x.fillRect(0,0,128,128);
      x.fillStyle='#caa172'; x.beginPath(); x.ellipse(64,76,40,40,0,0,7); x.fill();         // muzzle
      x.fillStyle='#3a2516'; [44,84].forEach(ex=>{ x.beginPath(); x.arc(ex,52,12,0,7); x.fill(); });
      x.fillStyle='#fff'; [44,84].forEach(ex=>{ x.beginPath(); x.arc(ex,52,6,0,7); x.fill(); });
      x.fillStyle='#111'; [44,84].forEach(ex=>{ x.beginPath(); x.arc(ex,53,3,0,7); x.fill(); });
      x.fillStyle='#2a1a10'; [56,72].forEach(nx=>{ x.beginPath(); x.ellipse(nx,80,4,6,0,0,7); x.fill(); });
      x.strokeStyle='#2a1a10'; x.lineWidth=4; x.beginPath(); x.arc(64,92,16,0.15*Math.PI,0.85*Math.PI); x.stroke();
    } else { // villager
      x.fillStyle='#6f8a55'; x.fillRect(0,0,128,128);
      x.fillStyle='#5b7346'; x.fillRect(36,86,56,42);                                        // robe collar
      x.fillStyle='#7a9560'; x.fillRect(54,40,20,58);                                        // big nose
      x.fillStyle='#1a241a'; x.fillRect(34,38,60,7);                                         // unibrow
      x.fillStyle='#101810'; x.fillRect(42,48,12,7); x.fillRect(76,48,12,7);                 // eyes
      x.strokeStyle='#33402b'; x.lineWidth=3; x.beginPath(); x.moveTo(54,104); x.lineTo(74,104); x.stroke();
    }
    const t=new THREE.CanvasTexture(c); t.anisotropy=4; if('sRGBEncoding' in THREE) t.encoding=THREE.sRGBEncoding; this[key]=t; return t;
  }
  faceBillboard(kind,w){ return new THREE.Mesh(new THREE.PlaneGeometry(w,w), new THREE.MeshBasicMaterial({ map:this.faceTex(kind), transparent:true })); }

  // EVENT ENEMY — ape body + streamer-face billboard (invades on every 6th round)
  makeMonkey(){
    const g=new THREE.Group();
    const fur=this.mat(0x4a3320,0.96,0), furD=this.mat(0x32230f,0.96,0), skin=this.mat(0xcaa172,0.85,0);
    const torso=this.box(0.62,0.78,0.4, fur); torso.position.set(0,1.18,0); torso.rotation.x=0.18; g.add(torso);
    g.add(this.at(this.box(0.5,0.4,0.34, skin),0,1.02,0.07));
    const head=new THREE.Group(); head.position.set(0,1.66,0.05); g.add(head);
    head.add(new THREE.Mesh(new THREE.SphereGeometry(0.27,14,14), fur));
    const face=this.faceBillboard('monkey',0.5); face.position.set(0,0,0.26); head.add(face);
    [-1,1].forEach(s=> head.add(this.at(new THREE.Mesh(new THREE.SphereGeometry(0.12,10,10),fur), s*0.26,0.05,0)));
    const armL=this.limb(skin,fur); armL.scale.set(1.2,1.4,1.2); armL.position.set(-0.42,1.5,0.04); armL.rotation.set(-0.9,0,0.25); g.add(armL);
    const armR=this.limb(skin,fur); armR.scale.set(1.2,1.4,1.2); armR.position.set(0.42,1.5,0.04); armR.rotation.set(-0.8,0,-0.25); g.add(armR);
    const legL=this.leg(furD); legL.scale.set(1,0.8,1); legL.position.set(-0.17,0.82,0); g.add(legL);
    const legR=this.leg(furD); legR.scale.set(1,0.8,1); legR.position.set(0.17,0.82,0); g.add(legR);
    g.userData.update=(t)=>{ g.position.y=Math.abs(Math.sin(t*5))*0.05; g.rotation.z=Math.sin(t*2.4)*0.05;
      legL.rotation.x=Math.sin(t*5)*0.55; legR.rotation.x=-Math.sin(t*5)*0.55;
      armL.rotation.z=0.25+Math.sin(t*4)*0.18; armR.rotation.z=-0.25-Math.sin(t*4+1)*0.18; head.rotation.z=Math.sin(t*3)*0.1; };
    return g;
  }
  // RARE (0.1%) — gold-hair zombie with a flaring aura; 20x HP, faster, hits harder
  makeSuperSaiyanZombie(){
    const g=this.makeZombie();
    const gold=this.glow(0xffe23a,2.2);
    const hair=new THREE.Group(); hair.position.set(0,1.92,0.06); g.add(hair);
    for(let i=0;i<9;i++){ const a=(i/9)*Math.PI*2; const spike=new THREE.Mesh(new THREE.ConeGeometry(0.07,0.34,5),gold);
      spike.position.set(Math.cos(a)*0.12,0.12,Math.sin(a)*0.1); spike.rotation.set(0.5*Math.cos(a),0,-0.5*Math.sin(a)); hair.add(spike); }
    hair.add(new THREE.Mesh(new THREE.ConeGeometry(0.1,0.42,6),gold));
    const aura=new THREE.Mesh(new THREE.SphereGeometry(0.7,16,16),
      new THREE.MeshBasicMaterial({ color:0xffe23a, transparent:true, opacity:0.18, depthWrite:false, blending:THREE.AdditiveBlending }));
    aura.position.y=1.2; aura.scale.set(1,1.7,1); g.add(aura);
    const zu=g.userData.update;
    g.userData.update=(t)=>{ if(zu)zu(t); hair.scale.setScalar(0.85+Math.sin(t*12)*0.15);
      aura.material.opacity=0.14+Math.abs(Math.sin(t*9))*0.12; aura.rotation.y=t*2; };
    g.userData.saiyan=true; return g;
  }
  // ROUND-20 FINALE — distinct giga model (mega boss + obsidian crown, horns, flame ring)
  makeGigaBoss(){
    const g=new THREE.Group();
    const mb=this.makeMegaBoss(); g.add(mb);
    const ember=this.glow(0xff4a14,2.0), bone=this.mat(0x140a0a,0.6,0);
    const crown=new THREE.Group(); crown.position.set(0,5.6,-0.2); g.add(crown);
    for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; crown.add(this.at(new THREE.Mesh(new THREE.ConeGeometry(0.18,0.9,5),bone),Math.cos(a)*1.0,0,Math.sin(a)*1.0)); }
    [-1,1].forEach(s=> g.add(this.at(new THREE.Mesh(new THREE.ConeGeometry(0.28,1.2,6),bone), s*1.2,5.4,0.3)));
    const ring=new THREE.Mesh(new THREE.TorusGeometry(2.4,0.18,10,28), ember); ring.rotation.x=Math.PI/2; ring.position.y=0.3; g.add(ring);
    const mu=mb.userData.update; g.userData.face=mb.userData.face;
    g.userData.update=(t)=>{ if(mu)mu(t); ring.material.emissiveIntensity=1.4+Math.sin(t*4)*0.8; ring.rotation.z=t*0.6; crown.rotation.y=Math.sin(t*0.5)*0.2; };
    g.userData.giga=true; return g;
  }
  // VILLAGER zombie variant — big-nose face billboard, crossed arms
  makeVillager(){
    const g=new THREE.Group();
    const skin=this.mat(0x6f8a55,0.9,0), robe=this.mat(0x4a3a6a,0.85,0), robe2=this.mat(0x6b4a2a,0.9,0);
    const torso=this.box(0.56,0.86,0.34, robe); torso.position.set(0,1.22,0); g.add(torso);
    g.add(this.at(this.box(0.6,0.3,0.36, robe2),0,0.92,0));
    const head=new THREE.Group(); head.position.set(0,1.78,0.05); g.add(head);
    head.add(this.box(0.32,0.38,0.3, skin));
    head.add(this.at(this.box(0.12,0.34,0.22, skin),0,-0.04,0.2));
    const face=this.faceBillboard('villager',0.36); face.position.set(0,0.02,0.17); head.add(face);
    const armL=this.limb(skin,robe); armL.position.set(-0.34,1.5,0.12); armL.rotation.set(-1.1,0.4,0.2); g.add(armL);
    const armR=this.limb(skin,robe); armR.position.set(0.34,1.5,0.12); armR.rotation.set(-1.1,-0.4,-0.2); g.add(armR);
    const legL=this.leg(robe); legL.position.set(-0.15,0.92,0); g.add(legL);
    const legR=this.leg(robe); legR.position.set(0.15,0.92,0); g.add(legR);
    g.userData.update=(t)=>{ g.position.y=Math.abs(Math.sin(t*4))*0.04; g.rotation.z=Math.sin(t*2)*0.05;
      legL.rotation.x=Math.sin(t*4)*0.45; legR.rotation.x=-Math.sin(t*4)*0.45; head.rotation.z=Math.sin(t*2.4)*0.07; };
    return g;
  }
  makeRoyalEgg() {
    const g=new THREE.Group();
    const shell=this.mat(0xf0e6c8,0.55,0.1), gold=this.mat(0xd9a441,0.4,0.6);
    const egg=new THREE.Mesh(new THREE.SphereGeometry(1,24,24),shell); egg.scale.set(1,1.4,1); egg.position.y=1.5; g.add(egg);
    // gold vertical ribs + spots
    for(let i=0;i<6;i++){ const a=i/6*Math.PI*2; const rib=new THREE.Mesh(new THREE.TorusGeometry(1.0,0.04,6,16,Math.PI),gold); rib.position.y=1.5; rib.rotation.set(Math.PI/2,0,a); rib.scale.set(1,1.4,1); g.add(rib); }
    for(let i=0;i<7;i++){ const a=Math.random()*Math.PI*2, yy=0.7+Math.random()*1.5; g.add(this.at(new THREE.Mesh(new THREE.SphereGeometry(0.1,8,8),gold), Math.cos(a)*0.92,yy,Math.sin(a)*0.92)); }
    // crown
    const crown=new THREE.Group(); crown.position.y=3.0; g.add(crown);
    crown.add(new THREE.Mesh(new THREE.CylinderGeometry(0.4,0.5,0.3,8),gold));
    for(let i=0;i<6;i++){ const a=i/6*Math.PI*2; crown.add(this.at(new THREE.Mesh(new THREE.ConeGeometry(0.08,0.3,5),gold),Math.cos(a)*0.42,0.25,Math.sin(a)*0.42)); }
    // boss hidden inside
    const boss=this.makeMegaBoss(); boss.position.y=0; boss.scale.setScalar(0.001); g.add(boss);
    const bu=boss.userData.update;
    g.userData.update=(t)=>{
      const C=16, ph=t%C;
      if (ph<7){ egg.visible=true; crown.visible=true; boss.scale.setScalar(0.001); const w=ph/7; egg.rotation.z=Math.sin(t*6)*0.06*w; crown.position.y=3.0+Math.sin(t*6)*0.05*w; }
      else if (ph<8.5){ const k=(ph-7)/1.5; egg.rotation.z=Math.sin(t*30)*0.12; egg.scale.set(1+k*0.2,1.4*(1-k*0.3),1+k*0.2); crown.position.y=3.0+k*1.5; crown.rotation.y=k*6; }
      else { egg.visible=false; crown.visible=false; const k=Math.min(1,(ph-8.5)/3.2); boss.scale.setScalar(0.001+k*1.0); if(bu)bu(t); }
    };
    return g;
  }
  makeTowerModel() {
    const g=new THREE.Group();
    const wall=this.mat(0x22262b,0.95,0.05), band=this.mat(0x171b1f,0.9,0), roof=this.mat(0x191d22,0.95,0), stepM=this.mat(0x2c3138,0.8,0.2);
    const S=6, FL=10, fh=1.15, HH=FL*fh;
    g.add(this.at(this.box(S*2,HH,0.3,wall),0,HH/2,-S));
    g.add(this.at(this.box(0.3,HH,S*2,wall),-S,HH/2,0));
    g.add(this.at(this.box(0.3,HH,S*2,wall),S,HH/2,0));
    for(let f=0;f<=FL;f++){ const y=f*fh; [[-S*0.55,0,S*0.9,2*S],[S*0.55,0,S*0.9,2*S],[0,-S*0.55,2*S,S*0.9],[0,S*0.55,2*S,S*0.9]].forEach(p=>{ g.add(this.at(this.box(p[2],0.1,p[3], f===FL?roof:band),p[0],y,p[1])); }); }
    const steps=84, turns=4.5;
    for(let i=0;i<steps;i++){ const a=i/steps*turns*Math.PI*2, y=i/steps*HH, r=S*0.6; const st=this.box(2.0,0.1,0.7,stepM); st.position.set(Math.cos(a)*r,y,Math.sin(a)*r); st.rotation.y=-a; g.add(st); }
    g.add(this.at(this.box(1.0,HH,1.0,band),0,HH/2,0));
    // tiny roof egg
    g.add(this.at(new THREE.Mesh(new THREE.SphereGeometry(0.5,12,12),this.mat(0xf0e6c8,0.6,0.1)),0,HH+0.6,0));
    return g;
  }
}
const KIT = new Kit();
window.KIT = KIT;
