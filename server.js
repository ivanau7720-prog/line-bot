const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");

const app = express();

// ===== 🟢 MONITOR（新增）=====
let MONITOR = {
  B: 0,
  P: 0,
  T: 0
};
let COUNT = {
  B: 0,
  P: 0,
  T: 0
};
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
          const vip = getVIP(p.total_topup);
          msg += `${i + 1}. 👤 ${p.name} ${vipTag(vip)} 💰${p.balance}\n`;
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

        // MONITOR重置
MONITOR = { B: 0, P: 0, T: 0 };
COUNT = { B: 0, P: 0, T: 0 };
        
        await broadcast(LANG.START);

try {
  await axios.post("https://live-sync-system-production.up.railway.app/update", {
    text: "🟢 开始下注（60秒）"
  });
} catch (e) {
  console.log("LIVE同步失败 START");
}
        
        let time = 60;
        const timer = setInterval(async () => {
          time -= 10;
          if (time <= 0) {
            clearInterval(timer);
            GAME.isBetting = false;
            await broadcast(LANG.STOP);

            try {
  await axios.post("https://live-sync-system-production.up.railway.app/update", {
    text: "⛔ 停止下注"
  });
} catch (e) {
  console.log("LIVE同步失败 STOP");
}
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

        // ===== 🟢 MONITOR统计（新增）=====
if (MONITOR[side] !== undefined) {
  MONITOR[side] += amount;
  COUNT[side] += 1;
}
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: LANG.BET_OK(user.name, side, amount)
        });
      }

      // ===== 开奖 =====
      if (text.toUpperCase().startsWith("/RESULT") && userId === process.env.ADMIN_ID) {
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

        const fakeBots = generateFakeBots();
        fakeBots.forEach(bot => {
          let change = bot.side === result ? bot.amount : -bot.amount;
          report += `👤 ${bot.name} ⭐VIP ${change > 0 ? "+" : ""}${change}\n`;
        });

        await broadcast(report);
        await broadcast(`${LANG.ROAD}\n${renderRoadTable()}`);

try {
  await axios.post("https://live-sync-system-production.up.railway.app/update", {
    text: `🎯 结果：${result}\n\n📊 路单\n${renderRoadTable()}`
  });
} catch (e) {
  console.log("LIVE同步失败 RESULT");
}
        
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

  <hr/>

  <h3>🔍 搜索玩家</h3>
  <form method="GET">
    <input name="search" placeholder="输入名字或ID"/>
    <button>搜索</button>
  </form>

  <hr/>
  `;

  for (const p of filtered) {
    const vip = getVIP(p.total_topup);

    const { data: userLogs } = await supabase
      .from("transactions")
      .select("*")
      .eq("user_id", p.user_id)
      .order("created_at", { ascending: false })
      .limit(10);

    html += `
    <div style="border:1px solid gray;padding:10px;margin-bottom:15px;">
    
    👤 ${p.name} ${vipTag(vip)} (${p.user_id}) 
    💰${p.balance} 
    💎充值:${p.total_topup}

    <form method="POST" action="/admin/topup">
      <input name="user_id" value="${p.user_id}" hidden />
      <input name="amount" placeholder="+100 / -100" />
      <button>充值 / 扣除</button>
    </form>

    <h4>下注记录</h4>
    `;

    userLogs.forEach(l => {
      html += `<div>${l.bet_side} ${l.amount} → ${l.result} | 输赢:${l.win_amount}</div>`;
    });

    html += "</div>";
  }

  html += `
  <h3>📊 最近记录</h3>
  `;

  logs.forEach(log => {
    html += `<div>${log.name} | ${log.bet_side} ${log.amount} → ${log.result} | ${log.win_amount}</div>`;
  });

  html += "</body></html>";

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

// ===== 🟢 MONITOR页面 =====
app.get("/monitor", (req, res) => {
 
  const total = MONITOR.B + MONITOR.P + MONITOR.T;

  const percent = (v) => total ? ((v / total) * 100).toFixed(1) : 0;

  res.send(`
    <html>
    <head>
      <meta http-equiv="refresh" content="1">
    </head>
    <body style="background:black;color:white;text-align:center;padding-top:80px;font-family:sans-serif;">
      
      <h1>📊 实时下注监控</h1>

      <h2 style="color:red;">
        B 🔴：${MONITOR.B}（${COUNT.B}人） ${percent(MONITOR.B)}%
      </h2>

      <h2 style="color:blue;">
        P 🔵：${MONITOR.P}（${COUNT.P}人） ${percent(MONITOR.P)}%
      </h2>

      <h2 style="color:green;">
        T 🟢：${MONITOR.T}（${COUNT.T}人） ${percent(MONITOR.T)}%
      </h2>

      <hr style="margin:30px;">

      <h2>💰 总下注：${total}</h2>

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
