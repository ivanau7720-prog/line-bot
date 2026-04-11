const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== 🌏 泰语系统 =====
const LANG = {
  START: "🟢 เปิดรอบ! กรุณาวางเดิมพัน (60 วินาที)",
  TIME: (t) => "⏳ เหลือ " + t + " วินาที",
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
  groupId: null
};

// ===== 🟢 MONITOR（新增）=====
let MONITOR = {
  time: 0,
  totals: { B: 0, P: 0, T: 0 }
};

// ===== 📊 路单 =====
let ROAD = [];

function getBall(result) {
  if (result === "B") return "🔴";
  if (result === "P") return "🔵";
  return "🟢";
}

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

function vipTag(vip) {
  if (vip >= 8) return "🔥VIP" + vip;
  if (vip >= 5) return "💎VIP" + vip;
  if (vip >= 1) return "⭐VIP" + vip;
  return "";
}

async function getProfileName(userId, groupId) {
  try {
    let profile;
    if (groupId) {
      profile = await client.getGroupMemberProfile(groupId, userId);
    } else {
      profile = await client.getProfile(userId);
    }
    return profile.displayName;
  } catch {
    return "玩家";
  }
}

async function getUser(userId, groupId) {
  const { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  const name = await getProfileName(userId, groupId);

  if (!data) {
    const newUser = {
      user_id: userId,
      balance: 0,
      name,
      total_topup: 0
    };
    await supabase.from("players").insert([newUser]);
    return newUser;
  }

  await supabase.from("players")
    .update({ name })
    .eq("user_id", userId);

  return { ...data, name };
}

async function changeBalance(userId, amount) {
  const { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  let newBalance = Number(data.balance) + Number(amount);
  let newTopup = data.total_topup || 0;

  if (amount > 0) newTopup += amount;

  await supabase
    .from("players")
    .update({
      balance: newBalance,
      total_topup: newTopup
    })
    .eq("user_id", userId);

  return { balance: newBalance, total_topup: newTopup };
}

async function broadcast(text) {
  if (!GAME.groupId) return;
  await client.pushMessage(GAME.groupId, {
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
      const user = await getUser(userId, groupId);

      // ===== 开局 =====
      if (text === "/START" && userId === process.env.ADMIN_ID) {
        GAME.isBetting = true;
        GAME.bets = {};

        // ✅ MONITOR重置
        MONITOR.time = 60;
        MONITOR.totals = { B: 0, P: 0, T: 0 };

        await broadcast(LANG.START);

        const timer = setInterval(async () => {
          MONITOR.time--;

          if (MONITOR.time <= 0) {
            clearInterval(timer);
            GAME.isBetting = false;
            await broadcast(LANG.STOP);
          } else {
            await broadcast(LANG.TIME(MONITOR.time));
          }
        }, 1000);

        continue;
      }

      // ===== 下注 =====
      if (/^[BPT]\d+$/.test(text)) {
        if (!GAME.isBetting) return;

        const side = text[0];
        const amount = Number(text.slice(1));

        await changeBalance(userId, -amount);
        GAME.bets[userId] = { side, amount };

        // ✅ MONITOR统计
        MONITOR.totals[side] += amount;

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: LANG.BET_OK(user.name, side, amount)
        });
      }

      // ===== 开奖 =====
      if (text.startsWith("/RESULT") && userId === process.env.ADMIN_ID) {
        const result = text.split(" ")[1];

        MONITOR.time = 0; // 停止monitor

        ROAD.push(result);
        if (ROAD.length > 30) ROAD = [];

        let report = `${LANG.RESULT(getBall(result) + " " + result)}\n\n`;

        for (const uid in GAME.bets) {
          const bet = GAME.bets[uid];
          const u = await getUser(uid, groupId);

          let change = bet.side === result ? bet.amount : -bet.amount;

          if (bet.side === result) {
            await changeBalance(uid, bet.amount * 2);
          }

          const vip = getVIP(u.total_topup);

          await supabase.from("transactions").insert([{
            user_id: uid,
            name: u.name,
            amount: bet.amount,
            bet_side: bet.side,
            result: result,
            win_amount: change
          }]);

          report += `👤 ${u.name} ${vipTag(vip)} ${change > 0 ? "+" : ""}${change}\n`;
        }

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

// ===== 🟢 MONITOR 页面（新增）=====
app.get("/monitor", (req, res) => {
  res.send(`
  <html>
  <body style="background:black;color:white;text-align:center;">
    <h1>🎯 实时下注监控</h1>
    <h2 id="time"></h2>
    <h2>B: <span id="b">0</span></h2>
    <h2>P: <span id="p">0</span></h2>
    <h2>T: <span id="t">0</span></h2>

    <script>
      setInterval(async () => {
        const res = await fetch("/monitor/data");
        const data = await res.json();

        document.getElementById("time").innerText = "倒数: " + data.time;
        document.getElementById("b").innerText = data.B;
        document.getElementById("p").innerText = data.P;
        document.getElementById("t").innerText = data.T;
      }, 1000);
    </script>
  </body>
  </html>
  `);
});

app.get("/monitor/data", (req, res) => {
  res.json({
    time: MONITOR.time,
    B: MONITOR.totals.B,
    P: MONITOR.totals.P,
    T: MONITOR.totals.T
  });
});

// ===== 后台（完全保留你原本）=====
app.use(express.urlencoded({ extended: true }));

app.get("/admin", async (req, res) => {
  const keyword = req.query.search || "";

  const { data: players } = await supabase.from("players").select("*");
  const { data: logs } = await supabase
    .from("transactions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);

  let filtered = players;
  if (keyword) {
    filtered = players.filter(p =>
      p.name.includes(keyword) || p.user_id.includes(keyword)
    );
  }

  let html = `
  <html>
  <body style="background:black;color:white;padding:20px;">

  <h2>👑 后台系统</h2>
  `;

  for (const p of filtered) {
    const vip = getVIP(p.total_topup);

    html += `
    <div style="border:1px solid gray;padding:10px;margin-bottom:15px;">
    👤 ${p.name} ${vipTag(vip)} (${p.user_id}) 
    💰${p.balance} 
    </div>`;
  }

  html += "</body></html>";

  res.send(html);
});

app.get("/", (req, res) => {
  res.send("BOT RUNNING");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("running");
});
