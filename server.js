const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ===== LINE =====
const config = {
  channelAccessToken: "MSoKv1nFk7+A5XOwlF/bg2FL9kfa8nT+gGP/DOLa6zY02XMfbgibLL2xQZ8Dp35UTKUQ0olq/jlDUcjwaApfs+2MCK4kAALknCC/GMwDC4MnUR9BGzPmVtbQLUbL5Gmu1tzmCBg7MhS3XD/VXCSfYwdB04t89/1O/w1cDnyilFU=",
  channelSecret: "945a0301583c7770ae2cbdf7fe3a4483"
};

const client = new line.Client(config);

// ===== Supabase =====
const supabase = createClient(
  "https://riqystgmpvxwsebyavuo.supabase.co",
  "sb_publishable_bWATEwsQd3fU_GKjcLdQzg_1pN6buQE"
);

// ===== 管理员 =====
const ADMIN_ID = "U8455884cfb22877f209092cc78ea9880";
const ADMIN_PASSWORD = "123456";

// ===== 状态 =====
let adminLoggedIn = false;
let gameOpen = false;
let bets = {};
let names = {};
let currentGroupId = null;
let timer = null;

// ===== DEBUG（解决没反应问题）=====
console.log("BOT 已启动");

// ===== 获取用户 =====
async function getUser(userId, name) {
  let { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId);

  if (!data || data.length === 0) {
    await supabase.from("players").insert([{
      user_id: userId,
      name: name,
      balance: 0,
      total_win: 0,
      total_lose: 0
    }]);
    return { balance: 0 };
  }

  return data[0];
}

// ===== 倒计时 =====
function startTimer() {
  let time = 60;

  timer = setInterval(async () => {
    time -= 10;

    console.log("倒计时:", time);

    if (time > 0 && currentGroupId) {
      await client.pushMessage(currentGroupId, {
        type: "text",
        text: `⏰ 剩余 ${time} 秒`
      });
    }

    if (time <= 0) {
      clearInterval(timer);
      closeGame();
    }
  }, 10000);
}

// ===== 关局 =====
async function closeGame() {
  gameOpen = false;

  let msg = "🔴 已关局\n\n📊 下注列表\n";

  for (let u in bets) {
    let b = bets[u];
    msg += `${b.name} ${b.side}${b.amount}\n`;
  }

  msg += "\n⌛ 等待管理员输入 /result";

  if (currentGroupId) {
    await client.pushMessage(currentGroupId, {
      type: "text",
      text: msg
    });
  }
}

// ===== 后台登录 =====
app.post("/admin/login", (req, res) => {
  const { password } = req.body;

  if (password === ADMIN_PASSWORD) {
    adminLoggedIn = true;
    return res.json({ success: true });
  }

  res.json({ success: false });
});

// ===== 充值 =====
app.post("/admin/add", async (req, res) => {
  if (!adminLoggedIn) {
    return res.json({ error: "未登录" });
  }

  const { user_id, amount } = req.body;

  let { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", user_id);

  if (!data || data.length === 0) {
    return res.json({ error: "找不到玩家" });
  }

  let player = data[0];
  let newBalance = player.balance + amount;

  await supabase
    .from("players")
    .update({ balance: newBalance })
    .eq("user_id", user_id);

  res.json({ success: true, newBalance });
});

// ===== webhook =====
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {

    console.log("收到事件:", JSON.stringify(req.body));

    for (const event of req.body.events) {

      if (event.type !== "message" || event.message.type !== "text") continue;

      const text = event.message.text.trim().toUpperCase();
      const userId = event.source.userId;

      console.log("用户:", userId, "内容:", text);

      if (event.source.type === "group") {
        currentGroupId = event.source.groupId;
      }

      // ===== 获取名字 =====
      if (!names[userId]) {
        try {
          const profile = await client.getProfile(userId);
          names[userId] = profile.displayName;
        } catch {
          names[userId] = "玩家";
        }
      }

      const name = names[userId];
      const userData = await getUser(userId, name);

      // ===== 管理员 =====
      if (userId === ADMIN_ID) {

        if (text === "/START") {

          if (gameOpen) {
            return reply(event, "❌ 已经开局中");
          }

          if (timer) {
            clearInterval(timer);
          }

          gameOpen = true;
          bets = {};

          startTimer();

          return reply(event, "🟢 开局 60秒下注");
        }

        if (text.startsWith("/RESULT")) {
          const result = text.split(" ")[1];

          if (!["B", "P", "T"].includes(result)) {
            return reply(event, "❌ /result B/P/T");
          }

          let msg = `📊 结果：${result}\n\n`;

          for (let user in bets) {
            const bet = bets[user];

            let win = bet.side === result
              ? (result === "T" ? bet.amount * 8 : bet.amount)
              : -bet.amount;

            let { data } = await supabase
              .from("players")
              .select("*")
              .eq("user_id", user);

            let player = data?.[0];
            if (!player) continue;

            let newBalance = player.balance + win;

            await supabase
              .from("players")
              .update({ balance: newBalance })
              .eq("user_id", user);

            msg += `${bet.name} ${win > 0 ? "✅+" : "❌"}${win}（余额 ${newBalance}）\n`;
          }

          bets = {};

          if (currentGroupId) {
            await client.pushMessage(currentGroupId, {
              type: "text",
              text: msg
            });
          }

          return reply(event, "✅ 已结算");
        }
      }

      // ===== 玩家 =====
      if (text === "/BALANCE") {
        return reply(event, `💰 余额：${userData.balance}`);
      }

      if (!gameOpen) return;

      if (bets[userId]) {
        return reply(event, "❌ 已下注");
      }

      const match = text.match(/^(B|P|T)(\d+)/);
      if (!match) return;

      const side = match[1];
      const amount = parseInt(match[2]);

      if (amount < 100 || amount > 10000) {
        return reply(event, "❌ 限制100-10000");
      }

      if (userData.balance < amount) {
        return reply(event, "❌ 余额不足");
      }

      bets[userId] = { side, amount, name };

      if (currentGroupId) {
        await client.pushMessage(currentGroupId, {
          type: "text",
          text: `📥 ${name} 下注 ${side}${amount}`
        });
      }
    }

    res.status(200).end();

  } catch (err) {
    console.log("🔥 ERROR:", err);
    res.status(500).end();
  }
});

// ===== 回复 =====
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text
  });
}

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 BOT RUNNING");
});
