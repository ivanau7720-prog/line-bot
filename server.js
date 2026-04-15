const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== 👑 管理员 =====
const ADMINS = ["U8455884cfb22877f209092cc78ea9880"];

// ===== 🔥 工具 =====
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== 🚀 防429发送队列 =====
let queue = [];
let processing = false;

// 🔥 动态延迟（核心）
let delay = 1500;       // 初始速度
let minDelay = 1200;    // 最快
let maxDelay = 8000;    // 最慢

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const job = queue.shift();

    try {
      await client.pushMessage(job.to, job.message);

      // ✅ 成功 → 慢慢加速
      delay = Math.max(minDelay, delay - 100);

      console.log("✅ send ok | delay:", delay);

    } catch (err) {

      if (err.statusCode === 429) {
        console.log("⚠️ 429 hit → slow down");

        // 🔥 关键：变慢
        delay = Math.min(maxDelay, delay + 1000);

        // 放回队列
        queue.unshift(job);

      } else {
        console.log("❌ error:", err);
      }
    }

    // 🔥 每次发送用动态delay
    await sleep(delay);
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

// ===== 🌏 泰语系统（完整保留）=====
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

// ===== 🎭 演员系统 =====
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
  running: false
};

// ===== 📊 路单 =====
let ROAD = [];

// ===== 球 =====
function getBall(result) {
  if (result === "B") return "🔴";
  if (result === "P") return "🔵";
  return "🟢";
}

// ===== 路表 =====
function renderRoadTable() {
  let grid = "";
  let col = 0;

  ROAD.forEach((r) => {
    grid += getBall(r) + " ";
    col++;
    if (col >= 6) {
      grid += "\n";
      col = 0;
    }
  });

  return grid || "-";
}

// ===== 假人 =====
function getRandomAmount() {
  return Math.floor(Math.random() * 9900) + 100;
}

function generateFakeBots() {
  if (!FAKE_CONFIG.enabled) return [];

  const sides = ["B", "P", "T"];
  let bots = [];

  for (let i = 0; i < FAKE_CONFIG.count; i++) {
    bots.push({
      name: FAKE_CONFIG.names[i % FAKE_CONFIG.names.length] + (i + 1),
      side: sides[Math.floor(Math.random() * 3)],
      amount: getRandomAmount()
    });
  }

  return bots;
}

// ===== VIP =====
function getVIP(total) {
  if (!total) return 0;
  if (total >= 10000) return 1;
  return 0;
}

function vipTag(vip) {
  if (vip >= 1) return "⭐VIP" + vip;
  return "";
}

// ===== 用户 =====
async function getUser(userId) {
  const { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!data) {
    const newUser = {
      user_id: userId,
      balance: 0,
      name: "玩家",
      total_topup: 0
    };
    await supabase.from("players").insert([newUser]);
    return newUser;
  }

  return data;
}

// ===== 改余额 =====
async function changeBalance(userId, amount) {
  const { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  let newBalance = Number(data.balance) + Number(amount);

  await supabase
    .from("players")
    .update({ balance: newBalance })
    .eq("user_id", userId);
}

// ===== 广播 =====
function broadcast(text) {
  if (!GAME.groupId) return;
  safePush(GAME.groupId, {
    type: "text",
    text
  });
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

      const user = await getUser(userId);

      // ===== START（已修复429）=====
      if (text === "/START" && ADMINS.includes(userId)) {

        if (GAME.running) return;

        GAME.running = true;
        GAME.isBetting = true;
        GAME.bets = {};

        MONITOR = { B: 0, P: 0, T: 0 };
        COUNT = { B: 0, P: 0, T: 0 };

        (async () => {

          await broadcast(LANG.START);

          await sleep(30000);
          if (!GAME.isBetting) return;
          await broadcast(LANG.TIME(30));

          await sleep(20000);
          if (!GAME.isBetting) return;
          await broadcast(LANG.TIME(10));

          await sleep(10000);
          GAME.isBetting = false;
          await broadcast(LANG.STOP);

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

      // ===== RESULT =====
      if (text.startsWith("/RESULT") && ADMINS.includes(userId)) {

        const result = text.split(" ")[1];

        ROAD.push(result);
        if (ROAD.length > 30) ROAD.shift();

        let report = `${LANG.RESULT(getBall(result) + " " + result)}\n\n`;

        for (const uid in GAME.bets) {

          const bet = GAME.bets[uid];
          const u = await getUser(uid);

          let change = bet.side === result ? bet.amount : -bet.amount;

          if (bet.side === result) {
            await changeBalance(uid, bet.amount * 2);
          }

          report += `👤 ${u.name} ${change > 0 ? "+" : ""}${change}\n`;

          await sleep(200);
        }

        const fakeBots = generateFakeBots();
        fakeBots.forEach(bot => {
          let change = bot.side === result ? bot.amount : -bot.amount;
          report += `👤 ${bot.name} ${change > 0 ? "+" : ""}${change}\n`;
        });

        await broadcast(report);
        await broadcast(`${LANG.ROAD}\n${renderRoadTable()}`);

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

// ===== ADMIN（恢复）=====
app.get("/admin", async (req, res) => {

  const { data: players } = await supabase.from("players").select("*");

  let html = `<html><body style="background:black;color:white;">`;

  players.forEach(p => {
    html += `<div>${p.name} 💰${p.balance}</div>`;
  });

  html += "</body></html>";

  res.send(html);
});

// ===== MONITOR =====
app.get("/monitor", (req, res) => {

  const total = MONITOR.B + MONITOR.P + MONITOR.T;

  res.send(`
  <html><body style="background:black;color:white;text-align:center;">
  <h2>B ${MONITOR.B}</h2>
  <h2>P ${MONITOR.P}</h2>
  <h2>T ${MONITOR.T}</h2>
  <h3>Total ${total}</h3>
  </body></html>
  `);
});

app.get("/", (req, res) => {
  res.send("BOT RUNNING");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("running");
});
