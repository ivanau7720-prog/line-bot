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
  ROAD: "📊 珠盘路",
  BET_OK: (name, side, amount) => `✅ ${name} เดิมพัน ${side} ${amount}`,
  RANK: "🏆 排行榜"
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

// ===== 🎭 演员 =====
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

// ===== 珠盘路（6行）=====
function renderBeadRoad() {
  let rows = [[], [], [], [], [], []];

  ROAD.forEach((r, i) => {
    let col = Math.floor(i / 6);
    let row = i % 6;
    rows[row][col] = getBall(r);
  });

  return rows.map(r => r.join(" ")).join("\n");
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

// ===== VIP（累计充值）=====
function getVIP(total) {
  if (total >= 5120000) return "🟣VIP10";
  if (total >= 2560000) return "🟣VIP9";
  if (total >= 1280000) return "🟣VIP8";
  if (total >= 640000) return "🔵VIP7";
  if (total >= 320000) return "🔵VIP6";
  if (total >= 160000) return "🔵VIP5";
  if (total >= 80000) return "🟢VIP4";
  if (total >= 40000) return "🟢VIP3";
  if (total >= 20000) return "🟡VIP2";
  if (total >= 10000) return "🟡VIP1";
  return "";
}

// ===== 获取LINE名字 =====
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
    const newUser = {
      user_id: userId,
      balance: 0,
      total_topup: 0,
      name
    };
    await supabase.from("players").insert([newUser]);
    return newUser;
  }

  await supabase.from("players").update({ name }).eq("user_id", userId);

  return { ...data, name };
}

// ===== 改余额 + 累计充值 =====
async function changeBalance(userId, amount) {
  const { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  let newBalance = Number(data.balance) + Number(amount);
  let newTopup = data.total_topup || 0;

  if (amount > 0) newTopup += Number(amount);

  await supabase
    .from("players")
    .update({
      balance: newBalance,
      total_topup: newTopup
    })
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

        for (const uid in GAME.bets) {
          const bet = GAME.bets[uid];
          const u = await getUser(uid, groupId);

          let change = bet.side === result ? bet.amount : -bet.amount;

          if (bet.side === result) {
            await changeBalance(uid, bet.amount * 2);
          }

          const vip = getVIP(u.total_topup || 0);

          await supabase.from("transactions").insert([{
            user_id: uid,
            name: u.name,
            amount: bet.amount,
            bet_side: bet.side,
            result,
            win_amount: change
          }]);

          report += `👤 ${u.name} ${vip} ${change > 0 ? "+" : ""}${change}\n`;
        }

        const fakeBots = generateFakeBots();
        fakeBots.forEach(bot => {
          let change = bot.side === result ? bot.amount : -bot.amount;
          let vip = "🔥VIP" + (Math.floor(Math.random() * 5) + 1);
          report += `👤 ${bot.name} ${vip} ${change > 0 ? "+" : ""}${change}\n`;
        });

        await broadcast(report);
        await broadcast(`📊 珠盘路\n${renderBeadRoad()}`);

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

  let html = `<html><body style="background:#111;color:#fff;padding:20px;">
  <h2>后台</h2>`;

  data.forEach(p => {
    html += `
    <div>
    👤 ${p.name} (${p.user_id}) 💰${p.balance} ${getVIP(p.total_topup || 0)}
    <form method="POST" action="/admin/topup">
    <input name="user_id" value="${p.user_id}" hidden />
    <input name="amount" placeholder="+100/-100"/>
    <button>确认</button>
    </form>
    </div>`;
  });

  html += "</body></html>";
  res.send(html);
});

app.post("/admin/topup", async (req, res) => {
  await changeBalance(req.body.user_id, Number(req.body.amount));
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
