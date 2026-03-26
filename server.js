const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const config = {
  channelAccessToken: "MSoKv1nFk7+A5XOwlF/bg2FL9kfa8nT+gGP/DOLa6zY02XMfbgibLL2xQZ8Dp35UTKUQ0olq/jlDUcjwaApfs+2MCK4kAALknCC/GMwDC4MnUR9BGzPmVtbQLUbL5Gmu1tzmCBg7MhS3XD/VXCSfYwdB04t89/1O/w1cDnyilFU=",
  channelSecret: "945a0301583c7770ae2cbdf7fe3a4483"
};

const client = new line.Client(config);

// ✅ Supabase（用你自己的）
const supabase = createClient(
  "https://riqystgmpvxwsebyavuo.supabase.co",
  "sb_publishable_bWATEwsQd3fU_GKjcLdQzg_1pN6buQE"
);

// ===== 管理员 =====
const ADMIN_ID = "U8455884cfb22877f209092cc78ea9880";

// ===== 游戏状态 =====
let gameOpen = false;
let bets = {};
let names = {};

// ===== 设置 =====
const MIN_BET = 100;
const MAX_BET = 10000;

// ===== 获取用户 =====
async function getUser(userId, name) {
  let { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId);

  if (!data || data.length === 0) {
    await supabase.from("players").insert([
      {
        user_id: userId,
        name: name,
        balance: 1000,
        total_win: 0,
        total_lose: 0
      }
    ]);

    return { balance: 1000 };
  }

  return data[0];
}

// ===== webhook =====
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;

    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const text = event.message.text.trim().toUpperCase();
      const userId = event.source.userId;

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
          gameOpen = true;
          bets = {};
          return reply(event, "🟢 开局");
        }

        if (text === "/STOP") {
          gameOpen = false;
          return reply(event, "🔴 关局");
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

            let player = data[0];

            let newBalance = player.balance + win;

            await supabase
              .from("players")
              .update({ balance: newBalance })
              .eq("user_id", user);

            msg += `${bet.name} ${win > 0 ? "✅+" : "❌"}${win}\n`;
          }

          bets = {};
          return reply(event, msg || "无人下注");
        }
      }

      // ===== 玩家下注 =====
      if (!gameOpen) return reply(event, "❌ 未开局");

      if (bets[userId]) {
        return reply(event, "❌ 已下注");
      }

      const match = text.match(/^(B|P|T)(\d+)/);
      if (!match) return;

      const side = match[1];
      const amount = parseInt(match[2]);

      if (amount < MIN_BET || amount > MAX_BET) {
        return reply(event, "❌ 限制100-10000");
      }

      if (userData.balance < amount) {
        return reply(event, "❌ 余额不足");
      }

      bets[userId] = { side, amount, name };

      return reply(event, `✅ ${name} ${side}${amount}`);
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
  console.log("RUNNING");
});
