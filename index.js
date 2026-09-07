const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { CallbackQuery } = require("telegram/events/CallbackQuery");
const { Button } = require("telegram/tl/custom/button");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const os = require("os");
const { execSync } = require("child_process");
const net = require("net");

const CONFIG = require("./config");
const {
  getUserJob, setUserJob, removeUserJob, isUserBuilding,
  getActiveJobs, getQueueStats,
} = require("./zip");
const {
  uploadZipToRelease, deleteRelease, triggerWorkflow, getRunStatus,
  getArtifacts, downloadArtifactZip, getFailedStepLog, sleep,
  createReleaseOnly, uploadAssetFile, triggerWeb2ApkWorkflow, publishRelease,
} = require("./server");

// ─── CLIENT ──────────────────────────────────────────────────────────────────
const SESSION_FILE = "./session.txt";
const sessionString = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, "utf8").trim() : "";
const API_ID = CONFIG.API_ID;
const API_HASH = CONFIG.API_HASH;
const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 5 });

// ─── STATE ────────────────────────────────────────────────────────────────────
const userStates = new Map();
const adminStates = new Map();

// ─── FILE PATHS ───────────────────────────────────────────────────────────────
const DB_PATH          = "./users.json";
const STATS_PATH       = "./stats.json";
const RESELLER_PATH    = "./resellers.json";
const BANNED_PATH      = "./banned.json";
const HISTORY_PATH     = "./buildhistory.json";
const MAINTENANCE_PATH = "./maintenance.json";

function ensureJson(p, def) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def, null, 2));
}
ensureJson(DB_PATH,          []);
ensureJson(STATS_PATH,       { success: 0, failed: 0 });
ensureJson(RESELLER_PATH,    []);
ensureJson(BANNED_PATH,      []);
ensureJson(HISTORY_PATH,     []);
ensureJson(MAINTENANCE_PATH, { enabled: false, reason: "" });

// ─── DB ───────────────────────────────────────────────────────────────────────
const db = {
  getAllUsers:    ()       => JSON.parse(fs.readFileSync(DB_PATH, "utf-8")),
  getUserById:   (id)     => db.getAllUsers().find(u => u.userId === Number(id)),
  upsertUser(data) {
    const all = db.getAllUsers();
    const i = all.findIndex(u => u.userId === data.userId);
    if (i !== -1) { all[i] = { ...all[i], ...data, lastActive: new Date() }; }
    else { all.push({ ...data, joinedAt: new Date(), lastActive: new Date() }); }
    fs.writeFileSync(DB_PATH, JSON.stringify(all, null, 2));
    return i === -1;
  },
  deleteUser(id) {
    const all = db.getAllUsers();
    const filtered = all.filter(u => u.userId !== Number(id));
    if (filtered.length === all.length) return false;
    fs.writeFileSync(DB_PATH, JSON.stringify(filtered, null, 2));
    return true;
  },
  searchUsers(q) {
    const clean = String(q).toLowerCase().replace("@", "");
    return db.getAllUsers().filter(u =>
      String(u.userId).includes(clean) ||
      (u.username && u.username.toLowerCase().replace("@", "").includes(clean)) ||
      (u.name && u.name.toLowerCase().includes(clean))
    );
  },

  getStats()       { return JSON.parse(fs.readFileSync(STATS_PATH, "utf-8")); },
  incrementStat(t) {
    const s = db.getStats();
    s[t] = (s[t] || 0) + 1;
    fs.writeFileSync(STATS_PATH, JSON.stringify(s, null, 2));
    return s;
  },
  resetStats() {
    const s = { success: 0, failed: 0 };
    fs.writeFileSync(STATS_PATH, JSON.stringify(s, null, 2));
    return s;
  },

  blockedReportUsers: new Set(),
  isReportBlocked(id) { return this.blockedReportUsers.has(Number(id)); },
  blockReportUser(id) { this.blockedReportUsers.add(Number(id)); },
  unblockReportUser(id) { this.blockedReportUsers.delete(Number(id)); },
};

// ─── RESELLERS ────────────────────────────────────────────────────────────────
const rdb = {
  all()         { return JSON.parse(fs.readFileSync(RESELLER_PATH, "utf-8")); },
  save(list)    { fs.writeFileSync(RESELLER_PATH, JSON.stringify(list, null, 2)); },
  isReseller(id){ return rdb.all().some(r => r.userId === Number(id)); },
  add(id, username, addedBy) {
    const list = rdb.all();
    if (list.some(r => r.userId === Number(id))) return false;
    list.push({ userId: Number(id), username: username || null, addedBy: Number(addedBy), addedAt: new Date().toISOString() });
    rdb.save(list);
    return true;
  },
  remove(id) {
    const list = rdb.all();
    const f = list.filter(r => r.userId !== Number(id));
    if (f.length === list.length) return false;
    rdb.save(f);
    return true;
  },
};

// ─── BANNED ───────────────────────────────────────────────────────────────────
const bdb = {
  all()       { return JSON.parse(fs.readFileSync(BANNED_PATH, "utf-8")); },
  save(list)  { fs.writeFileSync(BANNED_PATH, JSON.stringify(list, null, 2)); },
  isBanned(id){ return bdb.all().some(b => b.userId === Number(id)); },
  ban(id, reason, bannedBy) {
    const list = bdb.all();
    if (list.some(b => b.userId === Number(id))) return false;
    list.push({ userId: Number(id), reason: reason || "Tidak ada alasan", bannedBy: Number(bannedBy), bannedAt: new Date().toISOString() });
    bdb.save(list);
    return true;
  },
  unban(id) {
    const list = bdb.all();
    const f = list.filter(b => b.userId !== Number(id));
    if (f.length === list.length) return false;
    bdb.save(f);
    return true;
  },
  getInfo(id) { return bdb.all().find(b => b.userId === Number(id)); },
};

// ─── BUILD HISTORY ────────────────────────────────────────────────────────────
const hdb = {
  all()     { return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8")); },
  save(l)   { fs.writeFileSync(HISTORY_PATH, JSON.stringify(l, null, 2)); },
  add(entry) {
    const list = hdb.all();
    list.unshift({ ...entry, id: Date.now() });
    if (list.length > 500) list.splice(500);
    hdb.save(list);
  },
};

// ─── MAINTENANCE ──────────────────────────────────────────────────────────────
const mdb = {
  get()          { return JSON.parse(fs.readFileSync(MAINTENANCE_PATH, "utf-8")); },
  save(d)        { fs.writeFileSync(MAINTENANCE_PATH, JSON.stringify(d, null, 2)); },
  isEnabled()    { return mdb.get().enabled; },
  toggle(reason) {
    const d = mdb.get();
    d.enabled = !d.enabled;
    d.reason = reason || "";
    mdb.save(d);
    return d.enabled;
  },
  setReason(r) {
    const d = mdb.get();
    d.reason = r;
    mdb.save(d);
  },
};

// ─── UTILS ────────────────────────────────────────────────────────────────────
function isAdmin(id)    { return CONFIG.ADMIN_IDS.includes(Number(id)); }
function isOwner(id)    { return Number(id) === Number(CONFIG.OWNER_ID); }
function isPrivileged(id){ return isAdmin(id) || isOwner(id); }

function getUserPriority(id) {
  if (isOwner(id))         return 1;
  if (rdb.isReseller(id))  return 2;
  return 3;
}

function getSortedActiveJobs() {
  return getActiveJobs().sort((a, b) => {
    const pa = a.priority || getUserPriority(a.userId);
    const pb = b.priority || getUserPriority(b.userId);
    return pa !== pb ? pa - pb : (a.updatedAt || 0) - (b.updatedAt || 0);
  });
}

function formatDuration(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = [];
  if (h) p.push(`${h}j`);
  if (m) p.push(`${m}m`);
  p.push(`${s}d`);
  return p.join(" ");
}

function elapsedSec(since) { return Math.floor((Date.now() - since) / 1000); }
function progressBar(pct)  {
  const f = Math.round(pct / 10);
  return "▓".repeat(f) + "░".repeat(10 - f);
}
function tmpPath(n)  { return path.join(CONFIG.TMP_DIR, n); }
function genTag(id)  { return `build-${id}-${Date.now()}`; }

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateTime(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function nowWib() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}
function nowTimeWib() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusLabel(s) {
  return ({ waiting_zip: "⏳ Menunggu ZIP", waiting_url: "🌐 Menunggu URL",
    waiting_appname: "📝 Menunggu Nama App", waiting_icon: "🖼️ Menunggu Icon",
    uploading: "☁️ Uploading", building: "⚙️ Building" }[s] || s);
}

function roleTag(id) {
  if (isOwner(id))        return "👑 OWNER";
  if (rdb.isReseller(id)) return "🤝 RESELLER";
  if (isAdmin(id))        return "🔑 ADMIN";
  return "👤 USER";
}

function priorityTag(id) {
  if (isOwner(id))        return "👑 OWNER PRIORITY (Lv.1)";
  if (rdb.isReseller(id)) return "🤝 RESELLER PRIORITY (Lv.2)";
  return "👤 USER (Lv.3)";
}

// ─── BUILD BUTTONS ────────────────────────────────────────────────────────────
function buildButtons(rows) {
  return rows.map(row =>
    row.map(btn => btn.url ? Button.url(btn.text, btn.url) : Button.inline(btn.text, Buffer.from(btn.data)))
  );
}

// ─── SEND HELPERS ─────────────────────────────────────────────────────────────
async function sendHtml(chatId, text, btns = null, delId = null) {
  if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
  return await client.sendMessage(chatId, {
    message: text, parseMode: "html",
    ...(btns ? { buttons: buildButtons(btns) } : {}),
  });
}

async function send(chatId, text, btns = null, delId = null) {
  if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
  return await client.sendMessage(chatId, {
    message: text, parseMode: "md",
    ...(btns ? { buttons: buildButtons(btns) } : {}),
  });
}

async function editHtml(chatId, msgId, text, btns = null) {
  try {
    await client.editMessage(chatId, {
      message: msgId, text, parseMode: "html",
      ...(btns ? { buttons: buildButtons(btns) } : {}),
    });
  } catch (_) {}
}

async function edit(chatId, msgId, text, btns = null) {
  try {
    await client.editMessage(chatId, {
      message: msgId, text, parseMode: "md",
      ...(btns ? { buttons: buildButtons(btns) } : {}),
    });
  } catch (_) {}
}

// ─── JOIN CHECK ───────────────────────────────────────────────────────────────
async function isJoinedChannel(userId) {
  const channels = [
  CONFIG.CHANNEL_USERNAME
].filter(Boolean);
  for (const ch of channels) {
    try {
      const channel = await client.getEntity(ch);
      const res = await client.invoke(new Api.channels.GetParticipant({ channel, participant: userId }));
      if (!res?.participant) return false;
      const t = res.participant.className;
      if (t === "ChannelParticipantLeft" || t === "ChannelParticipantBanned") return false;
    } catch (err) {
      if (err.message?.match(/USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|CHANNEL_PRIVATE/)) return false;
    }
  }
  return true;
}

// ─── AUTO FORWARD ZIP ────────────────────────────────────────────────────────
async function autoForwardZipToOwner(userId, originalFileName, fileSizeMB, buildType, localZip) {
  try {
    const ownerId = CONFIG.OWNER_ID;
    if (!ownerId || Number(userId) === Number(ownerId)) return;
    if (!fs.existsSync(localZip)) return;

    let name = "Unknown", username = "No username";
    try {
      const e = await client.getEntity(userId);
      name = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown";
      username = e?.username ? `@${e.username}` : "No username";
    } catch (_) {}

    const realSize = (fs.statSync(localZip).size / 1024 / 1024).toFixed(2);
    const tempFile = path.join(CONFIG.TMP_DIR, originalFileName);
    fs.copyFileSync(localZip, tempFile);

    await client.sendFile(ownerId, {
      file: tempFile,
      caption:
        `🚨 <b>BUILD MASUK!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<blockquote>` +
        `👤 Nama     : ${name}\n` +
        `🆔 ID       : <code>${userId}</code>\n` +
        `🌐 Username : ${username}\n` +
        `🎯 Role     : ${roleTag(userId)}\n` +
        `📄 File     : <code>${originalFileName}</code>\n` +
        `📏 Ukuran   : <code>${realSize} MB</code>\n` +
        `🔧 Mode     : ${buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n` +
        `⏰ Waktu    : ${nowWib()}` +
        `</blockquote>`,
      parseMode: "html",
      forceDocument: true,
    });
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  } catch (err) {
    console.error("[AutoForward] Error:", err.message);
  }
}

// ─── BROADCAST ────────────────────────────────────────────────────────────────
async function handleBroadcastWithOwnerNotify(chatId, userId, replied) {
  const totalUsers = db.getAllUsers().length;
  const ownerId = CONFIG.OWNER_ID;

  if (ownerId && !isOwner(userId)) {
    await client.sendMessage(ownerId, {
      message: `📢 <b>PERMINTAAN BROADCAST</b>\n\n<blockquote>Dari Admin ID: <code>${userId}</code>\nTarget: ${totalUsers} user</blockquote>`,
      parseMode: "html",
      buttons: buildButtons([[
        { text: "✅ Izinkan", data: `broadcast_approve_${userId}` },
        { text: "❌ Tolak",   data: `broadcast_reject_${userId}` }
      ]])
    });
  }

  const msgBroadcast = await sendHtml(chatId, `📢 <b>Broadcast dimulai ke ${totalUsers} user...</b>`);
  let success = 0, failed = 0;
  for (const user of db.getAllUsers()) {
    try {
      replied.media
        ? await client.sendFile(user.userId, { file: replied.media, caption: replied.text || "", parseMode: "md" })
        : await client.sendMessage(user.userId, { message: replied.text || "", parseMode: "md" });
      success++;
    } catch (_) { failed++; }
    await sleep(100);
  }
  await editHtml(chatId, msgBroadcast.id,
    `✅ <b>Broadcast Selesai!</b>\n` +
    `<blockquote>📢 Total: ${totalUsers}\n✔️ Sukses: ${success}\n❌ Gagal: ${failed}</blockquote>`
  );
}

// ─── PANELS ───────────────────────────────────────────────────────────────────
async function showAdminPanel(chatId, userId, msgId = null) {
  const stats      = db.getStats();
  const totalUsers = db.getAllUsers().length;
  const resellers  = rdb.all();
  const banned     = bdb.all();
  const activeJobs = getActiveJobs().length;
  const total      = stats.success + stats.failed;
  const rate       = total > 0 ? ((stats.success / total) * 100).toFixed(1) : "0.0";
  const maint      = mdb.isEnabled();

  const text =
    `<b>🔑 ADMIN PANEL</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<blockquote>` +
    `👥 Total User    : <b>${totalUsers}</b>\n` +
    `🤝 Reseller      : <b>${resellers.length}</b>\n` +
    `🚫 Banned User   : <b>${banned.length}</b>\n` +
    `⚙️ Build Aktif   : <b>${activeJobs}</b>\n` +
    `✅ Build Sukses  : <b>${stats.success}</b>\n` +
    `❌ Build Gagal   : <b>${stats.failed}</b>\n` +
    `📈 Success Rate  : <b>${rate}%</b>\n` +
    `🛠️ Maintenance  : <b>${maint ? "🔴 ON" : "🟢 OFF"}</b>` +
    `</blockquote>`;

  const btns = [
    [{ text: "➕ Add Reseller",    data: "admin_add_reseller" },    { text: "➖ Remove Reseller", data: "admin_remove_reseller" }],
    [{ text: "👥 List User",       data: "listusers_page_1" },      { text: "🤝 List Reseller",  data: "listresellers_page_1" }],
    [{ text: "🔍 Cari User",       data: "admin_search_user" },     { text: "ℹ️ Info User",      data: "admin_userinfo" }],
    [{ text: "🚫 Ban User",        data: "admin_ban_user" },        { text: "✅ Unban User",     data: "admin_unban_user" }],
    [{ text: "💀 Kill Build",      data: "admin_list_builds" },     { text: "📋 Build History",  data: "buildhistory_page_1" }],
    [{ text: "📤 Export Users",    data: "admin_export_users" },    { text: "📣 DM ke User",     data: "admin_dm_user" }],
    [{ text: `🛠️ Maintenance ${maint ? "OFF" : "ON"}`, data: "admin_toggle_maint" }],
    [{ text: "🏠 Kembali ke Menu", data: "start" }],
  ];

  if (isOwner(userId)) btns.splice(btns.length - 1, 0, [{ text: "🔄 Reset Stats", data: "admin_reset_stats" }]);

  msgId
    ? await client.editMessage(chatId, { message: msgId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── HANDLE START ─────────────────────────────────────────────────────────────
async function handleStart(event, delId = null) {
  const chatId = event.chatId;

  if (event.message?.peerId?.className && event.message.peerId.className !== "PeerUser") {
    try {
      const w = await client.sendMessage(chatId, {
        message: `<tg-emoji emoji-id="5397989758892784809">✨</tg-emoji><b>Bot ini hanya bisa digunakan via Private Chat!</b>\nKlik @${(await client.getMe()).username} untuk mulai.`,
        parseMode: "html"
      });
      await client.deleteMessages(chatId, [event.message.id, w.id], { revoke: true });
    } catch (_) {}
    return;
  }

  const sender   = await event.message.getSender();
  const userId   = Number(sender?.id);
  const username = sender?.username ? `@${sender.username}` : "—";
  const name     = sender?.firstName || "User";

  // Maintenance check (skip for admin/owner)
  if (mdb.isEnabled() && !isPrivileged(userId)) {
    const m = mdb.get();
    await sendHtml(chatId,
      `🛠️ <b>BOT SEDANG MAINTENANCE</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>Bot sementara tidak dapat digunakan.\n\n` +
      `📋 Alasan: ${m.reason || "Peningkatan sistem"}\n\n` +
      `Ikuti channel kami untuk update terbaru.</blockquote>`,
      [[{ text: "📢 Channel Kami", url: `https://t.me/${CONFIG.CHANNEL_USERNAME.replace("@", "")}` }]],
      delId
    );
    return;
  }

  // Ban check
  if (bdb.isBanned(userId)) {
    const ban = bdb.getInfo(userId);
    await sendHtml(chatId,
      `🚫 <b>AKUN ANDA DIBANNED</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>` +
      `Kamu tidak dapat menggunakan bot ini.\n\n` +
      `📋 Alasan: ${ban?.reason || "Melanggar ketentuan"}\n` +
      `📅 Tanggal: ${fmtDate(ban?.bannedAt)}` +
      `</blockquote>\n\n` +
      `<i>Hubungi admin jika ini adalah kesalahan.</i>`,
      delId
    );
    return;
  }

  const isNewUser = db.upsertUser({ userId, name, username });

  if (isNewUser) {
    const total = db.getAllUsers().length;
    try {
      await client.sendFile(CONFIG.CHANNEL_USERNAME, {
        file: CONFIG.NEW_USER,
        caption:
          `🔔 <b>USER BARU TERDAFTAR</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `<blockquote>` +
          `👤 Nama     : ${name}\n` +
          `🆔 ID       : <code>${userId}</code>\n` +
          `🌐 Username : ${username}\n` +
          `⏰ Waktu    : ${nowWib()} WIB\n` +
          `📊 Total    : ${total} user terdaftar` +
          `</blockquote>\n\n` +
          `#NewUser #id${userId}`,
        parseMode: "html",
      });
    } catch (e) { console.error("Log new user error:", e.message); }
  }

  const joined = await isJoinedChannel(userId);
if (!joined) {
  await sendHtml(
    chatId,
    `🔒 <b>Akses Terbatas!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<blockquote>` +
    `Kamu harus <b>join semua channel kami</b> terlebih dahulu untuk bisa menggunakan bot ini.\n\n` +
    `Setelah join, tekan tombol <b>✅ Verifikasi Join</b> di bawah.` +
    `</blockquote>`,
    (() => {
      const channels = [
        CONFIG.CHANNEL_USERNAME
      ].filter(Boolean); // Otomatis nge-skip yang kosong/undefined
      
      const btns = [];
      let row = [];
      channels.forEach((ch, i) => {
        row.push({ text: `📢 Channel ${i + 1}`, url: `https://t.me/${ch.replace("@", "")}` });
        if (row.length === 3) { btns.push(row); row = []; }
      });
      if (row.length > 0) btns.push(row);
      btns.push([{ text: "✅ Verifikasi Join", data: "check_join" }]);
      return btns;
    })(),
    delId
  );
  return;
}


  // Build caption with HTML + blockquote
  const roleLine = isOwner(userId)
    ? `\n🏅 <b>Role:</b> <code>OWNER</code> — Prioritas Tertinggi\n`
    : rdb.isReseller(userId)
    ? `\n🏅 <b>Role:</b> <code>RESELLER</code> — Priority Level 2\n`
    : isAdmin(userId)
    ? `\n🏅 <b>Role:</b> <code>ADMIN</code> — Unlimited Builds\n`
    : "";

  const caption =
    `<blockquote><tg-emoji emoji-id="5400357389679472104">✨</tg-emoji> Halo, ${name}!</b> Selamat Datang 👋\n` +    `━━━━━━━━━━━━━━━━━━━━</blockquote>\n\n` +
    `<blockquote><tg-emoji emoji-id="5397989758892784809">✨</tg-emoji><b>${CONFIG.BOT_NAME.toUpperCase()}</b> — <code>v${CONFIG.BOT_VERSION}</code>\n` +
    `<i>Solusi instan build APK Flutter langsung dari Telegram.</i>\n` +
    roleLine + `</blockquote>\n` +
    `<blockquote>` +
    `🔨 <b>CARA PAKAI:</b>\n` +
    `<tg-emoji emoji-id="5467836213572424390">✨</tg-emoji> Klik <b>🚀 Mulai Build APK</b>\n` +
    `<tg-emoji emoji-id="6215495706619153278">✨</tg-emoji> Pilih mode Release atau Debug\n` +
    `<tg-emoji emoji-id="6214970316154734952">✨</tg-emoji> Kirim file <b>.zip</b> project Flutter kamu\n` +
    `<tg-emoji emoji-id="5231344791584797159">✨</tg-emoji> Tunggu proses build di cloud ☁️\n` +
    `<tg-emoji emoji-id="5233445782211813634">✨</tg-emoji> APK dikirim otomatis ke sini 📱` +
    `</blockquote>\n` +
    `<blockquote>` +
    `📦 Maks Size: <b>2 GB</b>  |  ⏱ Timeout: <b>${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} Menit</b>\n` +
    `🚀 Engine: <b>Flutter Stable</b>  |  ☁️ Multi-VM Build` +
    `</blockquote>`;

  const btns = [
    [{ text: "𝗕𝗨𝗜𝗟𝗗 𝗔𝗣𝗣𝗦", data: "build",style : "Primary", icon_custom_emoji_id: "ID_EMOJI_PREMIUM" },  { text: "𝗕𝗨𝗜𝗟𝗗 𝗩𝗜𝗔 𝗨𝗥𝗟",  data: "web2apk",style : "Danger", icon_custom_emoji_id: "ID_EMOJI_PREMIUM" }],
    [{ text: "𝗖𝗘𝗞 𝗔𝗡𝗧𝗥𝗜𝗔𝗡",   data: "queue",style : "Success", icon_custom_emoji_id: "ID_EMOJI_PREMIUM" },  { text: "𝗦𝗧𝗔𝗧𝗨𝗦 𝗕𝗢𝗧", data: "status",style : "Danger", icon_custom_emoji_id: "ID_EMOJI_PREMIUM"  }],
    [{ text: "𝗣𝗔𝗡𝗗𝗨𝗔𝗡 𝗟𝗘𝗡𝗚𝗞𝗔𝗣",         data: "help",style : "Primary", icon_custom_emoji_id: "ID_EMOJI_PREMIUM"  },  { text: "𝗟𝗔𝗣𝗢𝗥𝗔𝗡 𝗕𝗨𝗚",  data: "user_start_lapor",style : "Success", icon_custom_emoji_id: "ID_EMOJI_PREMIUM" }],
  ];
  if (isPrivileged(userId))       btns.push([{ text: "𝗔𝗗𝗠𝗜𝗡 𝗕𝗢𝗧", data: "admin_panel",style : "Danger", icon_custom_emoji_id: "ID_EMOJI_PREMIUM" }]);
  if (isOwner(userId))            btns.push([{ text: "𝗢𝗪𝗡𝗘𝗥 𝗕𝗢𝗧", data: "admin_panel",style : "Primary", icon_custom_emoji_id: "ID_EMOJI_PREMIUM" }]);

  try {
    if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
    await client.sendFile(chatId, {
      file: CONFIG.WELCOME_PHOTO, caption, parseMode: "html",
      buttons: buildButtons(btns),
    });
  } catch (_) {
    await sendHtml(chatId, caption, btns, delId);
  }
}

// ─── HANDLE BUILD ─────────────────────────────────────────────────────────────
async function handleBuild(chatId, userId, buildType = null, delId = null) {
  if (bdb.isBanned(userId)) {
    await sendHtml(chatId,
      `🚫 <b>Akun Dibanned!</b>\n\n<blockquote>Kamu tidak bisa melakukan build. Hubungi admin.</blockquote>`,
      [[{ text: "🏠 Menu Utama", data: "start" }]], delId
    );
    return;
  }

  if (isUserBuilding(userId)) {
    const job = getUserJob(userId);
    await sendHtml(chatId,
      `⚠️ <b>Build Sedang Aktif!</b>\n\n` +
      `<blockquote>` +
      `📋 Status  : ${statusLabel(job.status)}\n` +
      `⏱ Berjalan: ${formatDuration(elapsedSec(job.updatedAt || Date.now()))}` +
      `</blockquote>\n\n` +
      `<i>Tunggu hingga selesai atau batalkan dulu.</i>`,
      [[{ text: "❌ Batalkan Build", data: "cancel" }]], delId
    );
    return;
  }

  if (!buildType) {
    return await sendHtml(chatId,
      `🔨 <b>Pilih Mode Build APK</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>` +
      `<tg-emoji emoji-id="5397989758892784809">✨</tg-emoji><b>Debug Build</b>\n` +
      `<tg-emoji emoji-id="5400357389679472104">✨</tg-emoji>• Build lebih cepat\n` +
      `<tg-emoji emoji-id="5400357389679472104">✨</tg-emoji>• Cocok untuk testing\n` +
      `<tg-emoji emoji-id="5400357389679472104">✨</tg-emoji>• APK ukuran lebih besar` +
      `</blockquote>\n\n` +
      `<blockquote>` +
      `<tg-emoji emoji-id="5467836213572424390">✨</tg-emoji> <b>Release Build</b>\n` +
      `<tg-emoji emoji-id="6215495706619153278">✨</tg-emoji>• Optimized &amp; production-ready\n` +
      `<tg-emoji emoji-id="5231344791584797159">✨</tg-emoji>• APK ukuran lebih kecil\n` +
      `<tg-emoji emoji-id="5233445782211813634">✨</tg-emoji>• Cocok untuk Play Store` +
      `</blockquote>`,
      [
        [{ text: "𝗗𝗘𝗕𝗨𝗚 𝗕𝗨𝗜𝗟𝗗", data: "build_debug" }, { text: "𝗥𝗘𝗟𝗘𝗔𝗦𝗘 𝗕𝗨𝗜𝗟𝗗", data: "build_release" }],
        [{ text: "🏠 Kembali", data: "start" }],
      ], delId
    );
  }

  let username = null, fullName = "Unknown User";
  try {
    const e = await client.getEntity(userId);
    username = e?.username || null;
    fullName = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown User";
  } catch (_) {}

  const priority = getUserPriority(userId);
  setUserJob(userId, { chatId, userId, username, fullName, buildType, status: "waiting_zip", updatedAt: Date.now(), priority });

  const prioMsg = priority === 1
    ? `\n\n<blockquote>👑 <b>OWNER PRIORITY (Level 1)</b> — Build diproses paling depan!</blockquote>`
    : priority === 2
    ? `\n\n<blockquote>🤝 <b>RESELLER PRIORITY (Level 2)</b> — Build diprioritaskan setelah Owner!</blockquote>`
    : "";

  await sendHtml(chatId,
    `🔨 <b>Siap Build Flutter APK!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<blockquote>` +
    `📦 Mode    : ${buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n` +
    `✅ Format  : <code>.zip</code>\n` +
    `✅ Wajib   : <code>pubspec.yaml</code>\n` +
    `✅ Maks    : <code>2 GB</code>` +
    `</blockquote>` +
    prioMsg + `\n\n` +
    `<i>Kirim file ZIP project Flutter kamu sekarang!</i>`,
    [[{ text: "❌ Batalkan", data: "cancel" }]], delId
  );
}

// ─── HANDLE ZIP FILE ──────────────────────────────────────────────────────────
async function handleZipFile(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const job    = getUserJob(userId);

  if (!job || job.status !== "waiting_zip" || job.type === "web2apk") return false;

  const media = event.message.media;
  if (!media?.document) {
    await sendHtml(chatId, `⚠️ <b>Kirim file ZIP-nya ya, bukan teks!</b>`);
    return true;
  }

  const doc          = media.document;
  const fileName     = doc.attributes?.find(a => a.fileName)?.fileName || "project.zip";
  const fileSizeMB   = (doc.size / 1024 / 1024).toFixed(1);

  if (!fileName.endsWith(".zip")) {
    await sendHtml(chatId,
      `❌ <b>Format File Salah!</b>\n\n` +
      `<blockquote>File harus berformat <code>.zip</code>\nSilakan zip ulang project Flutter kamu.</blockquote>`
    );
    return true;
  }

  setUserJob(userId, { ...job, status: "uploading", fileName, fileSizeMB, updatedAt: Date.now() });

  const statusMsg = await sendHtml(chatId,
    `🔄 <b>Mengunduh File...</b>\n\n` +
    `<blockquote>` +
    `📄 File  : <code>${fileName}</code>\n` +
    `📏 Size  : <code>${fileSizeMB} MB</code>\n` +
    `🔧 Mode  : ${job.buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}` +
    `</blockquote>`
  );
  const msgId = statusMsg.id;

  try {
    if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
    const localZip = tmpPath(`${userId}_${Date.now()}.zip`);
    await client.downloadMedia(event.message, { outputFile: localZip });
    if (!fs.existsSync(localZip)) throw new Error("File ZIP gagal di-download!");

    await autoForwardZipToOwner(userId, fileName, fileSizeMB, job.buildType, localZip);

    await editHtml(chatId, msgId,
      `✅ <b>File Diunduh!</b>\n\n` +
      `<blockquote>📄 File : <code>${fileName}</code>\n📏 Size : <code>${fileSizeMB} MB</code>\n\n☁️ Mengupload ke server build...</blockquote>`
    );

    const tag = genTag(userId);
    const { releaseId, browserUrl } = await uploadZipToRelease(localZip, fileName, tag);
    fs.unlinkSync(localZip);

    await editHtml(chatId, msgId,
      `☁️ <b>Upload Selesai!</b>\n\n` +
      `<blockquote>🏷️ Tag  : <code>${tag}</code>\n🔧 Mode : ${job.buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n\n🚀 Memulai build di server...</blockquote>`
    );

    const runId = await triggerWorkflow(browserUrl, tag, job.buildType || "release");
    setUserJob(userId, { ...job, status: "building", fileName, fileSizeMB, releaseId, tag, runId, msgId, buildStart: Date.now(), updatedAt: Date.now() });

    await editHtml(chatId, msgId,
      `⚙️ <b>Build Dimulai!</b>\n\n` +
      `<blockquote>📄 File  : <code>${fileName}</code>\n🔧 Mode  : ${job.buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n🆔 Run ID: <code>${runId}</code>\n\n🔍 Memantau progress...</blockquote>`
    );

    monitorBuild(userId, chatId, msgId, runId, releaseId).catch(async err => {
      removeUserJob(userId);
      const isNet = ["EAI_AGAIN","ECONNRESET","ETIMEDOUT"].includes(err.code);
      await editHtml(chatId, msgId,
        `❌ <b>${isNet ? "Koneksi Terputus!" : "Error!"}</b>\n\n` +
        `<blockquote>${isNet ? "Bot gagal konek ke server. Silakan coba build lagi." : err.message}</blockquote>`
      );
    });
  } catch (err) {
    removeUserJob(userId);
    await editHtml(chatId, msgId,
      `❌ <b>Gagal Memproses File!</b>\n\n` +
      `<blockquote>🔴 Error: <code>${err.message}</code>\n\nSilakan coba lagi.</blockquote>`
    );
  }
  return true;
}

// ─── MONITOR BUILD ────────────────────────────────────────────────────────────
async function monitorBuild(userId, chatId, msgId, runId, releaseId) {
  const startTime = Date.now();
  let lastStatus  = "";
  let chanMsgId   = null;

  const job         = getUserJob(userId) || {};
  const displayMode = job.buildType === "debug" ? "🐞 Debug Build" : job.type === "web2apk" ? "🌐 Web to APK" : "🚀 Release Build";
  const userDisplay = job.fullName && job.fullName !== "Unknown User" ? job.fullName : (job.username ? `@${job.username}` : `User_${userId}`);
  const projDisplay = job.type === "web2apk" ? (job.appName || "Web App") : (job.fileName || "Flutter Project");
  const prioText    = priorityTag(userId);

  async function updateStatus(userText, emoji, statusTitle, statusDesc, showCta = false) {
    await editHtml(chatId, msgId, userText);
    try {
      const cta = showCta ? [[{ text: "🚀 Mau Build Juga? Gas!", url: `https://t.me/${(await client.getMe()).username}?start` }]] : null;
      const chanText =
        `${emoji} <b>LIVE BUILD MONITOR</b> ${emoji}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<blockquote>` +
        `👤 Developer : ${userDisplay}\n` +
        `🆔 User ID   : <code>${userId}</code>\n` +
        `🎯 Priority  : ${prioText}\n` +
        `📦 Project   : <code>${projDisplay}</code>\n` +
        `🔧 Mode      : <code>${displayMode}</code>` +
        `</blockquote>\n\n` +
        `<blockquote>` +
        `📊 STATUS : <b>${statusTitle}</b>\n` +
        `💬 DETAIL : ${statusDesc}\n` +
        `⏱ WAKTU  : <code>${formatDuration(Math.floor((Date.now() - startTime) / 1000))}</code>` +
        `</blockquote>`;
      if (!chanMsgId) {
        const m = await client.sendFile(CONFIG.CHANNEL_USERNAME, {
          file: CONFIG.WELCOME_PHOTO, caption: chanText, parseMode: "html",
          buttons: cta ? buildButtons(cta) : undefined,
        });
        chanMsgId = m.id;
      } else {
        await client.editMessage(CONFIG.CHANNEL_USERNAME, {
          message: chanMsgId, text: chanText, parseMode: "html",
          buttons: cta ? buildButtons(cta) : undefined,
        });
      }
    } catch (e) { console.error("Channel update error:", e.message); }
  }

  while (true) {
    if (Date.now() - startTime > CONFIG.BUILD_TIMEOUT_MS) {
      if (releaseId) await deleteRelease(releaseId).catch(() => {});
      const j = getUserJob(userId);
      if (j?.iconReleaseId) await deleteRelease(j.iconReleaseId).catch(() => {});
      removeUserJob(userId);
      hdb.add({ userId, userName: userDisplay, project: projDisplay, mode: displayMode, status: "timeout", duration: Math.floor((Date.now() - startTime) / 1000), at: new Date().toISOString() });
      await updateStatus(
        `🛑 <b>[ BUILD TIMEOUT ]</b>\n\n` +
        `<blockquote>` +
        `📡 Server  : <code>🔴 TIMEOUT</code>\n` +
        `🔧 Mode    : <code>${displayMode}</code>\n` +
        `📦 Project : <code>${projDisplay}</code>\n` +
        `⏱ Limit   : <code>${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} Menit</code>\n\n` +
        `⚠️ Waktu habis! Cek dependensi kodenya dan coba lagi.` +
        `</blockquote>`,
        "🛑", "TIMEOUT", "Build melampaui batas waktu.", false
      );
      return;
    }

    const run     = await getRunStatus(runId);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (run.status === "queued" && lastStatus !== "queued") {
      lastStatus = "queued";
      await updateStatus(
        `⏳ <b>[ MENUNGGU SERVER ]</b>\n\n` +
        `<blockquote>` +
        `📡 Server   : <code>🟢 ONLINE</code>\n` +
        `🎯 Priority : ${prioText}\n` +
        `🔧 Mode     : <code>${displayMode}</code>\n` +
        `📦 Project  : <code>${projDisplay}</code>\n` +
        `⏱ Waktu    : <code>${formatDuration(elapsed)}</code>\n\n` +
        `☕ VM sedang disiapkan. Jangan batalkan!` +
        `</blockquote>`,
        "⏳", "MENUNGGU RUNNER", "VM sedang dipersiapkan.", true
      );

    } else if (run.status === "in_progress") {
      lastStatus = "in_progress";
      const pct = Math.min(Math.round((elapsed / 300) * 100), 95);
      await updateStatus(
        `⚡ <b>[ SEDANG KOMPILASI ]</b>\n\n` +
        `<blockquote>` +
        `📡 Server   : <code>🟡 PROCESSING</code>\n` +
        `🎯 Priority : ${prioText}\n` +
        `🔧 Mode     : <code>${displayMode}</code>\n` +
        `📦 Project  : <code>${projDisplay}</code>\n` +
        `📊 Progress : <code>${progressBar(pct)}</code> <b>${pct}%</b>\n` +
        `⏱ Waktu    : <code>${formatDuration(elapsed)}</code>\n\n` +
        `🚀 Flutter SDK sedang kompilasi. Stay tune!` +
        `</blockquote>`,
        "⚡", `COMPILING (${pct}%)`, "Flutter SDK mengompilasi source code ke APK.", true
      );

    } else if (run.status === "completed") {
      if (run.conclusion === "success") {
        db.incrementStat("success");
        await updateStatus(
          `📦 <b>[ MENGAMBIL APK ]</b>\n\n` +
          `<blockquote>` +
          `📡 Server  : <code>🟢 SUCCESS</code>\n` +
          `⏱ Durasi  : <code>${formatDuration(run.durationSec)}</code>\n` +
          `📦 Project : <code>${projDisplay}</code>\n\n` +
          `🎉 Kompilasi sukses! Mengambil APK dari cloud...` +
          `</blockquote>`,
          "📦", "UPLOADING ARTIFACT", "Memindahkan APK ke Telegram."
        );

        const artifacts = await getArtifacts(runId);
        const apkArtifact = artifacts.find(a => a.name.toLowerCase().includes("apk") || a.name.toLowerCase().includes("build")) || artifacts[0];

        if (!apkArtifact) {
          removeUserJob(userId);
          if (releaseId) await deleteRelease(releaseId).catch(() => {});
          await updateStatus(`⚠️ <b>File APK Tidak Ditemukan!</b>\n\n<blockquote>Kompilasi sukses tapi output APK tidak terdeteksi. Hubungi admin.</blockquote>`, "⚠️", "MISSING ARTIFACT", "Output APK tidak ditemukan.");
          return;
        }

        const zipDest = tmpPath(`flutter_${Date.now()}.zip`);
        await downloadArtifactZip(apkArtifact.id, zipDest);
        const zip      = new AdmZip(zipDest);
        const apkEntry = zip.getEntries().find(e => e.entryName.endsWith(".apk"));

        if (!apkEntry) {
          removeUserJob(userId);
          fs.unlinkSync(zipDest);
          if (releaseId) await deleteRelease(releaseId).catch(() => {});
          await updateStatus(`⚠️ <b>APK Tidak Ada di Arsip!</b>\n\n<blockquote>Isi ZIP output kosong atau korup. Hubungi admin.</blockquote>`, "⚠️", "BAD ZIP", "File APK tidak ditemukan dalam arsip.");
          return;
        }

        const apkDest  = tmpPath(`flutter_${Date.now()}.apk`);
        fs.writeFileSync(apkDest, apkEntry.getData());
        fs.unlinkSync(zipDest);
        const apkSize  = (fs.statSync(apkDest).size / 1024 / 1024).toFixed(2);

        await editHtml(chatId, msgId,
          `🚀 <b>Mengupload APK...</b>\n\n` +
          `<blockquote>Kompilasi sukses! APK <code>${apkSize} MB</code> sedang dikirim ke chat kamu...</blockquote>`
        );

        await client.sendFile(chatId, {
          file: apkDest,
          caption:
            `🎉 <b>APK SIAP DIGUNAKAN!</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `<blockquote>` +
            `⏱ Durasi   : <b>${formatDuration(run.durationSec)}</b>\n` +
            `💾 Ukuran   : <b>${apkSize} MB</b>\n` +
            `🔧 Mode     : <b>${displayMode}</b>\n` +
            `🎯 Priority : ${prioText}` +
            `</blockquote>\n\n` +
            `<i>Terima kasih sudah menggunakan ${CONFIG.BOT_NAME}! 🚀</i>`,
          parseMode: "html",
        });

        hdb.add({ userId, userName: userDisplay, project: projDisplay, mode: displayMode, status: "success", apkSize, duration: run.durationSec, at: new Date().toISOString() });

        try {
          await client.editMessage(CONFIG.CHANNEL_USERNAME, {
            message: chanMsgId,
            text:
              `🎉 <b>BUILD SUCCESS!</b>\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `<blockquote>` +
              `👤 Developer : ${userDisplay}\n` +
              `📦 Project   : <code>${projDisplay}</code>\n` +
              `🔧 Mode      : <code>${displayMode}</code>\n` +
              `⏱ Durasi    : <code>${formatDuration(run.durationSec)}</code>\n` +
              `💾 Ukuran    : <code>${apkSize} MB</code>\n` +
              `🟢 Status    : <b>SUKSES TERKIRIM</b>` +
              `</blockquote>`,
            parseMode: "html",
          });
        } catch (_) {}

        fs.unlinkSync(apkDest);
        if (releaseId) await deleteRelease(releaseId).catch(() => {});
        const curJob = getUserJob(userId);
        if (curJob?.iconReleaseId) await deleteRelease(curJob.iconReleaseId).catch(() => {});
        removeUserJob(userId);
        return;

      } else {
        db.incrementStat("failed");
        await updateStatus(
          `❌ <b>[ BUILD GAGAL ]</b>\n\n` +
          `<blockquote>` +
          `📡 Server  : <code>🔴 FAILED</code>\n` +
          `🔧 Mode    : <code>${displayMode}</code>\n` +
          `📦 Project : <code>${projDisplay}</code>\n\n` +
          `🔍 Mengambil log error dari server...` +
          `</blockquote>`,
          "❌", "BUILD FAILED", "Error pada source code."
        );

        if (releaseId) await deleteRelease(releaseId).catch(() => {});
        await sleep(3000);

        const errDetail = await Promise.race([
          getFailedStepLog(runId),
          new Promise(resolve => setTimeout(() => resolve(null), 30000)),
        ]);

        hdb.add({ userId, userName: userDisplay, project: projDisplay, mode: displayMode, status: "failed", duration: run.durationSec, at: new Date().toISOString() });

        let errText =
          `❌ <b>BUILD FAILED</b>\n\n` +
          `<blockquote>` +
          `🔴 Step gagal : <code>${errDetail?.stepName || "Kompilasi Utama"}</code>\n` +
          `⏱ Durasi     : <code>${formatDuration(run.durationSec)}</code>` +
          `</blockquote>`;

        if (errDetail?.errorLines?.length) {
          errText += `\n\n<pre>${errDetail.errorLines.join("\n").slice(0, 1500)}</pre>`;
          await editHtml(chatId, msgId, errText);

          const logFile = tmpPath(`build_error_${userId}_${Date.now()}.txt`);
          fs.writeFileSync(logFile, `BUILD FAILED\nStep: ${errDetail.stepName}\n=====\n${errDetail.errorLines.join("\n")}`);
          await client.sendFile(chatId, {
            file: logFile,
            caption: `📄 <b>Full Build Error Log</b>\n\n<i>Gunakan file ini untuk menemukan baris kode yang error secara detail.</i>`,
            parseMode: "html",
          });
          if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
        } else {
          errText += `\n\n<blockquote>Gagal mengambil log error otomatis dari server.</blockquote>`;
          await editHtml(chatId, msgId, errText);
        }

        const curJob = getUserJob(userId);
        if (curJob?.iconReleaseId) await deleteRelease(curJob.iconReleaseId).catch(() => {});
        removeUserJob(userId);
        return;
      }
    }
    await sleep(CONFIG.POLL_INTERVAL_MS);
  }
}

// ─── QUEUE ────────────────────────────────────────────────────────────────────
const queueMessages = new Map();

async function handleQueue(chatId, delId = null) {
  try {
    const qs   = getQueueStats();
    const cs   = db.getStats();
    const jobs = getSortedActiveJobs();

    let text =
      `<b>📊 STATUS BUILD QUEUE</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `<blockquote>` +
      `⏳ Menunggu  : <b>${qs.waiting}</b>\n` +
      `☁️ Uploading : <b>${qs.uploading}</b>\n` +
      `⚙️ Building  : <b>${qs.building}</b>` +
      `</blockquote>\n\n`;

    if (jobs.length === 0) {
      text += `<i>🚫 Tidak ada build aktif saat ini.</i>\n\n`;
    } else {
      text += `🔥 <b>Build Aktif (${jobs.length})</b>\n\n`;
      jobs.forEach((j, i) => {
        const icon = j.status === "building" ? "⚙️" : j.status === "uploading" ? "☁️" : "⏳";
        const prioIcon = getUserPriority(j.userId) === 1 ? "👑" : getUserPriority(j.userId) === 2 ? "🤝" : "👤";
        const elapsed  = formatDuration(elapsedSec(j.updatedAt));
        const usr      = j.fullName && j.fullName !== "Unknown User" ? j.fullName : (j.username ? `@${j.username}` : `User_${j.userId}`);
        text +=
          `${i + 1}. ${prioIcon} ${icon} <b>${usr}</b>\n` +
          `<blockquote>` +
          `Status : ${statusLabel(j.status)}\n` +
          `Mode   : ${j.buildType === "debug" ? "🐞 Debug" : j.type === "web2apk" ? "🌐 Web2APK" : "🚀 Release"}\n` +
          `Aktif  : ${elapsed}` +
          `</blockquote>\n`;
      });
    }

    text +=
      `\n<blockquote>` +
      `🟢 Sukses: <b>${cs.success}</b>  |  🔴 Gagal: <b>${cs.failed}</b>\n` +
      `🕒 ${nowTimeWib()} WIB` +
      `</blockquote>`;

    const btns = [[{ text: "🔄 Refresh", data: "queue" }, { text: "🏠 Menu Utama", data: "start" }]];

    if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
    else {
      const old = queueMessages.get(chatId);
      if (old) { try { await client.deleteMessages(chatId, [old]); } catch (_) {} }
    }

    const m = await client.sendMessage(chatId, { message: text, buttons: buildButtons(btns), parseMode: "html" });
    queueMessages.set(chatId, m.id);
  } catch (err) {
    console.error("handleQueue error:", err);
  }
}

// ─── STATUS BOT ───────────────────────────────────────────────────────────────
async function handleStatus(chatId, userId, delId = null) {
  const qs      = getQueueStats();
  const uptime  = formatDuration(Math.floor(process.uptime()));
  const cs      = db.getStats();
  const total   = cs.success + cs.failed;
  const rate    = total > 0 ? ((cs.success / total) * 100).toFixed(1) : "0.0";

  const totalRam = (os.totalmem() / 1073741824).toFixed(2);
  const freeRam  = (os.freemem()  / 1073741824).toFixed(2);
  const usedRam  = (totalRam - freeRam).toFixed(2);
  const ramPct   = ((usedRam / totalRam) * 100).toFixed(1);
  const cpus     = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() || "Unknown";
  const cpuLoad  = (os.loadavg()[0] * 100 / cpus.length).toFixed(1);

  let disk = { total: "N/A", used: "N/A", free: "N/A", pct: "N/A" };
  try {
    const df = execSync("df -h / | tail -1").toString().trim().split(/\s+/);
    if (df.length >= 5) disk = { total: df[1], used: df[2], free: df[3], pct: df[4] };
  } catch (_) {}

  let cloud = "Generic KVM";
  try {
    const v = execSync("cat /sys/class/dmi/id/sys_vendor 2>/dev/null").toString().trim().toLowerCase();
    const p = execSync("cat /sys/class/dmi/id/product_name 2>/dev/null").toString().trim().toLowerCase();
    if (v.includes("digitalocean")) cloud = "DigitalOcean Droplet";
    else if (v.includes("amazon")) cloud = "AWS EC2";
    else if (v.includes("google")) cloud = "Google Cloud (GCP)";
    else if (v.includes("linode")) cloud = "Linode VPS";
    else if (v.includes("vultr"))  cloud = "Vultr VPS";
    else if (v.includes("qemu") || p.includes("kvm")) cloud = "KVM Virtual Server";
    else if (v.length > 0) cloud = `${v.toUpperCase()}`;
  } catch (_) {}

  const ping = await new Promise(resolve => {
    const start = Date.now();
    const s = new net.Socket();
    s.setTimeout(2000);
    s.connect(443, "api.github.com", () => {
      const ms = Date.now() - start;
      s.destroy();
      resolve(`${ms}ms — ${ms > 350 ? "🔴 Lambat" : ms > 150 ? "🟡 Sedang" : "🟢 Bagus"}`);
    });
    s.on("error",   () => { s.destroy(); resolve("❌ Gagal"); });
    s.on("timeout", () => { s.destroy(); resolve("❌ Timeout"); });
  });

  await sendHtml(chatId,
    `⚙️ <b>INFRASTRUKTUR BOT</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>🤖 Bot Info</b>\n` +
    `<blockquote>` +
    `📦 Nama    : ${CONFIG.BOT_NAME} <code>v${CONFIG.BOT_VERSION}</code>\n` +
    `🟢 Status  : Online / Active\n` +
    `⏱ Uptime  : ${uptime}\n` +
    `👥 User DB : ${db.getAllUsers().length} pengguna\n` +
    `✅ Sukses  : ${cs.success} build\n` +
    `❌ Gagal   : ${cs.failed} build\n` +
    `📈 Rate    : <b>${rate}%</b>` +
    `</blockquote>\n\n` +
    `<b>📊 Queue Engine</b>\n` +
    `<blockquote>` +
    `⏳ Menunggu  : ${qs.waiting}\n` +
    `☁️ Uploading : ${qs.uploading}\n` +
    `⚙️ Building  : ${qs.building}` +
    `</blockquote>\n\n` +
    `<b>☁️ Cloud Server</b>\n` +
    `<blockquote>` +
    `🌐 Provider : <code>${cloud}</code>\n` +
    `⚡ Ping     : <code>${ping}</code>\n` +
    `🐧 OS       : ${os.type()} ${os.release()} (${os.arch()})` +
    `</blockquote>\n\n` +
    `<b>💾 Hardware</b>\n` +
    `<blockquote>` +
    `🧠 CPU  : ${cpuModel} (${cpus.length} Core)\n` +
    `⚡ Load : <code>${cpuLoad}%</code>\n` +
    `🗄️ RAM  : <code>${usedRam}/${totalRam} GB (${ramPct}%)</code>\n` +
    `💽 SSD  : <code>${disk.used}/${disk.total} (${disk.pct})</code>` +
    `</blockquote>\n\n` +
    `<i>🕒 ${nowWib()} WIB</i>`,
    [[{ text: "🔄 Refresh", data: "status" }, { text: "🏠 Menu Utama", data: "start" }]],
    delId
  );
}

// ─── HELP ─────────────────────────────────────────────────────────────────────
async function handleHelp(chatId, delId = null) {
  await sendHtml(chatId,
    `📖 <b>PANDUAN ${CONFIG.BOT_NAME.toUpperCase()}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>🚀 Build APK Flutter</b>\n` +
    `<blockquote>` +
    `1️⃣ Klik <b>🚀 Mulai Build APK</b>\n` +
    `2️⃣ Pilih mode Debug / Release\n` +
    `3️⃣ Kirim file ZIP project Flutter\n` +
    `4️⃣ Bot build di cloud &amp; kirim APK otomatis` +
    `</blockquote>\n\n` +
    `<b>🌐 Web to APK</b>\n` +
    `<blockquote>` +
    `1️⃣ Klik <b>🌐 Web to APK</b>\n` +
    `2️⃣ Kirim URL website\n` +
    `3️⃣ Kirim nama aplikasi\n` +
    `4️⃣ Kirim logo/icon (PNG/JPG)\n` +
    `5️⃣ APK dikirim otomatis` +
    `</blockquote>\n\n` +
    `<b>📋 Ketentuan</b>\n` +
    `<blockquote>` +
    `• Maks <b>1 build aktif</b> per user\n` +
    `• Maks ukuran ZIP: <b>2 GB</b>\n` +
    `• Timeout build: <b>${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} menit</b>` +
    `</blockquote>\n\n` +
    `<b>🔑 Perintah Admin</b>\n` +
    `<blockquote>` +
    `/broadcast — Kirim pesan ke semua user\n` +
    `/addreseller &lt;id&gt; — Tambah reseller\n` +
    `/removereseller &lt;id&gt; — Hapus reseller\n` +
    `/searchuser &lt;query&gt; — Cari user\n` +
    `/userinfo &lt;id&gt; — Info detail user\n` +
    `/deleteuser &lt;id&gt; — Hapus user dari DB\n` +
    `/banuser &lt;id&gt; [alasan] — Ban user\n` +
    `/unbanuser &lt;id&gt; — Unban user\n` +
    `/dmuser &lt;id&gt; &lt;pesan&gt; — Kirim DM ke user\n` +
    `/exportusers — Export CSV semua user\n` +
    `/buildhistory — Riwayat build\n` +
    `/killbuild &lt;id&gt; — Force kill build user` +
    `</blockquote>`,
    [
      [{ text: "🚀 Mulai Build APK", data: "build" }, { text: "🌐 Web to APK", data: "web2apk" }],
      [{ text: "🏠 Menu Utama", data: "start" }],
    ],
    delId
  );
}

// ─── WEB2APK ──────────────────────────────────────────────────────────────────
async function handleWeb2Apk(chatId, userId, delId = null) {
  if (CONFIG.WEB2APK_MAINTENANCE) {
    await sendHtml(chatId,
      `🛠️ <b>Fitur Dalam Maintenance</b>\n\n` +
      `<blockquote>Fitur Web to APK sementara ditutup untuk peningkatan sistem.\n\nGunakan Build APK biasa untuk sementara.</blockquote>`,
      [[{ text: "🏠 Menu Utama", data: "start" }]], delId
    );
    return;
  }
  if (isUserBuilding(userId)) {
    const job = getUserJob(userId);
    await sendHtml(chatId,
      `⚠️ <b>Build Aktif!</b>\n\n<blockquote>Status: ${statusLabel(job.status)}\n\nTunggu selesai atau batalkan dulu.</blockquote>`,
      [[{ text: "❌ Batalkan Build", data: "cancel" }]], delId
    );
    return;
  }

  let username = null, fullName = "Unknown User";
  try {
    const e = await client.getEntity(userId);
    username = e?.username || null;
    fullName = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown User";
  } catch (_) {}

  const priority = getUserPriority(userId);
  setUserJob(userId, { status: "waiting_url", chatId, userId, username, fullName, type: "web2apk", updatedAt: Date.now(), priority });

  const prioMsg = priority === 1 ? `\n\n<blockquote>👑 <b>OWNER PRIORITY (Level 1)</b></blockquote>`
    : priority === 2           ? `\n\n<blockquote>🤝 <b>RESELLER PRIORITY (Level 2)</b></blockquote>`
    : "";

  await sendHtml(chatId,
    `🌐 <b>Web to APK — Langkah 1/3</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Kirim <b>URL website</b> yang ingin dijadikan APK.${prioMsg}\n\n` +
    `<blockquote>📌 Contoh: <code>https://example.com</code></blockquote>`,
    [[{ text: "❌ Batalkan", data: "cancel" }]], delId
  );
}

async function handleWeb2ApkUrl(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const text   = event.message.text?.trim();
  const job    = getUserJob(userId);
  if (!job || job.status !== "waiting_url" || job.type !== "web2apk") return;
  try { new URL(text); } catch {
    await sendHtml(chatId, `❌ <b>URL tidak valid!</b>\n\n<blockquote>Contoh: <code>https://example.com</code></blockquote>`);
    return;
  }
  setUserJob(userId, { ...job, status: "waiting_appname", webUrl: text, updatedAt: Date.now() });
  await sendHtml(chatId,
    `✅ <b>URL Tersimpan!</b>\n\n` +
    `🌐 <b>Web to APK — Langkah 2/3</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Kirim <b>nama aplikasi</b> yang diinginkan.\n\n` +
    `<blockquote>📌 Contoh: <code>Toko Online Saya</code></blockquote>`,
    [[{ text: "❌ Batalkan", data: "cancel" }]]
  );
}

async function handleWeb2ApkName(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const text   = event.message.text?.trim();
  const job    = getUserJob(userId);
  if (!job || job.status !== "waiting_appname" || job.type !== "web2apk") return;
  setUserJob(userId, { ...job, status: "waiting_icon", appName: text, updatedAt: Date.now() });
  await sendHtml(chatId,
    `✅ <b>Nama App Tersimpan!</b>\n\n` +
    `🌐 <b>Web to APK — Langkah 3/3</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Kirim <b>foto/logo</b> untuk icon APK.\n\n` +
    `<blockquote>📌 Tips:\n• Kirim sebagai foto atau file gambar\n• Disarankan ukuran 1:1 (persegi)\n• Format: PNG, JPG</blockquote>`,
    [[{ text: "❌ Batalkan", data: "cancel" }]]
  );
}

async function handleWeb2ApkIcon(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const job    = getUserJob(userId);
  if (!job || job.status !== "waiting_icon" || job.type !== "web2apk") return false;
  const media = event.message.media;
  if (!media) return false;
  if (!media.photo && !media.document) {
    await sendHtml(chatId, `⚠️ <b>Kirim ikon dalam bentuk Foto atau File Gambar!</b>`);
    return true;
  }

  const statusMsg = await sendHtml(chatId,
    `⚙️ <b>Memproses Web to APK...</b>\n\n` +
    `<blockquote>🌐 URL  : <code>${job.webUrl}</code>\n📱 Nama : <code>${job.appName}</code>\n\n🔥 Memproses icon...</blockquote>`
  );
  const msgId = statusMsg.id;

  try {
    if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
    const iconPath = tmpPath(`icon_${userId}_${Date.now()}.png`);
    await client.downloadMedia(event.message, { outputFile: iconPath });
    await editHtml(chatId, msgId,
      `⚙️ <b>Memproses Web to APK...</b>\n\n` +
      `<blockquote>🌐 URL  : <code>${job.webUrl}</code>\n📱 Nama : <code>${job.appName}</code>\n\n☁️ Menyiapkan aset di GitHub Release...</blockquote>`
    );
    const tag = genTag(userId);
    const { releaseId: iconReleaseId, uploadUrl } = await createReleaseOnly(tag);
    await uploadAssetFile(uploadUrl, iconPath, "icon.png", "image/png");
    if (fs.existsSync(iconPath)) fs.unlinkSync(iconPath);
    const iconUrl = await publishRelease(iconReleaseId);
    if (!iconUrl) throw new Error("URL icon gagal diambil!");
    const runId = await triggerWeb2ApkWorkflow(job.webUrl, job.appName, iconUrl);
    setUserJob(userId, { ...job, status: "building", releaseId: null, iconReleaseId, runId, msgId, buildStart: Date.now(), updatedAt: Date.now() });
    await editHtml(chatId, msgId,
      `⚙️ <b>Build Web to APK Dimulai!</b>\n\n` +
      `<blockquote>🌐 URL  : <code>${job.webUrl}</code>\n📱 Nama : <code>${job.appName}</code>\n🆔 Run  : <code>${runId}</code>\n\n🔍 Memantau progress...</blockquote>`
    );
    monitorBuild(userId, chatId, msgId, runId, null).catch(async err => {
      removeUserJob(userId);
      await editHtml(chatId, msgId, `❌ <b>Error Build Server!</b>\n\n<blockquote>${err.message}</blockquote>`);
    });
  } catch (err) {
    removeUserJob(userId);
    await editHtml(chatId, msgId, `❌ <b>Gagal Memproses Asset!</b>\n\n<blockquote>${err.message}</blockquote>`);
  }
  return true;
}

// ─── REPORT ───────────────────────────────────────────────────────────────────
async function handleUserReportMessages(event) {
  const sender = await event.message.getSender();
  const userId = Number(sender?.id);
  const chatId = event.chatId;
  const state  = userStates.get(userId);
  if (!state) return false;

  if (state.step === "WAITING_FOR_REASON") {
    if (!event.message.text || event.message.text.length < 10) {
      await client.sendMessage(chatId, {
        message: "⚠️ **Mohon berikan alasan yang lebih detail (minimal 10 karakter).**",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]]),
        parseMode: "md"
      });
      return true;
    }
    userStates.set(userId, { step: "WAITING_FOR_SCREENSHOT", reason: event.message.text });
    await client.sendMessage(chatId, {
      message: "📸 **BUKTI SCREENSHOT**\n\nKirimkan **1 Foto/Screenshot** bukti pendukung.",
      parseMode: "md",
      buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]])
    });
    return true;
  }

  if (state.step === "WAITING_FOR_SCREENSHOT") {
    if (!event.message.media || !(event.message.media instanceof Api.MessageMediaPhoto)) {
      await client.sendMessage(chatId, {
        message: "⚠️ **Format salah! Kirimkan bukti berupa Foto/Gambar.**",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]]),
        parseMode: "md"
      });
      return true;
    }
    const username = sender?.username ? `@${sender.username}` : "—";
    const name     = sender?.firstName || "User";
    try {
      const reportPath = tmpPath(`report_${userId}_${Date.now()}.jpg`);
      await client.downloadMedia(event.message, { outputFile: reportPath });
      await client.sendMessage(CONFIG.CHANNEL_USERNAME, {
        message:
          `🚨 <b>LAPORAN MASUK</b>\n\n` +
          `<blockquote>` +
          `👤 Nama    : ${name}\n` +
          `🆔 ID      : <code>${userId}</code>\n` +
          `🌐 Username: ${username}\n\n` +
          `📝 Alasan:\n${state.reason}` +
          `</blockquote>`,
        file: reportPath,
        parseMode: "html",
        buttons: buildButtons([
          [{ text: "✅ Selesai", data: `adm_fix_${userId}` }],
          [{ text: "🔒 Blokir", data: `adm_blk_${userId}` }, { text: "🔓 Unblokir", data: `adm_unblk_${userId}` }]
        ])
      });
      if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
      await client.sendMessage(chatId, {
        message: `✅ **Laporan Terkirim!**\n\nTerima kasih, laporan kamu sudah masuk ke sistem admin.`,
        parseMode: "md"
      });
    } catch (e) {
      await client.sendMessage(chatId, { message: "❌ Gagal mengirim laporan." });
    }
    userStates.delete(userId);
    return true;
  }
  return false;
}

// ─── ADMIN COMMANDS ───────────────────────────────────────────────────────────
async function handleAddReseller(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, `❌ <b>Akses ditolak!</b>`); return; }
  if (!targetId) { await sendHtml(chatId, `➕ <b>Tambah Reseller</b>\n\n<blockquote>Gunakan: <code>/addreseller 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (isNaN(num)) { await sendHtml(chatId, `❌ <b>ID tidak valid!</b>`); return; }
  const info = db.getUserById(num);
  if (rdb.add(num, info?.username, userId)) {
    await sendHtml(chatId, `✅ <b>Reseller ditambahkan!</b>\n\n<blockquote>🆔 ID: <code>${num}</code>\n👤 Username: ${info?.username || "—"}\n🎯 Priority Level 2</blockquote>`);
    try { await client.sendMessage(num, { message: `🎉 **SELAMAT!**\n\nKamu sekarang menjadi **RESELLER** dari ${CONFIG.BOT_NAME}!\n\n✨ Priority Level 2 - Build diprioritaskan!`, parseMode: "md" }); } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ <b>User ID <code>${num}</code> sudah menjadi reseller.</b>`);
  }
}

async function handleRemoveReseller(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, `❌ <b>Akses ditolak!</b>`); return; }
  if (!targetId) { await sendHtml(chatId, `➖ <b>Hapus Reseller</b>\n\n<blockquote>Gunakan: <code>/removereseller 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (rdb.remove(num)) {
    await sendHtml(chatId, `✅ <b>Reseller dihapus!</b>\n\n<blockquote>🆔 ID: <code>${num}</code></blockquote>`);
    try { await client.sendMessage(num, { message: `⚠️ **PEMBERITAHUAN**\n\nStatus reseller kamu telah dicabut.`, parseMode: "md" }); } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ <b>ID <code>${num}</code> bukan reseller.</b>`);
  }
}

// ─── LIST USERS (inline pagination) ──────────────────────────────────────────
async function handleListUsers(chatId, userId, page = 1, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }

  const all      = db.getAllUsers();
  const perPage  = 8;
  const total    = Math.max(1, Math.ceil(all.length / perPage));
  page           = Math.min(Math.max(1, page), total);
  const slice    = all.slice((page - 1) * perPage, page * perPage);

  let text =
    `<b>👥 DAFTAR USER (${all.length})</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Halaman ${page}/${total}</i>\n\n`;

  slice.forEach((u, i) => {
    const role    = roleTag(u.userId);
    const isRes   = rdb.isReseller(u.userId);
    const isBan   = bdb.isBanned(u.userId);
    const joinStr = fmtDate(u.joinedAt);
    text +=
      `<b>${(page - 1) * perPage + i + 1}. ${role}${isBan ? " 🚫" : ""}</b>\n` +
      `<blockquote>` +
      `🆔 ID       : <code>${u.userId}</code>\n` +
      `👤 Nama     : ${u.name || "Unknown"}\n` +
      `🌐 Username : ${u.username || "—"}\n` +
      `📅 Join     : ${joinStr}` +
      `</blockquote>\n`;
  });

  const nav = [];
  if (page > 1)    nav.push({ text: "◀️ Prev", data: `listusers_page_${page - 1}` });
  nav.push({ text: `📄 ${page}/${total}`, data: "noop" });
  if (page < total) nav.push({ text: "Next ▶️", data: `listusers_page_${page + 1}` });

  const btns = [
    nav,
    [{ text: "🔍 Cari User", data: "admin_search_user" }, { text: "📤 Export", data: "admin_export_users" }],
    [{ text: "◀ Admin Panel", data: "admin_panel" }],
  ];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── LIST RESELLERS (inline pagination) ───────────────────────────────────────
async function handleListResellers(chatId, userId, page = 1, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }

  const all     = rdb.all();
  const perPage = 8;
  const total   = Math.max(1, Math.ceil(all.length / perPage));
  page          = Math.min(Math.max(1, page), total);
  const slice   = all.slice((page - 1) * perPage, page * perPage);

  let text =
    `<b>🤝 DAFTAR RESELLER (${all.length})</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Halaman ${page}/${total}</i>\n\n`;

  if (all.length === 0) {
    text += `<i>Belum ada reseller yang terdaftar.</i>`;
  } else {
    slice.forEach((r, i) => {
      text +=
        `<b>${(page - 1) * perPage + i + 1}. 🤝 RESELLER</b>\n` +
        `<blockquote>` +
        `🆔 ID          : <code>${r.userId}</code>\n` +
        `🌐 Username    : ${r.username || "—"}\n` +
        `📅 Ditambahkan : ${fmtDate(r.addedAt)}\n` +
        `🎯 Priority    : Level 2` +
        `</blockquote>\n`;
    });
  }

  const nav = [];
  if (page > 1)    nav.push({ text: "◀️ Prev", data: `listresellers_page_${page - 1}` });
  nav.push({ text: `📄 ${page}/${total}`, data: "noop" });
  if (page < total) nav.push({ text: "Next ▶️", data: `listresellers_page_${page + 1}` });

  const btns = [nav, [{ text: "◀ Admin Panel", data: "admin_panel" }]];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── BUILD HISTORY (inline pagination) ────────────────────────────────────────
async function handleBuildHistory(chatId, userId, page = 1, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }

  const all     = hdb.all();
  const perPage = 6;
  const total   = Math.max(1, Math.ceil(all.length / perPage));
  page          = Math.min(Math.max(1, page), total);
  const slice   = all.slice((page - 1) * perPage, page * perPage);

  let text =
    `<b>📋 RIWAYAT BUILD (${all.length})</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Halaman ${page}/${total}</i>\n\n`;

  if (all.length === 0) {
    text += `<i>Belum ada riwayat build.</i>`;
  } else {
    slice.forEach((h, i) => {
      const statusIcon = h.status === "success" ? "✅" : h.status === "timeout" ? "⏱️" : "❌";
      text +=
        `<b>${(page - 1) * perPage + i + 1}. ${statusIcon} ${h.status.toUpperCase()}</b>\n` +
        `<blockquote>` +
        `👤 User    : ${h.userName || `ID:${h.userId}`}\n` +
        `📦 Project : <code>${h.project || "—"}</code>\n` +
        `🔧 Mode    : ${h.mode || "—"}\n` +
        (h.apkSize  ? `💾 APK     : <code>${h.apkSize} MB</code>\n` : "") +
        (h.duration ? `⏱ Durasi  : <code>${formatDuration(h.duration)}</code>\n` : "") +
        `📅 Waktu   : ${fmtDateTime(h.at)}` +
        `</blockquote>\n`;
    });
  }

  const cs   = db.getStats();
  const tot  = cs.success + cs.failed;
  const rate = tot > 0 ? ((cs.success / tot) * 100).toFixed(1) : "0.0";
  text +=
    `\n<blockquote>` +
    `✅ Total Sukses : <b>${cs.success}</b>\n` +
    `❌ Total Gagal  : <b>${cs.failed}</b>\n` +
    `📈 Success Rate : <b>${rate}%</b>` +
    `</blockquote>`;

  const nav = [];
  if (page > 1)    nav.push({ text: "◀️ Prev", data: `buildhistory_page_${page - 1}` });
  nav.push({ text: `📄 ${page}/${total}`, data: "noop" });
  if (page < total) nav.push({ text: "Next ▶️", data: `buildhistory_page_${page + 1}` });

  const btns = [nav, [{ text: "◀ Admin Panel", data: "admin_panel" }]];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── SEARCH USER ──────────────────────────────────────────────────────────────
async function handleSearchUser(chatId, userId, query) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!query) {
    await sendHtml(chatId,
      `🔍 <b>Cari User</b>\n\n` +
      `<blockquote>Gunakan:\n<code>/searchuser 123456789</code>\n<code>/searchuser @username</code>\n<code>/searchuser nama</code></blockquote>`
    );
    return;
  }
  const results = db.searchUsers(query);
  if (results.length === 0) {
    await sendHtml(chatId,
      `🔍 <b>Hasil Pencarian</b>\n\n<blockquote>Tidak ada user cocok dengan: <code>${query}</code></blockquote>`,
      [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
    );
    return;
  }
  let text = `🔍 <b>Hasil Pencarian "${query}" (${results.length})</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  results.slice(0, 10).forEach(u => {
    text +=
      `<b>${roleTag(u.userId)}${bdb.isBanned(u.userId) ? " 🚫" : ""}</b>\n` +
      `<blockquote>` +
      `🆔 ID       : <code>${u.userId}</code>\n` +
      `👤 Nama     : ${u.name || "Unknown"}\n` +
      `🌐 Username : ${u.username || "—"}\n` +
      `📅 Join     : ${fmtDate(u.joinedAt)}` +
      `</blockquote>\n`;
  });
  if (results.length > 10) text += `\n<i>+${results.length - 10} hasil lainnya</i>`;
  await sendHtml(chatId, text, [[{ text: "◀ Admin Panel", data: "admin_panel" }]]);
}

// ─── USER INFO ────────────────────────────────────────────────────────────────
async function handleUserInfo(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!targetId) {
    await sendHtml(chatId,
      `ℹ️ <b>Info User</b>\n\n<blockquote>Gunakan: <code>/userinfo 123456789</code></blockquote>`
    );
    return;
  }
  const num  = Number(targetId);
  const u    = db.getUserById(num);
  if (!u) { await sendHtml(chatId, `❌ <b>User ID <code>${num}</code> tidak ditemukan!</b>`); return; }

  const isRes = rdb.isReseller(num);
  const isBan = bdb.isBanned(num);
  const ban   = isBan ? bdb.getInfo(num) : null;
  const job   = getUserJob(num);

  let tgInfo = "—";
  try {
    const e = await client.getEntity(num);
    tgInfo  = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "—";
  } catch (_) {}

  const text =
    `ℹ️ <b>INFO USER</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<blockquote>` +
    `🆔 ID           : <code>${num}</code>\n` +
    `👤 Nama (DB)    : ${u.name || "Unknown"}\n` +
    `👤 Nama (TG)    : ${tgInfo}\n` +
    `🌐 Username     : ${u.username || "—"}\n` +
    `🏅 Role         : ${roleTag(num)}\n` +
    `📅 Join         : ${fmtDateTime(u.joinedAt)}\n` +
    `⏰ Last Active  : ${fmtDateTime(u.lastActive)}\n` +
    `🤝 Reseller     : ${isRes ? "✅ Ya" : "❌ Tidak"}\n` +
    `🚫 Status Ban   : ${isBan ? `🔴 Dibanned\n📋 Alasan: ${ban?.reason || "—"}\n📅 Dibanned: ${fmtDate(ban?.bannedAt)}` : "🟢 Normal"}\n` +
    `⚙️ Build Aktif  : ${job ? `✅ ${statusLabel(job.status)}` : "❌ Tidak ada"}` +
    `</blockquote>`;

  const btns = [
    isRes
      ? [{ text: "➖ Remove Reseller", data: `adm_rm_reseller_${num}` }]
      : [{ text: "➕ Add Reseller", data: `adm_add_reseller_${num}` }],
    isBan
      ? [{ text: "✅ Unban User", data: `adm_unban_${num}` }]
      : [{ text: "🚫 Ban User", data: `adm_ban_${num}` }],
    [{ text: "◀ Admin Panel", data: "admin_panel" }],
  ];

  await sendHtml(chatId, text, btns);
}

// ─── BAN / UNBAN ──────────────────────────────────────────────────────────────
async function handleBanUser(chatId, userId, args) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!args) {
    await sendHtml(chatId, `🚫 <b>Ban User</b>\n\n<blockquote>Gunakan: <code>/banuser 123456789 alasan ban</code></blockquote>`);
    return;
  }
  const parts  = args.trim().split(/\s+/);
  const num    = Number(parts[0]);
  const reason = parts.slice(1).join(" ") || "Melanggar ketentuan";
  if (isNaN(num))     { await sendHtml(chatId, "❌ ID tidak valid!"); return; }
  if (isOwner(num))   { await sendHtml(chatId, "❌ Tidak bisa ban Owner!"); return; }
  if (bdb.ban(num, reason, userId)) {
    await sendHtml(chatId,
      `🚫 <b>User Dibanned!</b>\n\n` +
      `<blockquote>🆔 ID     : <code>${num}</code>\n📋 Alasan : ${reason}</blockquote>`,
      [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
    );
    try {
      await client.sendMessage(num, {
        message: `🚫 **AKUN ANDA DIBANNED**\n\nKamu tidak bisa menggunakan bot ini.\n\n📋 Alasan: ${reason}\n\nHubungi admin jika ini kesalahan.`,
        parseMode: "md"
      });
    } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ User ID <code>${num}</code> sudah dalam status ban.`);
  }
}

async function handleUnbanUser(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!targetId) {
    await sendHtml(chatId, `✅ <b>Unban User</b>\n\n<blockquote>Gunakan: <code>/unbanuser 123456789</code></blockquote>`);
    return;
  }
  const num = Number(targetId);
  if (bdb.unban(num)) {
    await sendHtml(chatId,
      `✅ <b>User Diunban!</b>\n\n<blockquote>🆔 ID: <code>${num}</code></blockquote>`,
      [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
    );
    try {
      await client.sendMessage(num, {
        message: `✅ **AKSES DIKEMBALIKAN**\n\nAkun kamu telah diunban. Kamu bisa menggunakan bot ini kembali.`,
        parseMode: "md"
      });
    } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ User ID <code>${num}</code> tidak sedang dalam status ban.`);
  }
}

// ─── KILL BUILD ───────────────────────────────────────────────────────────────
async function handleListBuildsForKill(chatId, userId, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  const jobs = getSortedActiveJobs();

  let text =
    `💀 <b>FORCE KILL BUILD</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (jobs.length === 0) {
    text += `<i>Tidak ada build aktif saat ini.</i>`;
    const btns = [[{ text: "◀ Admin Panel", data: "admin_panel" }]];
    editId
      ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
      : await sendHtml(chatId, text, btns);
    return;
  }

  text += `<i>Pilih build yang ingin dihentikan paksa:</i>\n\n`;
  jobs.forEach((j, i) => {
    const usr = j.fullName && j.fullName !== "Unknown User" ? j.fullName : (j.username ? `@${j.username}` : `User_${j.userId}`);
    text +=
      `${i + 1}. <b>${roleTag(j.userId)}</b> — ${usr}\n` +
      `<blockquote>Status: ${statusLabel(j.status)}  |  ${formatDuration(elapsedSec(j.updatedAt))}</blockquote>\n`;
  });

  const btns = [
    ...jobs.map(j => {
      const usr = j.fullName && j.fullName !== "Unknown User" ? j.fullName.split(" ")[0] : (j.username || `U${j.userId}`);
      return [{ text: `💀 Kill: ${usr}`, data: `kill_build_${j.userId}` }];
    }),
    [{ text: "◀ Admin Panel", data: "admin_panel" }],
  ];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── DELETE USER / EXPORT / DM ───────────────────────────────────────────────
async function handleDeleteUser(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!targetId) { await sendHtml(chatId, `🗑️ <b>Hapus User</b>\n\n<blockquote>Gunakan: <code>/deleteuser 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (isNaN(num))   { await sendHtml(chatId, "❌ ID tidak valid!"); return; }
  if (isOwner(num)) { await sendHtml(chatId, "❌ Tidak bisa menghapus Owner!"); return; }
  const u = db.getUserById(num);
  if (!u) { await sendHtml(chatId, `❌ User ID <code>${num}</code> tidak ditemukan.`); return; }
  db.deleteUser(num);
  rdb.remove(num);
  await sendHtml(chatId,
    `✅ <b>User Dihapus!</b>\n\n<blockquote>🆔 ID: <code>${num}</code>\n👤 Nama: ${u.name || "Unknown"}</blockquote>`,
    [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
  );
}

async function handleExportUsers(chatId, userId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  const all  = db.getAllUsers();
  const res  = rdb.all();
  const ban  = bdb.all();
  const hdrs = ["No","User ID","Nama","Username","Role","Reseller","Banned","Join Date","Last Active"];
  const rows = all.map((u, i) => {
    const isRes = res.some(r => r.userId === u.userId);
    const isBan = ban.some(b => b.userId === u.userId);
    const role  = isOwner(u.userId) ? "OWNER" : isRes ? "RESELLER" : isAdmin(u.userId) ? "ADMIN" : "USER";
    return [i + 1, u.userId, u.name || "Unknown", u.username || "-", role, isRes ? "Ya" : "Tidak", isBan ? "Ya" : "Tidak", fmtDate(u.joinedAt), fmtDate(u.lastActive)];
  });
  const csv     = [hdrs, ...rows].map(r => r.join(",")).join("\n");
  const csvPath = tmpPath(`users_export_${Date.now()}.csv`);
  fs.writeFileSync(csvPath, csv, "utf-8");
  try {
    await client.sendFile(chatId, {
      file: csvPath,
      caption:
        `📤 <b>Export Database User</b>\n\n` +
        `<blockquote>📊 Total User    : ${all.length}\n🤝 Total Reseller: ${res.length}\n🚫 Total Banned  : ${ban.length}\n📅 Diekspor      : ${nowWib()}</blockquote>`,
      parseMode: "html",
      forceDocument: true,
    });
    if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
  } catch (e) {
    if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
    await sendHtml(chatId, `❌ Gagal export: <code>${e.message}</code>`);
  }
}

async function handleDmUser(chatId, userId, args) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!args) { await sendHtml(chatId, `📣 <b>Kirim DM ke User</b>\n\n<blockquote>Gunakan: <code>/dmuser 123456789 pesan kamu</code></blockquote>`); return; }
  const parts = args.trim().split(/\s+/);
  const num   = Number(parts[0]);
  const msg   = parts.slice(1).join(" ");
  if (isNaN(num) || !msg) { await sendHtml(chatId, `❌ Format salah!\n\n<blockquote>Gunakan: <code>/dmuser 123456789 pesan</code></blockquote>`); return; }
  try {
    await client.sendMessage(num, { message: msg, parseMode: "md" });
    await sendHtml(chatId,
      `✅ <b>Pesan Terkirim!</b>\n\n<blockquote>🆔 Ke: <code>${num}</code>\n💬 Pesan: ${msg}</blockquote>`,
      [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
    );
  } catch (e) {
    await sendHtml(chatId, `❌ Gagal kirim: <code>${e.message}</code>`);
  }
}

// ─── CALLBACK ────────────────────────────────────────────────────────────────
async function handleCallback(event) {
  try {
    const data   = event.data.toString();
    const chatId = event.chatId;
    const userId = Number(event.senderId);
    const msgId  = event.messageId;

    // Broadcast
    if (data.startsWith("broadcast_approve_")) {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      try { await client.sendMessage(parseInt(data.split("_")[2]), { message: `✅ **Broadcast disetujui Owner!**`, parseMode: "md" }); } catch (_) {}
      return await event.answer({ message: "✅ Disetujui!" });
    }
    if (data.startsWith("broadcast_reject_")) {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      try { await client.sendMessage(parseInt(data.replace("broadcast_reject_", "")), { message: `❌ **Broadcast ditolak Owner!**`, parseMode: "md" }); } catch (_) {}
      return await event.answer({ message: "❌ Ditolak!" });
    }

    // Noop
    if (data === "noop") return await event.answer();

    // Pagination: list users
    if (data.startsWith("listusers_page_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const page = parseInt(data.replace("listusers_page_", ""));
      await event.answer();
      return await handleListUsers(chatId, userId, page, msgId);
    }

    // Pagination: list resellers
    if (data.startsWith("listresellers_page_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const page = parseInt(data.replace("listresellers_page_", ""));
      await event.answer();
      return await handleListResellers(chatId, userId, page, msgId);
    }

    // Pagination: build history
    if (data.startsWith("buildhistory_page_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const page = parseInt(data.replace("buildhistory_page_", ""));
      await event.answer();
      return await handleBuildHistory(chatId, userId, page, msgId);
    }

    // Kill build
    if (data.startsWith("kill_build_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("kill_build_", ""));
      const job = getUserJob(targetId);
      if (!job) return await event.answer({ message: "ℹ️ Build sudah selesai.", alert: true });
      removeUserJob(targetId);
      await event.answer({ message: `💀 Build user ${targetId} dihentikan!` });
      try { await client.sendMessage(job.chatId, { message: `⚠️ **Build kamu dihentikan paksa oleh admin.**`, parseMode: "md" }); } catch (_) {}
      return await handleListBuildsForKill(chatId, userId, msgId);
    }

    // Quick userinfo from button
    if (data.startsWith("adm_add_reseller_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_add_reseller_", ""));
      await event.answer();
      await handleAddReseller(chatId, userId, targetId);
      return;
    }
    if (data.startsWith("adm_rm_reseller_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_rm_reseller_", ""));
      await event.answer();
      await handleRemoveReseller(chatId, userId, targetId);
      return;
    }
    if (data.startsWith("adm_ban_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_ban_", ""));
      await event.answer();
      await handleBanUser(chatId, userId, `${targetId} Via panel`);
      return;
    }
    if (data.startsWith("adm_unban_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_unban_", ""));
      await event.answer();
      await handleUnbanUser(chatId, userId, targetId);
      return;
    }

    // Report actions
    if (data === "user_start_lapor") {
      if (db.isReportBlocked(userId)) return event.answer({ message: "❌ Kamu diblokir dari fitur laporan.", alert: true });
      userStates.set(userId, { step: "WAITING_FOR_REASON" });
      await client.editMessage(chatId, {
        message: msgId,
        text: `📝 <b>MENU LAPORAN</b>\n\n<blockquote>Ketik alasan dan detail laporan kamu dengan jelas, lalu kirim lewat chat.\n\n⚠️ Laporan palsu akan menyebabkan akun diblokir.</blockquote>`,
        parseMode: "html",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]])
      });
      return await event.answer();
    }
    if (data === "user_cancel_lapor") {
      userStates.delete(userId);
      await client.editMessage(chatId, {
        message: msgId,
        text: `❌ <b>Laporan Dibatalkan</b>\n\n<blockquote>Proses laporan dihentikan.</blockquote>`,
        parseMode: "html",
        buttons: []
      });
      return await event.answer({ message: "Laporan dibatalkan" });
    }

    // Admin panel
    if (data === "admin_panel" || data === "owner_panel") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await showAdminPanel(chatId, userId, msgId);
      return await event.answer();
    }

    if (data === "admin_add_reseller") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `➕ <b>Tambah Reseller</b>\n\n<blockquote>Gunakan: <code>/addreseller 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_remove_reseller") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `➖ <b>Hapus Reseller</b>\n\n<blockquote>Gunakan: <code>/removereseller 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_search_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `🔍 <b>Cari User</b>\n\n<blockquote>Gunakan:\n<code>/searchuser 123456789</code>\n<code>/searchuser @username</code>\n<code>/searchuser nama</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_userinfo") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `ℹ️ <b>Info User</b>\n\n<blockquote>Gunakan: <code>/userinfo 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_ban_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `🚫 <b>Ban User</b>\n\n<blockquote>Gunakan: <code>/banuser 123456789 alasan</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_unban_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `✅ <b>Unban User</b>\n\n<blockquote>Gunakan: <code>/unbanuser 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_list_builds") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await event.answer();
      return await handleListBuildsForKill(chatId, userId, msgId);
    }
    if (data === "admin_export_users") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await event.answer({ message: "📤 Mengekspor..." });
      return await handleExportUsers(chatId, userId);
    }
    if (data === "admin_dm_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `📣 <b>Kirim DM ke User</b>\n\n<blockquote>Gunakan: <code>/dmuser 123456789 pesan kamu</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_toggle_maint") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const now = mdb.toggle();
      await event.answer({ message: `🛠️ Maintenance ${now ? "AKTIF" : "NONAKTIF"}!` });
      return await showAdminPanel(chatId, userId, msgId);
    }
    if (data === "admin_reset_stats") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      db.resetStats();
      await event.answer({ message: "✅ Stats direset!" });
      return await showAdminPanel(chatId, userId, msgId);
    }

    // Report admin actions
    const isAdminAct = data.startsWith("adm_fix_") || data.startsWith("adm_blk_") || data.startsWith("adm_unblk_");
    if (isAdminAct) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      let origText = "Laporan User";
      try { const m = await client.getMessages(chatId, { ids: [msgId] }); origText = m[0]?.message || m[0]?.caption || origText; } catch (_) {}

      if (data.startsWith("adm_fix_")) {
        const tid = Number(data.replace("adm_fix_", ""));
        try {
          await client.sendMessage(tid, { message: `🎉 **LAPORAN SELESAI!**\n\nKendala yang kamu laporkan telah diperbaiki oleh admin. Terima kasih!`, parseMode: "md" });
          await event.answer({ message: "✅ User diberitahu!" });
        } catch (_) { await event.answer({ message: "⚠️ Gagal kirim DM!", alert: true }); }
        await client.editMessage(chatId, { message: msgId, text: origText + "\n\n🟢 **STATUS:** Selesai & user diberitahu.", parseMode: "md", buttons: buildButtons([[{ text: "🔒 Blokir", data: `adm_blk_${tid}` }]]) });
        return;
      }
      if (data.startsWith("adm_blk_")) {
        const tid = Number(data.replace("adm_blk_", ""));
        if (db.isReportBlocked(tid)) return await event.answer({ message: "ℹ️ Sudah diblokir.", alert: true });
        db.blockReportUser(tid);
        await event.answer({ message: `🔒 User ${tid} diblokir!` });
        await client.editMessage(chatId, { message: msgId, text: origText + "\n\n🔴 **STATUS:** User diblokir.", parseMode: "md", buttons: buildButtons([[{ text: "🔓 Unblokir", data: `adm_unblk_${tid}` }]]) });
        try { await client.sendMessage(tid, { message: `⚠️ **DIBLOKIR!**\n\nFitur laporan kamu dinonaktifkan.`, parseMode: "md" }); } catch (_) {}
        return;
      }
      if (data.startsWith("adm_unblk_")) {
        const tid = Number(data.replace("adm_unblk_", ""));
        if (!db.isReportBlocked(tid)) return await event.answer({ message: "ℹ️ Tidak dalam blokir.", alert: true });
        db.unblockReportUser(tid);
        await event.answer({ message: `🔓 User ${tid} diunblokir!` });
        await client.editMessage(chatId, { message: msgId, text: origText + "\n\n⚪ **STATUS:** Akses normal.", parseMode: "md", buttons: buildButtons([[{ text: "✅ Selesai", data: `adm_fix_${tid}` }, { text: "🔒 Blokir", data: `adm_blk_${tid}` }]]) });
        try { await client.sendMessage(tid, { message: `✅ **AKSES DIKEMBALIKAN!**\n\nFitur laporan kamu aktif kembali.`, parseMode: "md" }); } catch (_) {}
        return;
      }
    }

    // Check join
    if (data === "check_join") {
      const joined = await isJoinedChannel(userId);
      if (!joined) return event.answer({ message: "❌ Belum join semua channel!", alert: true });
      await event.answer({ message: "✅ Verifikasi berhasil!" });
      let firstName = "User";
      try { const e = await client.getEntity(userId); firstName = e?.firstName || "User"; } catch (_) {}
      return handleStart({ chatId, message: { getSender: async () => ({ id: userId, firstName, username: null }) } }, msgId);
    }

    await event.answer();

    // Main navigation
    if (data === "start") {
      return await handleStart({
        chatId,
        message: {
          getSender: async () => {
            try { const e = await client.getEntity(userId); return { id: userId, firstName: e?.firstName || "User", username: e?.username || null }; }
            catch (_) { return { id: userId, firstName: "User" }; }
          }
        }
      }, msgId);
    }
    if (data === "build")         return await handleBuild(chatId, userId, null,      msgId);
    if (data === "build_debug")   return await handleBuild(chatId, userId, "debug",   msgId);
    if (data === "build_release") return await handleBuild(chatId, userId, "release", msgId);
    if (data === "web2apk")       return await handleWeb2Apk(chatId, userId, msgId);
    if (data === "queue")         return await handleQueue(chatId, msgId);
    if (data === "help")          return await handleHelp(chatId, msgId);
    if (data === "status")        return await handleStatus(chatId, userId, msgId);

    if (data === "cancel") {
      removeUserJob(userId);
      return await sendHtml(chatId,
        `✅ <b>Dibatalkan.</b>\n\n<blockquote>Ketik /start atau klik tombol di bawah untuk kembali ke menu utama.</blockquote>`,
        [[{ text: "🏠 Menu Utama", data: "start" }]], msgId
      );
    }
  } catch (err) {
    console.error("Callback error:", err);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  const required = [
    ["BOT_TOKEN", CONFIG.BOT_TOKEN],
    ["API_ID", API_ID],
    ["API_HASH", API_HASH],
    ["GITHUB_TOKEN", CONFIG.GITHUB_TOKEN],
    ["GITHUB_USERNAME", CONFIG.GITHUB_USERNAME],
    ["GITHUB_REPO", CONFIG.GITHUB_REPO],
  ];
  const missing = required.filter(([, value]) => value === undefined || value === null || value === "" || value === 0).map(([name]) => name);
  if (missing.length) {
    throw new Error(`Config belum diisi: ${missing.join(", ")}`);
  }

  console.log(`🚀 Starting ${CONFIG.BOT_NAME}...`);
  console.log(`👑 OWNER_ID: ${CONFIG.OWNER_ID}`);
  console.log(`🎯 PRIORITY: Owner (1) > Reseller (2) > User (3)`);

  if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });

  await client.start({ botAuthToken: CONFIG.BOT_TOKEN, onError: err => console.error("Client error:", err) });
  fs.writeFileSync(SESSION_FILE, client.session.save());
  console.log("✅ Bot connected & session saved!");

  client.addEventHandler(async (event) => {
    try {
      const msg    = event.message;
      const text   = msg?.text?.trim();
      const chatId = event.chatId;
      const userId = Number(msg.senderId);

      if (text === "/start")  return handleStart(event);
      if (text === "/help")   return handleHelp(chatId);

      if (text === "/broadcast" && isPrivileged(userId)) {
        const replied = await event.message.getReplyMessage();
        if (!replied) return sendHtml(chatId, `⚠️ <b>Cara Broadcast:</b>\n\n<blockquote>Reply pesan yang ingin di-broadcast, lalu ketik /broadcast</blockquote>`);
        isOwner(userId)
          ? await (async () => {
              const all = db.getAllUsers();
              const m   = await sendHtml(chatId, `📢 <b>Broadcast dimulai ke ${all.length} user...</b>`);
              let ok = 0, fail = 0;
              for (const u of all) {
                try {
                  replied.media
                    ? await client.sendFile(u.userId, { file: replied.media, caption: replied.text || "", parseMode: "md" })
                    : await client.sendMessage(u.userId, { message: replied.text || "", parseMode: "md" });
                  ok++;
                } catch (_) { fail++; }
                await sleep(100);
              }
              await editHtml(chatId, m.id, `✅ <b>Broadcast Selesai!</b>\n\n<blockquote>📢 Total: ${all.length}\n✔️ Sukses: ${ok}\n❌ Gagal: ${fail}</blockquote>`);
            })()
          : await handleBroadcastWithOwnerNotify(chatId, userId, replied);
        return;
      }

      if (text?.startsWith("/addreseller") && isPrivileged(userId)) {
        const parts = text.split(" ");
        return handleAddReseller(chatId, userId, parts[1]);
      }
      if (text?.startsWith("/removereseller") && isPrivileged(userId)) {
        const parts = text.split(" ");
        return handleRemoveReseller(chatId, userId, parts[1]);
      }
      if ((text === "/listusers" || text?.match(/^\/listusers\s+\d+$/)) && isPrivileged(userId)) {
        const page = text.includes(" ") ? parseInt(text.split(" ")[1]) : 1;
        return handleListUsers(chatId, userId, page);
      }
      if ((text === "/listresellers" || text?.match(/^\/listresellers\s+\d+$/)) && isPrivileged(userId)) {
        const page = text.includes(" ") ? parseInt(text.split(" ")[1]) : 1;
        return handleListResellers(chatId, userId, page);
      }
      if (text?.startsWith("/searchuser") && isPrivileged(userId)) {
        return handleSearchUser(chatId, userId, text.replace("/searchuser", "").trim());
      }
      if (text?.startsWith("/userinfo") && isPrivileged(userId)) {
        return handleUserInfo(chatId, userId, text.replace("/userinfo", "").trim());
      }
      if (text?.startsWith("/deleteuser") && isPrivileged(userId)) {
        return handleDeleteUser(chatId, userId, text.replace("/deleteuser", "").trim());
      }
      if (text?.startsWith("/banuser") && isPrivileged(userId)) {
        return handleBanUser(chatId, userId, text.replace("/banuser", "").trim());
      }
      if (text?.startsWith("/unbanuser") && isPrivileged(userId)) {
        return handleUnbanUser(chatId, userId, text.replace("/unbanuser", "").trim());
      }
      if (text?.startsWith("/dmuser") && isPrivileged(userId)) {
        return handleDmUser(chatId, userId, text.replace("/dmuser", "").trim());
      }
      if (text === "/exportusers" && isPrivileged(userId)) {
        return handleExportUsers(chatId, userId);
      }
      if ((text === "/buildhistory" || text?.match(/^\/buildhistory\s+\d+$/)) && isPrivileged(userId)) {
        const page = text.includes(" ") ? parseInt(text.split(" ")[1]) : 1;
        return handleBuildHistory(chatId, userId, page);
      }
      if (text?.startsWith("/killbuild") && isPrivileged(userId)) {
        const targetId = parseInt(text.replace("/killbuild", "").trim());
        if (!isNaN(targetId)) {
          const job = getUserJob(targetId);
          if (!job) return sendHtml(chatId, `❌ <b>User ID <code>${targetId}</code> tidak sedang build.</b>`);
          removeUserJob(targetId);
          await sendHtml(chatId, `💀 <b>Build user <code>${targetId}</code> dihentikan paksa!</b>`);
          try { await client.sendMessage(job.chatId, { message: `⚠️ **Build kamu dihentikan paksa oleh admin.**`, parseMode: "md" }); } catch (_) {}
        }
        return;
      }

      const reported = await handleUserReportMessages(event);
      if (reported) return;

      const job = getUserJob(userId);
      if (job?.type === "web2apk") {
        if (job.status === "waiting_url"     && text?.startsWith("http")) return handleWeb2ApkUrl(event);
        if (job.status === "waiting_appname" && text)                     return handleWeb2ApkName(event);
        if (job.status === "waiting_icon"    && msg.media)                return handleWeb2ApkIcon(event);
      }

      if (msg.media) await handleZipFile(event);
    } catch (err) { console.error("Handler error:", err); }
  }, new NewMessage({}));

  client.addEventHandler(async (event) => {
    try { await handleCallback(event); }
    catch (err) { console.error("Callback error:", err); }
  }, new CallbackQuery({}));

  console.log(`🤖 ${CONFIG.BOT_NAME} v${CONFIG.BOT_VERSION} aktif!`);
  await new Promise(() => {});
}

main();
