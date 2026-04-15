const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== 🔥 全局工具 =====
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== 🟢 防429发送队列 =====
let queue = [];
let processing = false;

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const job = queue.shift();

    try {
      await client.pushMessage(job.to, job.message);
      await sleep(1200); // 🔥 核心限速
    } catch (err) {
      if (err.statusCode === 429) {
        console.log("⚠️ 429 retry...");
        await sleep(3000);
        queue.unshift(job);
      } else {
        console.log("❌ send error", err);
      }
    }
  }

  processing = false;
}

function safePush(to, message) {
  queue.push({ to, message });
  processQueue();
}

// ===== 🟢 MONITOR =====
let MONITOR = { B: 0, P: 0, T: 0 };
let COUNT = { B: 0, P: 0, T: 0 };

// ===== 🌏 语言 =====
const LANG = {
  START: "🟢 เปิดรอบ! กรุณาวางเดิมพัน (60 วินาที)",
  TIME: (t) => `⏳ เหลือ ${t} วินาที`,
  STOP: "⛔ ปิดรับเดิมพัน รอผล",
  RESULT: (r) => `🎯 ผลออก: ${r}`,
  ROAD: "📊 ประวัติ (30 เกมล่าสุด)",
  BET_OK: (name, side, amount) => `✅ ${name} เดิมพัน ${side} ${amount}`,
  RANK: "🏆 อันดับผู้เล่น"
};

// ===== LINE =====
const config = {
  channelAccessToken: process.env.LINE_TOKEN,
  channelSecret: process.env.LINE_SECRET
};
const client = new line.Client(config);

// ===== DB =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===== 🎭 假人 =====
let FAKE_CONFIG = {
  enabled: true,
  count: 5,
  names: ["VIP玩家", "老板", "高手"]
};

// ===== 🎯 游戏 =====
let GAME = {
  isBetting: false,
  bets: {},
  groupId: null,
  running: false // 🔥 防重复
};

// ===== 📊 路 =====
let ROAD = [];

// ===== 🎨 球 =====
function getBall(r) {
  if (r === "B") return "🔴";
  if (r === "P") return "🔵";
  return "🟢";
}

// ===== 📊 路表 =====
function renderRoadTable() {
  let grid = "";
  let col = 0;

  ROAD.forEach(r => {
    grid += getBall(r) + " ";
    col++;
    if (col >= 6) {
      grid += "\n";
      col = 0;
    }
  });

  return grid || "-";
}

// ===== 🎭 假人 =====
function getRandomAmount() {
  return Math.floor(Math.random() * 9900) + 100;
}

function generateFakeBots() {
  if (!FAKE_CONFIG.enabled) return [];
  const sides = ["B", "P", "T"];

  return Array.from({ length: FAKE_CONFIG.count }).map((_, i) => ({
    name: FAKE_CONFIG.names[i % FAKE_CONFIG.names.length] + (i + 1),
    side: sides[Math.floor(Math.random() * 3)],
    amount: getRandomAmount()
  }));
}

// ===== VIP =====
function getVIP(total) {
  if (!total) return 0;
  if (total >= 5120000) return 1;
  if (total >= 2560000) return 2;
  if (total >= 1280000) return 3;
  if (total >= 640000) return 4;
  if (total >= 320000) return 5;
  if (total >= 160000) return 6;
  if (total >= 80000) return 7;
  if (total >= 40000) return 8;
  if (total >= 20000) return 9;
  if (total >= 10000) return 10;
  return 0;
}

function vipTag(v) {
  if (v >= 8) return "🔥VIP" + v;
  if (v >= 5) return "💎VIP" + v;
  if (v >= 1) return "⭐VIP" + v;
  return "";
}

// ===== 用户 =====
async function getUser(userId, groupId) {
  const { data } = await supabase.from("players").select("*").eq("user_id", userId).single();

  if (!data) {
    const user = { user_id: userId, balance: 0, name: "玩家", total_topup: 0 };
    await supabase.from("players").insert([user]);
    return user;
  }

  return data;
}

// ===== 改余额 =====
async function changeBalance(userId, amount) {
  const { data } = await supabase.from("players").select("*").eq("user_id", userId).single();

  let newBalance = Number(data.balance) + Number(amount);
  let newTopup = data.total_topup || 0;

  if (amount > 0) newTopup += amount;

  await supabase.from("players").update({
    balance: newBalance,
    total_topup: newTopup
  }).eq("user_id", userId);

  return { balance: newBalance, total_topup: newTopup };
}

// ===== 广播 =====
function broadcast(text) {
  if (!GAME.groupId) return;
  safePush(GAME.groupId, { type: "text", text });
}

// ===== webhook =====
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {

      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      const userId = event.source.userId;
      const groupId = event.source.groupId;
      if (groupId) GAME.groupId = groupId;

      const text = event.message.text.trim().toUpperCase();
      const user = await getUser(userId, groupId);

      // ===== 开局 =====
      if (text === "/START" && userId === process.env.ADMIN_ID) {

        if (GAME.running) return;

        GAME.running = true;
        GAME.isBetting = true;
        GAME.bets = {};

        MONITOR = { B: 0, P: 0, T: 0 };
        COUNT = { B: 0, P: 0, T: 0 };

        (async () => {
          broadcast(LANG.START);

          await sleep(30000);
          if (!GAME.isBetting) return;
          broadcast(LANG.TIME(30));

          await sleep(20000);
          if (!GAME.isBetting) return;
          broadcast(LANG.TIME(10));

          await sleep(10000);

          GAME.isBetting = false;
          broadcast(LANG.STOP);

          GAME.running = false;
        })();

        return;
      }

      // ===== 下注 =====
      if (/^[BPT]\d+$/.test(text)) {

        if (!GAME.isBetting) return;

        const side = text[0];
        const amount = Number(text.slice(1));

        if (user.balance < amount) return;

        await changeBalance(userId, -amount);

        GAME.bets[userId] = { side, amount };

        MONITOR[side] += amount;
        COUNT[side] += 1;

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: LANG.BET_OK(user.name, side, amount)
        });
      }

      // ===== 开奖 =====
      if (text.startsWith("/RESULT") && userId === process.env.ADMIN_ID) {

        const result = text.split(" ")[1];

        ROAD.push(result);
        if (ROAD.length > 30) ROAD.shift();

        let report = `${LANG.RESULT(getBall(result) + " " + result)}\n\n`;

        for (const uid in GAME.bets) {

          const bet = GAME.bets[uid];
          const u = await getUser(uid, groupId);

          let change = bet.side === result ? bet.amount : -bet.amount;

          if (bet.side === result) {
            await changeBalance(uid, bet.amount * 2);
          }

          report += `👤 ${u.name} ${change > 0 ? "+" : ""}${change}\n`;

          await sleep(200); // 🔥 防爆
        }

        generateFakeBots().forEach(bot => {
          let change = bot.side === result ? bot.amount : -bot.amount;
          report += `👤 ${bot.name} ${change > 0 ? "+" : ""}${change}\n`;
        });

        broadcast(report);
        broadcast(`${LANG.ROAD}\n${renderRoadTable()}`);

        GAME.bets = {};
        return;
      }

    }

    res.sendStatus(200);

  } catch (err) {
    console.log(err);
    res.sendStatus(500);
  }
});

// ===== MONITOR =====
app.get("/monitor", (req, res) => {

  const total = MONITOR.B + MONITOR.P + MONITOR.T;
  const percent = v => total ? ((v / total) * 100).toFixed(1) : 0;

  res.send(`
  <html>
  <body style="background:black;color:white;text-align:center;">
  <h1>📊 监控</h1>
  <h2>B: ${MONITOR.B} (${percent(MONITOR.B)}%)</h2>
  <h2>P: ${MONITOR.P} (${percent(MONITOR.P)}%)</h2>
  <h2>T: ${MONITOR.T} (${percent(MONITOR.T)}%)</h2>
  </body>
  </html>
  `);
});

app.get("/", (req, res) => {
  res.send("BOT RUNNING");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("running");
});
