const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== 后台专用 =====
const adminApp = express();
adminApp.use(express.urlencoded({ extended: true }));
adminApp.use(express.json());

// ===== LINE =====
const config = {
  channelAccessToken: process.env.LINE_TOKEN,
  channelSecret: process.env.LINE_SECRET
};
const client = new line.Client(config);

// ===== Supabase =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===== 管理员 =====
const ADMIN_ID = process.env.ADMIN_ID;

// ===== 状态 =====
let gameOpen = false;
let bets = {};
let names = {};
let groupId = null;

const FEE_RATE = 0.05;

// ===== 获取用户（🔥稳定版）=====
async function getUser(userId, name) {
  try {
    const { data, error } = await supabase
      .from("players")
      .select("*")
      .eq("user_id", userId);

    if (error) {
      console.log("❌ 查询失败:", error);
      return { balance: 0 };
    }

    if (!data || data.length === 0) {
      const { error: insertError } = await supabase
        .from("players")
        .insert([{
          user_id: userId,
          name,
          balance: 0,
          total_win: 0,
          total_lose: 0
        }]);

      if (insertError) {
        console.log("❌ 插入失败:", insertError);
      } else {
        console.log("✅ 新用户:", userId);
      }

      return { balance: 0 };
    }

    return data[0];

  } catch (err) {
    console.log("❌ getUser异常:", err);
    return { balance: 0 };
  }
}

// ===== 广播 =====
async function broadcast(text) {
  if (!groupId) return;
  await client.pushMessage(groupId, { type: "text", text });
}

// ===== 倒计时 =====
function startTimer() {
  let time = 60;

  const timer = setInterval(async () => {
    time -= 10;

    if (time > 0) {
      await broadcast(`⏰ 剩余 ${time} 秒`);
    }

    if (time <= 0) {
      clearInterval(timer);
      gameOpen = false;

      let list = "📊 下注列表\n";
      for (let u in bets) {
        let b = bets[u];
        list += `${b.name} ${b.side}${b.amount}\n`;
      }

      await broadcast("🔴 已关局\n\n" + list);
    }
  }, 10000);
}

// ===== 后台 =====
adminApp.get("/", (req, res) => {
  res.send(`
    <h2>💰 后台系统</h2>

    <form method="POST" action="/admin/topup">
      用户ID:<br>
      <input name="user_id"/><br><br>

      金额:<br>
      <input name="amount"/><br><br>

      <button type="submit">充值</button>
    </form>

    <br><br>

    <form method="GET" action="/admin/balance">
      查询余额:<br>
      <input name="user_id"/><br><br>
      <button type="submit">查询</button>
    </form>
  `);
});

// ===== 充值 =====
adminApp.post("/topup", async (req, res) => {
  const { user_id, amount } = req.body;

  const { data, error } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", user_id);

  if (error || !data || data.length === 0) {
    return res.send("❌ 找不到玩家");
  }

  let player = data[0];
  let newBalance = Number(player.balance) + Number(amount);

  await supabase
    .from("players")
    .update({ balance: newBalance })
    .eq("user_id", user_id);

  res.send(`✅ ${player.name} 余额 ${newBalance}`);
});

// ===== 查询余额 =====
adminApp.get("/balance", async (req, res) => {
  const { user_id } = req.query;

  const { data, error } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", user_id);

  if (error || !data || data.length === 0) {
    return res.send("❌ 找不到玩家");
  }

  res.send(`💰 ${data[0].name} 余额：${data[0].balance}`);
});

app.use("/admin", adminApp);

// ===== webhook（🔥关键稳定）=====
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;

    for (const event of events) {

      if (event.type !== "message" || event.message.type !== "text") continue;

      const userId = event.source.userId;
      const text = event.message.text.trim().toUpperCase();

      console.log("📩:", userId, text);

      if (event.source.type === "group") {
        groupId = event.source.groupId;
      }

      if (!names[userId]) {
        try {
          let profile = await client.getProfile(userId);
          names[userId] = profile.displayName;
        } catch {
          names[userId] = "玩家";
        }
      }

      const name = names[userId];
      const user = await getUser(userId, name);

      // 查余额
      if (text === "/BALANCE") {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: `💰 余额：${user.balance}`
        });
      }

      // 开局
      if (userId === ADMIN_ID && text === "/START") {
        gameOpen = true;
        bets = {};
        await broadcast("🟢 开局 60秒下注");
        startTimer();
        return;
      }

      // 下注
      if (!gameOpen) continue;
      if (bets[userId]) continue;

      let match = text.match(/^(B|P|T)(\d+)/);
      if (!match) continue;

      let side = match[1];
      let amount = parseInt(match[2]);

      if (user.balance < amount) {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "❌ 余额不足"
        });
      }

      bets[userId] = { side, amount, name };

      await broadcast(`📥 ${name} ${side}${amount}`);
    }

    res.sendStatus(200);

  } catch (err) {
    console.log("❌ ERROR:", err);
    res.sendStatus(500);
  }
});

// ===== 启动 =====
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 RUNNING");
});
