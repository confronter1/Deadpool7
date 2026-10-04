/**
 * Deadpool Bot — single-file core + config.js only
 * Base64 SESSION · no crash/bug tools
 */
const {
  default: makeWASocket, useMultiFileAuthState, DisconnectReason,
  fetchLatestBaileysVersion, downloadContentFromMessage, jidNormalizedUser,
  getContentType, Browsers, makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const NodeCache = require('node-cache');
const axios = require('axios');
const config = require('./config');

const AUTH_DIR = path.join(__dirname, 'auth_info');
const TMP = path.join(os.tmpdir(), 'bot-dl');
const msgCache = new NodeCache({ stdTTL: 28800, checkperiod: 120 });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0 Safari/537.36';
let sock = null, youtubedl = null;
try { youtubedl = require('youtube-dl-exec'); } catch {}
fs.ensureDirSync(TMP);

const dig = v => String(v || '').replace(/\D/g, '');
const isGroup = j => j?.endsWith('@g.us');
const phoneOf = j => dig(String(j || '').split('@')[0].split(':')[0]) || 'unknown';
const runtime = s => {
  s = Number(s) || 0;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m ${Math.floor(s % 60)}s`;
};
const footer = () => `\n_${config.POWERED_BY} ©${new Date().getFullYear()}_`;

function isOwner(jid) {
  const num = dig(jidNormalizedUser(String(jid || '')).split('@')[0].split(':')[0]);
  if (!num) return false;
  return [config.OWNER_NUMBER, ...(config.DEVELOPERS || [])].map(dig).filter(Boolean)
    .some(o => num === o || num.endsWith(o) || o.endsWith(num));
}

function inviteCode(link) {
  const m = String(link || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : (/^[A-Za-z0-9_-]{10,}$/.test(link) ? link : null);
}

function extractText(msg) {
  if (!msg) return '';
  let u = msg;
  for (let i = 0; i < 5; i++) {
    if (u.ephemeralMessage?.message) u = u.ephemeralMessage.message;
    else if (u.viewOnceMessage?.message) u = u.viewOnceMessage.message;
    else if (u.viewOnceMessageV2?.message) u = u.viewOnceMessageV2.message;
    else break;
  }
  return u.conversation || u.extendedTextMessage?.text || u.imageMessage?.caption || u.videoMessage?.caption || '';
}

function getExpiry() {
  try {
    const now = new Date();
    if (config.BOT_EXPIRY_DATE) {
      const d = Math.ceil((new Date(config.BOT_EXPIRY_DATE) - now) / 86400000);
      if (d < 0) return '⛔ Expired';
      return d + ' days left';
    }
    if (config.BOT_EXPIRY_DAYS > 0) {
      const act = config.BOT_ACTIVATED_AT ? new Date(config.BOT_ACTIVATED_AT) : now;
      const d = Math.ceil((new Date(act.getTime() + config.BOT_EXPIRY_DAYS * 86400000) - now) / 86400000);
      if (d < 0) return '⛔ Expired';
      return d + ' days left';
    }
  } catch {}
  return 'Unlimited';
}

function startBox() {
  const on = v => (v === true || v === 'pm' || v === 'chat') ? '✅' : '❌';
  const L = '──────────────';
  return `╭${L}╮\n│ 💀 *${config.BOT_NAME}*\n│ ✅ *ONLINE — READY*\n├${L}┤\n│ ⚡ Prefix : *${config.PREFIX}*\n│ 🌐 Mode   : *${config.MODE}*\n│ 👤 Owner  : *${config.OWNER_NUMBER || '—'}*\n│ ⏳ Expiry : *${getExpiry()}*\n├${L}┤\n│ 👁 AutoView : ${on(config.AUTO_VIEW_STATUS)}\n│ 📞 AntiCall : ${on(config.ANTI_CALL)}\n│ 👋 Welcome  : ${on(config.WELCOME)}\n│ 🚪 Goodbye  : ${on(config.GOODBYE)}\n├${L}┤\n│ 👑 ${config.OWNER_NAME}\n│ 💬 ${config.PREFIX}menu · ${config.PREFIX}ping\n╰${L}╯`;
}

// ——— yt-dlp ———
function runYtdlp(args, ms = 150000) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.env.YTDLP_PATH || 'yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} reject(new Error('timeout')); }, ms);
    c.stdout.on('data', d => o += d);
    c.stderr.on('data', d => e += d);
    c.on('error', err => { clearTimeout(t); reject(err); });
    c.on('close', code => { clearTimeout(t); code === 0 ? resolve(o) : reject(new Error((e || o).slice(-500) || 'exit ' + code)); });
  });
}

async function ytSearch(q) {
  q = String(q || '').trim();
  if (!q) return null;
  if (/youtube\.com|youtu\.be|music\.youtube/i.test(q)) return q;
  try {
    if (youtubedl) {
      const r = await youtubedl(`ytsearch1:${q}`, { print: '%(webpage_url)s', noPlaylist: true, skipDownload: true, quiet: true, noWarnings: true });
      const u = String(r || '').trim().split('\n')[0];
      if (u?.startsWith('http')) return u;
    }
    const out = await runYtdlp([`ytsearch1:${q}`, '--print', '%(webpage_url)s', '--no-playlist', '--skip-download', '--quiet', '--no-warnings'], 35000);
    const u = out.trim().split('\n')[0];
    if (u?.startsWith('http')) return u;
  } catch (e) { console.log('ytSearch:', e.message); }
  return null;
}

async function downloadYT(query, audioOnly) {
  const url = await ytSearch(query);
  if (!url) return null;
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const out = path.join(TMP, id + '.%(ext)s');
  try {
    if (audioOnly) {
      try {
        if (youtubedl) await youtubedl(url, { format: 'bestaudio/best', extractAudio: true, audioFormat: 'mp3', audioQuality: 0, output: out, noPlaylist: true, noWarnings: true });
      } catch {}
      const files = await fs.readdir(TMP);
      let fp = files.find(f => f.startsWith(id));
      if (!fp) {
        await runYtdlp([url, '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '-o', out, '--no-playlist', '--no-warnings']);
        fp = (await fs.readdir(TMP)).find(f => f.startsWith(id));
      }
      if (!fp) return null;
      const buffer = await fs.readFile(path.join(TMP, fp));
      await fs.remove(path.join(TMP, fp)).catch(() => {});
      if (buffer.length < 3000) return null;
      let title = 'audio';
      try { title = (await runYtdlp([url, '--print', 'title', '--skip-download', '--quiet'], 12000)).trim().split('\n')[0] || title; } catch {}
      return { buffer, title, audio: true };
    }
    try {
      if (youtubedl) await youtubedl(url, {
        format: 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/best[height<=720]/best',
        mergeOutputFormat: 'mp4', output: out, noPlaylist: true, noWarnings: true
      });
    } catch {}
    let fp = (await fs.readdir(TMP)).find(f => f.startsWith(id));
    if (!fp) {
      await runYtdlp([url, '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/best',
        '--merge-output-format', 'mp4', '-o', out, '--no-playlist', '--no-warnings']);
      fp = (await fs.readdir(TMP)).find(f => f.startsWith(id));
    }
    if (!fp) return null;
    const buffer = await fs.readFile(path.join(TMP, fp));
    await fs.remove(path.join(TMP, fp)).catch(() => {});
    if (buffer.length < 15000) return null;
    let title = 'video';
    try { title = (await runYtdlp([url, '--print', 'title', '--skip-download', '--quiet'], 12000)).trim().split('\n')[0] || title; } catch {}
    return { buffer, title, audio: false };
  } catch (e) {
    console.log('downloadYT:', e.message);
    return null;
  }
}

async function resolveName(gid, pjid, pushName) {
  const phone = phoneOf(pjid);
  const pretty = phone !== 'unknown' ? '+' + phone : 'Member';
  if (pushName && !/^\d+$/.test(pushName)) return { name: pushName.trim(), phone: pretty };
  try {
    const meta = await sock.groupMetadata(gid);
    const p = (meta.participants || []).find(x => x.id === pjid || dig(x.id) === dig(pjid));
    if (p?.notify || p?.name) return { name: (p.notify || p.name).trim(), phone: pretty };
  } catch {}
  return { name: pretty, phone: pretty };
}

async function autoJoin() {
  for (const raw of config.AUTO_JOIN_GROUPS || []) {
    const code = inviteCode(raw);
    if (!code) continue;
    try { await sock.groupAcceptInvite(code); console.log('Joined', code); } catch (e) { console.log('join:', e.message); }
  }
  if (config.AUTO_JOIN_CHANNEL) {
    const jid = config.AUTO_JOIN_CHANNEL.includes('@') ? config.AUTO_JOIN_CHANNEL : config.AUTO_JOIN_CHANNEL + '@newsletter';
    try { if (sock.newsletterFollow) await sock.newsletterFollow(jid); } catch (e) { console.log('channel:', e.message); }
  }
}

async function loadAuth() {
  if (config.SESSION && config.SESSION.length > 10) {
    try {
      let raw = config.SESSION.trim();
      if (/^deadpool~/i.test(raw)) raw = raw.slice(raw.indexOf('~') + 1).trim();
      const creds = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      await fs.ensureDir(AUTH_DIR);
      await fs.writeJson(path.join(AUTH_DIR, 'creds.json'), creds, { spaces: 2 });
      console.log('Session loaded');
    } catch (e) { console.error('SESSION:', e.message); }
  }
  return useMultiFileAuthState(AUTH_DIR);
}

async function startBot() {
  console.log(`
╔══════════════════════════════════════╗
║   💀  Deadpool still ruling the nation
║   Made by Confronter 👽
║   We defeated the weak 😑
║   We never died — short break 😤
║   That lazy dude is happy & smiling 😊
║   Confronter Techwizard 👑
╚══════════════════════════════════════╝
`);
  const { state, saveCreds } = await loadAuth();
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: !config.SESSION,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    emitOwnEvents: true,
    msgRetryCounterCache: new NodeCache(),
    getMessage: async key => msgCache.get(key.id)?.message
  });

  const _send = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, opts) => {
    const r = await _send(jid, content, opts);
    try { if (r?.key?.id && r.message) msgCache.set(r.key.id, { key: r.key, message: r.message }); } catch {}
    return r;
  };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    if (u.connection === 'open') {
      console.log('ONLINE — ready');
      try { if (config.PRESENCE === 'available') sock.sendPresenceUpdate('available').catch(() => {}); } catch {}
      autoJoin().catch(() => {});
      setImmediate(async () => {
        try {
          const me = sock.user?.id;
          if (!me) return;
          const jid = me.includes(':') ? me.split(':')[0] + '@s.whatsapp.net' : jidNormalizedUser(me);
          await sock.sendMessage(jid, { text: startBox() });
        } catch (e) { console.log('start msg:', e.message); }
      });
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error instanceof Boom ? u.lastDisconnect.error.output?.statusCode : 0;
      console.log('Closed', code);
      if (code === DisconnectReason.loggedOut) { await fs.remove(AUTH_DIR).catch(() => {}); process.exit(1); }
      setTimeout(startBot, 3000);
    }
  });

  sock.ev.on('call', async (calls) => {
    if (!config.ANTI_CALL) return;
    for (const c of calls) {
      if (c.status === 'offer') {
        try {
          await sock.rejectCall(c.id, c.from);
          await sock.sendMessage(c.from, { text: `📞 *${config.BOT_NAME}*\n${config.ANTI_CALL_MSG}` }).catch(() => {});
        } catch {}
      }
    }
  });

  sock.ev.on('group-participants.update', async (u) => {
    try {
      if (!config.WELCOME && !config.GOODBYE) return;
      const { id, participants, action } = u;
      const meta = await sock.groupMetadata(id).catch(() => null);
      const gname = meta?.subject || 'Group';
      for (const p of participants) {
        const { name, phone } = await resolveName(id, p);
        const mention = '@' + p.split('@')[0];
        if (action === 'add' && config.WELCOME) {
          const text = config.WELCOME_MSG.replace(/\{name\}/gi, name).replace(/\{phone\}/gi, phone)
            .replace(/\{group\}/gi, gname).replace(/@user/gi, mention).replace(/@group/gi, gname);
          await sock.sendMessage(id, { text, mentions: [p] });
        }
        if ((action === 'remove' || action === 'leave') && config.GOODBYE) {
          const text = config.GOODBYE_MSG.replace(/\{name\}/gi, name).replace(/\{phone\}/gi, phone)
            .replace(/\{group\}/gi, gname).replace(/@user/gi, mention).replace(/@group/gi, gname);
          await sock.sendMessage(id, { text, mentions: [p] });
        }
      }
    } catch {}
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!messages?.length) return;
    for (const m of messages) handleMsg(m).catch(e => console.log('msg:', e.message));
  });

  async function handleMsg(m) {
    if (!m?.key || !m.message) return;
    if (m.key.id) {
      try {
        msgCache.set(m.key.id, { key: m.key, message: JSON.parse(JSON.stringify(m.message)) });
      } catch {}
    }
    const from = m.key.remoteJid;
    const sender = m.key.participant || m.key.remoteJid;
    const isMe = !!m.key.fromMe;

    if (config.AUTO_READ && !isMe && from !== 'status@broadcast') sock.readMessages([m.key]).catch(() => {});

    if (from === 'status@broadcast') {
      if (isMe) return;
      if (config.AUTO_VIEW_STATUS) sock.readMessages([m.key]).catch(() => {});
      if (config.AUTO_LIKE_STATUS) {
        const emoji = config.STATUS_LIKES[Math.floor(Math.random() * config.STATUS_LIKES.length)] || '❤️';
        sock.sendMessage('status@broadcast', { react: { text: emoji, key: m.key } }).catch(() => {});
      }
      return;
    }

    // antilink
    if (isGroup(from) && !isMe && config.ANTILINK) {
      const body0 = extractText(m.message);
      if (/https?:\/\/|wa\.me\/|chat\.whatsapp/i.test(body0) && !isOwner(sender)) {
        try {
          const meta = await sock.groupMetadata(from);
          const botNum = dig(sock.user?.id);
          const botAdm = (meta.participants || []).some(p => dig(p.id) === botNum && (p.admin === 'admin' || p.admin === 'superadmin'));
          const userAdm = (meta.participants || []).some(p => (p.id === sender || dig(p.id) === dig(sender)) && (p.admin === 'admin' || p.admin === 'superadmin'));
          if (botAdm && !userAdm) {
            await sock.sendMessage(from, { delete: m.key }).catch(() => {});
            await sock.sendMessage(from, { text: `🔗 Antilink: @${sender.split('@')[0]}`, mentions: [sender] });
            return;
          }
        } catch {}
      }
    }

    const body = extractText(m.message).trim();
    if (!body) return;
    const candidates = [...new Set([String(config.PREFIX || '!').trim() || '!', '.', '!', '/', '#'])];
    let prefix = null;
    for (const p of candidates) if (body.startsWith(p)) { prefix = p; break; }
    if (!prefix) return;
    if (config.MODE === 'private' && !isOwner(sender) && !isMe) return;

    const args = body.slice(prefix.length).trim().split(/\s+/);
    const cmd = (args.shift() || '').toLowerCase();
    const text = args.join(' ');
    if (!cmd) return;
    console.log('CMD:', cmd, 'from:', phoneOf(sender));

    /** Boxed reply like Toxic-MD style — 「 TITLE 」 */
    const box = (title, lines) => {
      const body = Array.isArray(lines) ? lines.join('\n') : String(lines || '');
      return (
        `┌─ 「 ${title} 」\n` +
        body.split('\n').map(l => `│ ${l}`).join('\n') +
        `\n└───────────────`
      );
    };
    const reply = async t => {
      try { await sock.sendMessage(from, { text: String(t).trim() + footer() }); }
      catch (e) { console.log('reply:', e.message); }
    };
    const replyBox = async (title, lines) => reply(box(title, lines));
    const ownerOnly = async () => {
      if (!isOwner(sender) && !isMe) {
        await replyBox('ACCESS DENIED', [
          'You dare touch an owner command?',
          'Your existence is a patch note we skipped.',
          'Crawl back to the lobby where mid lives.',
          'Deadpool does not open doors for tourists.'
        ]);
        return true;
      }
      return false;
    };
    const mentioned = () => m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const quoted = () => m.message?.extendedTextMessage?.contextInfo?.quotedMessage;

    async function groupAdminOk() {
      if (!isGroup(from)) { await reply('Group only.'); return false; }
      try {
        const meta = await sock.groupMetadata(from);
        const botNum = dig(sock.user?.id);
        const botAdm = (meta.participants || []).some(p => dig(p.id) === botNum && (p.admin === 'admin' || p.admin === 'superadmin'));
        const userAdm = isOwner(sender) || isMe || (meta.participants || []).some(p => (p.id === sender || dig(p.id) === dig(sender)) && (p.admin === 'admin' || p.admin === 'superadmin'));
        if (!userAdm) { await reply('❌ Admins only.'); return false; }
        if (!botAdm) { await reply('❌ Bot must be admin.'); return false; }
        return true;
      } catch (e) { await reply('❌ ' + e.message); return false; }
    }

    // ——— commands ———
    if (['ping', 'speed'].includes(cmd)) {
      const t0 = Date.now();
      const name = m.pushName || 'soldier';
      return replyBox('PING', [
        `Still breathing, ${name}.`,
        `Latency : ${Date.now() - t0}ms`,
        `Uptime  : ${runtime(process.uptime())}`,
        `Prefix  : ${prefix}`
      ]);
    }
    if (['alive', 'runtime'].includes(cmd)) {
      return replyBox('ALIVE', [
        `${config.BOT_NAME} is online.`,
        `We didn't die — we took a break.`,
        `Runtime : ${runtime(process.uptime())}`,
        `Owner   : ${config.OWNER_NAME}`
      ]);
    }
    if (['owner', 'creator'].includes(cmd)) {
      return replyBox('OWNER', [
        `wa.me/${config.OWNER_NUMBER}`,
        config.OWNER_NAME,
        'Confronter Techwizard 👑'
      ]);
    }
    if (['menu', 'help', 'list'].includes(cmd)) {
      const p = prefix;
      return reply(
`💀 *${config.BOT_NAME}*
Prefix: *${p}*

*── Core ──*
${p}ping
${p}alive
${p}runtime
${p}owner
${p}menu
${p}sc

*── Download ──*
${p}play <song>
${p}ytmp3 <name/url>
${p}video <name/url>
${p}ytmp4 <name/url>
${p}tiktok <url>
${p}tiktokmp3 <url>
${p}mediafire <url>

*── Convert ──*
${p}sticker (reply)
${p}toimg (reply sticker)
${p}tomp3 (reply video)
${p}togif (reply video)
${p}qc <text>
${p}qcstick <text>
${p}emojimix 😀+😎

*── Group ──*
${p}tagall [text]
${p}hidetag [text]
${p}kick @user
${p}promote @user
${p}demote @user
${p}linkgc
${p}resetlink
${p}setname <text>
${p}setdesk <text>
${p}antilink on/off
${p}welcome on/off
${p}goodbye on/off

*── Owner ──*
${p}public
${p}self
${p}settings
${p}join <link>
${p}block @user
${p}unblock @user
${p}bcgc <msg>
${p}setpp (reply image)
${p}autoview on/off
${p}autolike on/off
${p}anticall on/off
${p}autoread on/off
${p}delete (reply)

*── Fun / Tools ──*
${p}quotes
${p}darkjoke
${p}cerpen
${p}couple
${p}google <q>
${p}weather <city>
${p}lyrics <song>
${p}qr <text>
${p}getname @user
${p}getpic @user`
      );
    }
    if (cmd === 'public') { if (await ownerOnly()) return; config.MODE = 'public'; return reply('✅ Mode → *public*'); }
    if (cmd === 'self') { if (await ownerOnly()) return; config.MODE = 'private'; return reply('✅ Mode → *self*'); }
    if (cmd === 'settings') {
      if (await ownerOnly()) return;
      return reply(`⚙️ Mode: ${config.MODE}\nPrefix: ${config.PREFIX}\nWelcome: ${config.WELCOME}\nGoodbye: ${config.GOODBYE}\nAutoView: ${config.AUTO_VIEW_STATUS}\nAntilink: ${config.ANTILINK}`);
    }

    if (['play', 'song', 'ytmp3'].includes(cmd)) {
      if (!text) return reply(`Usage: ${prefix}play <song>`);
      await reply('⏳ Fetching audio…');
      const data = await downloadYT(text, true);
      if (!data?.buffer) return reply('❌ Track not found.');
      try { await sock.sendMessage(from, { audio: data.buffer, mimetype: 'audio/mpeg', fileName: (data.title || 'audio') + '.mp3' }); }
      catch { try { await sock.sendMessage(from, { document: data.buffer, mimetype: 'audio/mpeg', fileName: 'audio.mp3' }); } catch { await reply('❌ Send failed.'); } }
      return;
    }
    if (['video', 'ytmp4', 'yt'].includes(cmd)) {
      if (!text) return reply(`Usage: ${prefix}video <name/url>`);
      await reply('⏳ Fetching video…');
      const data = await downloadYT(text, false);
      if (!data?.buffer) return reply('❌ Video not found.');
      try { await sock.sendMessage(from, { video: data.buffer, caption: `🎬 *${data.title || 'Video'}*` }); }
      catch { await reply('❌ Send failed.'); }
      return;
    }
    if (['tiktok', 'tt'].includes(cmd)) {
      if (!text) return reply(`Usage: ${prefix}tiktok <url>`);
      await reply('⏳ TikTok…');
      try {
        const r = await axios.get('https://tikwm.com/api/?url=' + encodeURIComponent(text), { timeout: 25000, headers: { 'User-Agent': UA } });
        const d = r.data?.data;
        const url = d?.play || d?.hdplay;
        if (!url) return reply('❌ Failed.');
        const buf = Buffer.from((await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 })).data);
        await sock.sendMessage(from, { video: buf, caption: `🎬 ${d?.title || 'TikTok'}` });
      } catch (e) { await reply('❌ ' + e.message); }
      return;
    }

    if (['sticker', 's'].includes(cmd)) {
      const q = quoted();
      const img = m.message?.imageMessage || q?.imageMessage;
      const vid = m.message?.videoMessage || q?.videoMessage;
      if (!img && !vid) return reply(`Reply image/video with ${prefix}sticker`);
      try {
        const type = img ? 'image' : 'video';
        const stream = await downloadContentFromMessage(img || vid, type);
        let buffer = Buffer.from([]);
        for await (const c of stream) buffer = Buffer.concat([buffer, c]);
        const { Sticker } = require('wa-sticker-formatter');
        const st = new Sticker(buffer, { pack: config.BOT_NAME, author: config.OWNER_NAME, quality: 70 });
        await sock.sendMessage(from, { sticker: await st.toBuffer() });
      } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (['toimg', 'toimage'].includes(cmd)) {
      const st = quoted()?.stickerMessage;
      if (!st) return reply(`Reply sticker with ${prefix}toimg`);
      try {
        const stream = await downloadContentFromMessage(st, 'sticker');
        let buffer = Buffer.from([]);
        for await (const c of stream) buffer = Buffer.concat([buffer, c]);
        await sock.sendMessage(from, { image: buffer, caption: '✅' });
      } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (cmd === 'qc') {
      if (!text) return reply(`Usage: ${prefix}qc <text>`);
      try {
        const res = await axios.post('https://bot.lyo.su/quote/generate', {
          type: 'quote', format: 'png', backgroundColor: '#FFFFFF', width: 512, height: 768, scale: 2,
          messages: [{ entities: [], avatar: true, from: { id: 1, name: m.pushName || 'User', photo: { url: 'https://telegra.ph/file/134ccbbd0dfc434a910ab.png' } }, text, replyMessage: {} }]
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
        await sock.sendMessage(from, { image: Buffer.from(res.data.result.image, 'base64') });
      } catch (e) { await reply('❌ ' + e.message); }
      return;
    }

    if (['tagall', 'tag'].includes(cmd)) {
      if (!(await groupAdminOk())) return;
      const meta = await sock.groupMetadata(from);
      let teks = `📢 *Tag All*\n${text || ''}\n\n`;
      const mentions = (meta.participants || []).map(p => { teks += `@${p.id.split('@')[0]}\n`; return p.id; });
      await sock.sendMessage(from, { text: teks, mentions });
      return;
    }
    if (['hidetag', 'ht'].includes(cmd)) {
      if (!(await groupAdminOk())) return;
      const meta = await sock.groupMetadata(from);
      await sock.sendMessage(from, { text: text || '​', mentions: (meta.participants || []).map(p => p.id) });
      return;
    }
    if (cmd === 'kick') {
      if (!(await groupAdminOk())) return;
      const t = mentioned();
      if (!t.length) return reply(`Tag: ${prefix}kick @user`);
      try { await sock.groupParticipantsUpdate(from, t, 'remove'); await reply('✅ Removed.'); } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (cmd === 'promote') {
      if (!(await groupAdminOk())) return;
      const t = mentioned();
      if (!t.length) return reply(`Tag: ${prefix}promote @user`);
      try { await sock.groupParticipantsUpdate(from, t, 'promote'); await reply('✅ Promoted.'); } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (cmd === 'demote') {
      if (!(await groupAdminOk())) return;
      const t = mentioned();
      if (!t.length) return reply(`Tag: ${prefix}demote @user`);
      try { await sock.groupParticipantsUpdate(from, t, 'demote'); await reply('✅ Demoted.'); } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (['linkgc', 'link'].includes(cmd)) {
      if (!isGroup(from)) return reply('Group only.');
      try { await reply('🔗 https://chat.whatsapp.com/' + await sock.groupInviteCode(from)); }
      catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (['resetlink', 'revoke'].includes(cmd)) {
      if (!(await groupAdminOk())) return;
      try {
        await sock.groupRevokeInvite(from);
        await reply('✅ Reset\n🔗 https://chat.whatsapp.com/' + await sock.groupInviteCode(from));
      } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (['setname', 'setsubject'].includes(cmd)) {
      if (!(await groupAdminOk())) return;
      if (!text) return reply(`Usage: ${prefix}setname <name>`);
      try { await sock.groupUpdateSubject(from, text); await reply('✅ Name updated.'); } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (['setdesk', 'setdesc'].includes(cmd)) {
      if (!(await groupAdminOk())) return;
      if (!text) return reply(`Usage: ${prefix}setdesk <text>`);
      try { await sock.groupUpdateDescription(from, text); await reply('✅ Desc updated.'); } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (cmd === 'antilink') {
      if (!(await groupAdminOk())) return;
      if (args[0] === 'on') { config.ANTILINK = true; return reply('✅ Antilink ON'); }
      if (args[0] === 'off') { config.ANTILINK = false; return reply('❌ Antilink OFF'); }
      return reply(`Antilink: *${config.ANTILINK ? 'ON' : 'OFF'}*`);
    }
    if (cmd === 'welcome') {
      if (await ownerOnly()) return;
      if (args[0] === 'on') { config.WELCOME = true; return reply('✅ Welcome ON'); }
      if (args[0] === 'off') { config.WELCOME = false; return reply('❌ Welcome OFF'); }
      return reply(`Welcome: *${config.WELCOME ? 'ON' : 'OFF'}*`);
    }
    if (cmd === 'goodbye') {
      if (await ownerOnly()) return;
      if (args[0] === 'on') { config.GOODBYE = true; return reply('✅ Goodbye ON'); }
      if (args[0] === 'off') { config.GOODBYE = false; return reply('❌ Goodbye OFF'); }
      return reply(`Goodbye: *${config.GOODBYE ? 'ON' : 'OFF'}*`);
    }

    if (cmd === 'join') {
      if (await ownerOnly()) return;
      if (!text) return reply(`Usage: ${prefix}join <link>`);
      const code = inviteCode(text) || text.trim();
      try { await sock.groupAcceptInvite(code); await reply('✅ Joined.'); } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (cmd === 'block') {
      if (await ownerOnly()) return;
      const t = mentioned()[0] || (text ? dig(text) + '@s.whatsapp.net' : null);
      if (!t) return reply(`Tag/number: ${prefix}block @user`);
      try { await sock.updateBlockStatus(t, 'block'); await reply('✅ Blocked.'); } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (cmd === 'unblock') {
      if (await ownerOnly()) return;
      const t = mentioned()[0] || (text ? dig(text) + '@s.whatsapp.net' : null);
      if (!t) return reply(`Tag/number: ${prefix}unblock @user`);
      try { await sock.updateBlockStatus(t, 'unblock'); await reply('✅ Unblocked.'); } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (['bcgc', 'broadcast'].includes(cmd)) {
      if (await ownerOnly()) return;
      if (!text) return reply(`Usage: ${prefix}bcgc <msg>`);
      const groups = await sock.groupFetchAllParticipating();
      const ids = Object.keys(groups || {});
      await reply(`📢 ${ids.length} groups…`);
      let ok = 0;
      for (const gid of ids) {
        try { await sock.sendMessage(gid, { text: `📢 *Broadcast*\n\n${text}` }); ok++; await new Promise(r => setTimeout(r, 400)); } catch {}
      }
      return reply(`✅ ${ok}/${ids.length}`);
    }

    // ——— more downloads ———
    if (['tiktokmp3', 'tiktokaudio', 'ttaudio'].includes(cmd)) {
      if (!text) return reply(`Usage: ${prefix}${cmd} <tiktok url>`);
      await reply('⏳ TikTok audio…');
      try {
        const r = await axios.get('https://tikwm.com/api/?url=' + encodeURIComponent(text), { timeout: 25000, headers: { 'User-Agent': UA } });
        const music = r.data?.data?.music;
        if (!music) return reply('❌ No audio.');
        const buf = Buffer.from((await axios.get(music, { responseType: 'arraybuffer', timeout: 60000 })).data);
        await sock.sendMessage(from, { audio: buf, mimetype: 'audio/mpeg' });
      } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (cmd === 'mediafire') {
      if (!text || !/mediafire\.com/i.test(text)) return reply(`Usage: ${prefix}mediafire <url>`);
      await reply('⏳ MediaFire…');
      try {
        const r = await axios.get(text, { timeout: 30000, headers: { 'User-Agent': UA } });
        const m = String(r.data).match(/href="(https:\/\/download[^"]+)"/i);
        if (!m) return reply('❌ Direct link not found.');
        await reply('📥 ' + m[1]);
      } catch (e) { await reply('❌ ' + e.message); }
      return;
    }

    // ——— convert ———
    if (['tomp3', 'toaudio'].includes(cmd)) {
      const q = quoted();
      const aud = q?.audioMessage || q?.videoMessage || m.message?.audioMessage || m.message?.videoMessage;
      if (!aud) return reply(`Reply video/audio with ${prefix}tomp3`);
      try {
        const kind = (q?.videoMessage || m.message?.videoMessage) ? 'video' : 'audio';
        const stream = await downloadContentFromMessage(aud, kind);
        let buffer = Buffer.from([]);
        for await (const c of stream) buffer = Buffer.concat([buffer, c]);
        await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mpeg' });
      } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (cmd === 'togif') {
      const q = quoted();
      const vid = q?.videoMessage || m.message?.videoMessage;
      if (!vid) return reply(`Reply video with ${prefix}togif`);
      try {
        const stream = await downloadContentFromMessage(vid, 'video');
        let buffer = Buffer.from([]);
        for await (const c of stream) buffer = Buffer.concat([buffer, c]);
        await sock.sendMessage(from, { video: buffer, gifPlayback: true, caption: '✅ GIF' });
      } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (cmd === 'qcstick') {
      if (!text) return reply(`Usage: ${prefix}qcstick <text>`);
      try {
        const res = await axios.post('https://bot.lyo.su/quote/generate', {
          type: 'quote', format: 'png', backgroundColor: '#FFFFFF', width: 700, height: 580, scale: 2,
          messages: [{ entities: [], avatar: true, from: { id: 1, name: m.pushName || 'User', photo: { url: 'https://telegra.ph/file/134ccbbd0dfc434a910ab.png' } }, text, replyMessage: {} }]
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
        const buffer = Buffer.from(res.data.result.image, 'base64');
        const { Sticker } = require('wa-sticker-formatter');
        const st = new Sticker(buffer, { pack: config.BOT_NAME, author: config.OWNER_NAME, quality: 80 });
        await sock.sendMessage(from, { sticker: await st.toBuffer() });
      } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (['emojimix', 'emojimix2'].includes(cmd)) {
      const parts = text.split(/[+|\s]+/).filter(Boolean);
      if (parts.length < 2) return reply(`Usage: ${prefix}emojimix 😀+😎`);
      try {
        const url = `https://tenor.googleapis.com/v2/featured?key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ&contentfilter=high&media_filter=png_transparent&component=proactive&collection=emoji_kitchen_v5&q=${encodeURIComponent(parts[0] + '_' + parts[1])}`;
        const r = await axios.get(url, { timeout: 20000 }).catch(() => null);
        const img = r?.data?.results?.[0]?.url;
        if (!img) return reply('❌ Mix not found.');
        const buf = Buffer.from((await axios.get(img, { responseType: 'arraybuffer' })).data);
        const { Sticker } = require('wa-sticker-formatter');
        const st = new Sticker(buf, { pack: config.BOT_NAME, author: config.OWNER_NAME, quality: 80 });
        await sock.sendMessage(from, { sticker: await st.toBuffer() });
      } catch (e) { await reply('❌ ' + e.message); }
      return;
    }

    // ——— owner extra ———
    if (['setpp', 'setppbot'].includes(cmd)) {
      if (await ownerOnly()) return;
      const img = m.message?.imageMessage || quoted()?.imageMessage;
      if (!img) return reply(`Reply image with ${prefix}setpp`);
      try {
        const stream = await downloadContentFromMessage(img, 'image');
        let buffer = Buffer.from([]);
        for await (const c of stream) buffer = Buffer.concat([buffer, c]);
        await sock.updateProfilePicture(sock.user.id, buffer);
        await reply('✅ Profile picture updated.');
      } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (['autoview', 'autostatusview'].includes(cmd)) {
      if (await ownerOnly()) return;
      if (args[0] === 'on') { config.AUTO_VIEW_STATUS = true; return reply('✅ AutoView ON'); }
      if (args[0] === 'off') { config.AUTO_VIEW_STATUS = false; return reply('❌ AutoView OFF'); }
      return reply(`AutoView: *${config.AUTO_VIEW_STATUS ? 'ON' : 'OFF'}*`);
    }
    if (cmd === 'autolike') {
      if (await ownerOnly()) return;
      if (args[0] === 'on') { config.AUTO_LIKE_STATUS = true; return reply('✅ AutoLike ON'); }
      if (args[0] === 'off') { config.AUTO_LIKE_STATUS = false; return reply('❌ AutoLike OFF'); }
      return reply(`AutoLike: *${config.AUTO_LIKE_STATUS ? 'ON' : 'OFF'}*`);
    }
    if (cmd === 'anticall') {
      if (await ownerOnly()) return;
      if (args[0] === 'on') { config.ANTI_CALL = true; return reply('✅ AntiCall ON'); }
      if (args[0] === 'off') { config.ANTI_CALL = false; return reply('❌ AntiCall OFF'); }
      return reply(`AntiCall: *${config.ANTI_CALL ? 'ON' : 'OFF'}*`);
    }
    if (cmd === 'autoread') {
      if (await ownerOnly()) return;
      if (args[0] === 'on') { config.AUTO_READ = true; return reply('✅ AutoRead ON'); }
      if (args[0] === 'off') { config.AUTO_READ = false; return reply('❌ AutoRead OFF'); }
      return reply(`AutoRead: *${config.AUTO_READ ? 'ON' : 'OFF'}*`);
    }
    if (['delete', 'del'].includes(cmd)) {
      const ctx = m.message?.extendedTextMessage?.contextInfo;
      if (!ctx?.stanzaId) return reply(`Reply a bot message with ${prefix}delete`);
      try {
        await sock.sendMessage(from, { delete: { remoteJid: from, fromMe: true, id: ctx.stanzaId, participant: ctx.participant } });
      } catch (e) { await reply('❌ ' + e.message); }
      return;
    }
    if (['sc', 'script', 'source'].includes(cmd)) {
      return reply(`💀 *${config.BOT_NAME}*\nBase by Confronter\nBaileys · yt-dlp\nNo crash/bug tools.`);
    }

    // ——— fun / utility ———
    if (cmd === 'quotes') {
      try {
        const r = await axios.get('https://api.quotable.io/random', { timeout: 15000 });
        await reply(`💬 *${r.data.content}*\n— _${r.data.author}_`);
      } catch { await reply('💬 Stay dangerous.'); }
      return;
    }
    if (['darkjoke', 'darkjokes'].includes(cmd)) {
      try {
        const r = await axios.get('https://v2.jokeapi.dev/joke/Dark?type=single', { timeout: 15000 });
        await reply('🌚 ' + (r.data.joke || 'No joke.'));
      } catch { await reply('🌚 API offline.'); }
      return;
    }
    if (cmd === 'cerpen') {
      try {
        const r = await axios.get('https://api.quotable.io/random?tags=fiction', { timeout: 15000 });
        await reply('📖 ' + (r.data.content || '…'));
      } catch { await reply('📖 Offline.'); }
      return;
    }
    if (cmd === 'couple') {
      try {
        const r = await axios.get('https://api.lrsdev.com/couple', { timeout: 15000 }).catch(() => null);
        if (r?.data?.male && r?.data?.female) {
          await sock.sendMessage(from, { image: { url: r.data.male }, caption: '👨' });
          await sock.sendMessage(from, { image: { url: r.data.female }, caption: '👩' });
        } else await reply('💞 API unavailable.');
      } catch { await reply('💞 API unavailable.'); }
      return;
    }
    if (['google', 'gsearch'].includes(cmd)) {
      if (!text) return reply(`Usage: ${prefix}google <query>`);
      return reply('🔍 https://www.google.com/search?q=' + encodeURIComponent(text));
    }
    if (['cuaca', 'weather'].includes(cmd)) {
      if (!text) return reply(`Usage: ${prefix}weather <city>`);
      try {
        const r = await axios.get('https://wttr.in/' + encodeURIComponent(text) + '?format=3', { timeout: 15000, headers: { 'User-Agent': UA } });
        await reply('🌤 ' + String(r.data).trim());
      } catch { await reply('❌ Weather offline.'); }
      return;
    }
    if (['lirik', 'lyrics'].includes(cmd)) {
      if (!text) return reply(`Usage: ${prefix}lyrics <song>`);
      try {
        const r = await axios.get('https://some-random-api.com/lyrics?title=' + encodeURIComponent(text), { timeout: 20000, headers: { 'User-Agent': UA } });
        if (r.data?.lyrics) await reply(`🎵 *${r.data.title || text}*\n${r.data.author || ''}\n\n${String(r.data.lyrics).slice(0, 3500)}`);
        else await reply('❌ Not found.');
      } catch { await reply('❌ Lyrics failed.'); }
      return;
    }
    if (['createqr', 'qr'].includes(cmd)) {
      if (!text) return reply(`Usage: ${prefix}qr <text>`);
      await sock.sendMessage(from, { image: { url: 'https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=' + encodeURIComponent(text) }, caption: '✅ QR' });
      return;
    }
    if (cmd === 'getname') {
      const t = mentioned()[0] || sender;
      try {
        const [wa] = await sock.onWhatsApp(phoneOf(t));
        await reply(`👤 ${wa?.notify || m.pushName || phoneOf(t)}\n+${phoneOf(t)}`);
      } catch { await reply('+' + phoneOf(t)); }
      return;
    }
    if (cmd === 'getpic') {
      const t = mentioned()[0] || sender;
      try {
        const url = await sock.profilePictureUrl(t, 'image');
        await sock.sendMessage(from, { image: { url }, caption: '🖼' });
      } catch { await reply('❌ No profile pic.'); }
      return;
    }
  }
}

startBot().catch(e => { console.error('Fatal:', e); process.exit(1); });
process.on('uncaughtException', e => console.log('Uncaught:', e.message));
process.on('unhandledRejection', e => console.log('Rejection:', e?.message || e));
