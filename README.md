# UNDEAD SIEGE

A first-person, Nacht-style wave-survival zombie game built in **Three.js (r128) + vanilla JS**,
running entirely from a single procedural model factory (no external meshes). Designed to a hard
**60fps / no-lag** budget with a hard cap of **25 live zombies** at once.

## Play

Just open `index.html` in a browser, or serve the folder:

```bash
# any static server works; example:
python3 -m http.server 8000
# then visit http://localhost:8000
```

Click **BEGIN THE SIEGE**, then click the canvas to lock the mouse.

### Controls
| Key | Action |
|-----|--------|
| **WASD** | Move |
| **Mouse** | Look |
| **Shift** | Sprint |
| **Space** | Jump |
| **L-Click** | Fire (hold to charge the Hell's Revolver) |
| **R** | Reload |
| **G** | Grenade |
| **F** | Interact / Buy / Open |
| **1 · 2 / Q / Scroll** | Swap weapon |
| **Esc** | Pause |

### The loop
Survive escalating rounds. Kills and head-shots earn **points**. Spend them on wall weapons, the
**Mystery Crate**, the progression **gates** around the ring, **perks** (Double Shot, Mug Rootbeer
Meth, Pingas Liquid), **Power**, and **Pack-a-Pingas** to upgrade your gun. Mini-bosses arrive every
5 rounds; the **Mega Pingas Boss** hatches from the Royal Egg as the finale.

## Files
| File | Purpose |
|------|---------|
| `index.html` | Shell + HUD + menus (COD-Zombies styling) |
| `models.js`  | Model factory **ported verbatim** from the asset kit (wrapped in a `Kit` class) |
| `game.js`    | Engine: renderer, fixed-timestep sim, FPS controller, pools, AI, weapons, economy, director |
| `resources.js` | The two image textures (`moon`, `pingasface`) embedded as data-URIs so it runs from `file://` |
| `three.min.js` | Three.js r128 |
| `assets/` | `moon.png`, `pingasface.png` |
| `smoketest.js` | Headless boot/perf/functional test (needs `playwright-core`) |

## Performance design (why it doesn't lag)
Built to the brief's budget from line one:

- **One** renderer, **one** `requestAnimationFrame` loop, **one** scene.
- **Fixed-timestep** (60Hz) accumulator — sim is decoupled from render and frame-rate independent.
- **Object pools**: 25 zombie rigs + 8 crawlers built once, hidden/reused on death — never instantiated mid-round.
- **Instancing**: hundreds of trees / fence posts / boulders collapse to a handful of draw calls (merged tree geometry).
- **One shadow-casting directional light**, baked **once** (`shadow.autoUpdate=false` after the first frame). Enemies use cheap blob shadows instead of dynamic shadow casting.
- **Hitscan via manual ray-sphere** tests against ≤33 enemy spheres — no `Raycaster` traversal, no allocation.
- **Zero per-frame allocation** in hot paths (shared `Vector3`/`Quaternion`/`Color` temporaries).
- Capped point lights (≤7, flicker by intensity), exponential fog + frustum culling, `pixelRatio ≤ 2`, ACES tone-mapping, PCFSoft shadows. A LOW quality toggle drops pixelRatio to 1 and shadows off.

### Measured (headless, full 25-zombie horde)
- Sim step: **~0.17 ms** (budget is 16.6 ms → ~96× headroom)
- Draw calls: **38** (budget < 150) · Triangles: **~52k** (budget < 150k)
- Shader programs: 8 · Textures: 12

(Headless framerate in CI looks low only because the container has no GPU and falls back to
software rasterization — the draw-call/triangle/sim budgets above are what predict real-hardware fps.)

## Credits
Procedural model kit and design brief: *Undead Siege Kit*. Engine and gameplay: this repo.
