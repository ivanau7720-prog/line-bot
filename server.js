// ===== 在原有 require 不动 =====
const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== 🌏 泰语系统 =====
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
  groupId: null
};

// ===== 📊 路单 =====
let ROAD = [];

// ===== 🎨 球 =====
function getBall(result) {
  if (result === "B") return "🔴";
  if (result === "P") return "🔵";
  return "🟢";
}

// ===== 📊 珠盘路 =====
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

// ===== 🎭 随机金额 =====
function getRandomAmount() {
  return Math.floor(Math.random() * 9900) + 100;
}

// ===== 🎭 生成演员 =====
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

// ===== 获取用户 =====
async function getUser(userId, groupId) {
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

// ===== webhook（原逻辑不动）=====
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

      // ===== 下注 =====
      if (/^[BPT]\d+$/.test(text)) {
        if (!GAME.isBetting) return;

        const side = text[0];
        const amount = Number(text.slice(1));

        await changeBalance(userId, -amount);
        GAME.bets[userId] = { side, amount };

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: LANG.BET_OK(user.name, side, amount)
        });
      }

      // ===== 开奖 =====
      if (text.startsWith("/RESULT") && userId === process.env.ADMIN_ID) {
        const result = text.split(" ")[1];

        for (const uid in GAME.bets) {
          const bet = GAME.bets[uid];
          const u = await getUser(uid, groupId);

          let change = bet.side === result ? bet.amount : -bet.amount;

          if (bet.side === result) {
            await changeBalance(uid, bet.amount * 2);
          }

          await supabase.from("transactions").insert([{
            user_id: uid,
            name: u.name,
            amount: bet.amount,
            bet_side: bet.side,
            result: result,
            win_amount: change
          }]);
        }

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

// ===== ✅ 后台升级 =====
app.use(express.urlencoded({ extended: true }));

app.get("/admin", async (req, res) => {
  const keyword = req.query.search || "";

  const { data: players } = await supabase.from("players").select("*");

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

  🔍 <form method="GET">
    <input name="search" placeholder="输入名字或ID" />
    <button>搜索玩家</button>
  </form>
  <hr/>
  `;

  for (const p of filtered) {
    const { data: logs } = await supabase
      .from("transactions")
      .select("*")
      .eq("user_id", p.user_id)
      .order("created_at", { ascending: false })
      .limit(10);

    html += `
    <div style="margin-bottom:20px;border:1px solid gray;padding:10px;">
    👤 ${p.name} (${p.user_id}) 💰${p.balance} 💎充值:${p.total_topup}

    <h4>📊 下注记录</h4>
    `;

    logs.forEach(l => {
      html += `
      <div>
      ${l.bet_side} ${l.amount} → ${l.result} | 输赢: ${l.win_amount}
      </div>`;
    });

    html += "</div>";
  }

  html += "</body></html>";

  res.send(html);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("running");
});
