#!/usr/bin/env node
/*
 * generate-dragon.js — build an animated isometric "3D contribution dragon" SVG
 * from a GitHub user's public contribution calendar.
 *
 *   node scripts/generate-dragon.js --user ISSEI51 --out dist/github-dragon-dark.svg
 *   node scripts/generate-dragon.js --file contrib.html --out dist/github-dragon-dark.svg
 *
 * The output is a self-contained SMIL-animated SVG that embeds directly in a
 * GitHub README. No JavaScript runs in the README.
 * Palette matches the profile theme: bg #0D1117, cyan #22D3EE, purple #8B5CF6.
 *
 * Depth handling: the dragon is emitted as per-route-cell sprites interleaved
 * with the contribution stacks in isometric depth order (c+r), so it passes
 * BEHIND taller stacks instead of always painting on top.
 */

const fs = require('fs');
const path = require('path');

// ---------- args ----------
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const USER = getArg('user', process.env.SNAKE_USER || 'ISSEI51');
const OUT  = getArg('out', 'dist/github-dragon-dark.svg');
const FILE = getArg('file', null);        // read local HTML instead of fetching

// ---------- fetch + parse contribution calendar ----------
async function loadHtml(){
  if (FILE) return fs.readFileSync(FILE, 'utf8');
  const url = `https://github.com/users/${USER}/contributions`;
  const res = await fetch(url, { headers: { 'User-Agent': 'dragon-3d-generator' } });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.text();
}

function parseGrid(html){
  const cells = html.match(/<td[^>]*class="ContributionCalendar-day"[^>]*>/g) || [];
  if (!cells.length) throw new Error('no contribution cells found (private profile or markup change?)');
  const byDate = [];
  for (const c of cells){
    const date = (c.match(/data-date="([^"]+)"/) || [])[1];
    const level = parseInt((c.match(/data-level="([^"]+)"/) || [])[1], 10);
    if (!date || Number.isNaN(level)) continue;
    byDate.push({ date, level });
  }
  byDate.sort((a, b) => a.date < b.date ? -1 : 1);
  const first = new Date(byDate[0].date + 'T00:00:00Z');
  const firstSunday = new Date(first);
  firstSunday.setUTCDate(first.getUTCDate() - first.getUTCDay());
  const grid = byDate.map(d => {
    const t = new Date(d.date + 'T00:00:00Z');
    const col = Math.round((t - firstSunday) / (7 * 864e5));
    const row = t.getUTCDay();
    return [col, row, d.level];
  });
  const total = byDate.length;
  return { grid, first: byDate[0].date, last: byDate[byDate.length - 1].date, total };
}

// ---------- geometry (isometric: top + left wall + right wall) ----------
const HW = 8.5, HH = 2.2, S = 0.46, CUBE = 10.5;
const P = (c, r, z) => [ (c - r) * HW, (c + r) * HH - z ];
const fmt = ([x, y]) => x.toFixed(2) + ',' + y.toFixed(2);
const n2 = v => v.toFixed(2);
const n1 = v => (+v.toFixed(1)).toString();
const n4 = v => (+v.toFixed(4)).toString();

// contribution-stack palette: profile dark theme ramp (navy -> cyan -> purple)
const BASE = ['#161b22', '#1E3A5F', '#3B6FA8', '#22D3EE', '#8B5CF6'];
function shade(hex, f){
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}
function cubeFaces(c, r, z0, z1, s = S){
  const A = [c - s, r - s], B = [c + s, r - s], C = [c + s, r + s], D = [c - s, r + s];
  return {
    top:   [P(A[0],A[1],z1),P(B[0],B[1],z1),P(C[0],C[1],z1),P(D[0],D[1],z1)].map(fmt).join(' '),
    right: [P(B[0],B[1],z0),P(C[0],C[1],z0),P(C[0],C[1],z1),P(B[0],B[1],z1)].map(fmt).join(' '),
    left:  [P(D[0],D[1],z0),P(C[0],C[1],z0),P(C[0],C[1],z1),P(D[0],D[1],z1)].map(fmt).join(' '),
  };
}

// ---------- pathfinding: low levels first, shortest path, detour around cubes ----------
const key = (c, r) => c + ',' + r;
function buildPlan(grid){
  const cellSet = {}, stacks = [];
  let maxCol = 0, maxRow = 0;
  grid.forEach(([c, r, lv]) => {
    cellSet[key(c, r)] = lv;
    if (c > maxCol) maxCol = c;
    if (r > maxRow) maxRow = r;
    if (lv > 0) stacks.push({ c, r, lv });
  });

  function bfs(start, goal, obstacles){
    const sK = key(start[0], start[1]), gK = key(goal[0], goal[1]);
    if (sK === gK) return [start];
    const prev = { [sK]: null }, q = [start]; let qi = 0;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    while (qi < q.length){
      const [c, r] = q[qi++];
      for (const [dc, dr] of dirs){
        const nc = c + dc, nr = r + dr, nk = key(nc, nr);
        if (nk in prev) continue;
        if (!(nk in cellSet)) continue;
        if (obstacles.has(nk) && nk !== gK) continue;
        prev[nk] = [c, r];
        if (nk === gK){
          const p = []; let cell = [nc, nr];
          while (cell){ p.push(cell); cell = prev[key(cell[0], cell[1])]; }
          return p.reverse();
        }
        q.push([nc, nr]);
      }
    }
    return null;
  }

  // order targets: level asc, nearest within a level
  const groups = { 1: [], 2: [], 3: [], 4: [] };
  stacks.forEach(s => groups[s.lv].push([s.c, s.r]));
  const targets = []; let cur = [0, 0];
  [1,2,3,4].forEach(lv => {
    const pool = groups[lv].slice();
    while (pool.length){
      let bi = 0, bd = Infinity;
      pool.forEach((p, i) => { const d = Math.abs(p[0]-cur[0]) + Math.abs(p[1]-cur[1]); if (d < bd){ bd = d; bi = i; } });
      cur = pool.splice(bi, 1)[0]; targets.push(cur);
    }
  });

  // stitch shortest paths, detouring around not-yet-eaten stacks
  const remaining = new Set(stacks.map(s => key(s.c, s.r)));
  cur = [0, 0];
  const route = [[0, 0]], eatAt = {};
  targets.forEach(t => {
    const tk = key(t[0], t[1]);
    const obst = new Set(remaining); obst.delete(tk);
    const p = bfs(cur, t, obst) || bfs(cur, t, new Set()) || [cur, t];
    for (let i = 1; i < p.length; i++) route.push(p[i]);
    eatAt[route.length - 1] = tk;
    remaining.delete(tk);
    cur = t;
  });

  return { cellSet, stacks, route, eatAt, maxCol, maxRow };
}

// ---------- SVG (SMIL) emission ----------
function buildSvg(plan, meta){
  const { cellSet, stacks, route, eatAt } = plan;
  const N = route.length;

  // timeline
  const SPC = 0.05;                 // seconds per route cell
  const GROW = 1.2;                 // grow-in window
  const PAUSE = 1.6;                // pause before loop
  const SWEEP = Math.max(0.1, (N - 1) * SPC);
  const T = GROW + SWEEP + PAUSE;
  const kg = GROW / T;
  const eatTimeK = j => (GROW + j * SPC) / T;
  const stepK = k => (GROW + k * SPC) / T;   // key-time of route step k

  // viewBox from content (extra headroom for horns on the top edge)
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  Object.keys(cellSet).forEach(k => {
    const [c, r] = k.split(',').map(Number);
    const zTop = Math.max(1, cellSet[k]) * CUBE;
    [P(c-S,r-S,0),P(c+S,r+S,0),P(c-S,r+S,0),P(c+S,r-S,0),P(c-S,r-S,zTop),P(c+S,r-S,zTop)]
      .forEach(([x,y]) => { if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; });
  });
  const pad = 18, padTop = 30;
  const vbW = maxX - minX + 2 * pad, vbH = maxY - minY + pad + padTop;
  const vb = `${n2(minX-pad)} ${n2(minY-padTop)} ${n2(vbW)} ${n2(vbH)}`;

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${n2(vbW)}" height="${n2(vbH)}" font-family="monospace">`);

  // ---- dragon body look: tapered chain of shaded spheres (streamlined) ----
  const SEG = 10;
  const RP  = [6.0, 5.5, 5.0, 4.6, 4.2, 3.8, 3.3, 2.8, 2.2, 1.5];      // radius per segment, head -> tail
  const RPM = RP.map((r, i) => (r + (RP[i + 1] || 0)) / 2);            // in-between spheres (keeps the body continuous)
  const HEADC = [139, 92, 246], TAILC = [34, 211, 238];                // #8B5CF6 -> #22D3EE
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);
  const segColor = t => `rgb(${lerp(TAILC[0],HEADC[0],t)},${lerp(TAILC[1],HEADC[1],t)},${lerp(TAILC[2],HEADC[2],t)})`;
  const COLS = Array.from({ length: SEG }, (_, i) => segColor(1 - i / (SEG - 1)));

  out.push(`<defs>`);
  // alpha-only sphere shading, laid over flat animated-colour circles
  // (SMIL cannot animate fill between url() paint servers, only between colours)
  out.push(`<radialGradient id="shade" cx="0.32" cy="0.28" r="0.95">` +
           `<stop offset="0" stop-color="#ffffff" stop-opacity="0.3"/>` +
           `<stop offset="0.45" stop-color="#ffffff" stop-opacity="0"/>` +
           `<stop offset="1" stop-color="#000000" stop-opacity="0.55"/></radialGradient>`);
  // head decoration, origin = centre of the head sphere (r = RP[0])
  out.push(`<g id="dhead">` +
           `<circle r="8.6" fill="#22D3EE" opacity="0.10"/>` +
           `<polygon points="-3.9,-2.2 -6.9,-9.8 -1.7,-4.4" fill="#C4B5FD" stroke="#0b0f14" stroke-width="0.4"/>` +
           `<polygon points="3.9,-2.2 6.9,-9.8 1.7,-4.4" fill="#A78BFA" stroke="#0b0f14" stroke-width="0.4"/>` +
           `<polygon points="-1.5,-4.9 0,-9.6 1.5,-4.9" fill="#8B5CF6" stroke="#0b0f14" stroke-width="0.4"/>` +
           `<circle cx="-2.4" cy="0.6" r="1.5" fill="#0d1117"/><circle cx="2.4" cy="0.6" r="1.5" fill="#0d1117"/>` +
           `<circle cx="-2.4" cy="0.6" r="1.0" fill="#22D3EE"><animate attributeName="opacity" values="1;0.45;1" dur="1.6s" repeatCount="indefinite"/></circle>` +
           `<circle cx="2.4" cy="0.6" r="1.0" fill="#22D3EE"><animate attributeName="opacity" values="1;0.45;1" dur="1.6s" repeatCount="indefinite"/></circle>` +
           `<circle cx="-2.15" cy="0.3" r="0.35" fill="#F0F6FC"/><circle cx="2.65" cy="0.3" r="0.35" fill="#F0F6FC"/>` +
           `<circle cx="-1.0" cy="3.4" r="0.42" fill="#0d1117"/><circle cx="1.0" cy="3.4" r="0.42" fill="#0d1117"/>` +
           `</g>`);
  out.push(`</defs>`);

  out.push(`<rect x="${n2(minX-pad)}" y="${n2(minY-padTop)}" width="${n2(vbW)}" height="${n2(vbH)}" fill="#0D1117"/>`);

  const STROKE = '#0b0f14';

  // ground tiles
  out.push('<g>');
  Object.keys(cellSet).forEach(k => {
    const [c, r] = k.split(',').map(Number);
    out.push(`<polygon points="${cubeFaces(c, r, 0, 0).top}" fill="#11161d" stroke="#1b232e" stroke-width="0.6"/>`);
  });
  out.push('</g>');

  // ---- depth-sorted scene: stacks and dragon sprites interleaved by (c + r) ----
  const items = [];

  // cube stacks — opacity animates grow -> eat -> loop
  stacks.forEach(s => {
    const kEy = key(s.c, s.r);
    let jEat = N - 1;
    for (const idx in eatAt) if (eatAt[idx] === kEy){ jEat = +idx; break; }
    const ke = Math.min(0.985, eatTimeK(jEat));
    const ke2 = Math.min(0.99, ke + 0.16 / T);
    const kgv = Math.min(kg, ke - 0.001);
    const top = shade(BASE[s.lv], 1), rgt = shade(BASE[s.lv], 0.82), lft = shade(BASE[s.lv], 0.60);
    const g = [];
    g.push(`<g opacity="0">`);
    g.push(`<animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;${n2(kgv)};${n2(ke)};${n2(ke2)};1" dur="${n2(T)}s" repeatCount="indefinite"/>`);
    for (let k = 0; k < s.lv; k++){
      const f = cubeFaces(s.c, s.r, k * CUBE, (k + 1) * CUBE);
      g.push(`<polygon points="${f.left}" fill="${lft}" stroke="${STROKE}" stroke-width="0.6"/>`);
      g.push(`<polygon points="${f.right}" fill="${rgt}" stroke="${STROKE}" stroke-width="0.6"/>`);
      if (k === s.lv - 1) g.push(`<polygon points="${f.top}" fill="${top}" stroke="${STROKE}" stroke-width="0.6"/>`);
    }
    g.push(`</g>`);
    items.push({ d: s.c + s.r, tie: 0, svg: g.join('') });
  });

  // one body sphere fixed at a route cell: appears when the head arrives, then the
  // taper wave (radius/colour per segment) travels through it as the body passes.
  function sphereSvg(cx, ay, j, radii, withShade){
    const dur = `dur="${n2(T)}s" repeatCount="indefinite"`;
    const t0 = stepK(j);
    const times = ['0', n4(Math.max(0, t0 - 0.0004))], rv = ['0', '0'], cyv = [n1(ay - 2), n1(ay - 2)];
    const fv = [COLS[0], COLS[0]];
    let lastR = 0, lastC = COLS[0], done = false;
    for (let k = 0; k <= radii.length; k++){
      if (j + k > N - 1){                          // sweep is over: park (freeze) through the pause
        times.push('1'); rv.push(n1(lastR)); cyv.push(n1(ay - 2 - lastR)); fv.push(lastC);
        done = true; break;
      }
      const val = k < radii.length ? radii[k] : 0; // one step after the tail: gone
      const col = COLS[Math.min(k, SEG - 1)];
      times.push(n4(stepK(j + k))); rv.push(n1(val)); cyv.push(n1(ay - 2 - val)); fv.push(col);
      lastR = val; lastC = col;
    }
    if (!done){ times.push('1'); rv.push('0'); cyv.push(n1(ay - 2)); fv.push(lastC); }
    const kt = `keyTimes="${times.join(';')}" ${dur} calcMode="linear"`;
    const rAnim  = `<animate attributeName="r" values="${rv.join(';')}" ${kt}/>`;
    const cyAnim = `<animate attributeName="cy" values="${cyv.join(';')}" ${kt}/>`;
    let s = `<circle cx="${n1(cx)}" cy="${n1(ay - 2)}" r="0" fill="${COLS[0]}" stroke="${STROKE}" stroke-width="0.4">` +
      rAnim + cyAnim +
      `<animate attributeName="fill" values="${fv.join(';')}" ${kt}/>` +
      `</circle>`;
    if (withShade){
      s += `<circle cx="${n1(cx)}" cy="${n1(ay - 2)}" r="0" fill="url(#shade)">` + rAnim + cyAnim + `</circle>`;
    }
    return s;
  }

  for (let j = 0; j < N; j++){
    const [c, r] = route[j];
    const cx = (c - r) * HW, ay = (c + r) * HH;

    // in-between sphere towards the previous cell (keeps the silhouette continuous)
    if (j > 0){
      const [pc, pr] = route[j - 1];
      const mcx = (cx + (pc - pr) * HW) / 2, may = (ay + (pc + pr) * HH) / 2;
      items.push({ d: (c + r + pc + pr) / 2, tie: 1, svg: sphereSvg(mcx, may, j, RPM, false) });
    }

    // main sphere + head decoration (visible only while this cell is the head)
    const t0 = n4(stepK(j));
    const headY = n1(ay - 2 - RP[0]);
    const head = j < N - 1
      ? `<use href="#dhead" x="${n1(cx)}" y="${headY}" opacity="0"><animate attributeName="opacity" calcMode="discrete" values="0;1;0" keyTimes="0;${t0};${n4(stepK(j + 1))}" dur="${n2(T)}s" repeatCount="indefinite"/></use>`
      : `<use href="#dhead" x="${n1(cx)}" y="${headY}" opacity="0"><animate attributeName="opacity" calcMode="discrete" values="0;1" keyTimes="0;${t0}" dur="${n2(T)}s" repeatCount="indefinite"/></use>`;
    items.push({ d: c + r, tie: 1, svg: sphereSvg(cx, ay, j, RP, true) + head });
  }

  items.sort((a, b) => a.d - b.d || a.tie - b.tie);
  items.forEach(it => out.push(it.svg));

  // caption
  out.push(`<text x="${n2(minX)}" y="${n2(maxY+pad-4)}" fill="#22D3EE" opacity="0.85" font-size="7">@${meta.user} // DRAGON TRACE // ${meta.total} contributions // ${meta.first} -&gt; ${meta.last}</text>`);
  out.push('</svg>');
  return out.join('\n');
}

// ---------- main ----------
(async () => {
  const html = await loadHtml();
  const { grid, first, last, total } = parseGrid(html);
  const plan = buildPlan(grid);
  const svg = buildSvg(plan, { user: USER, first, last, total });
  const outPath = path.resolve(OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, svg);
  console.log(`wrote ${outPath}  (${(svg.length/1024).toFixed(1)} KB, ${grid.length} days, ${plan.stacks.length} stacks, route ${plan.route.length})`);
})().catch(e => { console.error(e.message); process.exit(1); });
