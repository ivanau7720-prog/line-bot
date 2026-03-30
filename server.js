const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ✅ 后台专用（不会影响 webhook）
app.use("/admin", express.urlencoded({ extended: true }));
app.use("/admin", express.json());

// ===== LINE =====
const config = {
  channelAccessToken: "MSoKv1nFk7+A5XOwlF/bg2FL9kfa8nT+gGP/DOLa6zY02XMfbgibLL2xQZ8Dp35UTKUQ0olq/jlDUcjwaApfs+2MCK4kAALknCC/GMwDC4MnUR9BGzPmVtbQLUbL5Gmu1tzmCBg7MhS3XD/VXCSfYwdB04t89/1O/w1cDnyilFU=",
  channelSecret: "945a0301583c7770ae2cbdf7fe3a4483"
};
const client = new line.Client(config);

// ===== Supabase（❗一定要用 anon public key）=====
const supabase = createClient(
  "https://你的项目.supabase.co",
  "sb_publishable_bWATEwsQd3fU_GKjcLdQzg_1pN6buQE"
);

// ===== 管理员 =====
const ADMIN_ID = "U8455884cfb22877f209092cc78ea9880";

// ===== 状态 =====
let gameOpen = false;
let bets = {};
let names = {};
let groupId = null;
let history = [];

const FEE_RATE = 0.05;

// ===== 获取用户（自动注册）=====
async function getUser(userId, name) {
  let { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId);

  if (!data || data.length === 0) {
    await supabase.from("players").insert([{
      user_id: userId,
      name,
      balance: 0,
      total_win: 0,
      total_lose: 0
    }]);

    console.log("✅ 新用户:", userId);

    return { balance: 0 };
  }

  return data[0];
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

function emoji(r) {
  return r === "B" ? "🔴" : r === "P" ? "🔵" : "🟢";
}

// ===== 后台 =====
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

  let { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", user_id);

  if (!data || data.length === 0) {
    return res.send("❌ 找不到玩家");
  }

  let player = data[0];
  let newBalance = player.balance + Number(amount);

  await supabase
    .from("players")
    .update({ balance: newBalance })
    .eq("user_id", user_id);

  await supabase.from("transactions").insert([{
    user_id,
    name: player.name,
    amount: Number(amount),
    fee: 0,
    type: "topup"
  }]);

  res.send(`✅ ${player.name} 余额 ${newBalance}`);
});

// ===== 查余额 =====
app.get("/admin/balance", async (req, res) => {
  const { user_id } = req.query;

  let { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", user_id);

  if (!data || data.length === 0) {
    return res.send("❌ 找不到玩家");
  }

  res.send(`💰 ${data[0].name} 余额：${data[0].balance}`);
});

// ===== 🔥🔥🔥 最稳定 webhook =====
app.post(
  "/webhook",
  express.raw({ type: "*/*" }), // ❗核心修复
  line.middleware(config),
  async (req, res) => {
    try {
      for (const event of req.body.events) {

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

        if (text === "/BALANCE") {
          return reply(event, `💰 余额：${user.balance}`);
        }

        if (userId === ADMIN_ID && text === "/START") {
          gameOpen = true;
          bets = {};
          await broadcast("🟢 开局 60秒下注");
          startTimer();
          return reply(event, "已开局");
        }

        if (!gameOpen) continue;

        if (bets[userId]) {
          return reply(event, "❌ 已下注");
        }

        let match = text.match(/^(B|P|T)(\d+)/);
        if (!match) continue;

        let side = match[1];
        let amount = parseInt(match[2]);

        if (user.balance < amount) {
          return reply(event, "❌ 余额不足");
        }

        bets[userId] = { side, amount, name };

        await broadcast(`📥 ${name} ${side}${amount}`);
      }

      res.sendStatus(200);

    } catch (err) {
      console.log("❌ ERROR:", err);
      res.sendStatus(500);
    }
  }
);

function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text
  });
}

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 RUNNING");
});
