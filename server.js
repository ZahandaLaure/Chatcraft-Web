/**
 * ChatCraft Web Client — server
 * Menjembatani browser <-> server Minecraft (Java Edition) memakai mineflayer + socket.io.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');

const PORT = Number(process.env.PORT) || 3000;
// Jika dijalankan di hosting (PORT diset otomatis oleh cloud), otomatis gunakan 0.0.0.0.
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
// Opsional: password untuk membuka web (wajib diset saat di-hosting di internet!).
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const AUTH_DIR = path.join(DATA_DIR, 'auth-cache');
fs.mkdirSync(AUTH_DIR, { recursive: true });

// ---------------------------------------------------------------- storage
function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { return []; }
}
function saveAccounts() {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify([...sessions.values()].map((s) => s.cfg), null, 2));
}

const DEFAULT_CFG = {
  label: '',
  host: '',
  port: 25565,
  username: '',
  auth: 'offline',          // 'offline' (non-premium / cracked) | 'microsoft' (premium)
  version: '',              // '' = deteksi otomatis
  loginPassword: '',        // auto /login untuk server non-premium (AuthMe dll.)
  autoReconnect: true,
  reconnectDelay: 10,       // detik
  antiAfk: false,
  afkInterval: 30,          // detik
  scheduled: [],            // [{ cmd, interval }]
  keywords: [],             // kata kunci notifikasi (diproses di browser)
  notifyDamage: true,
};

// ---------------------------------------------------------------- helpers
/** Ubah komponen chat JSON / string menjadi teks polos. */
function flattenText(v) {
  if (v == null) return '';
  if (typeof v === 'string') {
    try { return flattenText(JSON.parse(v)); } catch { return v; }
  }
  if (Array.isArray(v)) return v.map(flattenText).join('');
  if (typeof v === 'object') {
    if (v.value !== undefined && v.type) return flattenText(v.value); // NBT
    let t = v.text ?? v.translate ?? '';
    if (v.with) t += ' ' + v.with.map(flattenText).join(' ');
    if (v.extra) t += v.extra.map(flattenText).join('');
    return typeof t === 'string' ? t : flattenText(t);
  }
  return String(v);
}

function blockColor(name) {
  const n = name;
  if (n.includes('water') || n === 'kelp' || n === 'seagrass' || n === 'bubble_column') return '#3f6fe0';
  if (n.includes('lava')) return '#e0661a';
  if (n === 'grass_block' || n === 'short_grass' || n === 'grass' || n === 'tall_grass' || n === 'fern') return '#6fae4f';
  if (n.includes('leaves')) return '#3f8a2f';
  if (n.includes('snow') || n === 'powder_snow') return '#f2f6f8';
  if (n.includes('ice')) return '#9cc3f5';
  if (n.includes('sand') && !n.includes('stone')) return n.includes('red') ? '#c46b2c' : '#ddd4a0';
  if (n.includes('sandstone')) return '#d8cb92';
  if (n.includes('log') || n.includes('wood') || n.includes('stem')) return '#6b5132';
  if (n.includes('planks') || n.includes('fence') || n.includes('door') || n.includes('chest') || n.includes('crafting')) return '#a2834f';
  if (n.includes('dirt') || n === 'farmland' || n === 'podzol' || n === 'mud' || n.includes('path')) return '#866043';
  if (n.includes('gravel')) return '#8a8380';
  if (n.includes('clay')) return '#a0a6b3';
  if (n.includes('terracotta')) return '#a05a3a';
  if (n.includes('netherrack') || n.includes('nylium') || n.includes('crimson')) return '#7a2f2f';
  if (n.includes('warped')) return '#2b7a73';
  if (n.includes('end_stone')) return '#dbe0a2';
  if (n.includes('obsidian')) return '#1c1530';
  if (n.includes('glass')) return '#c4e2ef';
  if (n.includes('flower') || n.includes('rose') || n.includes('tulip') || n === 'dandelion' || n === 'poppy') return '#d8504f';
  if (n.includes('wool') || n.includes('concrete') || n.includes('carpet')) {
    const c = { white: '#e9ecec', orange: '#f07613', magenta: '#bd44b3', light_blue: '#3aafd9', yellow: '#f8c627', lime: '#70b919',
      pink: '#ed8dac', gray: '#3e4447', light_gray: '#8e8e86', cyan: '#158991', purple: '#792aac', blue: '#35399d', brown: '#724728',
      green: '#546d1b', red: '#a12722', black: '#141519' };
    const key = Object.keys(c).sort((a, b) => b.length - a.length).find((k) => n.startsWith(k));
    if (key) return c[key];
  }
  if (n.includes('stone') || n.includes('ore') || n.includes('cobble') || n.includes('andesite') || n.includes('diorite')
    || n.includes('granite') || n.includes('deepslate') || n.includes('tuff') || n.includes('brick') || n === 'bedrock') return '#7d7d7d';
  return '#9a9a9a';
}
const AIR = new Set(['air', 'cave_air', 'void_air', 'light', 'barrier', 'structure_void']);

// ---------------------------------------------------------------- session
class Session {
  constructor(cfg) {
    this.cfg = { ...DEFAULT_CFG, ...cfg };
    this.bot = null;
    this.status = 'offline'; // offline | connecting | online | reconnecting
    this.log = [];
    this.timers = [];
    this.manualStop = true;
    this.reconnectTimer = null;
    this.reconnectAt = 0;
  }
  get id() { return this.cfg.id; }

  emit(ev, data) { io.emit(ev, this.id, data); }
  add(kind, text) {
    const entry = { t: Date.now(), kind, text };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    this.emit('chat', entry);
  }
  sys(text) { this.add('system', text); }
  alert(type, text) { this.add('alert', text); this.emit('alert', { type, text }); }
  setStatus(status) {
    this.status = status;
    io.emit('status', this.id, this.publicStatus());
  }
  publicStatus() {
    return { status: this.status, reconnectAt: this.reconnectAt, username: this.bot?.username || null };
  }

  start() {
    if (this.bot) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectAt = 0;
    this.manualStop = false;
    const c = this.cfg;
    if (!c.host || !c.username) return this.sys('Host dan username wajib diisi.');

    this.setStatus('connecting');
    this.sys(`Menghubungkan ke ${c.host}:${c.port || 25565} sebagai ${c.username}...`);

    const opts = {
      host: c.host.trim(),
      port: Number(c.port) || 25565,
      username: c.username.trim(),
      auth: c.auth === 'microsoft' ? 'microsoft' : 'offline',
      profilesFolder: AUTH_DIR,
      hideErrors: true,
      checkTimeoutInterval: 60_000,
      viewDistance: 'tiny',
    };
    if (c.version) opts.version = c.version.trim();
    if (opts.auth === 'microsoft') {
      opts.onMsaCode = (d) => {
        this.emit('msa', { code: d.user_code, uri: d.verification_uri });
        this.sys(`Login Microsoft: buka ${d.verification_uri} lalu masukkan kode ${d.user_code}`);
      };
    }

    let bot;
    try { bot = mineflayer.createBot(opts); } catch (e) {
      this.sys('Gagal membuat koneksi: ' + e.message);
      this.setStatus('offline');
      return this.scheduleReconnect();
    }
    this.bot = bot;

    bot.once('login', () => { this.setStatus('online'); this.sys('✔ Terhubung ke server.'); });
    bot.once('spawn', () => {
      if (c.loginPassword) setTimeout(() => this.bot === bot && bot.chat(`/login ${c.loginPassword}`), 1500);
      this.startTimers();
    });
    bot.on('message', (msg, position) => {
      if (position === 'game_info') return; // action bar
      let motd;
      try { motd = msg.toMotd(); } catch { motd = msg.toString(); }
      if (motd.trim()) this.add('chat', motd);
    });
    bot.on('entityHurt', (e) => {
      if (e === bot.entity && this.cfg.notifyDamage) this.alert('hurt', `⚠ Karakter diserang! HP: ${Math.max(0, Math.round(bot.health))}/20`);
    });
    bot.on('death', () => this.alert('death', '☠ Karakter mati. Respawn otomatis...'));
    bot.on('kicked', (reason) => this.alert('kick', 'Dikeluarkan dari server: ' + flattenText(reason)));
    bot.on('error', (err) => this.sys('Error: ' + (err?.message || err)));
    bot.on('end', (reason) => {
      this.stopTimers();
      this.bot = null;
      this.sys('Terputus dari server' + (reason ? ` (${reason})` : '') + '.');
      this.setStatus('offline');
      if (!this.manualStop) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.manualStop || !this.cfg.autoReconnect) return;
    const delay = Math.max(3, Number(this.cfg.reconnectDelay) || 10);
    this.reconnectAt = Date.now() + delay * 1000;
    this.setStatus('reconnecting');
    this.sys(`Menyambung ulang dalam ${delay} detik...`);
    this.reconnectTimer = setTimeout(() => this.start(), delay * 1000);
  }

  stop() {
    this.manualStop = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectAt = 0;
    if (this.bot) this.bot.quit('Disconnected');
    else this.setStatus('offline');
  }

  startTimers() {
    this.stopTimers();
    const bot = this.bot;
    if (!bot) return;
    // status ke browser tiap detik
    this.timers.push(setInterval(() => this.emit('state', this.snapshot()), 1000));
    // Anti-AFK: tengok, lompat, ayun tangan
    if (this.cfg.antiAfk) {
      const sec = Math.max(5, Number(this.cfg.afkInterval) || 30);
      this.timers.push(setInterval(() => {
        try {
          bot.look(bot.entity.yaw + (Math.random() - 0.5) * 2, 0, false);
          bot.swingArm();
          bot.setControlState('jump', true);
          setTimeout(() => bot.setControlState('jump', false), 400);
        } catch { /* ignore */ }
      }, sec * 1000));
    }
    // Perintah terjadwal
    for (const s of this.cfg.scheduled || []) {
      const sec = Number(s.interval);
      if (!s.cmd || !(sec >= 1)) continue;
      this.timers.push(setInterval(() => { try { bot.chat(s.cmd); } catch { /* ignore */ } }, sec * 1000));
    }
  }
  stopTimers() { this.timers.forEach(clearInterval); this.timers = []; }

  snapshot() {
    const b = this.bot;
    if (!b || !b.entity) return null;
    const p = b.entity.position;
    return {
      health: b.health, food: b.food, xp: b.experience?.level ?? 0,
      pos: { x: p.x, y: p.y, z: p.z }, yaw: b.entity.yaw,
      dimension: b.game?.dimension, gameMode: b.game?.gameMode,
      time: b.time?.timeOfDay,
      players: Object.values(b.players).map((pl) => ({ name: pl.username, ping: pl.ping })).sort((a, z) => a.name.localeCompare(z.name)),
      inventory: b.inventory.slots.map((it) => it && { slot: it.slot, name: it.name, label: it.displayName, count: it.count }),
      quickBar: b.quickBarSlot,
    };
  }

  map(radius = 32) {
    const b = this.bot;
    if (!b || !b.entity) return null;
    const p = b.entity.position.floored();
    const size = radius * 2 + 1;
    const cells = new Array(size * size).fill(null);
    const v = new Vec3(0, 0, 0);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let y = p.y + 12; y > p.y - 32; y--) {
          const blk = b.blockAt(v.set(p.x + dx, y, p.z + dz), false);
          if (!blk) break;
          if (!AIR.has(blk.name)) { cells[(dz + radius) * size + dx + radius] = [blockColor(blk.name), y - p.y]; break; }
        }
      }
    }
    const entities = Object.values(b.entities)
      .filter((e) => e !== b.entity && e.position && Math.abs(e.position.x - p.x) <= radius && Math.abs(e.position.z - p.z) <= radius)
      .map((e) => ({ type: e.type, name: e.username || e.name, dx: e.position.x - b.entity.position.x, dz: e.position.z - b.entity.position.z }));
    return { radius, cells, entities, yaw: b.entity.yaw };
  }

  world3d(radius = 12, vRadius = 8) {
    const b = this.bot;
    if (!b || !b.entity) return null;
    const pos = b.entity.position;
    const p = pos.floored();
    const palette = [];
    const palMap = new Map();
    const blocks = [];
    const v = new Vec3(0, 0, 0);
    const n = new Vec3(0, 0, 0);
    const TRANSPARENT = new Set([...AIR, 'water', 'lava', 'glass', 'glass_pane', 'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'cherry_leaves', 'mangrove_leaves', 'azalea_leaves', 'short_grass', 'tall_grass', 'fern', 'torch', 'wall_torch', 'soul_torch', 'lantern', 'chest', 'ender_chest', 'trapped_chest', 'oak_fence', 'iron_bars', 'ladder', 'vine']);
    const isTrans = (blk) => !blk || AIR.has(blk.name) || TRANSPARENT.has(blk.name) || blk.name.includes('glass') || blk.name.includes('leaves') || blk.name.includes('slab') || blk.name.includes('stairs') || blk.name.includes('fence') || blk.name.includes('carpet') || blk.name.includes('head') || blk.name.includes('skull');

    for (let dy = -vRadius; dy <= vRadius + 2; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const blk = b.blockAt(v.set(p.x + dx, p.y + dy, p.z + dz), false);
          if (!blk || AIR.has(blk.name)) continue;
          // Hanya kirim blok yang punya minimal 1 sisi terbuka/transparan agar ringan
          const exposed =
            isTrans(b.blockAt(n.set(v.x + 1, v.y, v.z), false)) ||
            isTrans(b.blockAt(n.set(v.x - 1, v.y, v.z), false)) ||
            isTrans(b.blockAt(n.set(v.x, v.y + 1, v.z), false)) ||
            isTrans(b.blockAt(n.set(v.x, v.y - 1, v.z), false)) ||
            isTrans(b.blockAt(n.set(v.x, v.y, v.z + 1), false)) ||
            isTrans(b.blockAt(n.set(v.x, v.y, v.z - 1), false));
          if (!exposed) continue;

          let idx = palMap.get(blk.name);
          if (idx === undefined) {
            idx = palette.length;
            palette.push([blk.name, blockColor(blk.name)]);
            palMap.set(blk.name, idx);
          }
          blocks.push([dx, dy, dz, idx]);
        }
      }
    }

    const entities = Object.values(b.entities)
      .filter((e) => e !== b.entity && e.position && Math.abs(e.position.x - pos.x) <= radius + 2 && Math.abs(e.position.z - pos.z) <= radius + 2 && Math.abs(e.position.y - pos.y) <= vRadius + 4)
      .map((e) => ({
        id: e.id,
        type: e.type,
        name: e.username || e.displayName || e.name || 'Entity',
        dx: +(e.position.x - p.x).toFixed(2),
        dy: +(e.position.y - p.y).toFixed(2),
        dz: +(e.position.z - p.z).toFixed(2),
        yaw: +(e.yaw || 0).toFixed(2),
      }));

    return {
      offset: { x: +(pos.x - p.x).toFixed(2), y: +(pos.y - p.y).toFixed(2), z: +(pos.z - p.z).toFixed(2) },
      yaw: b.entity.yaw,
      pitch: b.entity.pitch,
      time: b.time?.timeOfDay ?? 6000,
      palette,
      blocks,
      entities,
    };
  }
}

// ---------------------------------------------------------------- app
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
for (const cfg of loadAccounts()) sessions.set(cfg.id, new Session(cfg));

const listAccounts = () => [...sessions.values()].map((s) => ({ cfg: s.cfg, ...s.publicStatus() }));

io.use((socket, next) => {
  if (!ACCESS_PASSWORD || socket.handshake.auth?.password === ACCESS_PASSWORD) return next();
  next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  socket.emit('accounts', listAccounts());

  socket.on('account:save', (cfg, cb) => {
    const id = cfg.id || 'acc_' + Date.now().toString(36);
    const clean = { ...DEFAULT_CFG, ...cfg, id };
    clean.port = Number(clean.port) || 25565;
    clean.scheduled = (clean.scheduled || []).filter((s) => s && s.cmd);
    clean.keywords = (clean.keywords || []).map((k) => String(k).trim()).filter(Boolean);
    const existing = sessions.get(id);
    if (existing) {
      existing.cfg = clean;
      if (existing.bot?.entity) existing.startTimers(); // terapkan ulang AFK & jadwal
    } else sessions.set(id, new Session(clean));
    saveAccounts();
    io.emit('accounts', listAccounts());
    cb && cb(id);
  });

  socket.on('account:delete', (id) => {
    const s = sessions.get(id);
    if (!s) return;
    s.stop();
    sessions.delete(id);
    saveAccounts();
    io.emit('accounts', listAccounts());
  });

  socket.on('bot:start', (id) => sessions.get(id)?.start());
  socket.on('bot:stop', (id) => sessions.get(id)?.stop());
  socket.on('bot:history', (id, cb) => cb && cb(sessions.get(id)?.log || []));
  socket.on('bot:state', (id, cb) => cb && cb(sessions.get(id)?.snapshot() || null));
  socket.on('bot:map', (id, cb) => { try { cb && cb(sessions.get(id)?.map() || null); } catch { cb && cb(null); } });
  socket.on('bot:world3d', (id, cb) => { try { cb && cb(sessions.get(id)?.world3d() || null); } catch { cb && cb(null); } });

  socket.on('bot:chat', (id, text) => {
    const s = sessions.get(id);
    if (!s?.bot || typeof text !== 'string' || !text.trim()) return;
    try { s.bot.chat(text.slice(0, 256)); } catch (e) { s.sys('Gagal mengirim: ' + e.message); }
  });

  const CONTROLS = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']);
  socket.on('bot:control', (id, control, state) => {
    const b = sessions.get(id)?.bot;
    if (b && CONTROLS.has(control)) b.setControlState(control, !!state);
  });
  socket.on('bot:look', (id, dYaw) => {
    const b = sessions.get(id)?.bot;
    if (b?.entity) b.look(b.entity.yaw + Number(dYaw || 0), b.entity.pitch || 0, true);
  });
  socket.on('bot:look2d', (id, dYaw, dPitch) => {
    const b = sessions.get(id)?.bot;
    if (!b?.entity) return;
    const pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, (b.entity.pitch || 0) + Number(dPitch || 0)));
    b.look(b.entity.yaw + Number(dYaw || 0), pitch, true);
  });
  socket.on('bot:action', (id, act) => {
    const b = sessions.get(id)?.bot;
    if (!b?.entity) return;
    try {
      if (act === 'swing') {
        const ent = b.nearestEntity((e) => (e.type === 'mob' || e.type === 'player' || e.type === 'hostile') && b.entity.position.distanceTo(e.position) < 4);
        if (ent) b.attack(ent);
        else b.swingArm();
      } else if (act === 'use') {
        const blk = b.blockAtCursor?.(4);
        if (blk) b.activateBlock(blk).catch(() => b.activateItem());
        else b.activateItem();
      }
    } catch { /* ignore */ }
  });
  socket.on('bot:hotbar', (id, slot) => {
    const b = sessions.get(id)?.bot;
    if (b?.entity && slot >= 0 && slot <= 8) b.setQuickBarSlot(slot);
  });
  socket.on('bot:respawn', (id) => { try { sessions.get(id)?.bot?.respawn(); } catch { /* ignore */ } });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ChatCraft Web Client berjalan di  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  if (HOST === '0.0.0.0') console.log('  Bisa dibuka dari HP di jaringan Wi-Fi yang sama (pakai IP komputer ini).\n');
});

// Keep-alive otomatis untuk Codespaces (output terminal berkala) & hosting gratis
setInterval(() => {
  const activeCount = [...sessions.values()].filter((s) => s.status !== 'offline').length;
  console.log(`[KeepAlive ${new Date().toLocaleTimeString()}] Server aktif (${activeCount} akun berjalan)`);
}, 5 * 60 * 1000);

const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '';
if (EXTERNAL_URL) {
  setInterval(() => {
    fetch(`${EXTERNAL_URL.replace(/\/$/, '')}/healthz`).catch(() => {});
  }, 10 * 60 * 1000);
}

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
