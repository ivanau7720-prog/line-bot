const express = require("express");
const axios = require("axios");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== 🟢 MONITOR =====
let MONITOR = { B: 0, P: 0, T: 0 };
let COUNT = { B: 0, P: 0, T: 0 };

// ===== 🌏 泰语 =====
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

// ===== 工具 =====
function getBall(r) {
  if (r === "B") return "🔴";
  if (r === "P") return "🔵";
  return "🟢";
}

function renderRoadTable() {
  let grid = "", col = 0;
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

function getRandomAmount() {
  return Math.floor(Math.random() * 9900) + 100;
}

function generateFakeBots() {
  if (!FAKE_CONFIG.enabled) return [];
  const sides = ["B","P","T"];
  let bots = [];
  for (let i=0;i<FAKE_CONFIG.count;i++) {
    bots.push({
      name: FAKE_CONFIG.names[i%FAKE_CONFIG.names.length] + (i+1),
      side: sides[Math.floor(Math.random()*3)],
      amount: getRandomAmount()
    });
  }
  return bots;
}

function getVIP(total) {
  if (!total) return 0;
  if (total>=5120000) return 1;
  if (total>=2560000) return 2;
  if (total>=1280000) return 3;
  if (total>=640000) return 4;
  if (total>=320000) return 5;
  if (total>=160000) return 6;
  if (total>=80000) return 7;
  if (total>=40000) return 8;
  if (total>=20000) return 9;
  if (total>=10000) return 10;
  return 0;
}

function vipTag(vip) {
  if (vip>=8) return "🔥VIP"+vip;
  if (vip>=5) return "💎VIP"+vip;
  if (vip>=1) return "⭐VIP"+vip;
  return "";
}

// ===== 用户 =====
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
  const { data } = await supabase.from("players")
    .select("*").eq("user_id", userId).single();

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

  await supabase.from("players").update({ name }).eq("user_id", userId);
  return { ...data, name };
}

async function changeBalance(userId, amount) {
  const { data } = await supabase.from("players")
    .select("*").eq("user_id", userId).single();

  let newBalance = Number(data.balance) + Number(amount);
  let newTopup = data.total_topup || 0;

  if (amount > 0) newTopup += amount;

  await supabase.from("players").update({
    balance: newBalance,
    total_topup: newTopup
  }).eq("user_id", userId);

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
  res.sendStatus(200); // ⭐ 关键（防卡死）

  for (const event of req.body.events) {
    try {
      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      const userId = event.source.userId;
      const groupId = event.source.groupId;

      if (groupId) GAME.groupId = groupId;

      const text = event.message.text.trim().toUpperCase();
      const user = await getUser(userId, groupId);

      // ===== START =====
      if (text === "/START" && userId === process.env.ADMIN_ID) {

        GAME.isBetting = true;
        GAME.bets = {};
        MONITOR = { B:0,P:0,T:0 };
        COUNT = { B:0,P:0,T:0 };

        await broadcast(LANG.START);

        // LIVE
        axios.post("https://live-sync-system-production.up.railway.app/update", {
          text: LANG.START
        }).catch(()=>{});

        let time = 60;
        const timer = setInterval(async () => {
          time -= 10;

          if (time <= 0) {
            clearInterval(timer);
            GAME.isBetting = false;

            await broadcast(LANG.STOP);

            axios.post("https://live-sync-system-production.up.railway.app/update", {
              text: LANG.STOP
            }).catch(()=>{});

          } else {
            await broadcast(LANG.TIME(time));

            axios.post("https://live-sync-system-production.up.railway.app/update", {
              text: LANG.TIME(time)
            }).catch(()=>{});
          }
        },10000);

        return;
      }

      // ===== BET =====
      if (/^[BPT]\d+$/.test(text)) {
        if (!GAME.isBetting) return;

        const side = text[0];
        const amount = Number(text.slice(1));

        await changeBalance(userId, -amount);
        GAME.bets[userId] = { side, amount };

        MONITOR[side]+=amount;
        COUNT[side]+=1;

        return client.replyMessage(event.replyToken,{
          type:"text",
          text: LANG.BET_OK(user.name, side, amount)
        });
      }

      // ===== RESULT =====
      if (text.startsWith("/RESULT") && userId === process.env.ADMIN_ID) {

        const result = text.split(" ")[1];

        ROAD.push(result);
        if (ROAD.length>30) ROAD.shift();

        let report = `${LANG.RESULT(getBall(result)+" "+result)}\n\n`;

        for (const uid in GAME.bets) {
          const bet = GAME.bets[uid];
          const u = await getUser(uid, groupId);

          let change = bet.side===result ? bet.amount : -bet.amount;

          if (bet.side===result) {
            await changeBalance(uid, bet.amount*2);
          }

          const vip = getVIP(u.total_topup);

          report += `👤 ${u.name} ${vipTag(vip)} ${change>0?"+":""}${change}\n`;
        }

        // 假人
        generateFakeBots().forEach(bot=>{
          let change = bot.side===result ? bot.amount : -bot.amount;
          report += `👤 ${bot.name} ⭐VIP ${change>0?"+":""}${change}\n`;
        });

        await broadcast(report);

        axios.post("https://live-sync-system-production.up.railway.app/update", {
          text: report
        }).catch(()=>{});

        await broadcast(`${LANG.ROAD}\n${renderRoadTable()}`);

        GAME.bets = {};
        return;
      }

    } catch (err) {
      console.log("ERROR:", err);
    }
  }
});

// ===== MONITOR 页面 =====
app.get("/monitor", (req,res)=>{
  const total = MONITOR.B+MONITOR.P+MONITOR.T;
  const percent = v => total ? ((v/total)*100).toFixed(1):0;

  res.send(`
  <html>
  <head><meta http-equiv="refresh" content="1"></head>
  <body style="background:black;color:white;text-align:center;padding-top:80px;">
    <h1>📊 实时下注监控</h1>

    <h2 style="color:red;">B 🔴 ${MONITOR.B} (${COUNT.B}) ${percent(MONITOR.B)}%</h2>
    <h2 style="color:blue;">P 🔵 ${MONITOR.P} (${COUNT.P}) ${percent(MONITOR.P)}%</h2>
    <h2 style="color:green;">T 🟢 ${MONITOR.T} (${COUNT.T}) ${percent(MONITOR.T)}%</h2>

    <hr/>
    <h2>💰 总下注 ${total}</h2>
  </body>
  </html>
  `);
});

app.get("/", (req,res)=>{
  res.send("BOT RUNNING");
});

app.listen(process.env.PORT||3000,()=>{
  console.log("running");
});
