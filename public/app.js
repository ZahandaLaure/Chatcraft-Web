/* ChatCraft Web Client — frontend */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ------------------------------------------------------------ state
  const accounts = new Map();   // id -> { cfg, status, reconnectAt, username }
  const logs = new Map();       // id -> entries[]
  const unread = new Map();     // id -> count
  let current = localStorage.getItem('cc_current') || null;
  let lastState = null;
  let activeTab = 'status';

  const socket = io({ auth: { password: localStorage.getItem('cc_pass') || '' } });

  // ------------------------------------------------------------ Minecraft text
  const COLORS = { 0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00', 7: '#AAAAAA',
    8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF', g: '#DDD605' };
  const FMT = { l: 'b', o: 'i', n: 'u', m: 's', k: 'k' };
  const shadow = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${(n >> 16 & 255) >> 2},${(n >> 8 & 255) >> 2},${(n & 255) >> 2})`; };
  const stripCodes = (s) => s.replace(/§x(§[0-9a-f]){6}/gi, '').replace(/§#[0-9a-f]{6}/gi, '').replace(/§./g, '');

  /** Render string berkode § menjadi elemen span berwarna. */
  function mcRender(str, el, defaultColor = '#FFFFFF') {
    let color = null, fmt = new Set(), buf = '';
    const flush = () => {
      if (!buf) return;
      const sp = document.createElement('span');
      const hex = color || defaultColor;
      sp.style.color = hex; sp.style.setProperty('--sh', shadow(hex));
      fmt.forEach((f) => sp.classList.add(f));
      if (fmt.has('k')) sp.dataset.len = [...buf].length;
      sp.textContent = buf; el.appendChild(sp); buf = '';
    };
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '§' && i + 1 < str.length) {
        const c = str[i + 1].toLowerCase();
        const hx = str.slice(i, i + 14);
        if (c === 'x' && /^§x(§[0-9a-f]){6}$/i.test(hx)) { flush(); color = '#' + hx.replace(/§x|§/gi, '').toUpperCase(); fmt = new Set(); i += 13; continue; }
        if (c === '#' && /^[0-9a-f]{6}$/i.test(str.substr(i + 2, 6))) { flush(); color = '#' + str.substr(i + 2, 6); fmt = new Set(); i += 7; continue; }
        if (COLORS[c]) { flush(); color = COLORS[c]; fmt = new Set(); i++; continue; }
        if (FMT[c]) { flush(); fmt.add(FMT[c]); i++; continue; }
        if (c === 'r') { flush(); color = null; fmt = new Set(); i++; continue; }
      }
      buf += str[i];
    }
    flush();
    return el;
  }
  const OBF = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&@?';
  setInterval(() => $$('.k').forEach((e) => { let t = ''; for (let i = 0; i < +e.dataset.len; i++) t += OBF[Math.random() * OBF.length | 0]; e.textContent = t; }), 80);

  // ------------------------------------------------------------ toasts & notifications
  function toast(text, cls = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + cls; t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), 4500);
  }
  let audioCtx;
  function beep(freq = 880) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(.15, audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + .35);
      o.start(); o.stop(audioCtx.currentTime + .35);
    } catch { /* ignore */ }
  }
  function notify(title, body, cls) {
    toast(`${title}: ${body}`, cls);
    beep(cls === 'alert' ? 440 : 880);
    if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
      try { new Notification(title, { body }); } catch { /* ignore */ }
    }
    if (navigator.vibrate) navigator.vibrate(200);
  }
  document.addEventListener('click', () => {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }, { once: true });

  // ------------------------------------------------------------ sidebar
  const accName = (a) => a.cfg.label || a.cfg.host;
  const STATUS_TXT = { online: 'Online', connecting: 'Menghubungkan...', reconnecting: 'Menyambung ulang...', offline: 'Offline' };

  function renderAccounts() {
    const list = $('#accList');
    list.innerHTML = '';
    if (!accounts.size) list.innerHTML = '<div class="empty">Belum ada akun.<br/>Klik “Tambah Akun”.</div>';
    for (const [id, a] of accounts) {
      const b = document.createElement('button');
      b.className = 'acc' + (id === current ? ' active' : '');
      const n = unread.get(id) || 0;
      b.innerHTML = `
        <div class="avatar" style="background-image:url('https://mc-heads.net/avatar/${encodeURIComponent(a.cfg.username)}/36')"></div>
        <div class="info"><div class="n"></div><div class="s"><span class="dot ${a.status}"></span> <span class="st"></span></div></div>
        ${n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : ''}`;
      $('.n', b).textContent = accName(a);
      $('.st', b).textContent = `${a.cfg.username} · ${STATUS_TXT[a.status] || a.status}`;
      b.onclick = () => { select(id); closeSidebar(); };
      list.appendChild(b);
    }
  }

  function renderHeader() {
    const a = accounts.get(current);
    const btn = $('#btnConnect');
    $('#btnEdit').disabled = !a;
    if (!a) {
      $('#hdrName').textContent = 'Belum ada akun';
      $('#hdrStatus').textContent = 'Tambah akun untuk mulai';
      $('#hdrDot').className = 'dot';
      btn.textContent = 'Hubungkan'; btn.className = 'btn'; btn.disabled = true;
      return;
    }
    $('#hdrName').textContent = accName(a);
    let st = `${a.cfg.host}${+a.cfg.port !== 25565 ? ':' + a.cfg.port : ''} · ${STATUS_TXT[a.status]}`;
    if (a.status === 'reconnecting' && a.reconnectAt) st += ` (${Math.max(0, Math.ceil((a.reconnectAt - Date.now()) / 1000))} dtk)`;
    $('#hdrStatus').textContent = st;
    $('#hdrDot').className = 'dot ' + a.status;
    btn.disabled = false;
    if (a.status === 'offline') { btn.textContent = '▶ Hubungkan'; btn.className = 'btn primary'; }
    else { btn.textContent = '■ Putuskan'; btn.className = 'btn stop'; }
  }
  setInterval(() => { if (accounts.get(current)?.status === 'reconnecting') renderHeader(); }, 1000);

  function select(id) {
    current = id;
    localStorage.setItem('cc_current', id || '');
    unread.set(id, 0);
    lastState = null;
    renderAccounts(); renderHeader(); renderState(null);
    if (!id) { $('#chatLog').innerHTML = ''; return; }
    socket.emit('bot:history', id, (entries) => { logs.set(id, entries); renderLog(); });
    socket.emit('bot:state', id, (s) => { if (current === id) renderState(s); });
  }

  const sidebar = $('#sidebar'), backdrop = $('#backdrop');
  const closeSidebar = () => { sidebar.classList.remove('open'); backdrop.classList.remove('show'); };
  $('#btnMenu').onclick = () => { sidebar.classList.add('open'); backdrop.classList.add('show'); };
  backdrop.onclick = closeSidebar;

  // ------------------------------------------------------------ chat log
  const chatLog = $('#chatLog');
  function isKeywordHit(entry, cfg) {
    if (entry.kind !== 'chat' || !cfg?.keywords?.length) return false;
    const plain = stripCodes(entry.text).toLowerCase();
    return cfg.keywords.some((k) => k && plain.includes(k.toLowerCase()));
  }
  function lineEl(entry) {
    const d = document.createElement('div');
    d.className = 'line ' + entry.kind;
    if (isKeywordHit(entry, accounts.get(current)?.cfg)) d.classList.add('hit');
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = new Date(entry.t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    d.appendChild(ts);
    if (entry.kind === 'chat') mcRender(entry.text, d);
    else d.appendChild(document.createTextNode(entry.text));
    return d;
  }
  function renderLog() {
    chatLog.innerHTML = '';
    const frag = document.createDocumentFragment();
    (logs.get(current) || []).forEach((e) => frag.appendChild(lineEl(e)));
    chatLog.appendChild(frag);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const inp = $('#chatText');
    const text = inp.value.trim();
    if (!text || !current) return;
    if (accounts.get(current)?.status !== 'online') return toast('Belum terhubung ke server.', 'alert');
    socket.emit('bot:chat', current, text);
    // riwayat input (panah atas/bawah)
    history.unshift(text); if (history.length > 50) history.pop(); hIdx = -1;
    inp.value = '';
    $('#quickBar').hidden = true;
  };
  const history = []; let hIdx = -1;
  $('#chatText').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && history.length) { hIdx = Math.min(hIdx + 1, history.length - 1); e.target.value = history[hIdx]; e.preventDefault(); }
    if (e.key === 'ArrowDown') { hIdx = Math.max(hIdx - 1, -1); e.target.value = hIdx < 0 ? '' : history[hIdx]; e.preventDefault(); }
  });
  $('#btnQuick').onclick = () => { $('#quickBar').hidden = !$('#quickBar').hidden; };
  $$('#quickBar button').forEach((b) => (b.onclick = () => {
    const inp = $('#chatText'); inp.value = b.dataset.cmd; inp.focus(); $('#quickBar').hidden = true;
  }));

  // ------------------------------------------------------------ status panel
  function iconRow(value, full, half, max = 10) {
    let h = '';
    for (let i = 0; i < max; i++) {
      const v = value - i * 2;
      h += `<span class="ico ${v >= 2 ? '' : v >= 1 ? 'half' : 'off'}">${v >= 1 ? full : full}</span>`;
    }
    return h;
  }
  const DIM = { 'minecraft:overworld': 'Overworld', 'minecraft:the_nether': 'Nether', 'minecraft:the_end': 'The End', overworld: 'Overworld', the_nether: 'Nether', the_end: 'The End' };
  function renderState(s) {
    lastState = s;
    if (!s) {
      $('#hearts').innerHTML = ''; $('#foods').innerHTML = '';
      $('#stats').innerHTML = '<div class="empty" style="grid-column:1/-1">Tidak terhubung.</div>';
      $('#players').innerHTML = '<div class="empty">Tidak terhubung.</div>';
      $('#invMain').innerHTML = ''; $('#invHotbar').innerHTML = '';
      return;
    }
    $('#hearts').innerHTML = iconRow(s.health, '❤️');
    $('#foods').innerHTML = iconRow(s.food, '🍗');
    const t = s.time ?? 0, hh = Math.floor((t / 1000 + 6) % 24), mm = Math.floor((t % 1000) / 1000 * 60);
    const stat = (k, v) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $('#stats').innerHTML =
      stat('Nyawa', `${Math.round(s.health)} / 20`) + stat('Lapar', `${s.food} / 20`) +
      stat('Posisi', `${s.pos.x.toFixed(0)}, ${s.pos.y.toFixed(0)}, ${s.pos.z.toFixed(0)}`) +
      stat('Dimensi', DIM[s.dimension] || s.dimension || '-') +
      stat('Level XP', s.xp) + stat('Mode', s.gameMode || '-') +
      stat('Waktu', `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`) + stat('Pemain', s.players.length);
    if (activeTab === 'players') renderPlayers(s);
    if (activeTab === 'inv') renderInv(s);
  }

  function renderPlayers(s) {
    const wrap = $('#players');
    const sig = s.players.map((p) => p.name + p.ping).join();
    if (wrap.dataset.sig === sig) return;
    wrap.dataset.sig = sig;
    wrap.innerHTML = `<div class="note" style="margin-bottom:6px">${s.players.length} pemain online</div>`;
    s.players.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'player';
      row.innerHTML = `<img src="https://mc-heads.net/avatar/${encodeURIComponent(p.name)}/24" alt="" loading="lazy" /><span class="pn"></span><span class="pp">${p.ping} ms</span><button class="mini">/msg</button>`;
      $('.pn', row).textContent = p.name;
      $('.mini', row).onclick = () => { const i = $('#chatText'); i.value = `/msg ${p.name} `; i.focus(); };
      wrap.appendChild(row);
    });
  }

  function slotEl(it, idx) {
    const d = document.createElement('div');
    d.className = 'slot';
    d.dataset.idx = idx;
    if (it) {
      d.title = `${it.label} ×${it.count}`;
      const abbr = it.name.replace(/_/g, ' ').split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 3);
      d.innerHTML = `<span class="abbr">${abbr}</span>${it.count > 1 ? `<span class="cnt">${it.count}</span>` : ''}`;
    }
    return d;
  }
  function renderInv(s) {
    const inv = s.inventory || [];
    const sig = JSON.stringify(inv.slice(9, 45).map((i) => i && i.name + i.count)) + s.quickBar;
    if ($('#invMain').dataset.sig === sig) return;
    $('#invMain').dataset.sig = sig;
    const main = $('#invMain'), hot = $('#invHotbar');
    main.innerHTML = ''; hot.innerHTML = '';
    for (let i = 9; i < 36; i++) main.appendChild(slotEl(inv[i], i));
    for (let i = 36; i < 45; i++) {
      const el = slotEl(inv[i], i);
      if (i - 36 === s.quickBar) el.classList.add('sel');
      el.onclick = () => socket.emit('bot:hotbar', current, i - 36);
      hot.appendChild(el);
    }
  }

  // ------------------------------------------------------------ map
  const canvas = $('#mapCanvas'), ctx = canvas.getContext('2d');
  function shade(hex, dh) {
    const f = Math.max(.55, Math.min(1.35, 1 + dh * .035));
    const n = parseInt(hex.slice(1), 16);
    const c = (v) => Math.min(255, Math.round(v * f));
    return `rgb(${c(n >> 16 & 255)},${c(n >> 8 & 255)},${c(n & 255)})`;
  }
  function drawMap(m) {
    const W = canvas.width;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, W);
    if (!m) { ctx.fillStyle = '#777'; ctx.font = '16px Inter'; ctx.textAlign = 'center'; ctx.fillText('Tidak terhubung', W / 2, W / 2); return; }
    const size = m.radius * 2 + 1, px = W / size;
    for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
      const c = m.cells[z * size + x];
      if (!c) continue;
      ctx.fillStyle = shade(c[0], c[1]);
      ctx.fillRect(Math.floor(x * px), Math.floor(z * px), Math.ceil(px), Math.ceil(px));
    }
    const cx = W / 2;
    for (const e of m.entities) {
      const col = e.type === 'player' ? '#55ffff' : (e.type === 'hostile' || e.type === 'mob' || e.type === 'animal') ? '#ff5555' : '#ffff55';
      ctx.fillStyle = col; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx + e.dx * px, cx + e.dz * px, e.type === 'player' ? 5 : 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (e.type === 'player' && e.name) { ctx.font = '13px VT323, monospace'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(e.name, cx + e.dx * px, cx + e.dz * px - 8); }
    }
    // panah pemain (yaw mineflayer: 0 = utara (-Z), bertambah berlawanan jarum jam)
    ctx.save(); ctx.translate(cx, cx); ctx.rotate(-m.yaw);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 14px Inter'; ctx.textAlign = 'center'; ctx.fillText('N', cx, 20);
  }
  let mapBusy = false;
  setInterval(() => {
    if (activeTab !== 'map' || mapBusy || !current) return;
    if (accounts.get(current)?.status !== 'online') return drawMap(null);
    mapBusy = true;
    socket.emit('bot:map', current, (m) => { mapBusy = false; drawMap(m); });
  }, 1500);

  // ------------------------------------------------------------ 3D World Viewer (Three.js)
  const worldWrap = $('#worldWrap'), worldCanvas = $('#worldCanvas'), worldInfo = $('#worldInfo');
  let camMode = 'pov'; // 'pov' | 'orbit'
  let orbitYaw = 0.6, orbitPitch = 0.45, orbitDist = 10;
  let localYaw = 0, localPitch = 0, lastLookSync = 0;
  let wScene, wCamera, wRenderer, wWorldGroup, wEntityGroup, wSelfMesh;
  const matCache = new Map();
  let boxGeo;

  function makePixelTex(baseHex, kind = 'normal') {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const g = c.getContext('2d');
    const n = parseInt((baseHex || '#888888').slice(1), 16);
    const r = (n >> 16) & 255, gr = (n >> 8) & 255, b = n & 255;
    const clamp = (v) => Math.max(0, Math.min(255, v | 0));
    let seed = (r * 73 + gr * 151 + b * 29) | 1;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed & 0xffff) / 0xffff; };

    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        let d = (rnd() - 0.5) * 22;
        if (kind === 'planks' && (y % 4 === 0 || (x + (y >> 2) * 7) % 16 === 0)) d -= 24;
        if (kind === 'brick' && (y % 4 === 0 || ((x + (y >> 2) * 4) % 8 === 0))) d -= 28;
        if (kind === 'log' && (x % 3 === 0)) d -= 18;
        const border = (x === 0 || y === 0 || x === 15 || y === 15) ? -10 : 0;
        if (kind === 'grassSide' && y < 4 + ((x * 7) % 3)) {
          g.fillStyle = `rgb(${clamp(110 + d)},${clamp(174 + d)},${clamp(79 + d)})`;
        } else {
          g.fillStyle = `rgb(${clamp(r + d + border)},${clamp(gr + d + border)},${clamp(b + d + border)})`;
        }
        g.fillRect(x, y, 1, 1);
      }
    }
    if (kind === 'glass') {
      g.clearRect(1, 1, 14, 14);
      g.fillStyle = 'rgba(200,235,255,0.22)';
      g.fillRect(1, 1, 14, 14);
      g.fillStyle = 'rgba(255,255,255,0.65)';
      g.fillRect(3, 3, 2, 1); g.fillRect(3, 4, 1, 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
  }

  function getBlockMaterial(name, hex) {
    if (matCache.has(name)) return matCache.get(name);
    let mat;
    if (name === 'grass_block') {
      const top = new THREE.MeshLambertMaterial({ map: makePixelTex('#6fae4f', 'normal') });
      const bot = new THREE.MeshLambertMaterial({ map: makePixelTex('#866043', 'normal') });
      const side = new THREE.MeshLambertMaterial({ map: makePixelTex('#866043', 'grassSide') });
      mat = [side, side, top, bot, side, side];
    } else if (name.includes('glass')) {
      mat = new THREE.MeshLambertMaterial({ map: makePixelTex(hex, 'glass'), transparent: true, opacity: 0.55 });
    } else if (name.includes('water')) {
      mat = new THREE.MeshLambertMaterial({ color: 0x3f6fe0, transparent: true, opacity: 0.68 });
    } else if (name.includes('lava')) {
      mat = new THREE.MeshBasicMaterial({ map: makePixelTex('#ff661a', 'normal') });
    } else {
      const kind = name.includes('planks') ? 'planks' : (name.includes('brick') || name.includes('cobble')) ? 'brick' : name.includes('log') ? 'log' : 'normal';
      mat = new THREE.MeshLambertMaterial({ map: makePixelTex(hex, kind) });
    }
    matCache.set(name, mat);
    return mat;
  }

  function makeNameSprite(text, color = '#ffffff') {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = 'bold 28px monospace';
    const w = Math.min(248, g.measureText(text).width + 24);
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect((256 - w) / 2, 12, w, 38);
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text.slice(0, 18), 128, 31);
    const tex = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.scale.set(2.4, 0.6, 1);
    sp.renderOrder = 10;
    return sp;
  }

  function makeCharMesh(colorHex = 0x55ffff, label = '') {
    const grp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.35, 0.35), new THREE.MeshLambertMaterial({ color: colorHex }));
    body.position.y = 0.675;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshLambertMaterial({ color: 0xffd2a6 }));
    head.position.y = 1.6;
    grp.add(body, head);
    if (label) {
      const sp = makeNameSprite(label, colorHex === 0x55ffff ? '#55ffff' : '#ff9999');
      sp.position.y = 2.25;
      grp.add(sp);
    }
    return grp;
  }

  function initWorld3D() {
    if (wRenderer || typeof THREE === 'undefined') return;
    wScene = new THREE.Scene();
    wScene.background = new THREE.Color(0x78a7ff);
    wScene.fog = new THREE.FogExp2(0x78a7ff, 0.032);

    wCamera = new THREE.PerspectiveCamera(72, 1, 0.1, 80);
    wCamera.rotation.order = 'YXZ';

    wRenderer = new THREE.WebGLRenderer({ canvas: worldCanvas, antialias: false, powerPreference: 'high-performance' });
    wRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const amb = new THREE.AmbientLight(0xffffff, 0.72);
    const sun = new THREE.DirectionalLight(0xfff6e0, 0.65);
    sun.position.set(18, 32, 14);
    wScene.add(amb, sun);

    boxGeo = new THREE.BoxGeometry(1, 1, 1);
    wWorldGroup = new THREE.Group();
    wEntityGroup = new THREE.Group();
    wSelfMesh = makeCharMesh(0x55ff55, 'Kamu');
    wScene.add(wWorldGroup, wEntityGroup, wSelfMesh);

    const resize = () => {
      if (!worldWrap.clientWidth || !worldWrap.clientHeight) return;
      wCamera.aspect = worldWrap.clientWidth / worldWrap.clientHeight;
      wCamera.updateProjectionMatrix();
      wRenderer.setSize(worldWrap.clientWidth, worldWrap.clientHeight, false);
    };
    new ResizeObserver(resize).observe(worldWrap);
    resize();

    const loop = () => {
      requestAnimationFrame(loop);
      if (activeTab !== 'world' || !wRenderer) return;
      updateCameraTransform();
      wRenderer.render(wScene, wCamera);
    };
    requestAnimationFrame(loop);
  }

  let lastWorldData = null;
  function updateCameraTransform() {
    const off = lastWorldData?.offset || { x: 0.5, y: 0, z: 0.5 };
    wSelfMesh.position.set(off.x, off.y, off.z);
    wSelfMesh.rotation.y = localYaw;
    wSelfMesh.visible = camMode === 'orbit';
    $('#worldCrosshair').style.display = camMode === 'pov' ? '' : 'none';

    if (camMode === 'pov') {
      wCamera.position.set(off.x, off.y + 1.62, off.z);
      wCamera.rotation.y = localYaw;
      wCamera.rotation.x = localPitch;
    } else {
      const tx = off.x, ty = off.y + 1.2, tz = off.z;
      const cx = tx + Math.sin(orbitYaw) * Math.cos(orbitPitch) * orbitDist;
      const cy = ty + Math.sin(orbitPitch) * orbitDist;
      const cz = tz + Math.cos(orbitYaw) * Math.cos(orbitPitch) * orbitDist;
      wCamera.position.set(cx, cy, cz);
      wCamera.lookAt(tx, ty, tz);
    }
  }

  function updateWorld3D(data) {
    initWorld3D();
    if (!wScene) return;
    if (!data) {
      worldInfo.textContent = 'Tidak terhubung ke server';
      return;
    }
    const firstLoad = !lastWorldData;
    lastWorldData = data;
    if (firstLoad || Date.now() - lastLookSync > 1200) {
      localYaw = data.yaw || 0;
      localPitch = data.pitch || 0;
    }

    // Warna langit siang / malam
    const t = (data.time ?? 6000) % 24000;
    const isNight = t > 13000 && t < 23000;
    const skyHex = isNight ? 0x0b1021 : (t > 12000 || t > 23000) ? 0xd97b43 : 0x78a7ff;
    wScene.background.setHex(skyHex);
    wScene.fog.color.setHex(skyHex);

    // Rebuild instanced meshes per tipe blok
    while (wWorldGroup.children.length) {
      const ch = wWorldGroup.children.pop();
      ch.dispose?.();
    }
    const byType = new Map();
    for (const b of data.blocks) {
      const idx = b[3];
      if (!byType.has(idx)) byType.set(idx, []);
      byType.get(idx).push(b);
    }
    const dummy = new THREE.Object3D();
    for (const [idx, arr] of byType) {
      const [name, hex] = data.palette[idx];
      const mat = getBlockMaterial(name, hex);
      const inst = new THREE.InstancedMesh(boxGeo, mat, arr.length);
      for (let i = 0; i < arr.length; i++) {
        const [dx, dy, dz] = arr[i];
        dummy.position.set(dx + 0.5, dy + 0.5, dz + 0.5);
        dummy.scale.set(1, name.includes('carpet') ? 0.1 : name.includes('slab') ? 0.5 : 1, 1);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
      wWorldGroup.add(inst);
    }

    // Entities (pemain & mob sekitar)
    while (wEntityGroup.children.length) wEntityGroup.children.pop();
    for (const e of data.entities) {
      const col = e.type === 'player' ? 0x55ffff : (e.type === 'mob' || e.type === 'hostile') ? 0xff5555 : 0xffff55;
      const m = makeCharMesh(col, e.name);
      m.position.set(e.dx, e.dy, e.dz);
      m.rotation.y = e.yaw || 0;
      wEntityGroup.add(m);
    }

    worldInfo.textContent = `${data.blocks.length} blok · ${data.entities.length} objek sekitar`;
  }

  // Kontrol geser layar 3D (menengok / putar kamera)
  let dragging3D = false, lastPx = 0, lastPy = 0;
  worldCanvas.addEventListener('pointerdown', (e) => {
    dragging3D = true; lastPx = e.clientX; lastPy = e.clientY;
    worldCanvas.setPointerCapture(e.pointerId);
  });
  worldCanvas.addEventListener('pointermove', (e) => {
    if (!dragging3D) return;
    const dx = e.clientX - lastPx, dy = e.clientY - lastPy;
    lastPx = e.clientX; lastPy = e.clientY;
    if (camMode === 'pov') {
      const dYaw = -dx * 0.006, dPitch = -dy * 0.006;
      localYaw += dYaw;
      localPitch = Math.max(-1.5, Math.min(1.5, localPitch + dPitch));
      lastLookSync = Date.now();
      if (current && accounts.get(current)?.status === 'online') {
        socket.emit('bot:look2d', current, dYaw, dPitch);
      }
    } else {
      orbitYaw -= dx * 0.008;
      orbitPitch = Math.max(-1.2, Math.min(1.4, orbitPitch + dy * 0.008));
    }
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) =>
    worldCanvas.addEventListener(ev, () => { dragging3D = false; })
  );
  worldCanvas.addEventListener('wheel', (e) => {
    if (camMode === 'orbit') {
      e.preventDefault();
      orbitDist = Math.max(3, Math.min(28, orbitDist + (e.deltaY > 0 ? 1.2 : -1.2)));
    }
  }, { passive: false });

  $('#btnCamPov').onclick = () => { camMode = 'pov'; $('#btnCamPov').classList.add('active'); $('#btnCamOrbit').classList.remove('active'); };
  $('#btnCamOrbit').onclick = () => { camMode = 'orbit'; $('#btnCamOrbit').classList.add('active'); $('#btnCamPov').classList.remove('active'); };
  $('#btnWorldFs').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (worldWrap.requestFullscreen) worldWrap.requestFullscreen().catch(() => worldWrap.classList.toggle('fs'));
    else worldWrap.classList.toggle('fs');
  };
  $('#btnActSwing').onclick = () => current && socket.emit('bot:action', current, 'swing');
  $('#btnActUse').onclick = () => current && socket.emit('bot:action', current, 'use');

  let worldBusy = false;
  function pollWorld3D() {
    if (activeTab !== 'world' || worldBusy || !current) return;
    if (accounts.get(current)?.status !== 'online') return updateWorld3D(null);
    worldBusy = true;
    socket.emit('bot:world3d', current, (d) => { worldBusy = false; updateWorld3D(d); });
  }
  setInterval(pollWorld3D, 900);

  // ------------------------------------------------------------ panel tabs
  $('#panelTabs').onclick = (e) => {
    const t = e.target.closest('.tab'); if (!t) return;
    activeTab = t.dataset.tab;
    $$('#panelTabs .tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === activeTab));
    $('#players').dataset.sig = ''; $('#invMain').dataset.sig = '';
    if (lastState) renderState(lastState);
    if (activeTab === 'map' && accounts.get(current)?.status !== 'online') drawMap(null);
    if (activeTab === 'world') pollWorld3D();
  };

  // ------------------------------------------------------------ movement
  const held = new Set();
  function control(ctl, on) {
    if (!current) return;
    if (ctl === 'look-left' || ctl === 'look-right') { if (on) socket.emit('bot:look', current, ctl === 'look-left' ? Math.PI / 8 : -Math.PI / 8); return; }
    if (on === held.has(ctl)) return;
    on ? held.add(ctl) : held.delete(ctl);
    $$(`.dpad [data-ctl="${ctl}"], .mini-move [data-ctl="${ctl}"]`).forEach((b) => b.classList.toggle('on', on));
    socket.emit('bot:control', current, ctl, on);
  }
  $$('.dpad button, .mini-move button').forEach((b) => {
    const ctl = b.dataset.ctl;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); control(ctl, true); });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => b.addEventListener(ev, () => control(ctl, false)));
  });
  const KEYS = { KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right', Space: 'jump', ShiftLeft: 'sneak', ControlLeft: 'sprint', KeyQ: 'look-left', KeyE: 'look-right' };
  const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  document.addEventListener('keydown', (e) => {
    if (typing() || !$('#accModal').hidden) return;
    if (e.key === 't' || e.key === '/') { e.preventDefault(); $('#chatText').focus(); if (e.key === '/') $('#chatText').value = '/'; return; }
    const c = KEYS[e.code]; if (!c) return;
    e.preventDefault(); if (!e.repeat) control(c, true);
  });
  document.addEventListener('keyup', (e) => { const c = KEYS[e.code]; if (c) control(c, false); });
  window.addEventListener('blur', () => [...held].forEach((c) => control(c, false)));
  $('#btnRespawn').onclick = () => current && socket.emit('bot:respawn', current);

  // ------------------------------------------------------------ connect button
  $('#btnConnect').onclick = () => {
    const a = accounts.get(current); if (!a) return;
    socket.emit(a.status === 'offline' ? 'bot:start' : 'bot:stop', current);
  };

  // ------------------------------------------------------------ account modal
  const modal = $('#accModal'), form = $('#accForm');
  let editingId = null;
  function schedRow(s = { cmd: '', interval: 300 }) {
    const r = document.createElement('div');
    r.className = 'sched-row';
    r.innerHTML = `<input class="c" placeholder="/perintah atau pesan" /><input class="iv" type="number" min="1" title="interval (detik)" /><span class="note">dtk</span><button type="button">✕</button>`;
    $('.c', r).value = s.cmd; $('.iv', r).value = s.interval;
    $('button', r).onclick = () => r.remove();
    $('#schedList').appendChild(r);
  }
  function syncAuthFields() {
    const ms = form.auth.value === 'microsoft';
    $$('.offline-only', form).forEach((e) => (e.style.display = ms ? 'none' : ''));
    $$('.ms-only', form).forEach((e) => (e.style.display = ms ? '' : 'none'));
    $('#userLbl').textContent = ms ? 'Email / nama profil (untuk cache login)' : 'Username';
  }
  form.auth.onchange = syncAuthFields;

  function openModal(id) {
    editingId = id;
    const cfg = id ? accounts.get(id).cfg : { port: 25565, auth: 'offline', autoReconnect: true, reconnectDelay: 10, antiAfk: false, afkInterval: 30, notifyDamage: true, scheduled: [], keywords: [] };
    $('#accModalTitle').textContent = id ? 'Pengaturan Akun' : 'Tambah Akun';
    $('#btnDelete').style.display = id ? '' : 'none';
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') el.checked = !!cfg[el.name];
      else if (el.name === 'keywords') el.value = (cfg.keywords || []).join(', ');
      else el.value = cfg[el.name] ?? '';
    }
    $('#schedList').innerHTML = '';
    (cfg.scheduled || []).forEach(schedRow);
    syncAuthFields();
    modal.hidden = false;
  }
  $('#btnAdd').onclick = () => { openModal(null); closeSidebar(); };
  $('#btnEdit').onclick = () => current && openModal(current);
  $('#btnAddSched').onclick = () => schedRow();
  $$('[data-close]').forEach((b) => (b.onclick = () => (b.closest('.modal').hidden = true)));

  form.onsubmit = (e) => {
    e.preventDefault();
    const cfg = editingId ? { ...accounts.get(editingId).cfg } : {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') cfg[el.name] = el.checked;
      else if (el.type === 'number') cfg[el.name] = Number(el.value);
      else cfg[el.name] = el.value.trim();
    }
    cfg.keywords = cfg.keywords.split(',').map((s) => s.trim()).filter(Boolean);
    cfg.scheduled = $$('.sched-row').map((r) => ({ cmd: $('.c', r).value.trim(), interval: Number($('.iv', r).value) })).filter((s) => s.cmd && s.interval > 0);
    socket.emit('account:save', cfg, (id) => { modal.hidden = true; select(id); toast('Akun disimpan ✔'); });
  };
  $('#btnDelete').onclick = () => {
    if (!editingId || !confirm('Hapus akun ini?')) return;
    socket.emit('account:delete', editingId);
    modal.hidden = true;
  };

  // ------------------------------------------------------------ MSA
  $('#btnCopyCode').onclick = () => navigator.clipboard?.writeText($('#msaCode').textContent).then(() => toast('Kode disalin'));

  // ------------------------------------------------------------ socket events
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') { $('#authModal').hidden = false; $('#authPass').focus(); }
  });
  $('#authForm').onsubmit = (e) => {
    e.preventDefault();
    localStorage.setItem('cc_pass', $('#authPass').value);
    socket.auth.password = $('#authPass').value;
    $('#authModal').hidden = true;
    socket.connect();
  };
  socket.on('disconnect', () => toast('Koneksi ke server web terputus...', 'alert'));

  socket.on('accounts', (list) => {
    accounts.clear();
    list.forEach((a) => accounts.set(a.cfg.id, { cfg: a.cfg, status: a.status, reconnectAt: a.reconnectAt, username: a.username }));
    if (!accounts.has(current)) current = accounts.size ? accounts.keys().next().value : null;
    renderAccounts(); renderHeader();
    if (current && !logs.has(current)) select(current);
    if (!current) select(null);
  });

  socket.on('status', (id, st) => {
    const a = accounts.get(id); if (!a) return;
    Object.assign(a, st);
    if (st.status !== 'online' && id === current) { renderState(null); [...held].forEach((c) => control(c, false)); }
    renderAccounts(); if (id === current) renderHeader();
  });

  socket.on('chat', (id, entry) => {
    if (!logs.has(id)) logs.set(id, []);
    const arr = logs.get(id); arr.push(entry); if (arr.length > 500) arr.shift();
    const a = accounts.get(id);
    if (isKeywordHit(entry, a?.cfg)) notify(`Kata kunci · ${a ? accName(a) : ''}`, stripCodes(entry.text).slice(0, 140), 'kw');
    if (id === current) {
      const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 60;
      chatLog.appendChild(lineEl(entry));
      while (chatLog.childElementCount > 500) chatLog.firstChild.remove();
      if (atBottom) chatLog.scrollTop = chatLog.scrollHeight;
    } else if (entry.kind === 'chat') {
      unread.set(id, (unread.get(id) || 0) + 1); renderAccounts();
    }
  });

  socket.on('alert', (id, al) => {
    const a = accounts.get(id);
    notify(a ? accName(a) : 'ChatCraft', al.text, 'alert');
  });

  socket.on('state', (id, s) => { if (id === current) renderState(s); });

  socket.on('msa', (id, d) => {
    $('#msaCode').textContent = d.code;
    $('#msaLink').href = d.uri; $('#msaLink').textContent = d.uri.replace(/^https?:\/\//, '');
    $('#msaModal').hidden = false;
  });
})();
