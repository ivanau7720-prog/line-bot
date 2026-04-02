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
  ROAD: "📊 ประวัติ",
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

// ===== 路单 =====
function renderRoad() {
  return ROAD.map(r => getBall(r)).join(" ");
}

// ===== 🎭 随机金额 =====
function getRandomAmount() {
  return Math.floor(Math.random() * 9900) + 100;
}

// ===== 🎭 生成演员 =====
function generateFakeBots() {
  if (!FAKE_CONFIG.enabled) return [];

  let bots = [];
  const sides = ["B", "P", "T"];

  for (let i = 0; i < FAKE_CONFIG.count; i++) {
    bots.push({
      name: FAKE_CONFIG.names[i % FAKE_CONFIG.names.length] + (i + 1),
      side: sides[Math.floor(Math.random() * 3)],
      amount: getRandomAmount()
    });
  }
  return bots;
}

// ===== 获取LINE名字（支持中英泰）=====
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

// ===== 用户 =====
async function getUser(userId, groupId) {
  const { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  const name = await getProfileName(userId, groupId);

  if (!data) {
    const newUser = { user_id: userId, balance: 0, name };
    await supabase.from("players").insert([newUser]);
    return newUser;
  }

  await supabase.from("players").update({ name }).eq("user_id", userId);

  return { ...data, name };
}

// ===== 改余额 =====
async function changeBalance(userId, amount) {
  const { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  const newBalance = Number(data.balance) + Number(amount);

  await supabase
    .from("players")
    .update({ balance: newBalance })
    .eq("user_id", userId);

  return newBalance;
}

// ===== 广播 =====
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

      // ===== 排行榜 =====
      if (text === "/RANK") {
        const { data } = await supabase.from("players").select("*");
        data.sort((a, b) => b.balance - a.balance);

        let msg = LANG.RANK + "\n\n";
        data.slice(0, 10).forEach((p, i) => {
          msg += `${i + 1}. 👤 ${p.name} 💰${p.balance}\n`;
        });

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: msg
        });
      }

      // ===== 开局 =====
      if (text === "/START" && userId === process.env.ADMIN_ID) {
        GAME.isBetting = true;
        GAME.bets = {};

        await broadcast(LANG.START);

        let time = 60;
        const timer = setInterval(async () => {
          time -= 10;
          if (time <= 0) {
            clearInterval(timer);
            GAME.isBetting = false;
            await broadcast(LANG.STOP);
          } else {
            await broadcast(LANG.TIME(time));
          }
        }, 10000);

        continue;
      }

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

        ROAD.push(result);
        if (ROAD.length > 30) ROAD = [];

        let report = `${LANG.RESULT(getBall(result) + " " + result)}\n\n`;

        // ===== 真玩家 =====
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

          report += `👤 ${u.name} ${change > 0 ? "+" : ""}${change}\n`;
        }

        // ===== 演员 =====
        const fakeBots = generateFakeBots();
        fakeBots.forEach(bot => {
          let change = bot.side === result ? bot.amount : -bot.amount;
          report += `👤 ${bot.name} [VIP] ${change > 0 ? "+" : ""}${change}\n`;
        });

        await broadcast(report);

        await broadcast(`${LANG.ROAD}\n${renderRoad()}`);

        GAME.bets = {};
        return;
      }

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "OK"
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.log(err);
    res.sendStatus(500);
  }
});

// ===== 后台 =====
app.use(express.urlencoded({ extended: true }));

app.get("/admin", async (req, res) => {
  const { data } = await supabase.from("players").select("*");
  const { data: logs } = await supabase
    .from("transactions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);

  let html = `
  <html>
  <head>
  <style>
  body {
    background: linear-gradient(135deg,#0f2027,#203a43,#2c5364);
    color: white;
    font-family: Arial;
    padding: 20px;
  }
  .box {
    background: rgba(0,0,0,0.7);
    padding: 15px;
    margin-bottom: 20px;
    border-radius: 10px;
  }
  </style>
  </head>
  <body>

  <h2>👑 后台系统</h2>

  <div class="box">
  <h3>🎭 演员系统</h3>
  <form method="POST" action="/admin/fake">
  数量: <input name="count" value="${FAKE_CONFIG.count}" />
  名字: <input name="names" value="${FAKE_CONFIG.names.join(",")}" />
  状态:
  <select name="enabled">
  <option value="true">开启</option>
  <option value="false">关闭</option>
  </select>
  <button>保存</button>
  </form>
  </div>

  <div class="box">
  <h3>👤 玩家管理</h3>
  `;

  data.forEach(p => {
    html += `
    <div>
      👤 ${p.name} (${p.user_id}) 💰${p.balance}
      <form method="POST" action="/admin/topup" style="display:inline;">
        <input name="user_id" value="${p.user_id}" hidden />
        <input name="amount" placeholder="+100 / -100" />
        <button>确认</button>
      </form>
    </div>`;
  });

  html += `</div><div class="box"><h3>📊 最近记录</h3>`;

  logs.forEach(log => {
    html += `
    <div>
      ${log.name} | ${log.bet_side} ${log.amount} → ${log.result} | ${log.win_amount}
    </div>`;
  });

  html += `</div></body></html>`;

  res.send(html);
});

app.post("/admin/topup", async (req, res) => {
  const { user_id, amount } = req.body;
  await changeBalance(user_id, Number(amount));
  res.redirect("/admin");
});

app.post("/admin/fake", (req, res) => {
  FAKE_CONFIG.count = Number(req.body.count);
  FAKE_CONFIG.names = req.body.names.split(",");
  FAKE_CONFIG.enabled = req.body.enabled === "true";
  res.redirect("/admin");
});

app.get("/", (req, res) => {
  res.send("BOT RUNNING");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("running");
});
