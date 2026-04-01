const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

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

// ===== 🎭 演员配置 =====
let FAKE_CONFIG = {
  enabled: true,
  count: 5,
  names: ["小明", "VIP玩家", "老板"]
};

// ===== 游戏状态 =====
let GAME = {
  isBetting: false,
  bets: {},
  history: [],
  groupId: null
};

// ===== 🎭 生成演员 =====
function generateFakeBots() {
  if (!FAKE_CONFIG.enabled) return [];

  let bots = [];
  const sides = ["B", "P", "T"];

  for (let i = 0; i < FAKE_CONFIG.count; i++) {
    const name = FAKE_CONFIG.names[i % FAKE_CONFIG.names.length];
    const side = sides[Math.floor(Math.random() * 3)];
    const amount = Math.floor(Math.random() * 9900) + 100;

    bots.push({
      name: name + (i + 1),
      side,
      amount
    });
  }

  return bots;
}

// ===== ✅ 正确获取LINE名字（关键修复）=====
async function getProfileName(userId, groupId) {
  try {
    if (groupId) {
      const profile = await client.getGroupMemberProfile(groupId, userId);
      return profile.displayName;
    } else {
      const profile = await client.getProfile(userId);
      return profile.displayName;
    }
  } catch {
    return "玩家";
  }
}

// ===== 获取用户（自动更新名字）=====
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
      name: name
    };

    await supabase.from("players").insert([newUser]);
    return newUser;
  }

  // 每次自动更新名字（支持中英泰）
  await supabase
    .from("players")
    .update({ name: name })
    .eq("user_id", userId);

  return { ...data, name };
}

// ===== 修改余额 =====
async function changeBalance(userId, amount) {
  const user = await getUser(userId);
  const newBalance = Number(user.balance) + Number(amount);

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
    const events = req.body.events;

    for (const event of events) {
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

        let msg = "🏆 排行榜\n\n";

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

        await broadcast("🟢 开局！请下注（60秒）");

        let time = 60;

        const timer = setInterval(async () => {
          time -= 10;

          if (time <= 0) {
            clearInterval(timer);
            GAME.isBetting = false;
            await broadcast("⛔ 停止下注，等待开奖");
          } else {
            await broadcast(`⏳ 剩余 ${time} 秒`);
          }
        }, 10000);

        continue;
      }

      // ===== 下注 =====
      if (/^[BPT]\d+$/i.test(text)) {
        if (!GAME.isBetting) return;

        const side = text[0];
        const amount = Number(text.slice(1));

        await changeBalance(userId, -amount);
        GAME.bets[userId] = { side, amount };

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: `✅ ${user.name} 下注 ${side} ${amount}`
        });
      }

      // ===== 开奖 =====
      if (text.startsWith("/RESULT") && userId === process.env.ADMIN_ID) {
        const result = text.split(" ")[1];

        let report = `🎯 开奖结果：${result}\n\n`;

        for (const uid in GAME.bets) {
          const bet = GAME.bets[uid];
          const u = await getUser(uid, groupId);

          let change = bet.side === result ? bet.amount : -bet.amount;

          if (bet.side === result) {
            await changeBalance(uid, bet.amount * 2);
          }

          report += `👤 ${u.name} ${change > 0 ? "+" : ""}${change}\n`;
        }

        // 🎭 演员
        const fakeBots = generateFakeBots();

        report += "\n🎭 演员\n";

        fakeBots.forEach(bot => {
          let change = bot.side === result ? bot.amount : -bot.amount;
          report += `🎭 ${bot.name} ${change > 0 ? "+" : ""}${change}\n`;
        });

        await broadcast(report);

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

  let html = `
  <h2>👑 后台管理系统</h2>

  <h3>🎭 演员设置</h3>
  <form method="POST" action="/admin/fake">
    数量: <input name="count" value="${FAKE_CONFIG.count}"/><br>
    名字: <input name="names" value="${FAKE_CONFIG.names.join(",")}"/><br>
    启用:
    <select name="enabled">
      <option value="true">ON</option>
      <option value="false">OFF</option>
    </select>
    <button>保存</button>
  </form>

  <hr>
  <h3>👤 玩家管理</h3>
  `;

  data.forEach(p => {
    html += `
    <div style="margin-bottom:10px;">
      👤 ${p.name} (${p.user_id}) | 💰${p.balance}
      <form method="POST" action="/admin/topup" style="display:inline;">
        <input name="user_id" value="${p.user_id}" hidden />
        <input name="amount" placeholder="+100 / -100" />
        <button>充值/扣分</button>
      </form>
    </div>`;
  });

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
