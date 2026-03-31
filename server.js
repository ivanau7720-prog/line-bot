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
let groupId = null;

// ===== 自动注册用户 =====
async function getUser(userId) {
  try {
    let { data } = await supabase
      .from("players")
      .select("*")
      .eq("user_id", userId);

    if (!data || data.length === 0) {
      let name = "玩家";

      try {
        const profile = await client.getProfile(userId);
        name = profile.displayName;
      } catch {}

      await supabase.from("players").insert([{
        user_id: userId,
        name,
        balance: 0,
        total_win: 0,
        total_lose: 0
      }]);

      console.log("✅ 自动注册:", userId);

      return { user_id: userId, name, balance: 0 };
    }

    return data[0];

  } catch (err) {
    console.log("❌ getUser error:", err);
    return null;
  }
}

// ===== 广播 =====
async function broadcast(text) {
  if (!groupId) return;
  try {
    await client.pushMessage(groupId, { type: "text", text });
  } catch (e) {
    console.log("❌ broadcast error", e);
  }
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
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/admin", (req, res) => {
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
app.post("/admin/topup", async (req, res) => {
  const { user_id, amount } = req.body;

  const user = await getUser(user_id);
  if (!user) return res.send("❌ 系统错误");

  const newBalance = Number(user.balance) + Number(amount);

  await supabase
    .from("players")
    .update({ balance: newBalance })
    .eq("user_id", user_id);

  res.send(`✅ ${user.name} 余额 ${newBalance}`);
});

// ===== 查询 =====
app.get("/admin/balance", async (req, res) => {
  const { user_id } = req.query;

  const user = await getUser(user_id);
  if (!user) return res.send("❌ 系统错误");

  res.send(`💰 ${user.name} 余额：${user.balance}`);
});

// ===== webhook（稳定版）=====
app.post(
  "/webhook",
  express.raw({ type: "*/*" }),
  line.middleware(config),
  async (req, res) => {
    try {
      for (const event of req.body.events) {

        if (event.type !== "message" || event.message.type !== "text") continue;

        const userId = event.source.userId;
        const text = event.message.text.trim().toUpperCase();

        if (event.source.type === "group") {
          groupId = event.source.groupId;
        }

        const user = await getUser(userId);
        if (!user) continue;

        // ===== 查询余额 =====
        if (text === "/BALANCE") {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: `💰 余额：${user.balance}`
          });
          continue;
        }

        // ===== 开局 =====
        if (userId === ADMIN_ID && text === "/START") {
          gameOpen = true;
          bets = {};
          await broadcast("🟢 开局 60秒下注");
          startTimer();
          continue;
        }

        // ===== 下注 =====
        if (!gameOpen) continue;
        if (bets[userId]) continue;

        let match = text.match(/^(B|P|T)(\d+)/);
        if (!match) continue;

        let side = match[1];
        let amount = parseInt(match[2]);

        if (user.balance < amount) {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ 余额不足"
          });
          continue;
        }

        // ✅ 扣钱（重点修复）
        await supabase
          .from("players")
          .update({ balance: user.balance - amount })
          .eq("user_id", userId);

        bets[userId] = { side, amount, name: user.name };

        await broadcast(`📥 ${user.name} ${side}${amount}`);
      }

      res.sendStatus(200);

    } catch (err) {
      console.log("❌ ERROR:", err);
      res.sendStatus(500);
    }
  }
);

// ===== 启动 =====
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 RUNNING");
});
