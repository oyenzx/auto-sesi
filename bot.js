const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

// === INTEGRASI MODUL CRYPTO & API DARI BOT.JS ===
const fetch = require('node-fetch');
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');
const nacl = require('tweetnacl');

const SESSION_PATH = path.join(__dirname, 'session.json');

let HttpProxyAgent, SocksProxyAgent;
try {
  HttpProxyAgent = require('http-proxy-agent').HttpProxyAgent;
  SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
} catch (e) {
  console.error("[ERROR] Modul proxy agent tambahan belum diinstal. Jalankan: npm install http-proxy-agent socks-proxy-agent");
  process.exit(1);
}

function loadJsonConfig(fileName) {
  try {
    const filePath = path.join(__dirname, fileName);
    if (!fs.existsSync(filePath) && fileName === 'session.json') return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`[ERROR] Gagal membaca atau parse file ${fileName}:`, error.message);
    process.exit(1);
  }
}

function loadProxyList(fileName) {
  try {
    const filePath = path.join(__dirname, fileName);
    if (!fs.existsSync(filePath)) {
      console.log(`[WARN] File ${fileName} tidak ditemukan. Failover proxy dilewati.`);
      return [];
    }
    const data = fs.readFileSync(filePath, 'utf8');
    return data.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        if (line.includes('://')) return line;
        const parts = line.split(':');
        if (parts.length === 4) {
          const [ip, port, user, pass] = parts;
          return `socks5://${user}:${pass}@${ip}:${port}`;
        }
        if (parts.length === 2) {
          return `socks5://${line}`;
        }
        return line;
      });
  } catch (error) {
    console.error(`[ERROR] Gagal membaca file ${fileName}:`, error.message);
    return [];
  }
}

// === LOAD KEYPAIR AUTOMATICALLY FROM WALLET.JSON ===
function loadKeypair() {
  const walletFile = loadJsonConfig('wallet.json');
  const secretString = walletFile?.wallet || '';

  if (!secretString || secretString.includes('your secret phrase')) {
    console.error('❌ [ERROR] Silakan isi wallet.json Anda terlebih dahulu dengan Private Key Base58 Solana!');
    process.exit(1);
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(secretString.trim()));
  } catch (e) {
    console.error('❌ [ERROR] Format wallet.json tidak valid. Pastikan menggunakan Base58 Private Key.');
    process.exit(1);
  }
}

const config    = loadJsonConfig('wallet-config.json');
const botConfig = loadJsonConfig('bot-config.json');
const globalProxyList = loadProxyList('free-proxy-list.txt');

const keypair = loadKeypair();
const WALLET_ADDRESS = keypair.publicKey.toBase58();
console.log(`[WALLET] Auto-detected Address: ${WALLET_ADDRESS}`);

const ENABLE_SKILL   = (botConfig.autoSkill && botConfig.autoSkill.aktif || 'Y').toUpperCase() === 'Y';
const SKILL_PRIORITY = (botConfig.autoSkill && botConfig.autoSkill.prioritas) || ['str', 'agi', 'vit'];
const TILE_TO_WORLD = 64;

// === INTEGRASI AUTO-LOGIN API MENGGUNAKAN ACTIVE PROXY ===
async function doLogin(agent) {
  console.log('[AUTH] Meminta session token baru dari API...');
  const timestamp = Math.floor(Date.now() / 1000);
  const messageStr = `Sign in to Islands.games\nTimestamp: ${timestamp}`;
  const messageBytes = Buffer.from(messageStr);
  
  const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
  const signatureBase58 = bs58.encode(signatureBytes);

  const loginPayload = { walletAddress: WALLET_ADDRESS, timestamp, signature: signatureBase58 };
  const serverUrl = config.gameServer?.url || 'wss://game.islands.games';
  const apiUrl = serverUrl.replace('ws://', 'http://').replace('wss://', 'https://') + '/api/auth/connect';

  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(loginPayload)
  };
  if (agent) options.agent = agent; // Menggunakan proxy aktif yang sama dengan WS

  const res = await fetch(apiUrl, options);
  const data = await res.json();

  if (!res.ok || !data.sessionToken) {
    throw new Error(data.message || 'Gagal mendapatkan session token');
  }

  fs.writeFileSync(SESSION_PATH, JSON.stringify({
    walletAddress: WALLET_ADDRESS,
    sessionToken: data.sessionToken,
    username: data.username || 'IslandsBot'
  }, null, 2));

  console.log(`[AUTH] Login Berhasil! Username: ${data.username || 'IslandsBot'}`);
  return data;
}

class GameBot {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.player = { id: null, x: 16000, y: 16000, facing: 1, boat: false, bd: 'right', vcx: 16000, vcy: 16000, vr: 3275 };
    this.inventory = { wood: 0 };
    this.xp        = { level: 1, free: 0, speedMult: 1 };
    this.world     = { mobs: [] }; 
    this.currentTargetMobId = null; 
    this.isMoving           = false;
    this.searchAngle = 0;
    this.searchRadius = 250; 
    this.stateInterval  = null;
    this.attackInterval = null;
    this.sessionKills  = 0;
    this.totalAttacks  = 0;
    this.totalSkillUps = 0;
    this._running = false;
    this._pingTimer = null;
    this.currentProxyIndex = -1; 
    
    // Simpan data auth dinamis di class instansiasi
    this.sessionToken = null;
    this.botName = 'IslandsBot';
  }

  getProxyAgent(proxyUrl) {
    if (!proxyUrl) return null;
    try {
      if (proxyUrl.startsWith('socks')) {
        return new SocksProxyAgent(proxyUrl);
      } else if (proxyUrl.startsWith('https')) {
        return new HttpsProxyAgent(proxyUrl);
      } else {
        return new HttpProxyAgent(proxyUrl);
      }
    } catch (err) {
      console.error(`[PROXY ERROR] Gagal membuat agent untuk ${proxyUrl}:`, err.message);
      return null;
    }
  }

  async connect() {
    // 1. Tentukan proxy yang aktif terlebih dahulu sebelum proses login & WS
    let activeProxy = null;
    if (config.proxy && this.currentProxyIndex === -1) {
      activeProxy = config.proxy;
      console.log(`[BOT] Menggunakan Proxy Utama (wallet-config.json): ${activeProxy}`);
    } else if (globalProxyList.length > 0) {
      if (this.currentProxyIndex < 0 || this.currentProxyIndex >= globalProxyList.length) {
        this.currentProxyIndex = 0;
      }
      activeProxy = globalProxyList[this.currentProxyIndex];
      const safeLog = activeProxy.replace(/\/\/(.*):(.*)@/, '//***:***@');
      console.log(`[BOT] Menggunakan Failover Proxy [${this.currentProxyIndex + 1}/${globalProxyList.length}]: ${safeLog}`);
    }
    const agent = activeProxy ? this.getProxyAgent(activeProxy) : null;

    // 2. Selesaikan masalah session menggunakan proxy terpilih
    try {
      const existingSession = loadJsonConfig('session.json');
      if (existingSession && existingSession.walletAddress === WALLET_ADDRESS && existingSession.sessionToken) {
        this.sessionToken = existingSession.sessionToken;
        this.botName = existingSession.username || 'IslandsBot';
      } else {
        const loginData = await doLogin(agent);
        this.sessionToken = loginData.sessionToken;
        this.botName = loginData.username || 'IslandsBot';
      }
    } catch (loginErr) {
      console.error(`[AUTH ERROR] Auto login gagal memakai proxy ini: ${loginErr.message}`);
      // Lemparkan error agar memicu rotasi proxy di fungsi startBot() luar
      throw loginErr;
    }

    return new Promise((resolve, reject) => {
      const options = {};
      if (agent) options.agent = agent;

      console.log(`[BOT] Menghubungkan ke ${config.gameServer.url}`);
      this.ws = new WebSocket(config.gameServer.url, options);

      this.ws.on('open', () => {
        console.log('[BOT] Terhubung ke Islands server!');
        this.isConnected = true;
        this.sendHello();
        if (this._pingTimer) clearInterval(this._pingTimer);
        this._pingTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
        }, 15000);
        resolve();
      });

      this.ws.on('pong', () => {});
      this.ws.on('message', (data) => this.handleMessage(data));
      
      this.ws.on('error', (err) => { 
        console.error(`[BOT ERROR] Masalah koneksi: ${err.message}`);
        this.isConnected = false; 
        if (globalProxyList.length > 0) {
          this.currentProxyIndex++;
          if (this.currentProxyIndex >= globalProxyList.length) this.currentProxyIndex = 0;
        }
        reject(err); 
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        this.stopIntervals();
        if (this._running) {
          if (globalProxyList.length > 0) {
            this.currentProxyIndex++;
            if (this.currentProxyIndex >= globalProxyList.length) this.currentProxyIndex = 0;
          }
          console.log('[BOT] Koneksi terputus. Mencoba menghubungkan kembali dalam 3 detik...');
          setTimeout(() => this.connect().catch(() => {}), 3000);
        }
      });
    });
  }

  stopIntervals() {
    if (this.stateInterval) clearInterval(this.stateInterval);
    if (this.attackInterval) clearInterval(this.attackInterval);
    if (this._pingTimer) clearInterval(this._pingTimer);
  }

  send(msg) {
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendHello() {
    // Menggunakan data hasil auto-auth yang tersimpan di class instance
    this.send({
      t: 'hello',
      auth: { walletAddress: WALLET_ADDRESS, sessionToken: this.sessionToken },
      name:  this.botName,
      color: config.player?.color || '#ffffff'
    });
  }

  sendState() {
    this.send({
      t: 'state', x: this.player.x, y: this.player.y, moving: this.isMoving, facing: this.player.facing,
      boat: this.player.boat, bd: this.player.bd, vcx: this.player.vcx, vcy: this.player.vcy, vr: this.player.vr
    });
  }

  sendAttack() {
    this.send({ t: 'attack' });
    this.totalAttacks++;
  }

  checkAndAllocateSkills() {
    if (!ENABLE_SKILL || this.xp.free <= 0) return;
    for (const stat of SKILL_PRIORITY) {
      if (this.xp.free > 0) {
        this.send({ t: 'allocate', stat: stat });
        this.totalSkillUps++;
        this.xp.free--;
        break; 
      }
    }
  }

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    switch (msg.t) {
      case 'welcome':
        this.player.id = msg.id;
        this.isAuthenticated = true;
        console.log(`[BOT] Login Sukses! Menjalankan Engine PVP/PVE Murder-Mode.`);
        this.startIntervals();
        break;
      case 'inv':
        if (msg.wood !== undefined) this.inventory.wood = msg.wood;
        break;
      case 'xp':
        const prevLv = this.xp.level;
        this.xp = { level: msg.level, free: msg.free || 0, speedMult: msg.speedMult || 1 };
        if (msg.level > prevLv) console.log(`[BOT] ⬆️ LEVEL UP! Sekarang Level ${msg.level}`);
        if (msg.free > 0) this.checkAndAllocateSkills();
        break;
      case 'loot':
        console.log(`[BOT] ⚔️ Loot terjatuh: ${msg.item} x${msg.qty}`);
        break;
      case 'world':
        if (msg.mobs) this.world.mobs = msg.mobs;
        break;
      case 'death':
        if (msg.id === this.currentTargetMobId) {
          this.sessionKills++;
          console.log(`[BOT] 💀 Target Mati! Total Kill Sesi Ini: ${this.sessionKills}`);
          this.currentTargetMobId = null;
          this.searchRadius = 250;
        }
        break;
    }
  }

  startIntervals() {
    const jitter = Math.floor(Math.random() * 15);
    this.stateInterval  = setInterval(() => this.sendState(), 45 + jitter);
    this.attackInterval = setInterval(() => this.processRadarCombat(), 65 + jitter);
  }

  processRadarCombat() {
    if (!this.isConnected || !this.isAuthenticated) return;
    const availableMobs = (this.world.mobs || []).filter(m => m.hp === undefined || m.hp > 0);
    if (availableMobs.length > 0) {
      let targetMob = null;
      const mappedMobs = availableMobs.map(m => {
        const wx = m.x !== undefined ? (m.x > 1000 ? m.x : m.x * TILE_TO_WORLD) : (m.wx || 0);
        const wy = m.y !== undefined ? (m.y > 1000 ? m.y : m.y * TILE_TO_WORLD) : (m.wy || 0);
        return { id: m.id, type: m.type || 'Monster', wx, wy, hp: m.hp };
      });
      if (this.currentTargetMobId) {
        targetMob = mappedMobs.find(m => m.id === this.currentTargetMobId);
      }
      if (!targetMob) {
        let minDistance = Infinity;
        for (const m of mappedMobs) {
          const d = this.distanceTo(m.wx, m.wy);
          if (d < minDistance) { minDistance = d; targetMob = m; }
        }
        if (targetMob) {
          this.currentTargetMobId = targetMob.id;
          console.log(`[BOT] ⚔️ LOCK TARGET -> [${targetMob.type}] Jarak: ${minDistance.toFixed(0)} unit.`);
        }
      }
      if (targetMob) {
        const dist = this.distanceTo(targetMob.wx, targetMob.wy);
        if (dist > 48) {
          let hyperStep = 90;
          if (dist > 400) { hyperStep = 550; } else if (dist > 150) { hyperStep = 300; }
          const finalStep = Math.min(dist, hyperStep * this.xp.speedMult);
          this.moveToward(targetMob.wx, targetMob.wy, finalStep);
        } else {
          this.isMoving = false;
          this.sendAttack(); this.sendAttack(); this.sendAttack();
        }
      }
    } else {
      this.currentTargetMobId = null;
      this.radarSweep();
    }
  }

  moveToward(tx, ty, step) {
    const dx   = tx - this.player.x;
    const dy   = ty - this.player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return;
    const BOAT_DISTANCE_THRESHOLD = 450; 
    if (dist > BOAT_DISTANCE_THRESHOLD) {
      if (!this.player.boat) this.player.boat = true;
    } else {
      if (this.player.boat) this.player.boat = false;
    }
    const nextX = Math.round(this.player.x + (dx / dist) * step);
    const nextY = Math.round(this.player.y + (dy / dist) * step);
    this.player.x      = nextX;
    this.player.y      = nextY;
    this.player.vcx    = nextX; 
    this.player.vcy    = nextY; 
    this.player.facing = dx > 0 ? 1 : -1;
    this.player.bd     = dx > 0 ? 'right' : 'left';
    this.isMoving      = true;
  }

  radarSweep() {
    this.searchAngle += 0.5; this.searchRadius += 12;  
    if (this.searchRadius > 1000) this.searchRadius = 200;
    const targetX = Math.round(this.player.x + Math.cos(this.searchAngle) * this.searchRadius);
    const targetY = Math.round(this.player.y + Math.sin(this.searchAngle) * this.searchRadius);
    this.moveToward(targetX, targetY, 150); 
  }

  distanceTo(x, y) {
    return Math.sqrt((x - this.player.x) ** 2 + (y - this.player.y) ** 2);
  }

  startAutoPlay() {
    this._running = true;
    console.log('[BOT] ⚔️ MODE PERTARUNGAN AGRESIF (MURDER-MODE) DIALIRKAN!');
    return new Promise(() => {});
  }
}

module.exports = GameBot;

if (require.main === module) {
  const bot = new GameBot();
  process.on('SIGINT', () => { bot.stopIntervals(); process.exit(0); });
  const startBot = () => {
    bot.connect()
      .then(() => bot.startAutoPlay())
      .catch(() => {
        console.log('[BOT] Gagal terhubung pada proxy/login ini. Mengalihkan ke proxy berikutnya dalam 3 detik...');
        if (globalProxyList.length > 0) {
          bot.currentProxyIndex++;
          if (bot.currentProxyIndex >= globalProxyList.length) bot.currentProxyIndex = 0;
        }
        setTimeout(startBot, 3000);
      });
  };
  startBot();
}
