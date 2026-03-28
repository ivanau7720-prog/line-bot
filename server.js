const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const config = {
  channelAccessToken: "MSoKv1nFk7+A5XOwlF/bg2FL9kfa8nT+gGP/DOLa6zY02XMfbgibLL2xQZ8Dp35UTKUQ0olq/jlDUcjwaApfs+2MCK4kAALknCC/GMwDC4MnUR9BGzPmVtbQLUbL5Gmu1tzmCBg7MhS3XD/VXCSfYwdB04t89/1O/w1cDnyilFU=",
  channelSecret: "945a0301583c7770ae2cbdf7fe3a4483"
};

const client = new line.Client(config);

// ===== Supabase =====
const supabase = createClient(
  "https://riqystgmpvxwsebvayuo.supabase.co",
  "sb_publishable_bWATEwsQd3fU_GKjcLdQzg_1pN6buQE"
);

// ===== 管理员 =====
const ADMIN_ID = "U8455884cfb22877f209092cc78ea9880";

// ===== 状态 =====
let gameOpen = false;
let bets = {};
let names = {};
let groupId = null;

// ===== 清理名字（支持泰文）=====
function clean(name) {
  return name.replace(/[@\s]/g, "").toLowerCase();
}

// ===== 获取用户（默认0分）=====
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
    return { balance: 0 };
  }

  return data[0];
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

// ===== 广播 =====
async function broadcast(text) {
  if (!groupId) return;

  await client.pushMessage(groupId, {
    type: "text",
    text
  });
}

// ===== webhook =====
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      if (event.type !== "message") continue;

      const textRaw = event.message.text || "";
      const text = textRaw.trim().toUpperCase();
      const userId = event.source.userId;

      if (event.source.type === "group") {
        groupId = event.source.groupId;
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
      const user = await getUser(userId, name);

      // ===== 💰 查余额（不受游戏限制）=====
      if (text === "/BALANCE") {
        return reply(event, `💰 余额：${user.balance}`);
      }

      // ===== 👑 管理员 =====
      if (userId === ADMIN_ID) {

        // 开局
        if (text === "/START") {
          gameOpen = true;
          bets = {};

          await broadcast("🟢 开局！60秒下注");

          startTimer();
          return reply(event, "已开局");
        }

        // 充值（支持@）
        if (text.startsWith("/ADD")) {
          let input = textRaw.replace(/\/add/i, "").trim();

          let match = input.match(/(.+)\s([+-]?\d+)/);
          if (!match) return reply(event, "❌ /add 名字 +1000");

          let target = clean(match[1]);
          let amount = parseInt(match[2]);

          let { data } = await supabase.from("players").select("*");

          let player = data.find(p =>
            clean(p.name).includes(target)
          );

          if (!player) return reply(event, "❌ 找不到玩家");

          let newBalance = player.balance + amount;

          await supabase
            .from("players")
            .update({ balance: newBalance })
            .eq("user_id", player.user_id);

          await broadcast(`💰 ${player.name} ${amount > 0 ? "+" : ""}${amount}\n余额 ${newBalance}`);

          return reply(event, "充值成功");
        }

        // 结算
        if (text.startsWith("/RESULT")) {
          let result = text.split(" ")[1];

          let msg = `📊 结果 ${result}\n\n`;
          let ranking = [];

          for (let u in bets) {
            let b = bets[u];

            let win = b.side === result ? b.amount : -b.amount;

            let { data } = await supabase
              .from("players")
              .select("*")
              .eq("user_id", u);

            let player = data[0];

            let newBalance = player.balance + win;

            await supabase
              .from("players")
              .update({ balance: newBalance })
              .eq("user_id", u);

            msg += `${b.name} ${win > 0 ? "✅+" : "❌"}${win}\n`;

            ranking.push({ name: b.name, score: newBalance });
          }

          ranking.sort((a, b) => b.score - a.score);

          msg += "\n🏆 排行榜\n";
          ranking.slice(0, 5).forEach((p, i) => {
            msg += `${i + 1}. ${p.name} ${p.score}\n`;
          });

          bets = {};

          await broadcast(msg);
          return reply(event, "已结算");
        }
      }

      // ===== 玩家下注 =====
      if (!gameOpen) return;

      if (bets[userId]) return reply(event, "❌ 已下注");

      let match = text.match(/^(B|P|T)(\d+)/);
      if (!match) return;

      let side = match[1];
      let amount = parseInt(match[2]);

      if (user.balance < amount) {
        return reply(event, "❌ 余额不足");
      }

      bets[userId] = { side, amount, name };

      await broadcast(`📥 ${name} ${side}${amount}`);
    }

    res.status(200).end();

  } catch (err) {
    console.log("ERROR:", err);
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
